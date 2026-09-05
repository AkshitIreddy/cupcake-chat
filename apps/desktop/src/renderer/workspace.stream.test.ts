import { describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../shared/desktop-api';
import { applyRuntimeMessageEvent, type MessageRecord } from './workspace';

function event(type: string, payload: Record<string, unknown>, sequence = 1): RuntimeEvent {
  return { type, payload, sequence, timestamp: '2026-08-29T12:00:00.000Z' };
}

describe('workspace runtime message stream', () => {
  it('resets discarded provider deltas and accumulates the replacement stream', () => {
    const initial: MessageRecord[] = [
      {
        id: 'run-1',
        role: 'assistant',
        content: 'partial from primary',
        streaming: true,
        reasoningSummary: 'old summary',
        citations: [{ id: 'old', title: 'Old source' }],
      },
    ];

    const reset = applyRuntimeMessageEvent(
      initial,
      event('provider.fallback.started', { runId: 'run-1', discardPriorDeltas: true }),
      'run-1',
    );
    const replacement = applyRuntimeMessageEvent(
      reset,
      event('message.delta', { runId: 'run-1', delta: 'replacement' }, 2),
      'run-1',
    );

    expect(replacement).toEqual([
      expect.objectContaining({
        id: 'run-1',
        content: 'replacement',
        streaming: true,
        reasoningSummary: undefined,
        citations: undefined,
        usage: undefined,
      }),
    ]);
  });

  it('accumulates reasoning summary deltas and preserves final message provenance', () => {
    const started = applyRuntimeMessageEvent(
      [],
      event('message.started', { runId: 'run-2' }),
      null,
    );
    const summary = applyRuntimeMessageEvent(
      applyRuntimeMessageEvent(
        started,
        event('reasoning.summary.delta', { runId: 'run-2', delta: 'Checked ' }, 2),
        'run-2',
      ),
      event('reasoning.summary.delta', { runId: 'run-2', delta: 'the evidence.' }, 3),
      'run-2',
    );
    const completed = applyRuntimeMessageEvent(
      summary,
      event(
        'message.completed',
        {
          runId: 'run-2',
          content: 'Final answer',
          message: {
            id: 'message-2',
            branch_id: 'branch-2',
            content: 'Final answer',
            model_id: 'model-2',
            provider_id: 'provider-2',
            created_at: '2026-08-29T12:01:00.000Z',
          },
        },
        4,
      ),
      'run-2',
    );

    expect(completed).toEqual([
      expect.objectContaining({
        id: 'run-2',
        branchId: 'branch-2',
        content: 'Final answer',
        modelId: 'model-2',
        providerId: 'provider-2',
        createdAt: '2026-08-29T12:01:00.000Z',
        reasoningSummary: 'Checked the evidence.',
        streaming: false,
      }),
    ]);
  });

  it('settles cancelled and failed assistant rows without adding duplicate status messages', () => {
    const streaming: MessageRecord[] = [
      { id: 'run-3', role: 'assistant', content: 'Partial', streaming: true },
    ];
    const cancelled = applyRuntimeMessageEvent(
      streaming,
      event('message.cancelled', {
        runId: 'run-3',
        partialContent: 'Partial response',
        message: { model_id: 'model-3', provider_id: 'provider-3' },
      }),
      'run-3',
    );
    const failed = applyRuntimeMessageEvent(
      streaming,
      event('run.failed', { runId: 'run-3', error: { message: 'Provider unavailable' } }),
      'run-3',
    );

    expect(cancelled).toEqual([
      expect.objectContaining({
        id: 'run-3',
        content: 'Partial response',
        modelId: 'model-3',
        providerId: 'provider-3',
        responseState: 'cancelled',
        streaming: false,
      }),
    ]);
    expect(failed).toEqual([
      expect.objectContaining({ id: 'run-3', content: 'Partial', streaming: false }),
    ]);
  });
});
