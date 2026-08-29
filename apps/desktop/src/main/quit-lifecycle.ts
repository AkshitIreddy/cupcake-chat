export interface QuitEvent {
  preventDefault(): void;
}

export interface QuitLifecycle {
  beforeQuit(event: QuitEvent): void;
  isCleaningUp(): boolean;
  isReadyToQuit(): boolean;
}

/**
 * Keeps every quit request blocked until the asynchronous desktop cleanup has
 * settled. Only the coordinator's final request is allowed through, so a
 * second OS/app quit event cannot close Electron's event loop while sidecars
 * are still checkpointing.
 */
export function createQuitLifecycle(
  cleanup: () => Promise<void>,
  requestQuit: () => void,
): QuitLifecycle {
  let state: 'running' | 'cleaning' | 'ready' = 'running';

  return {
    beforeQuit(event): void {
      if (state === 'ready') return;
      event.preventDefault();
      if (state === 'cleaning') return;

      state = 'cleaning';
      const finish = (): void => {
        state = 'ready';
        requestQuit();
      };
      let cleanupResult: Promise<void>;
      try {
        cleanupResult = cleanup();
      } catch {
        finish();
        return;
      }
      void cleanupResult.then(finish, finish);
    },
    isCleaningUp(): boolean {
      return state === 'cleaning';
    },
    isReadyToQuit(): boolean {
      return state === 'ready';
    },
  };
}
