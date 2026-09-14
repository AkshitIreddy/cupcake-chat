import { useEffect } from 'react';
import type {
  AppUpdateCheckResult,
  AppUpdateStatus,
  CupcakeDesktopApi,
} from '../shared/desktop-api';

type ReleaseUpdateApi = CupcakeDesktopApi['app']['updates'];

export type AutomaticReleaseCheckResult =
  | { kind: 'alreadyStarted' }
  | { kind: 'notConfigured'; status: AppUpdateStatus }
  | { kind: 'alreadyPending'; status: AppUpdateStatus }
  | { kind: 'busy'; status: AppUpdateStatus }
  | { kind: 'checked'; status: AppUpdateStatus; result: AppUpdateCheckResult }
  | { kind: 'failed'; error: unknown };

let automaticCheck: Promise<AutomaticReleaseCheckResult> | undefined;

/**
 * Starts one quiet update check for the renderer session. Calling this again,
 * including React Strict Mode's second effect pass, never starts another native
 * request. The updater host retains any discovered release for Settings.
 */
export function checkForReleaseOnce(
  updateApi: ReleaseUpdateApi,
): Promise<AutomaticReleaseCheckResult> {
  if (automaticCheck) return Promise.resolve({ kind: 'alreadyStarted' });
  automaticCheck = runAutomaticReleaseCheck(updateApi);
  return automaticCheck;
}

export function useAutomaticReleaseCheck({
  offline,
  ready,
  updateApi,
}: {
  offline: boolean;
  ready: boolean;
  updateApi?: ReleaseUpdateApi;
}): void {
  const hostApi =
    updateApi ?? (typeof window === 'undefined' ? undefined : window.cupcake?.app.updates);

  useEffect(() => {
    if (offline || !ready || !hostApi) return;
    void checkForReleaseOnce(hostApi);
  }, [hostApi, offline, ready]);
}

export function automaticReleaseCheckStarted(): boolean {
  return automaticCheck !== undefined;
}

export function resetAutomaticReleaseCheckForTests(): void {
  automaticCheck = undefined;
}

async function runAutomaticReleaseCheck(
  updateApi: ReleaseUpdateApi,
): Promise<AutomaticReleaseCheckResult> {
  try {
    const status = await updateApi.status();
    if (!status.configured) return { kind: 'notConfigured', status };
    if (status.busy) return { kind: 'busy', status };
    if (status.availableVersion) return { kind: 'alreadyPending', status };
    const result = await updateApi.check();
    return { kind: 'checked', status, result };
  } catch (error) {
    return { kind: 'failed', error };
  }
}
