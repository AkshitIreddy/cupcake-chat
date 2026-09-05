import { describe, expect, it } from 'vitest';
import type {
  ConversationParticipant,
  CupcakePersona,
  GroupMention,
  ModelDescriptor,
} from '../types';
import {
  insertParticipantMention,
  mentionTokenAtCaret,
  normalizePersonaHandle,
  reconcileMentions,
  validatePersonaDraft,
} from './persona-utils';

const persona = (overrides: Partial<CupcakePersona> = {}): CupcakePersona => ({
  id: 'persona-miso',
  name: 'Miso',
  handle: 'miso',
  avatar: 'atlas:2',
  role: 'Evidence critic',
  description: '',
  instructions: '',
  speakWhen: 'Claims need checking',
  personality: { preset: 'analytical', warmth: 0.4, brevity: 0.5, initiative: 0.4 },
  modelId: 'openai:gpt-6-astra',
  createdAt: '2026-09-05T00:00:00Z',
  updatedAt: '2026-09-05T00:00:00Z',
  archivedAt: null,
  ...overrides,
});

const participant: ConversationParticipant = {
  id: 'participant-miso',
  conversationId: 'conversation-one',
  personaId: 'persona-miso',
  position: 0,
  enabled: true,
  isLead: true,
  addedAt: '2026-09-05T00:00:00Z',
  persona: persona(),
  availability: { status: 'ready', message: '' },
};

const model = (overrides: Partial<ModelDescriptor> = {}): ModelDescriptor => ({
  id: 'openai:gpt-6-astra',
  provider: 'OpenAI',
  name: 'GPT-6 Astra',
  route: 'Cloud',
  tags: ['chat'],
  context: '1,050,000',
  cost: '$10 / $50',
  status: 'ready',
  description: 'Test model',
  chatCompatibility: 'chat',
  ...overrides,
});

describe('persona handles', () => {
  it('normalizes to the same conservative ASCII identity accepted by the runtime', () => {
    expect(normalizePersonaHandle(' @Miso Cake! ')).toBe('miso-cake');
    expect(normalizePersonaHandle('MÍSØ')).toBe('ms');
  });

  it('rejects short and duplicate normalized handles', () => {
    const short = validatePersonaDraft({ ...persona(), handle: 'x' }, [], [model()]);
    const duplicate = validatePersonaDraft(
      { ...persona({ id: 'new-persona' }), handle: '@MISO' },
      [persona()],
      [model()],
    );
    expect(short.handle).toMatch(/at least 2/i);
    expect(duplicate.handle).toMatch(/already in use/i);
  });

  it('allows an explicit compatible model to be configured before its provider is ready', () => {
    const errors = validatePersonaDraft(persona(), [], [model({ status: 'setup' })]);
    expect(errors.modelId).toBeUndefined();
    const incompatible = validatePersonaDraft(
      persona(),
      [],
      [model({ status: 'incompatible', chatCompatibility: 'non_chat' })],
    );
    expect(incompatible.modelId).toMatch(/chat-compatible/i);
  });
});

describe('structured mentions', () => {
  it('finds the token at the caret and inserts an opaque participant binding', () => {
    const value = 'Can @mi check this?';
    const token = mentionTokenAtCaret(value, 7);
    expect(token).toEqual({ start: 4, end: 7, query: 'mi' });
    const result = insertParticipantMention(value, token!, participant);
    expect(result.content).toBe('Can @miso check this?');
    expect(result.mention).toEqual({
      participantId: 'participant-miso',
      personaId: 'persona-miso',
      start: 4,
      end: 9,
      token: '@miso',
    });
  });

  it('keeps wire offsets in UTF-16 code units when emoji precede a mention', () => {
    const value = '\n  🧁 Hi @mi';
    const token = mentionTokenAtCaret(value, value.length);
    expect(token).toEqual({ start: 9, end: 12, query: 'mi' });
    const result = insertParticipantMention(value, token!, participant);
    expect(result.content).toBe('\n  🧁 Hi @miso ');
    expect(result.mention).toMatchObject({ start: 9, end: 14, token: '@miso' });
  });

  it('shifts a selected mention only when an edit occurs strictly before it', () => {
    const mention: GroupMention = {
      participantId: participant.id,
      personaId: participant.personaId,
      start: 6,
      end: 11,
      token: '@miso',
    };
    expect(reconcileMentions('Ask:  @miso review', 'Please ask:  @miso review', [mention])).toEqual(
      [{ ...mention, start: 13, end: 18 }],
    );
  });

  it('drops a binding when its chip is edited, removed, or extended as ordinary text', () => {
    const mention: GroupMention = {
      participantId: participant.id,
      personaId: participant.personaId,
      start: 0,
      end: 5,
      token: '@miso',
    };
    expect(reconcileMentions('@miso review', '@mia review', [mention])).toEqual([]);
    expect(reconcileMentions('@miso review', 'review @miso', [mention])).toEqual([]);
    expect(reconcileMentions('@miso', '@misox', [mention])).toEqual([]);
  });

  it('treats an unknown raw @token as ordinary prompt text', () => {
    expect(mentionTokenAtCaret('email me at hello@example.com', 23)).toBeNull();
    expect(reconcileMentions('ask @unknown', 'ask @unknown please', [])).toEqual([]);
  });
});
