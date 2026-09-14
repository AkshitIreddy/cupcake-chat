import { useEffect, useMemo, useState } from 'react';
import type {
  AppUpdateCheckResult,
  AppUpdateMetadata,
  AppUpdateProgress,
  AppUpdateStatus,
  CupcakeDesktopApi,
  Unsubscribe,
} from '../shared/desktop-api';
import { Icon } from './icons';
import './styles-release-updates.css';

export type ReleaseUpdatePhase =
  | 'loading'
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export interface ReleaseUpdateState {
  phase: ReleaseUpdatePhase;
  currentVersion: string;
  update?: AppUpdateMetadata;
  availableVersion?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
  configured?: boolean;
  offline: boolean;
  lastOperation?: 'status' | 'check' | 'download' | 'install';
}

export type ReleaseUpdateApi = CupcakeDesktopApi['app']['updates'];

type StateListener = (state: ReleaseUpdateState) => void;

let automaticCheckClaimed = false;

export class ReleaseUpdateController {
  private readonly listeners = new Set<StateListener>();
  private progressRelease?: Unsubscribe;
  private operation = 0;
  private initialized = false;
  private state: ReleaseUpdateState;

  constructor(
    private readonly api: ReleaseUpdateApi | undefined,
    options: { offline: boolean; currentVersion?: string },
  ) {
    this.state = {
      phase: api ? 'loading' : 'unavailable',
      currentVersion: options.currentVersion ?? 'Unknown',
      configured: api ? undefined : false,
      offline: options.offline,
    };
  }

  get snapshot(): ReleaseUpdateState {
    return this.state;
  }

  get readyForAutomaticCheck(): boolean {
    return (
      this.initialized &&
      !this.state.offline &&
      this.state.configured === true &&
      this.state.phase === 'idle'
    );
  }

