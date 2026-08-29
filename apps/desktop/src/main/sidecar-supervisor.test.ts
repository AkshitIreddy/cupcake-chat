import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalFileGrant } from './file-handles';
import {
  FileGrantReplayLedger,
  safeLog,
  stopChildProcess,
  waitForChildExit,
} from './sidecar-supervisor';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly actions: string[] = [];
  readonly stdin = {
    writable: true,
    end: (): void => {
      this.actions.push('stdin.end');
    },
  };

  kill(signal?: NodeJS.Signals | number): boolean {
    this.actions.push(String(signal));
    return true;
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sidecar diagnostic redaction', () => {
  it('redacts a synthetic NVIDIA NIM credential wherever it appears', () => {
    const canary = 'nvapi-synthetic-electron-canary-1234567890';
    const output = safeLog(`provider error for ${canary}`);

    expect(output).not.toContain(canary);
    expect(output).toBe('provider error for [redacted]');
  });
});

describe('sidecar file grant replay', () => {
  const grant = (overrides: Partial<InternalFileGrant> = {}): InternalFileGrant => ({
    id: '0198f1e2-d3c4-7a69-8def-0123456789ab',
    kind: 'file',
    name: 'notes.txt',
    writable: false,
    absolutePath: 'C:\\selected\\notes.txt',
    createdAt: 1,
    ...overrides,
  });

  it('replays active grants after a broker restart and omits released grants', () => {
    const ledger = new FileGrantReplayLedger();
    ledger.register(grant());
    const firstBroker: unknown[] = [];
    ledger.replay((item) => firstBroker.push(item));

    const restartedBroker: unknown[] = [];
    ledger.replay((item) => restartedBroker.push(item));
    expect(restartedBroker).toEqual(firstBroker);

    expect(ledger.release(grant().id)).toBe(true);
    const afterRelease: unknown[] = [];
    ledger.replay((item) => afterRelease.push(item));
    expect(afterRelease).toEqual([]);
  });

  it('accepts exact pre-request re-registration and rejects capability replacement', () => {
    const ledger = new FileGrantReplayLedger();
    const original = ledger.register(grant());

    expect(ledger.register(grant())).toBe(original);
    expect(() => ledger.register(grant({ absolutePath: 'C:\\other\\notes.txt' }))).toThrow(
      'Conflicting file grant re-registration',
    );
  });
});

describe('sidecar shutdown lifecycle', () => {
  it('stops after a signed graceful-shutdown request exits the broker', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const shutdown = vi.fn(() => child.exit());

    await stopChildProcess(child, shutdown, {
      gracefulMs: 20,
      stdinCloseMs: 20,
      terminateMs: 20,
      forceKillMs: 20,
    });

    expect(shutdown).toHaveBeenCalledOnce();
    expect(child.actions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates through stdin, termination, and force-kill in order', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const shutdown = vi.fn(() => child.actions.push('shutdown'));
    const stopped = stopChildProcess(child, shutdown, {
      gracefulMs: 20,
      stdinCloseMs: 20,
      terminateMs: 20,
      forceKillMs: 20,
    });

    expect(child.actions).toEqual(['shutdown']);
    await vi.advanceTimersByTimeAsync(20);
    expect(child.actions).toEqual(['shutdown', 'stdin.end']);
    await vi.advanceTimersByTimeAsync(20);
    expect(child.actions).toEqual(['shutdown', 'stdin.end', 'SIGTERM']);
    await vi.advanceTimersByTimeAsync(20);
    expect(child.actions).toEqual(['shutdown', 'stdin.end', 'SIGTERM', 'SIGKILL']);
    await vi.advanceTimersByTimeAsync(20);
    await stopped;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the exit listener and timer when a process exits during a wait', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const exited = waitForChildExit(child, 20_000);

    expect(child.listenerCount('exit')).toBe(1);
    child.exit();

    await expect(exited).resolves.toBe(true);
    expect(child.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
