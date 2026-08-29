import { describe, expect, it, vi } from 'vitest';
import { createQuitLifecycle } from './quit-lifecycle';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Electron quit lifecycle', () => {
  it('blocks repeated quit requests until asynchronous cleanup settles', async () => {
    const cleanupGate = deferred();
    const cleanup = vi.fn(() => cleanupGate.promise);
    const requestQuit = vi.fn();
    const lifecycle = createQuitLifecycle(cleanup, requestQuit);
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };

    lifecycle.beforeQuit(firstEvent);
    lifecycle.beforeQuit(repeatedEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(requestQuit).not.toHaveBeenCalled();
    expect(lifecycle.isCleaningUp()).toBe(true);

    cleanupGate.resolve();
    await cleanupGate.promise;
    await Promise.resolve();

    expect(requestQuit).toHaveBeenCalledOnce();
    expect(lifecycle.isReadyToQuit()).toBe(true);

    const finalEvent = { preventDefault: vi.fn() };
    lifecycle.beforeQuit(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('allows the final quit even when cleanup rejects', async () => {
    const cleanupGate = deferred();
    const requestQuit = vi.fn();
    const lifecycle = createQuitLifecycle(() => cleanupGate.promise, requestQuit);

    lifecycle.beforeQuit({ preventDefault: vi.fn() });
    cleanupGate.reject();
    await cleanupGate.promise.catch(() => undefined);
    await Promise.resolve();

    expect(requestQuit).toHaveBeenCalledOnce();
    expect(lifecycle.isReadyToQuit()).toBe(true);
  });
});
