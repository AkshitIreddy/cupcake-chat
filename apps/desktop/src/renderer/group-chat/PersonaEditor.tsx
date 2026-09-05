import { Check, ChevronDown, Cloud, HardDrive, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CupcakePersona, ModelDescriptor } from '../types';
import { modelAvailabilityDetail } from '../model-intelligence';
import { PersonaPortrait } from './PersonaPortrait';
import {
  modelCanBackPersona,
  normalizePersonaHandle,
  personaDraft,
  personaModelId,
  personaModelReady,
  validatePersonaDraft,
  type PersonaDraft,
} from './persona-utils';
import { useDialogFocus } from './useDialogFocus';

const PRESETS: Array<{
  id: CupcakePersona['personality']['preset'];
  label: string;
  detail: string;
}> = [
  { id: 'balanced', label: 'Balanced', detail: 'Warm and clear' },
  { id: 'concise', label: 'Focused', detail: 'Direct and brief' },
  { id: 'warm', label: 'Friendly', detail: 'Conversational' },
  { id: 'analytical', label: 'Analytical', detail: 'Methodical' },
];

function personaAvailabilityDetail(model: ModelDescriptor): string {
  if (model.route === 'Local' && !personaModelReady(model)) {
    return model.status === 'installed'
      ? 'Installed · load in Models before sending'
      : 'Configure now · install and load in Models before sending';
  }
  return modelAvailabilityDetail(model);
}

