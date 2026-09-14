import { describe, expect, it, vi } from 'vitest';
import type { ModelDescriptor } from './types';
import {
  canonicalModelId,
  createKeyedRequestCoalescer,
  mergeModelDescriptors,
  modelSelectionParams,
  resolvePersistedMessageModel,
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
    expect(modelSelectionParams(local).modelId).toBe('cupcake-local:qwen3-4b-q4-k-m');
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

  it('treats the model click itself as compatibility acknowledgement for unknown NIM rows', () => {
    const unknown = model('nim-unknown', {
      provider: 'NVIDIA NIM',
      chatCompatibility: 'unknown',
    });
    expect(modelSelectionParams(unknown).compatibilityConfirmed).toBe(true);
    expect(
      modelSelectionParams(model('nim-chat', { provider: 'NVIDIA NIM', chatCompatibility: 'chat' }))
        .compatibilityConfirmed,
    ).toBe(false);
  });

  it('resolves provider-native history ids to one exact catalog route', () => {
    const nim = model('nvidia-nim:nvidia/nemotron-3-super-120b-a12b', {
      provider: 'NVIDIA NIM',
      runtimeModelId: 'nvidia/nemotron-3-super-120b-a12b',
    });
    const local = model('openai-compatible:cupcake-local/nemotron', {
      provider: 'Cupcake Local',
      runtimeModelId: 'nemotron',
      route: 'Local',
    });

    expect(
      resolvePersistedMessageModel([local, nim], {
        modelId: 'nvidia/nemotron-3-super-120b-a12b',
        providerId: 'nvidia-nim',
      }),
    ).toBe(nim);
  });

  it('uses compatible endpoint identity and rejects ambiguous compatible routes', () => {
    const openRouter = model('openai-compatible:openrouter/vendor/shared-model', {
      provider: 'OpenRouter',
      runtimeModelId: 'vendor/shared-model',
    });
    const custom = model('openai-compatible:private/vendor/shared-model', {
      provider: 'Private endpoint',
      runtimeModelId: 'vendor/shared-model',
    });

    expect(
      resolvePersistedMessageModel([openRouter, custom], {
        modelId: 'vendor/shared-model',
        providerId: 'openai-compatible',
        modelFamily: 'openai-compatible:openrouter:vendor/shared-model',
      }),
    ).toBe(openRouter);
    expect(
      resolvePersistedMessageModel([openRouter, custom], {
        modelId: 'vendor/shared-model',
        providerId: 'openai-compatible',
      }),
    ).toBeNull();
  });

  it('resolves unloaded Cupcake Local history through its exact compatible endpoint identity', () => {
    const unloadedLocal = model('cupcake-local:qwen3-8b-q4-k-m', {
      provider: 'Cupcake Local',
      runtimeModelId: 'qwen3-8b-q4-k-m',
      route: 'Local',
      status: 'catalog',
    });
    const cloudLookalike = model('openai-compatible:private/qwen3-8b-q4-k-m', {
      provider: 'Private endpoint',
      runtimeModelId: 'qwen3-8b-q4-k-m',
    });

    expect(
      resolvePersistedMessageModel([unloadedLocal, cloudLookalike], {
        modelId: 'qwen3-8b-q4-k-m',
        providerId: 'openai-compatible',
        modelFamily: 'openai-compatible:cupcake-local:qwen3-8b-q4-k-m',
      }),
    ).toBe(unloadedLocal);
    expect(
      resolvePersistedMessageModel([unloadedLocal], {
        modelId: 'qwen3-8b-q4-k-m',
        providerId: 'openai-compatible',
      }),
    ).toBeNull();
    expect(
      resolvePersistedMessageModel([unloadedLocal], {
        modelId: 'qwen3-8b-q4-k-m',
        providerId: 'openai-compatible',
        modelFamily: 'openai-compatible:private:qwen3-8b-q4-k-m',
      }),
    ).toBeNull();
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