  subscribe(listener: StateListener): Unsubscribe {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  listenToProgress(): Unsubscribe {
    if (!this.api || this.progressRelease) return () => undefined;
    this.progressRelease = this.api.onProgress((progress) => this.applyProgress(progress));
    return () => {
      this.progressRelease?.();
      this.progressRelease = undefined;
    };
  }

  setOffline(offline: boolean): void {
    if (this.state.offline === offline) return;
    this.patch({ offline });
  }

  async initialize(): Promise<ReleaseUpdateState> {
    if (!this.api) {
      this.initialized = true;
      return this.state;
    }
    const token = ++this.operation;
    this.patch({ phase: 'loading', error: undefined, lastOperation: 'status' });
    try {
      const status = await this.api.status();
      if (token !== this.operation) return this.state;
      this.applyStatus(status);
      this.initialized = true;
    } catch (reason) {
      if (token !== this.operation) return this.state;
      this.initialized = true;
      this.fail('status', reason, 'Cupcake Chat could not read the update service status.');
    }
    return this.state;
  }

  async check(): Promise<ReleaseUpdateState> {
    if (!this.api || this.state.offline || this.state.configured !== true) return this.state;
    const token = ++this.operation;
    this.patch({ phase: 'checking', error: undefined, lastOperation: 'check' });
    try {
      const result = await this.api.check();
      if (token !== this.operation) return this.state;
      this.applyCheckResult(result);
    } catch (reason) {
      if (token !== this.operation) return this.state;
      this.fail('check', reason, 'Cupcake Chat could not check for updates.');
    }
    return this.state;
  }

  async download(): Promise<ReleaseUpdateState> {
    if (
      !this.api ||
      this.state.offline ||
      this.state.configured !== true ||
      !this.state.availableVersion
    ) {
      return this.state;
    }
    const token = ++this.operation;
    this.patch({
      phase: 'downloading',
      downloadedBytes: 0,
      totalBytes: undefined,
      error: undefined,
      lastOperation: 'download',
    });
    try {
      const update = await this.api.download();
      if (token !== this.operation) return this.state;
      this.patch({
        phase: 'ready',
        update,
        availableVersion: update.version,
        downloadedBytes: undefined,
        totalBytes: undefined,
      });
    } catch (reason) {
      if (token !== this.operation) return this.state;
      this.fail('download', reason, 'The update could not be downloaded and verified.');
    }
    return this.state;
  }

  async install(): Promise<ReleaseUpdateState> {
    const retryingInstall = this.state.phase === 'error' && this.state.lastOperation === 'install';
    if (!this.api || this.state.offline || (this.state.phase !== 'ready' && !retryingInstall)) {
      return this.state;
    }
    const token = ++this.operation;
    this.patch({ phase: 'installing', error: undefined, lastOperation: 'install' });
    try {
      await this.api.install();
      if (token !== this.operation) return this.state;
      // On Windows the verified NSIS updater exits the app and restarts it. Keep
      // this state if the host remains visible for the brief handoff interval.
      this.patch({ phase: 'installing' });
    } catch (reason) {
      if (token !== this.operation) return this.state;
      this.fail('install', reason, 'The verified update could not be installed.');
    }
    return this.state;
  }

  private applyStatus(status: AppUpdateStatus): void {
    const base = {
      currentVersion: status.currentVersion,
      availableVersion: status.availableVersion,
      configured: status.configured,
      error: undefined,
      downloadedBytes: undefined,
      totalBytes: undefined,
      lastOperation: undefined,
    };
    if (!status.configured) {
      this.patch({ ...base, phase: 'unavailable', update: undefined });
    } else if (status.busy) {
      this.patch({ ...base, phase: 'checking' });
    } else if (status.downloaded && status.availableVersion) {
      this.patch({ ...base, phase: 'ready' });
    } else if (status.availableVersion) {
      this.patch({ ...base, phase: 'available' });
    } else {
      this.patch({ ...base, phase: 'idle', update: undefined });
    }
  }

  private applyCheckResult(result: AppUpdateCheckResult): void {
    if (!result.available) {
      this.patch({
        phase: 'upToDate',
        update: undefined,
        availableVersion: undefined,
        error: undefined,
        lastOperation: undefined,
      });
      return;
    }
    if (!result.update) {
      this.fail(
        'check',
        new Error('The update feed returned no release details.'),
        'The update feed returned no release details.',
      );
      return;
    }
    this.patch({
      phase: result.update.downloaded ? 'ready' : 'available',
      currentVersion: result.update.currentVersion,
      update: result.update,
      availableVersion: result.update.version,
      error: undefined,
      lastOperation: undefined,
    });
  }

  private applyProgress(progress: AppUpdateProgress): void {
    const version = progress.version ?? this.state.availableVersion;
    switch (progress.stage) {
      case 'checking':
        this.patch({ phase: 'checking', error: undefined });
        break;
      case 'available':
        this.patch({ phase: 'available', availableVersion: version, error: undefined });
        break;
      case 'upToDate':
        this.patch({ phase: 'upToDate', availableVersion: undefined, update: undefined });
        break;
      case 'downloadStarted':
      case 'downloadProgress':
        this.patch({
          phase: 'downloading',
          availableVersion: version,
          downloadedBytes: progress.downloadedBytes ?? this.state.downloadedBytes ?? 0,
          totalBytes: progress.totalBytes ?? this.state.totalBytes,
          error: undefined,
        });
        break;
      case 'downloadVerified':
        this.patch({
          phase: 'ready',
          availableVersion: version,
          downloadedBytes: undefined,
          totalBytes: undefined,
          error: undefined,
        });
        break;
      case 'installing':
        this.patch({ phase: 'installing', availableVersion: version, error: undefined });
        break;
      case 'failed':
        this.patch({
          phase: 'error',
          error: this.state.error ?? 'The update action did not finish.',
        });
        break;
    }
  }

  private fail(
    operation: NonNullable<ReleaseUpdateState['lastOperation']>,
    reason: unknown,
    fallback: string,
  ): void {
    this.patch({ phase: 'error', error: errorMessage(reason, fallback), lastOperation: operation });
  }

  private patch(patch: Partial<ReleaseUpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

export function ReleaseUpdates({
  offline,
  currentVersion,
  compact = false,
  updateApi,
}: {
  offline: boolean;
  currentVersion?: string;
  compact?: boolean;
  updateApi?: ReleaseUpdateApi;
}) {
  const hostApi =
    updateApi ?? (typeof window === 'undefined' ? undefined : window.cupcake?.app.updates);
  const controller = useMemo(
    () => new ReleaseUpdateController(hostApi, { offline, currentVersion }),
    [hostApi, currentVersion],
  );
  const [state, setState] = useState(controller.snapshot);

  useEffect(() => {
    const releaseState = controller.subscribe(setState);
    const releaseProgress = controller.listenToProgress();
    let active = true;
    void controller.initialize().then((next) => {
      if (
        active &&
        !next.offline &&
        controller.readyForAutomaticCheck &&
        claimAutomaticReleaseCheckForSession()
      ) {
        void controller.check();
      }
    });
    return () => {
      active = false;
      releaseProgress();
      releaseState();
    };
  }, [controller]);

  useEffect(() => {
    controller.setOffline(offline);
    if (!offline && controller.readyForAutomaticCheck && claimAutomaticReleaseCheckForSession()) {
      void controller.check();
    }
  }, [controller, offline]);

  const progress = downloadProgress(state);
  const action = updateAction(state, controller);
  const presentation = updatePresentation(state);

  return (
    <section
      className={`release-updates${compact ? ' release-updates--compact' : ''}`}
      aria-label="Cupcake Chat updates"
    >
      <div className="release-updates__heading">
        <span className="release-updates__mark" aria-hidden="true">
          <Icon name="download" size={18} />
        </span>
        <span>
          <strong>App updates</strong>
          <small>Version {state.currentVersion}</small>
        </span>
        <span className={`release-updates__state is-${presentation.tone}`}>
          {presentation.label}
        </span>
      </div>

      <div className="release-updates__body" aria-live="polite" aria-atomic="true">
        <strong>{presentation.title}</strong>
        <p>{presentation.detail}</p>
        {state.update?.notes && state.phase === 'available' && !compact && (
          <p className="release-updates__notes">{state.update.notes}</p>
        )}
        {state.phase === 'downloading' && (
          <div className="release-updates__progress">
            <progress
              max={state.totalBytes ?? 1}
              value={state.totalBytes ? (state.downloadedBytes ?? 0) : undefined}
              aria-label={`Downloading Cupcake Chat ${state.availableVersion ?? 'update'}`}
            />
            <small>{progress}</small>
          </div>
        )}
      </div>

      {action && (
        <button
          type="button"
          className={`button${action.primary ? ' button--primary' : ''} release-updates__action`}
          disabled={action.disabled}
          onClick={() => void action.run()}
        >
          <Icon name={action.icon} size={15} />
          {action.label}
        </button>
      )}
    </section>
  );
}

function updatePresentation(state: ReleaseUpdateState): {
  label: string;
  title: string;
  detail: string;
  tone: 'quiet' | 'working' | 'good' | 'available' | 'error';
} {
  if (state.offline && !['downloading', 'installing'].includes(state.phase)) {
    return {
      label: 'Offline',
      title: 'Update checks are paused',
      detail: 'Turn off offline mode when you want to check for a new release.',
      tone: 'quiet',
    };
  }
  switch (state.phase) {
    case 'loading':
      return {
        label: 'Starting',
        title: 'Reading update status…',
        detail: 'This stays in the background.',
        tone: 'working',
      };
    case 'unavailable':
      return {
        label: 'Unavailable',
        title:
          state.configured === false ? 'Signed updates are not configured' : 'Updates unavailable',
        detail:
          state.configured === false
            ? 'This build cannot verify release downloads. Install a signed release build to enable updates.'
            : 'Open the packaged Windows app to check for releases.',
        tone: 'quiet',
      };
    case 'idle':
      return {
        label: 'Ready',
        title: 'Check for a new release',
        detail: 'Cupcake Chat can check the signed release feed when you ask.',
        tone: 'quiet',
      };
    case 'checking':
      return {
        label: 'Checking',
        title: 'Looking for a new release…',
        detail: 'You can keep using Cupcake Chat.',
        tone: 'working',
      };
    case 'upToDate':
      return {
        label: 'Current',
        title: 'You have the latest release',
        detail: `Cupcake Chat ${state.currentVersion} is up to date.`,
        tone: 'good',
      };
    case 'available':
      return {
        label: 'Available',
        title: `Cupcake Chat ${state.availableVersion ?? 'update'} is ready to download`,
        detail: 'Download it now, or keep working and come back later.',
        tone: 'available',
      };
    case 'downloading':
      return {
        label: 'Downloading',
        title: `Downloading ${state.availableVersion ?? 'the update'}…`,
        detail: 'The download is verified before it can be installed.',
        tone: 'working',
      };
    case 'ready':
      return {
        label: 'Restart ready',
        title: `Cupcake Chat ${state.availableVersion ?? 'update'} is ready`,
        detail: 'Restart and install closes Cupcake Chat briefly, then reopens it.',
        tone: 'available',
      };
    case 'installing':
      return {
        label: 'Installing',
        title: 'Handing off to the installer…',
        detail: 'Cupcake Chat will close briefly and reopen after the update.',
        tone: 'working',
      };
    case 'error':
      return {
        label: 'Needs attention',
        title: 'The update action did not finish',
        detail: state.error ?? 'Try again when you are ready.',
        tone: 'error',
      };
  }
}

function updateAction(
  state: ReleaseUpdateState,
  controller: ReleaseUpdateController,
): {
  label: string;
  icon: 'retry' | 'download';
  primary: boolean;
  disabled: boolean;
  run: () => Promise<ReleaseUpdateState>;
} | null {
  if (state.offline || ['loading', 'checking', 'downloading', 'installing'].includes(state.phase)) {
    return null;
  }
  if (state.phase === 'available') {
    return {
      label: 'Download update',
      icon: 'download',
      primary: true,
      disabled: false,
      run: () => controller.download(),
    };
  }
  if (state.phase === 'ready') {
    return {
      label: 'Restart and install',
      icon: 'download',
      primary: true,
      disabled: false,
      run: () => controller.install(),
    };
  }
  if (state.phase === 'error' && state.lastOperation === 'download') {
    return {
      label: 'Try download again',
      icon: 'retry',
      primary: false,
      disabled: false,
      run: () => controller.download(),
    };
  }
  if (state.phase === 'error' && state.lastOperation === 'install') {
    return {
      label: 'Try install again',
      icon: 'retry',
      primary: false,
      disabled: false,
      run: () => controller.install(),
    };
  }
  if (state.configured === true) {
    return {
      label: state.phase === 'error' ? 'Check again' : 'Check now',
      icon: 'retry',
      primary: false,
      disabled: false,
      run: () => controller.check(),
    };
  }
  return null;
}

function downloadProgress(state: ReleaseUpdateState): string {
  const downloaded = state.downloadedBytes ?? 0;
  if (!state.totalBytes)
    return downloaded > 0 ? `${formatBytes(downloaded)} downloaded` : 'Starting…';
  const percent = Math.min(100, Math.round((downloaded / state.totalBytes) * 100));
  return `${percent}% · ${formatBytes(downloaded)} of ${formatBytes(state.totalBytes)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function claimAutomaticReleaseCheckForSession(): boolean {
  if (automaticCheckClaimed) return false;
  automaticCheckClaimed = true;
  return true;
}

export function resetAutomaticReleaseCheckForTests(): void {
  automaticCheckClaimed = false;
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (
    reason &&
    typeof reason === 'object' &&
    'message' in reason &&
    typeof reason.message === 'string' &&
    reason.message.trim()
  ) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) return reason;
  return fallback;
}
