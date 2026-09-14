import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppUpdateCheckResult,
  AppUpdateMetadata,
  AppUpdateProgress,
  AppUpdateStatus,
} from '../shared/desktop-api';
import {
  ReleaseUpdateController,
  resetAutomaticReleaseCheckForTests,
  type ReleaseUpdateApi,
  type ReleaseUpdateState,
} from './ReleaseUpdates';
import { checkForReleaseOnce } from './useAutomaticReleaseCheck';

const release: AppUpdateMetadata = {
  currentVersion: '1.8.0',
  version: '1.9.0',
  notes: 'Faster local models and calmer group turns.',
  publishedAt: '2026-09-15T12:00:00Z',
  target: 'windows-x86_64',
  downloaded: false,
};

const idleStatus: AppUpdateStatus = {
  configured: true,
  currentVersion: '1.8.0',
  endpoint: 'https://updates.example.test/latest.json',
  busy: false,
  downloaded: false,
};

beforeEach(() => resetAutomaticReleaseCheckForTests());

describe('ReleaseUpdateController', () => {
  it('reports a successful no-release check without inventing it before the feed responds', async () => {
    const mock = updaterMock({ check: { available: false } });
    const controller = new ReleaseUpdateController(mock.api, { offline: false });

    expect(controller.snapshot.phase).toBe('loading');
    await controller.initialize();
    expect(controller.snapshot.phase).toBe('idle');
    await controller.check();

    expect(controller.snapshot).toMatchObject({
      phase: 'upToDate',
      currentVersion: '1.8.0',
      configured: true,
    });
    expect(mock.check).toHaveBeenCalledOnce();
  });

  it('keeps an unsigned or missing release feed unavailable instead of claiming up to date', async () => {
    const mock = updaterMock({
      status: { ...idleStatus, configured: false },
      check: { available: false },
    });
    const controller = new ReleaseUpdateController(mock.api, { offline: false });

    await controller.initialize();
    await controller.check();

    expect(controller.snapshot.phase).toBe('unavailable');
    expect(mock.check).not.toHaveBeenCalled();
  });

  it('never contacts the update feed while offline and can check after reconnecting', async () => {
    const mock = updaterMock({ check: { available: false } });
    const controller = new ReleaseUpdateController(mock.api, { offline: true });

    await controller.initialize();
    await controller.check();
    expect(mock.check).not.toHaveBeenCalled();
    expect(controller.snapshot.offline).toBe(true);

    controller.setOffline(false);
    await controller.check();
    expect(mock.check).toHaveBeenCalledOnce();
    expect(controller.snapshot.phase).toBe('upToDate');
  });

  it('moves from available through real byte progress to restart-ready', async () => {
    const mock = updaterMock({
      check: { available: true, update: release },
      download: { ...release, downloaded: true },
      downloadProgress: [
        {
          stage: 'downloadProgress',
          version: '1.9.0',
          downloadedBytes: 25,
          totalBytes: 100,
        },
        {
          stage: 'downloadProgress',
          version: '1.9.0',
          downloadedBytes: 75,
          totalBytes: 100,
        },
        { stage: 'downloadVerified', version: '1.9.0' },
      ],
    });
    const controller = new ReleaseUpdateController(mock.api, { offline: false });
    const snapshots: ReleaseUpdateState[] = [];
    const releaseListener = controller.subscribe((state) => snapshots.push({ ...state }));
    const releaseProgress = controller.listenToProgress();

    await controller.initialize();
    await controller.check();
    expect(controller.snapshot.phase).toBe('available');
    await controller.download();

    expect(snapshots).toContainEqual(
      expect.objectContaining({
        phase: 'downloading',
        downloadedBytes: 75,
        totalBytes: 100,
      }),
    );
    expect(controller.snapshot).toMatchObject({
      phase: 'ready',
      availableVersion: '1.9.0',
      update: { downloaded: true },
    });
    releaseProgress();
    releaseListener();
  });

  it('surfaces native check failures and supports a later retry', async () => {
    const mock = updaterMock({
      check: [
        Promise.reject(
          Object.assign(new Error('The signed release feed did not respond.'), {
            code: 'UPDATE_FAILED',
            retryable: true,
          }),
        ),
        { available: false },
      ],
    });
    const controller = new ReleaseUpdateController(mock.api, { offline: false });

    await controller.initialize();
    await controller.check();
    expect(controller.snapshot).toMatchObject({
      phase: 'error',
      error: 'The signed release feed did not respond.',
      lastOperation: 'check',
    });

    await controller.check();
    expect(controller.snapshot.phase).toBe('upToDate');
  });

  it('hands a verified download to install only after an explicit call', async () => {
    const mock = updaterMock({
      status: {
        ...idleStatus,
        availableVersion: '1.9.0',
        downloaded: true,
      },
      installProgress: { stage: 'installing', version: '1.9.0' },
    });
    const controller = new ReleaseUpdateController(mock.api, { offline: false });
    const releaseProgress = controller.listenToProgress();

    await controller.initialize();
    expect(controller.snapshot.phase).toBe('ready');
    expect(mock.install).not.toHaveBeenCalled();
    await controller.install();

    expect(mock.install).toHaveBeenCalledOnce();
    expect(controller.snapshot).toMatchObject({
      phase: 'installing',
      availableVersion: '1.9.0',
    });
    releaseProgress();
  });

  it('claims the quiet automatic check once per renderer session', () => {
    const mock = updaterMock({ check: { available: false } });
    const first = checkForReleaseOnce(mock.api);
    const second = checkForReleaseOnce(mock.api);

    return Promise.all([first, second]).then(([firstResult, secondResult]) => {
      expect(firstResult.kind).toBe('checked');
      expect(secondResult.kind).toBe('alreadyStarted');
      expect(mock.status).toHaveBeenCalledOnce();
      expect(mock.check).toHaveBeenCalledOnce();
    });
  });

  it('keeps an update already found by the native host without checking again', async () => {
    const mock = updaterMock({
      status: { ...idleStatus, availableVersion: '1.9.0' },
      check: { available: false },
    });

    const result = await checkForReleaseOnce(mock.api);

    expect(result.kind).toBe('alreadyPending');
    expect(mock.status).toHaveBeenCalledOnce();
    expect(mock.check).not.toHaveBeenCalled();
  });
});

function updaterMock(options?: {
  status?: AppUpdateStatus;
  check?: AppUpdateCheckResult | Array<AppUpdateCheckResult | Promise<never>>;
  download?: AppUpdateMetadata;
  downloadProgress?: AppUpdateProgress[];
  installProgress?: AppUpdateProgress;
}) {
  const listeners = new Set<(progress: AppUpdateProgress) => void>();
  const checks = Array.isArray(options?.check)
    ? [...options.check]
    : [options?.check ?? { available: false }];
  const status = vi.fn(() => Promise.resolve(options?.status ?? idleStatus));
  const check = vi.fn(async () => {
    const next = checks.shift() ?? { available: false };
    return await next;
  });
  const download = vi.fn(() => {
    for (const progress of options?.downloadProgress ?? []) {
      for (const listener of listeners) listener(progress);
    }
    return Promise.resolve(options?.download ?? { ...release, downloaded: true });
  });
  const install = vi.fn(() => {
    if (options?.installProgress) {
      for (const listener of listeners) listener(options.installProgress);
    }
    return Promise.resolve();
  });
  const api: ReleaseUpdateApi = {
    status,
    check,
    download,
    install,
    onProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { api, status, check, download, install };
}