export function PersonaEditor({
  open,
  persona,
  personas,
  models,
  pending = false,
  error = '',
  onClose,
  onSave,
  onArchive,
}: {
  open: boolean;
  persona?: CupcakePersona | null;
  personas: CupcakePersona[];
  models: ModelDescriptor[];
  pending?: boolean;
  error?: string;
  onClose: () => void;
  onSave: (draft: PersonaDraft) => void | Promise<void>;
  onArchive?: (persona: CupcakePersona) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(() => personaDraft(persona));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [modelQuery, setModelQuery] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [showUnavailableModels, setShowUnavailableModels] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(personaDraft(persona));
    setFieldErrors({});
    setModelQuery('');
    setModelOpen(false);
    setShowUnavailableModels(false);
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, persona]);

  useDialogFocus(open, dialogRef, onClose, pending || modelOpen);

  useEffect(() => {
    if (!modelOpen) return;
    const closeModelList = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setModelOpen(false);
      }
    };
    document.addEventListener('keydown', closeModelList, true);
    return () => document.removeEventListener('keydown', closeModelList, true);
  }, [modelOpen]);

  const selectedModel = models.find((model) => personaModelId(model) === draft.modelId);
  const shownModels = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    return models
      .filter(
        (model) =>
          (showUnavailableModels || personaModelReady(model)) &&
          (!query ||
            `${model.name} ${model.provider} ${model.publisher ?? ''}`
              .toLocaleLowerCase()
              .includes(query)),
      )
      .sort((left, right) => {
        const readiness = Number(personaModelReady(right)) - Number(personaModelReady(left));
        return (
          readiness ||
          left.provider.localeCompare(right.provider) ||
          left.name.localeCompare(right.name)
        );
      });
  }, [modelQuery, models, showUnavailableModels]);
  const update = <Key extends keyof PersonaDraft>(key: Key, value: PersonaDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
  const submit = () => {
    const normalized = { ...draft, handle: normalizePersonaHandle(draft.handle) };
    const errors = validatePersonaDraft(normalized, personas, models, persona?.id);
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      const first = dialogRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      first?.focus();
      return;
    }
    void onSave(normalized);
  };

  if (!open) return null;
  return (
    <div className="group-dialog-layer">
      <section
        className="group-dialog persona-editor"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="persona-editor-title"
        data-testid="persona-editor"
      >
        <header className="group-dialog__header">
          <div>
            <span className="eyebrow">A distinct voice at the table</span>
            <h2 id="persona-editor-title">
              {persona ? `Edit ${persona.name}` : 'Create a Cupcake'}
            </h2>
            <p>Give this Cupcake one job, one voice, and one exact model route.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close Cupcake editor"
            disabled={pending}
          >
            <X size={18} />
          </button>
        </header>

        <div className="persona-editor__body">
          <aside className="persona-editor__preview">
            <PersonaPortrait value={draft.avatar} name={draft.name || 'New Cupcake'} />
            <strong>{draft.name.trim() || 'New Cupcake'}</strong>
            <span>@{normalizePersonaHandle(draft.handle) || 'handle'}</span>
            <p>{draft.role.trim() || 'Add a clear role for this voice.'}</p>
            {selectedModel ? (
              <small className={personaModelReady(selectedModel) ? 'is-ready' : 'needs-attention'}>
                {selectedModel.route === 'Local' ? <HardDrive size={13} /> : <Cloud size={13} />}
                {selectedModel.name}
              </small>
            ) : (
              <small className="needs-attention">No model selected</small>
            )}
          </aside>

          <div className="persona-editor__fields">
            <section className="persona-form-section">
              <div className="persona-form-section__heading">
                <span>1</span>
                <div>
                  <strong>Identity</strong>
                  <small>How you will recognize and mention them</small>
                </div>
              </div>
              <div className="persona-field-grid">
                <label>
                  Name
                  <input
                    ref={nameRef}
                    value={draft.name}
                    maxLength={40}
                    aria-invalid={Boolean(fieldErrors.name)}
                    onChange={(event) => update('name', event.target.value)}
                    placeholder="Miso"
                  />
                  {fieldErrors.name && <small className="field-error">{fieldErrors.name}</small>}
                </label>
                <label>
                  Handle
                  <span className="handle-input">
                    <b aria-hidden="true">@</b>
                    <input
                      value={draft.handle}
                      maxLength={32}
                      aria-invalid={Boolean(fieldErrors.handle)}
                      onChange={(event) => update('handle', event.target.value)}
                      placeholder="miso"
                    />
                  </span>
                  {fieldErrors.handle && (
                    <small className="field-error">{fieldErrors.handle}</small>
                  )}
                </label>
              </div>
              <fieldset className="persona-avatar-picker">
                <legend>Avatar</legend>
                <div>
                  {Array.from({ length: 20 }, (_, index) => `atlas:${index}`).map((avatar) => (
                    <button
                      key={avatar}
                      type="button"
                      className={draft.avatar === avatar ? 'is-selected' : ''}
                      onClick={() => update('avatar', avatar)}
                      aria-label={`Choose Cupcake portrait ${Number(avatar.split(':')[1]) + 1}`}
                    >
                      <PersonaPortrait value={avatar} name="Cupcake" />
                      {draft.avatar === avatar && <Check size={12} />}
                    </button>
                  ))}
                </div>
              </fieldset>
            </section>

            <section className="persona-form-section">
              <div className="persona-form-section__heading">
                <span>2</span>
                <div>
                  <strong>Purpose</strong>
                  <small>Smart uses this to decide when a voice adds value</small>
                </div>
              </div>
              <label>
                Role
                <input
                  value={draft.role}
                  maxLength={120}
                  aria-invalid={Boolean(fieldErrors.role)}
                  onChange={(event) => update('role', event.target.value)}
                  placeholder="Research critic"
                />
                {fieldErrors.role && <small className="field-error">{fieldErrors.role}</small>}
              </label>
              <label>
                When should this Cupcake speak?
                <textarea
                  value={draft.speakWhen}
                  maxLength={500}
                  rows={3}
                  onChange={(event) => update('speakWhen', event.target.value)}
                  placeholder="When sources conflict, assumptions need checking, or a second interpretation would help."
                />
                <small>{draft.speakWhen.length}/500</small>
              </label>
              <label>
                Short description <em>Optional</em>
                <input
                  value={draft.description}
                  maxLength={240}
                  onChange={(event) => update('description', event.target.value)}
                  placeholder="A careful evidence checker"
                />
              </label>
            </section>

            <section className="persona-form-section">
              <div className="persona-form-section__heading">
                <span>3</span>
                <div>
                  <strong>Voice</strong>
                  <small>Visible instructions for future replies</small>
                </div>
              </div>
              <div className="persona-preset-row" role="radiogroup" aria-label="Personality preset">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={draft.personality.preset === preset.id}
                    className={draft.personality.preset === preset.id ? 'is-selected' : ''}
                    onClick={() =>
                      update('personality', { ...draft.personality, preset: preset.id })
                    }
                  >
                    <strong>{preset.label}</strong>
                    <small>{preset.detail}</small>
                  </button>
                ))}
              </div>
              <div className="persona-sliders">
                {(
                  [
                    ['Warmth', 'warmth'],
                    ['Brevity', 'brevity'],
                    ['Initiative', 'initiative'],
                  ] as const
                ).map(([label, key]) => (
                  <label key={key}>
                    <span>
                      {label}
                      <output>{Math.round(draft.personality[key] * 100)}</output>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(draft.personality[key] * 100)}
                      onChange={(event) =>
                        update('personality', {
                          ...draft.personality,
                          preset: 'custom',
                          [key]: Number(event.target.value) / 100,
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <label>
                Instructions <em>Optional</em>
                <textarea
                  value={draft.instructions}
                  maxLength={4000}
                  rows={4}
                  onChange={(event) => update('instructions', event.target.value)}
                  placeholder="For example: Challenge unclear claims, cite the strongest evidence, and say when you are uncertain."
                />
                <small>{draft.instructions.length}/4,000</small>
              </label>
            </section>

            <section className="persona-form-section">
              <div className="persona-form-section__heading">
                <span>4</span>
                <div>
                  <strong>Model</strong>
                  <small>One exact route; CupcakeAI never substitutes another</small>
                </div>
              </div>
              <button
                type="button"
                className={`persona-model-select ${fieldErrors.modelId ? 'has-error' : ''}`}
                onClick={() => setModelOpen((value) => !value)}
                aria-expanded={modelOpen}
                aria-controls="persona-model-options"
                data-testid="persona-model-picker"
              >
                {selectedModel ? (
                  <>
                    <span className={`route-orb is-${selectedModel.route.toLowerCase()}`}>
                      {selectedModel.route === 'Local' ? (
                        <HardDrive size={16} />
                      ) : (
                        <Cloud size={16} />
                      )}
                    </span>
                    <span>
                      <strong>{selectedModel.name}</strong>
                      <small>
                        {selectedModel.provider} · {personaAvailabilityDetail(selectedModel)}
                      </small>
                    </span>
                  </>
                ) : (
                  <span>
                    <strong>Choose an exact model</strong>
                    <small>Ready routes first; future routes stay visible</small>
                  </span>
                )}
                <ChevronDown size={17} />
              </button>
              {fieldErrors.modelId && <small className="field-error">{fieldErrors.modelId}</small>}
              {modelOpen && (
                <div className="persona-model-options" id="persona-model-options">
                  <label className="persona-model-search">
                    <Search size={15} />
                    <input
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder="Search models or providers"
                      aria-label="Search models for this Cupcake"
                      autoFocus
                    />
                  </label>
                  <label className="persona-model-availability-toggle">
                    <input
                      type="checkbox"
                      checked={showUnavailableModels}
                      onChange={(event) => setShowUnavailableModels(event.target.checked)}
                    />
                    Show routes that need setup or loading
                  </label>
                  <div role="listbox" aria-label="Available models">
                    {shownModels.map((model) => {
                      const configurable = modelCanBackPersona(model);
                      const canonicalId = personaModelId(model);
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="option"
                          aria-selected={draft.modelId === canonicalId}
                          disabled={!configurable}
                          onClick={() => {
                            update('modelId', canonicalId);
                            setModelOpen(false);
                          }}
                        >
                          <span className={`route-orb is-${model.route.toLowerCase()}`}>
                            {model.route === 'Local' ? (
                              <HardDrive size={14} />
                            ) : (
                              <Cloud size={14} />
                            )}
                          </span>
                          <span>
                            <strong>{model.name}</strong>
                            <small>
                              {model.provider} · {personaAvailabilityDetail(model)}
                            </small>
                          </span>
                          {draft.modelId === canonicalId && <Check size={15} />}
                        </button>
                      );
                    })}
                    {!shownModels.length && <p>No models match that search.</p>}
                  </div>
                </div>
              )}
              {selectedModel &&
                !personaModelReady(selectedModel) &&
                persona?.modelId === draft.modelId && (
                  <p className="persona-route-warning" role="status">
                    You can save other edits, but this Cupcake will stay in Needs attention until{' '}
                    {selectedModel.name} is ready.
                  </p>
                )}
            </section>
          </div>
        </div>

        {error && (
          <p className="group-dialog__error" role="alert">
            {error}
          </p>
        )}
        <footer className="group-dialog__footer">
          {persona && onArchive && (
            <button
              type="button"
              className="button button--danger-quiet"
              onClick={() => void onArchive(persona)}
              disabled={pending}
            >
              <Trash2 size={15} /> Archive
            </button>
          )}
          <span />
          <button type="button" className="button" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={submit}
            disabled={pending}
          >
            {pending ? 'Saving…' : persona ? 'Save Cupcake' : 'Create Cupcake'}
          </button>
        </footer>
      </section>
    </div>
  );
}
