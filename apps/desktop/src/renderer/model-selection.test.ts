import { describe, expect, it, vi } from 'vitest';
import type { ModelDescriptor } from './types';
import {
  canonicalModelId,
  createKeyedRequestCoalescer,
  mergeModelDescriptors,
  modelSelectionParams,
  requiresCompatibilityAcknowledgement,
} from './model-selection';

function model(id: string, overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id,
    provider: 'OpenAI',
    name: id,
    route: 'Cloud',
    tags: [],
    context: '128K',
    cost: 'Provider pricing',
    status: 'ready',
    description: 'test model',
    selected: false,
    ...overrides,
  };
}

describe('model selection hardening', () => {
  it('uses the catalog id for product requests and keeps native ids out of chat selection', () => {
    const local = model('cupcake-local:qwen3-4b-q4-k-m', {
      provider: 'Cupcake Local',
      runtimeModelId: 'qwen3-4b-q4-k-m',
      route: 'Local',
    });

    expect(canonicalModelId(local)).toBe('cupcake-local:qwen3-4b-q4-k-m');
    expect(modelSelectionParams(local, false).modelId).toBe('cupcake-local:qwen3-4b-q4-k-m');
  });

  it('restores a persisted selection when its refreshed descriptor arrives later', () => {
    const initial = [model('mock', { selected: false })];
    const refreshed = [model('nvidia/model', { provider: 'NVIDIA NIM' })];

    const merged = mergeModelDescriptors(initial, refreshed, 'nvidia/model');

    expect(merged.find((item) => item.id === 'nvidia/model')?.selected).toBe(true);
    expect(merged.filter((item) => item.selected)).toHaveLength(1);
  });

  it('preserves a newer live selection instead of applying a stale refresh snapshot', () => {
    const current = [model('old'), model('new', { selected: true })];
    const refreshed = [model('old'), model('new')];

    const merged = mergeModelDescriptors(current, refreshed);

    expect(merged.find((item) => item.id === 'new')?.selected).toBe(true);
    expect(merged.filter((item) => item.selected)).toHaveLength(1);
  });

  it('requires an explicit acknowledgement only for unverified NVIDIA chat models', () => {
    const unknown = model('nim-unknown', {
      provider: 'NVIDIA NIM',
      chatCompatibility: 'unknown',
    });
    expect(requiresCompatibilityAcknowledgement(unknown)).toBe(true);
    expect(modelSelectionParams(unknown, false).compatibilityConfirmed).toBe(false);
    expect(modelSelectionParams(unknown, true).compatibilityConfirmed).toBe(true);
    expect(
      requiresCompatibilityAcknowledgement(
        model('nim-chat', { provider: 'NVIDIA NIM', chatCompatibility: 'chat' }),
      ),
    ).toBe(false);
  });

  it('coalesces duplicate selection requests and permits retry after failure', async () => {
    const coalesce = createKeyedRequestCoalescer();
    let rejectFirst: ((reason: Error) => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );

    const first = coalesce('model-a', operation);
    const duplicate = coalesce('model-a', operation);
    expect(first).toBe(duplicate);
    expect(operation).toHaveBeenCalledTimes(1);

    rejectFirst?.(new Error('selection failed'));
    await expect(first).rejects.toThrow('selection failed');

    const retryOperation = vi.fn(() => Promise.resolve());
    await coalesce('model-a', retryOperation);
    expect(retryOperation).toHaveBeenCalledTimes(1);
  });
});
