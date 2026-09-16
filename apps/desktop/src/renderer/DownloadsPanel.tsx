import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';
import { useWorkspace, type DownloadRecord } from './workspace';

type DownloadAction = 'pause' | 'resume' | 'cancel' | 'reset';
type DownloadGroup = 'active' | 'paused' | 'failed';

const failedStates = new Set(['error', 'failed', 'checksum-failed']);
const pausedStates = new Set(['paused']);
const exclusiveTransferStates = new Set([
  'queued',
  'resolving',
  'downloading',
  'verifying',
  'extracting',
  'installing',
]);
const finishingStates = new Set(['extracting', 'installing']);
const finishedStates = new Set([
  'complete',
  'completed',
  'installed',
  'ready',
  'cancelled',
  'canceled',
  'removed',
]);

function normalizedState(state: string): string {
  return state.trim().toLowerCase().replaceAll('_', '-');
}

function groupFor(download: DownloadRecord): DownloadGroup {
  const state = normalizedState(download.state);
  if (failedStates.has(state)) return 'failed';
  if (pausedStates.has(state)) return 'paused';
  return 'active';
}

function visibleDownload(download: DownloadRecord): boolean {
  return !finishedStates.has(normalizedState(download.state));
}

function stateLabel(download: DownloadRecord): string {
  const state = normalizedState(download.state);
  const labels: Record<string, string> = {
    queued: 'Queued',
    resolving: 'Getting things ready',
    preparing: 'Preparing',
    downloading: 'Downloading',
    verifying: 'Verifying',
    extracting: 'Unpacking',
    installing: 'Installing',
    paused: 'Paused',
    failed: 'Needs attention',
    error: 'Needs attention',
    'checksum-failed': 'Verification failed',
  };
  return (
    labels[state] ?? state.replaceAll('-', ' ').replace(/^./u, (letter) => letter.toUpperCase())
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  const digits = power === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[power]}`;
}

function progressFor(download: DownloadRecord): number | null {
  if (!Number.isFinite(download.totalBytes) || download.totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, (download.bytesReceived / download.totalBytes) * 100));
}

function pendingLabel(action: DownloadAction): string {
  return {
    pause: 'Pausing…',
    resume: 'Resuming…',
    cancel: 'Cancelling…',
    reset: 'Retrying…',
  }[action];
}

function actionErrorLabel(action: DownloadAction): string {
  return {
    pause: 'Could not pause this download.',
    resume: 'Could not resume this download.',
    cancel: 'Could not cancel this download.',
    reset: 'Could not retry this download.',
  }[action];
}

function TransferActions({
  download,
  pending,
  startBlocked,
  onAction,
}: {
  download: DownloadRecord;
  pending?: DownloadAction;
  startBlocked: boolean;
  onAction: (action: DownloadAction, id: string) => void;
}) {
  const group = groupFor(download);
  const state = normalizedState(download.state);
  const pauseBlocked = state === 'verifying';
  if (pending) {
    return (
      <div className="downloads-transfer__actions" aria-live="polite">
        <button type="button" className="button" disabled>
          <span className="downloads-action-spinner" aria-hidden="true" />
          {pendingLabel(pending)}
        </button>
      </div>
    );
  }
  if (finishingStates.has(state)) {
    return (
      <div className="downloads-transfer__actions" aria-live="polite">
        <button type="button" className="button" disabled>
          <span className="downloads-action-spinner" aria-hidden="true" />
          Finishing installation…
        </button>
      </div>
    );
  }
  return (
    <div className="downloads-transfer__actions">
      {group === 'active' && (
        <button
          type="button"
          className="button"
          disabled={pauseBlocked}
          title={pauseBlocked ? 'Verification can be cancelled, but not paused.' : undefined}
          onClick={() => onAction('pause', download.id)}
        >
          <Icon name="pause" size={14} /> Pause
        </button>
      )}
      {group === 'paused' && (
        <button
          type="button"
          className="button button--primary"
          disabled={startBlocked}
          title={startBlocked ? 'Pause the active download before starting another.' : undefined}
          onClick={() => onAction('resume', download.id)}
        >
          <Icon name="play" size={14} /> Resume
        </button>
      )}
      {group === 'failed' && (
        <button
          type="button"
          className="button button--primary"
          disabled={startBlocked}
          title={startBlocked ? 'Pause the active download before retrying this one.' : undefined}
          onClick={() => onAction('reset', download.id)}
        >
          <Icon name="retry" size={14} /> Retry
        </button>
      )}
      <button
        type="button"
        className="button downloads-cancel"
        onClick={() => onAction('cancel', download.id)}
      >
        <Icon name="x" size={13} /> {group === 'failed' ? 'Remove' : 'Cancel'}
      </button>
    </div>
  );
}

function TransferCard({
  download,
  pending,
  actionError,
  startBlocked,
  onAction,
}: {
  download: DownloadRecord;
  pending?: DownloadAction;
  actionError?: string;
  startBlocked: boolean;
  onAction: (action: DownloadAction, id: string) => void;
}) {
  const group = groupFor(download);
  const progress = progressFor(download);
  const received = Math.max(0, download.bytesReceived || 0);
  const total = Math.max(0, download.totalBytes || 0);
  const progressText =
    total > 0
      ? `${formatBytes(received)} of ${formatBytes(total)}${progress === null ? '' : ` · ${Math.round(progress)}%`}`
      : received > 0
        ? `${formatBytes(received)} downloaded`
        : group === 'active'
          ? 'Waiting for transfer details'
          : 'No transfer size reported';

  return (
    <article
      className={`downloads-transfer downloads-transfer--${group}`}
      aria-busy={Boolean(pending)}
    >
      <header className="downloads-transfer__header">
        <span className="downloads-transfer__icon" aria-hidden="true">
          <Icon name={download.kind === 'runtime' ? 'local' : 'model'} size={18} />
        </span>
        <div>
          <span>{download.kind === 'runtime' ? 'Runtime' : 'Model'}</span>
          <h4>{download.name}</h4>
        </div>
        <span className={`downloads-state downloads-state--${group}`}>{stateLabel(download)}</span>
      </header>

      <div className="downloads-transfer__progress">
        <progress
          aria-label={`${download.name}: ${stateLabel(download)}`}
          max={100}
          value={progress ?? undefined}
        />
        <div>
          <span>{progressText}</span>
          {group === 'active' && progress !== null && <strong>{Math.round(progress)}%</strong>}
        </div>
      </div>

      {(download.error || actionError) && (
        <p className="downloads-transfer__error" role={actionError ? 'alert' : undefined}>
          {actionError ?? download.error}
        </p>
      )}
      <TransferActions
        download={download}
        pending={pending}
        startBlocked={startBlocked}
        onAction={onAction}
      />
    </article>
  );
}

export function DownloadsPanel({
  onClose,
  onBrowseModels,
}: {
  onClose: () => void;
  onBrowseModels: () => void;
}) {
  const workspace = useWorkspace();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const pendingIds = useRef(new Set<string>());
  const [pending, setPending] = useState<Record<string, DownloadAction>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  closeRef.current = onClose;

  const downloads = useMemo(
    () => workspace.downloads.filter(visibleDownload),
    [workspace.downloads],
  );
  const groups = useMemo(
    () => ({
      active: downloads.filter((download) => groupFor(download) === 'active'),
      paused: downloads.filter((download) => groupFor(download) === 'paused'),
      failed: downloads.filter((download) => groupFor(download) === 'failed'),
    }),
    [downloads],
  );
  const activeTransferId = downloads.find((download) =>
    exclusiveTransferStates.has(normalizedState(download.state)),
  )?.id;

  const runAction = useCallback(
    async (action: DownloadAction, id: string) => {
      if (pendingIds.current.has(id)) return;
      pendingIds.current.add(id);
      setPending((current) => ({ ...current, [id]: action }));
      setActionErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      try {
        await workspace.runDownloadAction(action, id);
      } catch {
        setActionErrors((current) => ({ ...current, [id]: actionErrorLabel(action) }));
      } finally {
        pendingIds.current.delete(id);
        setPending((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    },
    [workspace],
  );

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inertRegions = Array.from(
      document.querySelectorAll<HTMLElement>('.app-titlebar, .shelf, .app-content'),
    ).map((node) => ({ node, inert: node.inert }));
    inertRegions.forEach(({ node }) => {
      node.inert = true;
    });
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('[autofocus], button:not(:disabled)')?.focus();
    }, 0);
    const keydown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => item.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', keydown, true);
      inertRegions.forEach(({ node, inert }) => {
        node.inert = inert;
      });
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  const browseModels = () => {
    onClose();
    onBrowseModels();
  };

  return createPortal(
    <div
      className="downloads-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={panelRef}
        className="downloads-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="downloads-panel__header">
          <div className="downloads-panel__heading">
            <span className="downloads-panel__mark" aria-hidden="true">
              <Icon name="download" size={19} />
            </span>
            <div>
              <span className="eyebrow">Transfers</span>
              <h2 id={titleId}>Downloads</h2>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close downloads"
            onClick={onClose}
            autoFocus
          >
            <Icon name="x" size={17} />
          </button>
        </header>

        <div className="downloads-panel__summary">
          <strong>{downloads.length}</strong>
          <p id={descriptionId}>
            {downloads.length === 1
              ? 'One transfer is still in your queue.'
              : `${downloads.length} transfers are active or need attention.`}
          </p>
        </div>

        <div className="downloads-panel__body">
          {downloads.length === 0 ? (
            <section className="downloads-empty">
              <span aria-hidden="true">
                <Icon name="download" size={26} />
              </span>
              <h3>Nothing downloading</h3>
              <p>
                Models and runtimes you install will appear here with live progress and controls.
              </p>
              <button type="button" className="button button--primary" onClick={browseModels}>
                <Icon name="model" size={15} /> Browse models
              </button>
            </section>
          ) : (
            (['active', 'paused', 'failed'] as const).map((group) => {
              const records = groups[group];
              if (!records.length) return null;
              return (
                <section
                  className="downloads-group"
                  key={group}
                  aria-labelledby={`downloads-${group}`}
                >
                  <div className="downloads-group__heading">
                    <h3 id={`downloads-${group}`}>
                      {group === 'active'
                        ? 'In progress'
                        : group === 'paused'
                          ? 'Paused'
                          : 'Needs attention'}
                    </h3>
                    <span>{records.length}</span>
                  </div>
                  <div className="downloads-group__list">
                    {records.map((download) => (
                      <TransferCard
                        key={download.id}
                        download={download}
                        pending={pending[download.id]}
                        actionError={actionErrors[download.id]}
                        startBlocked={Boolean(activeTransferId && activeTransferId !== download.id)}
                        onAction={(action, id) => void runAction(action, id)}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>

        {downloads.length > 0 && (
          <footer className="downloads-panel__footer">
            <button type="button" className="button" onClick={browseModels}>
              Browse models
            </button>
          </footer>
        )}
      </aside>
    </div>,
    // Wallpaper palettes are scoped to the shell, not document.body. A direct
    // shell child keeps viewport positioning and inherits every live theme token.
    document.querySelector('.app-shell') ?? document.body,
  );
}
