import { describe, expect, it, vi } from 'vitest';
import type { RuntimeStatus } from '../shared/desktop-api';
import { RuntimeRecoveryCoordinator } from './runtime-recovery';

describe('RuntimeRecoveryCoordinator', () => {
  it('uses the initial ready worker as a baseline without duplicating bootstrap', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const coordinator = new RuntimeRecoveryCoordinator({ refresh });

    expect(coordinator.observe(ready(0, 4100))).toBe(false);
    expect(coordinator.observe(ready(0, 4100))).toBe(false);
    await coordinator.whenIdle();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes after an incremented restart generation becomes ready', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const restarted = vi.fn();
    const coordinator = new RuntimeRecoveryCoordinator({
      refresh,
      onRestartDetected: restarted,
    });

    coordinator.observe(ready(0, 4100));
    coordinator.observe(status('crashed', 0, 4100));
    coordinator.observe(status('starting', 1, 5200));
    expect(coordinator.observe(ready(1, 5200))).toBe(true);
    await coordinator.whenIdle();

    expect(restarted).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(ready(1, 5200));
  });

  it('also recognizes a ready worker PID change when the counter is unchanged', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const coordinator = new RuntimeRecoveryCoordinator({ refresh });

    coordinator.observe(ready(2, 4100));
    expect(coordinator.observe(ready(2, 5200))).toBe(true);
    expect(coordinator.observe(ready(2, 5200))).toBe(false);
    await coordinator.whenIdle();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it('ignores delayed ready events from an older restart generation', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const coordinator = new RuntimeRecoveryCoordinator({ refresh });

    coordinator.observe(ready(3, 7100));
    expect(coordinator.observe(ready(2, 6100))).toBe(false);
    expect(coordinator.observe(ready(3, 7100))).toBe(false);
    await coordinator.whenIdle();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('coalesces ready generations that arrive while a refresh is running', async () => {
    let finishFirst: (() => void) | undefined;
    const firstRefresh = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const refresh = vi
      .fn<(status: RuntimeStatus) => Promise<void>>()
      .mockReturnValueOnce(firstRefresh)
      .mockResolvedValue(undefined);
    const coordinator = new RuntimeRecoveryCoordinator({ refresh });

    coordinator.observe(ready(0, 4100));
    coordinator.observe(ready(1, 5100));
    coordinator.observe(ready(2, 6100));
    coordinator.observe(ready(3, 7100));
    expect(refresh).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await coordinator.whenIdle();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith(ready(3, 7100));
  });

  it('contains refresh failures and can recover on a later generation', async () => {
    const onRefreshError = vi.fn();
    const refresh = vi
      .fn<(status: RuntimeStatus) => Promise<void>>()
      .mockRejectedValueOnce(new Error('runtime warming'))
      .mockResolvedValue(undefined);
    const coordinator = new RuntimeRecoveryCoordinator({ refresh, onRefreshError });

    coordinator.observe(ready(0, 4100));
    coordinator.observe(ready(1, 5100));
    await coordinator.whenIdle();
    coordinator.observe(ready(2, 6100));
    await coordinator.whenIdle();

    expect(onRefreshError).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('ignores mock, disabled, starting, degraded, and crashed statuses', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const coordinator = new RuntimeRecoveryCoordinator({ refresh });

    coordinator.observe({ ...ready(0, 4100), mode: 'mock' });
    coordinator.observe({ ...ready(1, 5100), mode: 'disabled' });
    coordinator.observe(status('starting', 1, 5100));
    coordinator.observe(status('degraded', 1, 5100));
    coordinator.observe(status('crashed', 1, 5100));
    await coordinator.whenIdle();

    expect(refresh).not.toHaveBeenCalled();
  });
});

function ready(restartCount: number, pid?: number): RuntimeStatus {
  return status('ready', restartCount, pid);
}

function status(state: RuntimeStatus['state'], restartCount: number, pid?: number): RuntimeStatus {
  return { state, mode: 'broker', restartCount, pid };
}
