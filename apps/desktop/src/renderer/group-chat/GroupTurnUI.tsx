import {
  AlertCircle,
  Check,
  Cloud,
  HardDrive,
  LoaderCircle,
  Pause,
  Sparkles,
  X,
} from 'lucide-react';
import { useRef } from 'react';
import type {
  GroupIneligibleSpeaker,
  GroupEligibleSpeaker,
  GroupModelRoute,
  GroupTurnPreflight,
  GroupTurnSpeakerState,
  GroupTurnState,
} from '../types';
import type { ReferenceRecord, StagedAttachmentRecord } from '../workspace';
import { PersonaPortrait } from './PersonaPortrait';
import { useDialogFocus } from './useDialogFocus';

const ACTIVE_TURN_STATES = new Set<GroupTurnState['status']>([
  'preparing',
  'choosing',
  'responding',
]);

export function GroupTurnRail({
  turn,
  stopping = false,
  onStop,
  onRepair,
}: {
  turn: GroupTurnState | null;
  stopping?: boolean;
  onStop: () => void | Promise<void>;
  onRepair: (speaker: GroupTurnSpeakerState) => void;
}) {
  if (!turn) return null;
  const active = ACTIVE_TURN_STATES.has(turn.status);
  const choosing = turn.status === 'preparing' || turn.status === 'choosing';
  const completed = turn.speakers.filter((item) => item.status === 'completed');
  const statusText =
    turn.status === 'interrupted'
      ? 'Group turn interrupted by restart'
      : turn.status === 'selection_failed'
        ? 'Smart selection could not finish'
        : turn.status === 'waiting_for_you'
          ? 'Waiting for your next message'
          : turn.status === 'cancelled'
            ? 'Group turn stopped'
            : turn.status === 'awaiting_tool'
              ? 'Group paused for a tool request'
              : turn.status === 'member_failed'
                ? 'A Cupcake could not reply'
                : choosing
                  ? turn.callIndex > 1
                    ? 'Choosing a distinct follow-up…'
                    : 'Choosing who should answer…'
                  : turn.status === 'completed'
                    ? completed.length
                      ? `${completed.map((item) => item.speaker.name).join(' and ')} replied`
                      : 'No additional voice was needed'
                    : 'Group turn in progress';
  return (
    <section
      className={`group-turn-rail is-${turn.status}`}
      aria-label="Group turn status"
      aria-live="polite"
      data-testid="group-turn-rail"
    >
      <div className="group-turn-rail__status">
        <span className="group-turn-rail__icon">
          {active ? (
            <LoaderCircle size={16} />
          ) : turn.status === 'completed' || turn.status === 'waiting_for_you' ? (
            <Check size={15} />
          ) : (
            <AlertCircle size={15} />
          )}
        </span>
        <span>
          <strong>{statusText}</strong>
          <small>
            {turn.mode === 'smart'
              ? `Smart selection · routing ${Math.min(turn.callIndex, turn.maxSelectorCalls)} of ${turn.maxSelectorCalls}`
              : `Direct mentions · up to ${turn.maxReplies} replies`}
          </small>
          {turn.status === 'waiting_for_you' && turn.selectionSummary && (
            <em className="group-turn-rail__reason">{turn.selectionSummary}</em>
          )}
        </span>
      </div>
      {turn.speakers.length > 0 && (
        <div className="group-turn-rail__speakers" aria-label="Selected speakers">
          {turn.speakers.map((item) => (
            <span
              className={`turn-speaker-chip is-${item.status}`}
              key={`${item.sequence}:${item.speaker.participantId}`}
            >
              <PersonaPortrait value={item.speaker.avatar} name={item.speaker.name} />
              <span>
                <strong>{item.speaker.name}</strong>
                <small>{speakerStateLabel(item)}</small>
              </span>
              {item.status === 'failed' && (
                <button type="button" onClick={() => onRepair(item)}>
                  Repair
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {active && (
        <button
          type="button"
          className="stop-group-turn"
          onClick={() => void onStop()}
          disabled={stopping}
          data-testid="group-stop"
        >
          <Pause size={13} /> {stopping ? 'Stopping…' : 'Stop group turn'}
        </button>
      )}
      {!active && turn.error && <p>{turn.error}</p>}
    </section>
  );
}

function speakerStateLabel(item: GroupTurnSpeakerState) {
  if (item.status === 'selected') return 'Up next';
  if (item.status === 'speaking') return 'Speaking';
  if (item.status === 'completed') return 'Replied';
  if (item.status === 'failed') return item.error || 'Could not reply';
  return 'Stopped';
}

export function GroupTurnDisclosureDialog({
  preflight,
  attachments,
  references,
  pending,
  error,
  onCancel,
  onConfirm,
  onRepair,
}: {
  preflight: GroupTurnPreflight | null;
  attachments: StagedAttachmentRecord[];
  references: ReferenceRecord[];
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  onRepair: (speaker: GroupIneligibleSpeaker) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(Boolean(preflight), dialogRef, onCancel, pending);
  if (!preflight) return null;
  const smart = preflight.mode === 'smart';
  const cloudCandidates = preflight.disclosure.candidateRoutes.filter(
    (route) => route.model.privacyRoute.toLowerCase() !== 'local',
  );
  const localCandidates = preflight.disclosure.candidateRoutes.filter(
    (route) => route.model.privacyRoute.toLowerCase() === 'local',
  );
  const selectorCloud =
    preflight.disclosure.selector &&
    preflight.disclosure.selector.model.privacyRoute.toLowerCase() !== 'local';
  const needsConfirmation = preflight.confirmationRequired;
  const blockedMention = !smart && preflight.ineligibleSpeakers.length > 0;
  return (
    <div className="group-dialog-layer">
      <section
        ref={dialogRef}
        className="group-dialog group-disclosure-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-disclosure-title"
        tabIndex={-1}
        data-testid="group-disclosure"
      >
        <header className="group-dialog__header">
          <div>
            <span className="eyebrow">Bounded group turn</span>
            <h2 id="group-disclosure-title">
              {needsConfirmation ? 'Confirm possible destinations' : 'Ready for this group turn'}
            </h2>
            <p>
              {smart
                ? 'Smart decides one speaker at a time, then stops when another view would be redundant.'
                : 'Only the Cupcakes you mentioned will receive this turn.'}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onCancel}
            aria-label="Cancel group turn"
            disabled={pending}
          >
            <X size={18} />
          </button>
        </header>
        <div className="group-disclosure-dialog__body">
          {smart && preflight.selector && (
            <section className="disclosure-selector-card">
              <span className="disclosure-route-icon">
                {preflight.selector.model.privacyRoute === 'local' ? (
                  <HardDrive size={18} />
                ) : (
                  <Sparkles size={18} />
                )}
              </span>
              <div>
                <span className="eyebrow">Smart lead</span>
                <strong>{routeName(preflight.selector)}</strong>
                <p>
                  Receives the latest text, a bounded transcript, and participant role cards. It
                  never receives file bytes, retrieved passages, or tool results.
                </p>
              </div>
              <small>
                Up to {preflight.maxSelectorCalls} short{' '}
                {preflight.maxSelectorCalls === 1 ? 'decision' : 'decisions'} ·{' '}
                {preflight.selectorMaxOutputTokens} tokens each
              </small>
            </section>
          )}
          <section className="disclosure-candidates">
            <header>
              <div>
                <strong>{smart ? 'Possible speakers' : 'Mentioned speakers'}</strong>
                <small>
                  {smart
                    ? `At most ${preflight.maxReplies} will reply`
                    : 'Sequential, in mention order'}
                </small>
              </div>
            </header>
            <div>
              {preflight.eligibleSpeakers.map((candidate) => (
                <article key={candidate.participantId}>
                  <PersonaPortrait value={candidate.persona.avatar} name={candidate.persona.name} />
                  <span>
                    <strong>{candidate.persona.name}</strong>
                    <small>{candidate.persona.role}</small>
                  </span>
                  <RoutePill route={candidate.model} />
                </article>
              ))}
            </div>
          </section>
          {preflight.ineligibleSpeakers.length > 0 && (
            <section className="disclosure-ineligible">
              <header>
                <strong>Needs attention</strong>
                <small>These Cupcakes will not run.</small>
              </header>
              {preflight.ineligibleSpeakers.map((speaker) => (
                <div key={speaker.participantId}>
                  <AlertCircle size={15} />
                  <span>
                    <strong>{speaker.persona.name}</strong>
                    <small>{speaker.message}</small>
                  </span>
                  {speaker.repairAction && (
                    <button type="button" onClick={() => onRepair(speaker)}>
                      Repair
                    </button>
                  )}
                </div>
              ))}
              {blockedMention && (
                <p role="alert">
                  Repair or remove every unavailable mention before this turn can start.
                </p>
              )}
            </section>
          )}
          {(attachments.length > 0 || references.length > 0) && (
            <section className="group-disclosure-context">
              <strong>Responder context</strong>
              <p>
                {attachments.length
                  ? `${attachments.length} attached ${attachments.length === 1 ? 'file' : 'files'}`
                  : 'No files'}{' '}
                ·{' '}
                {references.length
                  ? `${references.length} selected ${references.length === 1 ? 'reference' : 'references'}`
                  : 'No selected references'}
              </p>
              {smart && (
                <small>
                  The selector sees their labels only. File bytes and resolved content go only to an
                  actual, compatible responder after confirmation.
                </small>
              )}
            </section>
          )}
          {needsConfirmation && (
            <div className="group-cloud-summary">
              <Cloud size={18} />
              <div>
                <strong>This turn can send context through disclosed cloud routes.</strong>
                <p>
                  {smart
                    ? 'Confirmation covers the disclosed selector and every possible speaker because the final choice is not known yet.'
                    : 'Confirmation covers only the named Cupcakes.'}
                </p>
                <small>
                  {localCandidates.length
                    ? `${localCandidates.length} local route${localCandidates.length === 1 ? '' : 's'} stay on this computer. `
                    : ''}
                  {selectorCloud ? 'The Smart lead uses a cloud route. ' : ''}
                  {cloudCandidates.length} possible cloud{' '}
                  {cloudCandidates.length === 1 ? 'responder' : 'responders'} disclosed. Routes that
                  are not selected make no responder call.
                </small>
              </div>
            </div>
          )}
        </div>
        {error && (
          <p className="group-dialog__error" role="alert">
            {error}
          </p>
        )}
        <footer className="group-dialog__footer">
          <button type="button" className="button" onClick={onCancel} disabled={pending}>
            Keep editing
          </button>
          <span />
          <button
            type="button"
            className="button button--primary"
            onClick={() => void onConfirm()}
            disabled={
              pending ||
              !preflight.sendable ||
              preflight.eligibleSpeakers.length === 0 ||
              blockedMention
            }
            data-testid="group-confirm"
          >
            {pending ? 'Starting…' : needsConfirmation ? 'Confirm group turn' : 'Start group turn'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function RoutePill({ route }: { route: GroupModelRoute }) {
  const local = route.privacyRoute.toLowerCase() === 'local';
  return (
    <span className={`group-route-pill ${local ? 'is-local' : 'is-cloud'}`}>
      {local ? <HardDrive size={12} /> : <Cloud size={12} />}
      <span>
        <strong>{route.id}</strong>
        <small>{route.provider}</small>
      </span>
    </span>
  );
}

function routeName(route: GroupEligibleSpeaker) {
  return `${route.model.id} · ${route.model.provider}`;
}
