import { FileText, FolderKanban, HardDrive, Lightbulb, ListChecks, Wrench } from 'lucide-react';
import type { ConversationParticipant } from '../types';
import type { ReferenceRecord } from '../workspace';
import { PersonaPortrait } from './PersonaPortrait';

export type MentionMenuItem =
  | { kind: 'participant'; key: string; participant: ConversationParticipant; disabled: boolean }
  | { kind: 'reference'; key: string; reference: ReferenceRecord; disabled: false };

export function buildMentionMenuItems(
  participants: ConversationParticipant[],
  references: ReferenceRecord[],
  query: string,
): MentionMenuItem[] {
  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  return [
    ...participants
      .filter(
        (item) =>
          item.enabled &&
          matches(`${item.persona.name} ${item.persona.handle} ${item.persona.role}`),
      )
      .sort((left, right) => left.position - right.position)
      .map((participant): MentionMenuItem => ({
        kind: 'participant',
        key: `participant:${participant.id}`,
        participant,
        disabled: participant.availability.status !== 'ready',
      })),
    ...references
      .filter((item) => matches(`${item.label} ${item.type}`))
      .map((reference): MentionMenuItem => ({
        kind: 'reference',
        key: `reference:${reference.type}:${reference.id}`,
        reference,
        disabled: false,
      })),
  ];
}

export function GroupMentionMenu({
  items,
  activeIndex,
  onActiveIndex,
  onSelect,
  onRepair,
}: {
  items: MentionMenuItem[];
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  onSelect: (item: MentionMenuItem) => void;
  onRepair: (participant: ConversationParticipant) => void;
}) {
  const participants = items.filter(
    (item): item is Extract<MentionMenuItem, { kind: 'participant' }> =>
      item.kind === 'participant',
  );
  const references = items.filter(
    (item): item is Extract<MentionMenuItem, { kind: 'reference' }> => item.kind === 'reference',
  );
  const optionIndex = new Map(items.map((item, index) => [item.key, index]));
  return (
    <div
      className="group-mention-menu"
      id="composer-mention-options"
      data-testid="group-mention-menu"
    >
      <div className="group-mention-menu__topline">
        <strong>Mention</strong>
        <small>
          <kbd>↑</kbd>
          <kbd>↓</kbd> choose · <kbd>Enter</kbd> add · <kbd>Esc</kbd> close
        </small>
      </div>
      <div role="listbox" aria-label="Mention a Cupcake or your work">
        {participants.length > 0 && (
          <section aria-label="Cupcakes in this chat">
            <header>
              <span>Cupcakes in this chat</span>
              <small>Choose exactly who should answer</small>
            </header>
            {participants.map((item) => {
              const index = optionIndex.get(item.key) ?? -1;
              const participant = item.participant;
              return (
                <div className="group-mention-option-wrap" key={item.key}>
                  <button
                    type="button"
                    id={`mention-option-${index}`}
                    role="option"
                    aria-selected={activeIndex === index}
                    aria-disabled={item.disabled}
                    className={activeIndex === index ? 'is-active' : ''}
                    onMouseEnter={() => onActiveIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => !item.disabled && onSelect(item)}
                  >
                    <PersonaPortrait
                      value={participant.persona.avatar}
                      name={participant.persona.name}
                    />
                    <span>
                      <strong>
                        {participant.persona.name}
                        <small>@{participant.persona.handle}</small>
                      </strong>
                      <p>{participant.persona.role}</p>
                    </span>
                    {participant.availability.status === 'ready' ? (
                      <em>Ready</em>
                    ) : (
                      <em className="needs-attention">Needs attention</em>
                    )}
                  </button>
                  {item.disabled && (
                    <button
                      type="button"
                      className="mention-repair"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onRepair(participant)}
                    >
                      Repair
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        )}
        {references.length > 0 && (
          <section aria-label="Project context">
            <header>
              <span>Project context</span>
              <small>Add context without choosing a speaker</small>
            </header>
            {references.map((item) => {
              const index = optionIndex.get(item.key) ?? -1;
              const reference = item.reference;
              return (
                <button
                  type="button"
                  id={`mention-option-${index}`}
                  role="option"
                  aria-selected={activeIndex === index}
                  className={activeIndex === index ? 'is-active' : ''}
                  key={item.key}
                  onMouseEnter={() => onActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(item)}
                >
                  <span className="mention-context-icon">
                    <ReferenceIcon type={reference.type} />
                  </span>
                  <span>
                    <strong>{reference.label}</strong>
                    <p>{reference.type}</p>
                  </span>
                </button>
              );
            })}
          </section>
        )}
        {!items.length && (
          <div className="group-mention-menu__empty">
            <Lightbulb size={17} />
            <span>
              <strong>No matches</strong>
              <small>Keep typing, or press Escape to leave this as ordinary text.</small>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ReferenceIcon({ type }: { type: ReferenceRecord['type'] }) {
  if (type === 'project') return <FolderKanban size={16} />;
  if (type === 'task') return <ListChecks size={16} />;
  if (type === 'memory') return <Lightbulb size={16} />;
  if (type === 'artifact') return <FileText size={16} />;
  if (type === 'memory') return <HardDrive size={16} />;
  return <Wrench size={16} />;
}
