import type {
  ConversationParticipant,
  CupcakePersona,
  GroupMention,
  ModelDescriptor,
} from '../types';

export interface MentionToken {
  start: number;
  end: number;
  query: string;
}

export interface PersonaDraft {
  name: string;
  handle: string;
  avatar: string;
  role: string;
  description: string;
  instructions: string;
  speakWhen: string;
  personality: CupcakePersona['personality'];
  modelId: string;
}

export function normalizePersonaHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

export function personaDraft(persona?: CupcakePersona | null): PersonaDraft {
  return {
    name: persona?.name ?? '',
    handle: persona?.handle ?? '',
    avatar: persona?.avatar ?? 'atlas:0',
    role: persona?.role ?? '',
    description: persona?.description ?? '',
    instructions: persona?.instructions ?? '',
    speakWhen: persona?.speakWhen ?? '',
    personality: persona?.personality ?? {
      preset: 'balanced',
      warmth: 0.55,
      brevity: 0.45,
      initiative: 0.3,
    },
    modelId: persona?.modelId ?? '',
  };
}

export function validatePersonaDraft(
  draft: PersonaDraft,
  personas: CupcakePersona[],
  models: ModelDescriptor[],
  editingId?: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const normalizedHandle = normalizePersonaHandle(draft.handle);
  if (!draft.name.trim()) errors.name = 'Give this Cupcake a name.';
  else if (draft.name.trim().length > 40) errors.name = 'Keep the name to 40 characters or fewer.';
  if (normalizedHandle.length < 2) errors.handle = 'Use at least 2 letters, numbers, - or _.';
  else if (
    personas.some(
      (item) => item.id !== editingId && normalizePersonaHandle(item.handle) === normalizedHandle,
    )
  )
    errors.handle = `@${normalizedHandle} is already in use.`;
  if (!draft.role.trim()) errors.role = 'Describe the role this Cupcake should play.';
  else if (draft.role.trim().length > 120)
    errors.role = 'Keep the role to 120 characters or fewer.';
  if (!draft.modelId) errors.modelId = 'Choose an exact model.';
  else {
    const model = models.find(
      (item) => item.id === draft.modelId || item.runtimeModelId === draft.modelId,
    );
    if (!model) errors.modelId = 'That exact model is no longer in the catalog.';
    else if (!modelCanBackPersona(model))
      errors.modelId = 'Choose a chat-compatible model for this Cupcake.';
  }
  return errors;
}

export function modelCanBackPersona(model: ModelDescriptor): boolean {
  return model.status !== 'incompatible' && model.chatCompatibility !== 'non_chat';
}

export function mentionTokenAtCaret(value: string, caret: number): MentionToken | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, safeCaret);
  const match = /(?:^|[\s([{])@([\p{L}\p{N}_-]*)$/u.exec(before);
  if (!match || match.index === undefined) return null;
  const token = match[0];
  const atOffset = token.lastIndexOf('@');
  const start = match.index + atOffset;
  return { start, end: safeCaret, query: match[1] ?? '' };
}

export function insertParticipantMention(
  value: string,
  token: MentionToken,
  participant: ConversationParticipant,
): { content: string; caret: number; mention: GroupMention } {
  const visibleToken = `@${normalizePersonaHandle(participant.persona.handle)}`;
  const suffix = value.slice(token.end);
  const needsSpace = suffix.length === 0 || !/^\s/.test(suffix);
  const insertion = `${visibleToken}${needsSpace ? ' ' : ''}`;
  const content = `${value.slice(0, token.start)}${insertion}${suffix}`;
  const end = token.start + visibleToken.length;
  return {
    content,
    caret: token.start + insertion.length,
    mention: {
      participantId: participant.id,
      personaId: participant.personaId,
      start: token.start,
      end,
      token: visibleToken,
    },
  };
}

export function reconcileMentions(
  previousContent: string,
  nextContent: string,
  selected: GroupMention[],
): GroupMention[] {
  let prefix = 0;
  while (
    prefix < previousContent.length &&
    prefix < nextContent.length &&
    previousContent[prefix] === nextContent[prefix]
  )
    prefix += 1;
  let previousSuffix = previousContent.length;
  let nextSuffix = nextContent.length;
  while (
    previousSuffix > prefix &&
    nextSuffix > prefix &&
    previousContent[previousSuffix - 1] === nextContent[nextSuffix - 1]
  ) {
    previousSuffix -= 1;
    nextSuffix -= 1;
  }
  const delta = nextContent.length - previousContent.length;
  const next: GroupMention[] = [];
  for (const mention of selected) {
    if (mention.end <= prefix) {
      if (isExactMentionAt(nextContent, mention)) next.push(mention);
      continue;
    }
    if (mention.start >= previousSuffix) {
      const shifted = { ...mention, start: mention.start + delta, end: mention.end + delta };
      if (isExactMentionAt(nextContent, shifted)) next.push(shifted);
    }
  }
  return next.sort((a, b) => a.start - b.start);
}

function isExactMentionAt(content: string, mention: GroupMention): boolean {
  if (content.slice(mention.start, mention.end) !== mention.token) return false;
  const before = content[mention.start - 1] ?? '';
  const after = content[mention.end] ?? '';
  return (!before || /[\s([{]/.test(before)) && (!after || /[\s,.;:!?)}\]]/.test(after));
}

export function participantRouteSummary(
  participants: ConversationParticipant[],
  models: ModelDescriptor[],
): { label: string; detail: string; allLocal: boolean } {
  const ready = participants.filter((item) => item.enabled && item.availability.status === 'ready');
  const routes = ready.map((participant) => {
    const model = models.find(
      (item) =>
        item.id === participant.persona.modelId ||
        item.runtimeModelId === participant.persona.modelId,
    );
    return {
      route: model?.route ?? 'Cloud',
      provider: model?.provider ?? 'Unavailable route',
    };
  });
  const localCount = routes.filter((item) => item.route === 'Local').length;
  const cloudProviders = [
    ...new Set(routes.filter((item) => item.route === 'Cloud').map((item) => item.provider)),
  ];
  const allLocal = routes.length > 0 && localCount === routes.length;
  if (allLocal)
    return {
      label: 'Private group · all local',
      detail: `${localCount} ${localCount === 1 ? 'Cupcake runs' : 'Cupcakes run'} on this computer`,
      allLocal: true,
    };
  const parts = [localCount ? `${localCount} local` : '', ...cloudProviders].filter(Boolean);
  return {
    label: 'Mixed routes',
    detail: parts.join(' · ') || 'No ready routes',
    allLocal: false,
  };
}
