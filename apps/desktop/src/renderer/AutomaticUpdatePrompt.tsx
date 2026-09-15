import { useEffect, useMemo, useRef, useState } from 'react';
import { ReleaseUpdateController, type ReleaseUpdateApi } from './ReleaseUpdates';
import { checkForReleaseOnce } from './useAutomaticReleaseCheck';

export function AutomaticUpdatePrompt({
  offline,
  ready,
  busy,
  updateApi,
}: {
  offline: boolean;
  ready: boolean;
  busy: boolean;
  updateApi?: ReleaseUpdateApi;
}) {
  const api = updateApi ?? window.cupcake?.app.updates;
  const controller = useMemo(() => new ReleaseUpdateController(api, { offline }), [api]);
  const [state, setState] = useState(controller.snapshot);
  const [dismissed, setDismissed] = useState<string>();
  const [accepted, setAccepted] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const working = ['downloading', 'installing'].includes(state.phase);
  const visible = Boolean(
    state.availableVersion && state.availableVersion !== dismissed && (!busy || accepted),
  );

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    const unlisten = controller.listenToProgress();
    return () => {
      unsubscribe();
      unlisten();
    };
  }, [controller]);

  useEffect(() => {
    controller.setOffline(offline);
    if (!ready || offline || !api) return;
    let active = true;
    const refresh = async (first: boolean) => {
      if (
        !active ||
        ['downloading', 'installing', 'ready', 'available'].includes(controller.snapshot.phase)
      )
        return;
      await controller.initialize();
      if (!active) return;
      if (first) await checkForReleaseOnce(api);
      else if (controller.snapshot.configured && !controller.snapshot.availableVersion)
        await controller.check();
      if (active) await controller.initialize();
    };
    void refresh(true);
    const timer = window.setInterval(() => void refresh(false), 6 * 60 * 60 * 1000);
    const reconnect = () => void refresh(false);
    window.addEventListener('online', reconnect);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', reconnect);
    };
  }, [api, controller, offline, ready]);

  useEffect(() => {
    if (visible && !dialog.current?.open) dialog.current?.showModal();
    if (!visible && dialog.current?.open) dialog.current.close();
  }, [visible]);

  const later = () => {
    if (!working) {
      setDismissed(state.availableVersion);
      setAccepted(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="automatic-update-dialog"
      aria-labelledby="automatic-update-title"
      onCancel={(event) => {
        event.preventDefault();
        later();
      }}
    >
      <h2 id="automatic-update-title">
        {working ? 'Updating Cupcake Chat…' : 'A new Cupcake Chat is here'}
      </h2>
      <p>
        {state.phase === 'installing'
          ? 'Installing now. Cupcake Chat will reopen automatically.'
          : state.phase === 'downloading'
            ? 'Downloading your update…'
            : `Version ${state.availableVersion ?? ''} is available. Update now?`}
      </p>
      {!working && <p>Your chats and projects will stay right here.</p>}
      {state.phase === 'downloading' && (
        <progress
          aria-label="Downloading update"
          max={state.totalBytes ?? 1}
          value={state.totalBytes ? (state.downloadedBytes ?? 0) : undefined}
        />
      )}
      {state.error && <p role="alert">{state.error}</p>}
      <footer>
        <button className="button" disabled={working} onClick={later}>
          Later
        </button>
        <button
          className="button button--primary"
          disabled={working || offline || busy}
          onClick={() => {
            setAccepted(true);
            void controller.updateNow();
          }}
        >
          {working ? 'Updating…' : state.phase === 'error' ? 'Try again' : 'Yes, update'}
        </button>
      </footer>
    </dialog>
  );
}
