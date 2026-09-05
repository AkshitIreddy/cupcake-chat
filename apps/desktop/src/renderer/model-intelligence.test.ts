import { describe, expect, it } from 'vitest';

import {
  completeModelDescriptor,
  modelAvailabilityDetail,
  modelIsAvailableInChat,
  modelIsCurated,
  modelRouteDescription,
  modelSize,
  modelTasks,
  publisherForModel,
  publisherLogoAsset,
  recommendModels,
  recommendationReason,
} from './model-intelligence';
import type { ModelDescriptor } from './types';

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'nvidia-nim:openai/gpt-oss-20b',
    runtimeModelId: 'nvidia-nim:openai/gpt-oss-20b',
    provider: 'NVIDIA NIM',
    name: 'GPT-OSS 20B',
    route: 'Cloud',
    tags: ['reasoning'],
    context: '1m',
    cost: 'NVIDIA pricing',
    status: 'ready',
    description: 'Current hosted model',
    chatCompatibility: 'chat',
    ...overrides,
  };
}

describe('model intelligence', () => {
  it('groups a hosted route by the company that released the model', () => {
    expect(publisherForModel(model())).toBe('OpenAI');
  });

  it('uses curated task and size metadata without synthetic ratings', () => {
    expect(modelIsCurated(model())).toBe(true);
    expect(modelTasks(model())).toEqual(expect.arrayContaining(['coding', 'reasoning', 'tools']));
    expect(modelSize(model())).toBe('compact');
    expect(
      completeModelDescriptor(model({ description: 'Explicitly selected model' })).description,
    ).toContain('open-weight reasoning');
  });

  it('recognizes the current first-party hosted catalog without retaining stale aliases', () => {
    const current = model({
      id: 'gpt',
      runtimeModelId: 'openai:gpt-6-astra',
      provider: 'OpenAI',
      name: 'GPT-6 Astra',
    });
    const stale = model({
      id: 'gpt-old',
      runtimeModelId: 'openai:gpt-5.6-sol',
      provider: 'OpenAI',
      name: 'GPT-5.6 Sol',
    });
    const cohere = model({
      id: 'cohere',
      runtimeModelId: 'cohere:command-a-plus-05-2026',
      provider: 'Cohere',
      name: 'Command A Plus',
    });

    expect(modelIsCurated(current)).toBe(true);
    expect(modelIsCurated(stale)).toBe(false);
    expect(modelTasks(cohere)).toEqual(['chat', 'tools']);
  });

  it('uses publisher branding instead of the NVIDIA route logo', () => {
    expect(publisherLogoAsset(publisherForModel(model()))).toBe('/providers/openai.svg');
    expect(publisherLogoAsset('NVIDIA')).toBe('/providers/nvidia-nim.svg');
    expect(publisherLogoAsset('Qwen')).toBe('/providers/qwen.svg');
    expect(publisherLogoAsset('Microsoft')).toBe('/providers/microsoft.svg');
    expect(publisherLogoAsset('xAI')).toBe('/providers/xai.webp');
  });

  it('uses the model family rather than a Hugging Face repack uploader', () => {
    expect(
      publisherForModel(
        model({
          id: 'hf:bartowski/Qwen3-8B-GGUF',
          runtimeModelId: 'hf:bartowski/Qwen3-8B-GGUF',
          provider: 'Hugging Face',
          publisher: 'bartowski',
          name: 'Qwen3 8B GGUF',
        }),
      ),
    ).toBe('Qwen');
  });

  it('hides disconnected and specialized routes from the picker by default', () => {
    expect(modelIsAvailableInChat(model())).toBe(true);
    expect(modelIsAvailableInChat(model({ status: 'setup' }))).toBe(false);
    expect(modelIsAvailableInChat(model({ chatCompatibility: 'non_chat' }))).toBe(false);
  });

  it('builds a ready-first recommendation shelf and diversifies publishers', () => {
    const recommendations = recommendModels(
      [
        model({ id: 'nvidia-nim:openai/gpt-oss-20b', status: 'setup' }),
        model({
          id: 'nvidia-nim:nvidia/nemotron-3-super-120b-a12b',
          runtimeModelId: 'nvidia-nim:nvidia/nemotron-3-super-120b-a12b',
          name: 'Nemotron 3 Super',
          status: 'ready',
        }),
        model({
          id: 'cupcake-local:qwen3-8b-q4-k-m',
          runtimeModelId: 'qwen3-8b-q4-k-m',
          provider: 'Cupcake Local',
          name: 'Qwen3 8B',
          route: 'Local',
          status: 'installed',
          fit: 'recommended',
        }),
      ],
      'reasoning',
      3,
    );

    expect(recommendations.map((item) => publisherForModel(item))).toEqual([
      'Qwen',
      'NVIDIA',
      'OpenAI',
    ]);
    expect(modelRouteDescription(recommendations[0]!)).toContain('runs on this computer');
    expect(recommendationReason(recommendations[0]!, 'reasoning')).toBe('Fits this device well');
  });

  it('explains why unavailable routes cannot be selected', () => {
    expect(modelAvailabilityDetail(model({ status: 'setup' }))).toBe(
      'Connect NVIDIA NIM to use this route',
    );
    expect(modelAvailabilityDetail(model({ status: 'ready' }))).toBe('Connected and ready');
  });
});
