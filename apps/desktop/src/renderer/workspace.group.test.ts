import { describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../shared/desktop-api';
import type { GroupTurnState } from './types';
import {
  applyGroupTurnEvent,
  applyRuntimeMessageEvent,
  mapRuntimeMessage,
  type MessageRecord,
} from './workspace';

function event(type: string, payload: Record<string, unknown>, sequence = 1): RuntimeEvent {
  return { type, payload, sequence, timestamp: '2026-09-05T12:00:00.000Z' };
}

const speaker = (name: string, sequence: number) => ({
  participantId: `participant-${sequence}`,
  personaId: `persona-${sequence}`,
  name,
  handle: name.toLowerCase(),
  avatar: `atlas:${sequence}`,
  role: sequence === 1 ? 'Research lead' : 'Product critic',
  modelId: sequence === 1 ? 'groq:openai/gpt-oss-20b' : 'cohere:command-a-plus-05-2026',
  providerId: sequence === 1 ? 'groq' : 'cohere',
  privacyRoute: 'cloud' as const,
});

describe('group conversation renderer state', () => {
  it('rehydrates the persisted nested speaker snapshot without losing attribution', () => {
    const mapped = mapRuntimeMessage({
      id: 'message-two',
      role: 'assistant',
      content: 'A distinct follow-up.',
      model_id: 'cohere:command-a-plus-05-2026',
      provider_id: 'cohere',
      canonical_metadata: {
        group: {
          turnId: 'turn-one',
          sequence: 2,
          selectionReason: 'Adds a product risk check.',
          speaker: speaker('Mira', 2),
        },
      },
    });

    expect(mapped).toMatchObject({
      groupTurnId: 'turn-one',
      groupSequence: 2,
      speaker: {
        name: 'Mira',
        role: 'Product critic',
        modelId: 'cohere:command-a-plus-05-2026',
        providerId: 'cohere',
      },
      selectionReason: { reason: 'Adds a product risk check.' },
    });
  });

  it('keeps two speakers on one group run in separate streaming rows', () => {
    const turnId = 'turn-shared-run';
    let messages: MessageRecord[] = [];
    messages = applyRuntimeMessageEvent(
      messages,
      event('message.started', { runId: turnId, turnId, sequence: 1, speaker: speaker('Miso', 1) }),
      turnId,
    );
    messages = applyRuntimeMessageEvent(
      messages,
      event('message.delta', {
        runId: turnId,
        turnId,
        sequence: 1,
        speaker: speaker('Miso', 1),
        delta: 'First view',
      }),
      turnId,
    );
    messages = applyRuntimeMessageEvent(
      messages,
      event('message.completed', {
        runId: turnId,
        turnId,
        sequence: 1,
        speaker: speaker('Miso', 1),
        message: { id: 'persisted-one', content: 'First view' },
      }),
      turnId,
    );
    messages = applyRuntimeMessageEvent(
      messages,
      event('message.delta', {
        runId: turnId,
        turnId,
        sequence: 2,
        speaker: speaker('Mira', 2),
        delta: 'Second view',
      }),
      turnId,
    );

    expect(messages).toHaveLength(2);
    expect(messages).toEqual([
      expect.objectContaining({ id: 'persisted-one', content: 'First view', groupSequence: 1 }),
      expect.objectContaining({
        id: `${turnId}:speaker:2`,
        content: 'Second view',
        groupSequence: 2,
        speaker: expect.objectContaining({ name: 'Mira' }),
      }),
    ]);
  });

  it('settles the active speaker on cancellation and ignores late reactivation events', () => {
    const current: GroupTurnState = {
      turnId: 'turn-cancel',
      conversationId: 'conversation-a',
      branchId: 'branch-a',
      userMessageId: 'user-a',
      planRevision: 'a'.repeat(64),
      rosterRevision: 1,
      status: 'responding',
      mode: 'smart',
      callIndex: 1,
      maxSelectorCalls: 2,
      maxReplies: 2,
      speakers: [{ sequence: 1, speaker: speaker('Miso', 1), status: 'speaking' }],
    };
    const cancelled = applyGroupTurnEvent(
      current,
      event('group.turn.cancelled', { turnId: current.turnId, sequence: 1 }),
    );
    const late = applyGroupTurnEvent(
      cancelled,
      event('group.speaker.started', {
        turnId: current.turnId,
        sequence: 1,
        speaker: speaker('Miso', 1),
      }),
    );

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      speakers: [{ status: 'cancelled' }],
    });
    expect(late).toEqual(cancelled);
  });
});
