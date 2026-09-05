import {
  Check,
  ChevronDown,
  Cloud,
  HardDrive,
  Plus,
  Search,
  Settings2,
  Sparkles,
  UserRoundPlus,
  UsersRound,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConversationGroupSettings,
  ConversationParticipant,
  CupcakePersona,
  GroupConversationStrategy,
  ModelDescriptor,
} from '../types';
import { PersonaPortrait } from './PersonaPortrait';
import { participantRouteSummary, personaModelId, personaModelReady } from './persona-utils';
import { useDialogFocus } from './useDialogFocus';

export function ParticipantTray({
  participants,
  settings,
  models,
  onAdd,
  onEdit,
  onRemove,
  onEnabledChange,
  onSettingsChange,
}: {
  participants: ConversationParticipant[];
  settings: ConversationGroupSettings | null;
  models: ModelDescriptor[];
  onAdd: () => void;
  onEdit: (persona: CupcakePersona) => void;
  onRemove: (participant: ConversationParticipant) => void | Promise<void>;
  onEnabledChange: (participant: ConversationParticipant, enabled: boolean) => Promise<void>;
  onSettingsChange: (patch: {
    strategy?: GroupConversationStrategy;
    maxReplies?: 1 | 2 | 3;
    leadParticipantId?: string;
  }) => void | Promise<void>;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changingMember, setChangingMember] = useState<string | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const sorted = useMemo(
    () => [...participants].sort((left, right) => left.position - right.position),
    [participants],
  );
  const route = participantRouteSummary(sorted, models);
  const lead = sorted.find((item) => item.id === settings?.leadParticipantId || item.isLead);
  const strategy = settings?.strategy ?? 'smart-selective';
  const maxReplies = settings?.maxReplies ?? 2;
  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    const dismiss = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener('keydown', close, true);
    document.addEventListener('pointerdown', dismiss, true);
    return () => {
      document.removeEventListener('keydown', close, true);
      document.removeEventListener('pointerdown', dismiss, true);
    };
  }, [settingsOpen]);

  return (
    <section
      className="participant-tray"
      aria-label="Cupcakes in this conversation"
      ref={settingsRef}
      data-testid="participant-tray"
      onBlur={(event) => {
        if (settingsOpen && !event.currentTarget.contains(event.relatedTarget))
          setSettingsOpen(false);
      }}
    >
      <div className="participant-tray__scroll">
        {sorted.map((participant) => (
          <button
            type="button"
            className={`participant-chip ${participant.availability.status !== 'ready' ? 'needs-attention' : ''}`}
            key={participant.id}
            onClick={() => onEdit(participant.persona)}
            aria-label={`Edit ${participant.persona.name}, ${participant.persona.role}. ${participant.enabled ? participant.availability.message : 'Paused in this conversation'}`}
          >
            <PersonaPortrait value={participant.persona.avatar} name={participant.persona.name} />
            <span>
              <strong>{participant.persona.name}</strong>
              <small>
                {!participant.enabled
                  ? 'Paused'
                  : participant.availability.status === 'ready'
                    ? participant.persona.role
                    : 'Needs attention'}
              </small>
            </span>
            {participant.isLead && <Sparkles size={12} aria-label="Smart lead" />}
            <i
              className={`participant-state is-${participant.enabled ? participant.availability.status : 'paused'}`}
              aria-hidden="true"
            />
          </button>
        ))}
        <button type="button" className="participant-add" onClick={onAdd} data-testid="add-cupcake">
          <Plus size={15} /> Add Cupcake
        </button>
      </div>
      {sorted.length > 0 && (
        <div className="participant-tray__summary">
          <span className={route.allLocal ? 'is-local' : 'is-mixed'}>
            {route.allLocal ? <HardDrive size={13} /> : <Cloud size={13} />}
            <strong>{route.label}</strong>
            <small>{route.detail}</small>
          </span>
          {sorted.length > 0 && (
            <button
              type="button"
              className="group-settings-trigger"
              onClick={() => setSettingsOpen((value) => !value)}
              aria-expanded={settingsOpen}
              aria-controls="group-response-settings"
              aria-haspopup="dialog"
              data-testid="group-settings"
            >
              <Settings2 size={14} />
              {strategy === 'smart-selective' ? 'Smart selection' : 'Mentions only'}
              <b>Up to {maxReplies}</b>
              <ChevronDown size={13} />
            </button>
          )}
        </div>
      )}
      {settingsOpen && (
        <div
          className="group-settings-popover"
          id="group-response-settings"
          role="dialog"
          aria-label="Group response settings"
        >
          <header>
            <div>
              <strong>Who should answer?</strong>
              <small>Bound every turn before any model runs.</small>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close group response settings"
            >
              <X size={15} />
            </button>
          </header>
          <fieldset>
            <legend>Response strategy</legend>
            <button
              type="button"
              className={strategy === 'smart-selective' ? 'is-selected' : ''}
              onClick={() => void onSettingsChange({ strategy: 'smart-selective' })}
            >
              <span>
                <Sparkles size={16} />
                <strong>Smart selection</strong>
              </span>
              <small>
                The disclosed lead chooses one useful voice, then may choose one distinct follow-up.
              </small>
              {strategy === 'smart-selective' && <Check size={15} />}
            </button>
            <button
              type="button"
              className={strategy === 'mentions-only' ? 'is-selected' : ''}
              onClick={() => void onSettingsChange({ strategy: 'mentions-only' })}
            >
              <span>
                <UsersRound size={16} />
                <strong>Mentions only</strong>
              </span>
              <small>Only Cupcakes you select with @ will receive this turn.</small>
              {strategy === 'mentions-only' && <Check size={15} />}
            </button>
          </fieldset>
          <fieldset>
            <legend>Maximum visible replies</legend>
            <div
              className="reply-limit-control"
              role="radiogroup"
              aria-label="Maximum visible replies"
            >
              {([1, 2, 3] as const).map((limit) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={maxReplies === limit}
                  className={maxReplies === limit ? 'is-selected' : ''}
                  key={limit}
                  onClick={() => void onSettingsChange({ maxReplies: limit })}
                >
                  {limit}
                  <small>{limit === 1 ? 'reply' : 'replies'}</small>
                </button>
              ))}
            </div>
            <p>
              Smart makes at most the same number of short routing decisions. A complete first
              answer can end the turn early.
            </p>
          </fieldset>
          {strategy === 'smart-selective' && (
            <label>
              Smart lead
              <select
                value={lead?.id ?? ''}
                onChange={(event) =>
                  void onSettingsChange({ leadParticipantId: event.target.value })
                }
              >
                <option value="" disabled>
                  Choose a ready lead
                </option>
                {sorted.map((participant) => (
                  <option
                    key={participant.id}
                    value={participant.id}
                    disabled={!participant.enabled || participant.availability.status !== 'ready'}
                  >
                    {participant.persona.name} · {participant.persona.modelId}
                  </option>
                ))}
              </select>
              <small>
                {lead
                  ? `${lead.persona.name}'s exact model makes the disclosed routing decisions.`
                  : 'Smart cannot run until a ready lead is selected.'}
              </small>
            </label>
          )}
          <div className="group-roster-manage">
            <strong>Conversation roster</strong>
            {sorted.map((participant) => (
              <div key={participant.id}>
                <PersonaPortrait
                  value={participant.persona.avatar}
                  name={participant.persona.name}
                />
                <span>
                  <strong>{participant.persona.name}</strong>
                  <small>
                    {participant.enabled
                      ? participant.availability.message
                      : 'Paused · excluded from new turns'}
                  </small>
                </span>
                <button
                  type="button"
                  disabled={changingMember !== null}
                  aria-label={`${participant.enabled ? 'Pause' : 'Resume'} ${participant.persona.name} in this conversation`}
                  onClick={() => {
                    setChangingMember(participant.id);
                    void onEnabledChange(participant, !participant.enabled).finally(() =>
                      setChangingMember(null),
                    );
                  }}
                >
                  {changingMember === participant.id
                    ? 'Saving…'
                    : participant.enabled
                      ? 'Pause'
                      : 'Resume'}
                </button>
                <button type="button" onClick={() => onEdit(participant.persona)}>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void onRemove(participant)}
                  aria-label={`Remove ${participant.persona.name} from this conversation`}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function AddCupcakeDialog({
  open,
  personas,
  participants,
  models,
  pendingId,
  error,
  onClose,
  onCreate,
  onAdd,
  onEdit,
}: {
  open: boolean;
  personas: CupcakePersona[];
  participants: ConversationParticipant[];
  models: ModelDescriptor[];
  pendingId?: string | null;
  error?: string;
  onClose: () => void;
  onCreate: () => void;
  onAdd: (persona: CupcakePersona) => void | Promise<void>;
  onEdit: (persona: CupcakePersona) => void;
}) {
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(open, dialogRef, onClose, Boolean(pendingId));
  const rosterIds = new Set(participants.map((item) => item.personaId));
  const candidates = personas
    .filter((persona) => !persona.archivedAt && !rosterIds.has(persona.id))
    .map((persona) => {
      const model = models.find((item) => personaModelId(item) === persona.modelId);
      return { persona, model, ready: Boolean(model && personaModelReady(model)) };
    })
    .filter(
      ({ persona, model }) =>
        !query.trim() ||
        `${persona.name} ${persona.handle} ${persona.role} ${model?.name ?? ''}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    )
    .sort(
      (left, right) =>
        Number(right.ready) - Number(left.ready) ||
        left.persona.name.localeCompare(right.persona.name),
    );
  const ready = candidates.filter((item) => item.ready);
  const needsAttention = candidates.filter((item) => !item.ready);

  if (!open) return null;
  return (
    <div className="group-dialog-layer">
      <section
        ref={dialogRef}
        className="group-dialog add-cupcake-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-cupcake-title"
        tabIndex={-1}
        data-testid="add-cupcake-dialog"
      >
        <header className="group-dialog__header">
          <div>
            <span className="eyebrow">Build the conversation table</span>
            <h2 id="add-cupcake-title">Add a Cupcake</h2>
            <p>Choose a saved voice or make a new one. This conversation can hold up to eight.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close Add Cupcake"
          >
            <X size={18} />
          </button>
        </header>
        <div className="add-cupcake-dialog__toolbar">
          <label>
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your Cupcakes"
              aria-label="Search your Cupcakes"
              autoFocus
            />
          </label>
          <button type="button" className="button button--primary" onClick={onCreate}>
            <UserRoundPlus size={15} /> Create a Cupcake
          </button>
        </div>
        <div className="add-cupcake-dialog__body">
          {ready.length > 0 && (
            <PersonaList
              title="Ready"
              items={ready}
              pendingId={pendingId}
              onAdd={onAdd}
              onEdit={onEdit}
            />
          )}
          {needsAttention.length > 0 && (
            <PersonaList
              title="Needs attention"
              items={needsAttention}
              pendingId={pendingId}
              onAdd={onAdd}
              onEdit={onEdit}
            />
          )}
          {!candidates.length && (
            <div className="cupcake-empty-library">
              <span>
                <UsersRound size={24} />
              </span>
              <h3>{personas.length ? 'No more saved Cupcakes' : 'Create your first Cupcake'}</h3>
              <p>
                {personas.length
                  ? 'Every matching Cupcake is already at this table.'
                  : 'Fresh profiles start empty. Choose a name, purpose, voice, and exact model.'}
              </p>
              <button type="button" className="button button--primary" onClick={onCreate}>
                <Plus size={15} /> Create a Cupcake
              </button>
            </div>
          )}
        </div>
        {error && (
          <p className="group-dialog__error" role="alert">
            {error}
          </p>
        )}
        <footer className="group-dialog__footer">
          <span />
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}

function PersonaList({
  title,
  items,
  pendingId,
  onAdd,
  onEdit,
}: {
  title: string;
  items: Array<{ persona: CupcakePersona; model?: ModelDescriptor; ready: boolean }>;
  pendingId?: string | null;
  onAdd: (persona: CupcakePersona) => void | Promise<void>;
  onEdit: (persona: CupcakePersona) => void;
}) {
  return (
    <section className="persona-library-section">
      <header>
        <h3>{title}</h3>
        <span>{items.length}</span>
      </header>
      <div>
        {items.map(({ persona, model, ready }) => (
          <article className={!ready ? 'needs-attention' : ''} key={persona.id}>
            <PersonaPortrait value={persona.avatar} name={persona.name} />
            <div>
              <strong>{persona.name}</strong>
              <span>@{persona.handle}</span>
              <p>{persona.role}</p>
              <small>{model ? `${model.name} · ${model.route}` : 'Saved model missing'}</small>
            </div>
            {ready ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => void onAdd(persona)}
                disabled={pendingId === persona.id}
              >
                {pendingId === persona.id ? 'Adding…' : 'Add'}
              </button>
            ) : (
              <div className="persona-library-actions">
                <button type="button" className="button" onClick={() => onEdit(persona)}>
                  Repair
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => void onAdd(persona)}
                  disabled={pendingId === persona.id}
                >
                  {pendingId === persona.id ? 'Adding…' : 'Add anyway'}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
