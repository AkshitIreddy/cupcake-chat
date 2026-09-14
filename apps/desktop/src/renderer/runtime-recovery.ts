import { useEffect, useRef } from 'react';
import type { CupcakeDesktopApi, RuntimeStatus, Unsubscribe } from '../shared/desktop-api';

type RuntimeStatusApi = Pick<CupcakeDesktopApi['runtime'], 'status' | 'onStatus'>;

export interface RuntimeRecoveryOptions {
  refresh: (status: RuntimeStatus) => Promise<void>;
  onRestartDetected?: (status: RuntimeStatus) => void;
  onRefreshError?: (error: unknown, status: RuntimeStatus) => void;
}

interface ReadyGeneration {
  restartCount: number;
  pid?: number;
}

/**
 * Converts noisy runtime status events into one workspace refresh per ready
 * worker generation. The first ready worker is the baseline, so initial app
 * startup never duplicates the normal workspace bootstrap.
 */
export class RuntimeRecoveryCoordinator {
  private baseline?: ReadyGeneration;
  private readonly handled = new Set<string>();
  private queued?: RuntimeStatus;
  private refreshing = false;
  private disposed = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly options: RuntimeRecoveryOptions) {}

  observe(status: RuntimeStatus): boolean {
    if (this.disposed || status.mode !== 'broker' || status.state !== 'ready') return false;

    const next = readyGeneration(status);
    if (!this.baseline) {
      this.baseline = next;
      this.handled.add(generationKey(next));
      return false;
    }

    // Ignore a delayed event from a worker generation older than the latest
    // ready status already observed.
    if (next.restartCount < this.baseline.restartCount) return false;

    const restarted =
      next.restartCount > this.baseline.restartCount ||
      (next.pid !== undefined && this.baseline.pid !== undefined && next.pid !== this.baseline.pid);
    this.baseline = next;
    if (!restarted) return false;

    const key = generationKey(next);
    if (this.handled.has(key)) return false;
    this.handled.add(key);
    this.options.onRestartDetected?.(status);
    // A later ready generation supersedes an older queued generation. The
    // current refresh is allowed to finish, then one refresh reads the newest
    // durable workspace and provider catalog.
    this.queued = status;
    void this.drain();
    return true;
  }

  whenIdle(): Promise<void> {
    if (!this.refreshing && !this.queued) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  dispose(): void {
    this.disposed = true;
    this.queued = undefined;
    if (!this.refreshing) this.resolveIdle();
  }

  private async drain(): Promise<void> {
    if (this.refreshing || this.disposed) return;
    this.refreshing = true;
    try {
      while (this.queued && !this.disposed) {
        const status = this.queued;
        this.queued = undefined;
        try {
          await this.options.refresh(status);
        } catch (error) {
          this.options.onRefreshError?.(error, status);
        }
      }
    } finally {
      this.refreshing = false;
      this.resolveIdle();
    }
  }

  private resolveIdle(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

/**
 * Subscribes after the normal workspace bootstrap is ready. A runtime restart
 * clears transient run UI through `onRestartDetected`, then refreshes durable
 * workspace/provider state. It never retries or sends a chat message.
 */
export function useRuntimeRecovery({
  enabled,
  runtime,
  refresh,
  onRestartDetected,
  onRefreshError,
}: RuntimeRecoveryOptions & {
  enabled: boolean;
  runtime?: RuntimeStatusApi;
}): void {
  const refreshRef = useRef(refresh);
  const restartRef = useRef(onRestartDetected);
  const errorRef = useRef(onRefreshError);
  refreshRef.current = refresh;
  restartRef.current = onRestartDetected;
  errorRef.current = onRefreshError;

  useEffect(() => {
    if (!enabled || !runtime) return;

    const coordinator = new RuntimeRecoveryCoordinator({
      refresh: (status) => refreshRef.current(status),
      onRestartDetected: (status) => restartRef.current?.(status),
      onRefreshError: (error, status) => errorRef.current?.(error, status),
    });
    const buffered: RuntimeStatus[] = [];
    let seeded = false;
    let disposed = false;
    const release: Unsubscribe = runtime.onStatus((status) => {
      if (disposed) return;
      if (seeded) coordinator.observe(status);
      else buffered.push(status);
    });

    void runtime
      .status()
      .then((status) => {
        if (disposed) return;
        coordinator.observe(status);
        seeded = true;
        for (const pending of buffered.splice(0)) coordinator.observe(pending);
      })
      .catch(() => {
        if (disposed) return;
        seeded = true;
        for (const pending of buffered.splice(0)) coordinator.observe(pending);
      });

    return () => {
      disposed = true;
      release();
      coordinator.dispose();
    };
  }, [enabled, runtime]);
}

function readyGeneration(status: RuntimeStatus): ReadyGeneration {
  return { restartCount: status.restartCount, pid: status.pid };
}

function generationKey(generation: ReadyGeneration): string {
  return `${generation.restartCount}:${generation.pid ?? 'unknown'}`;
}
