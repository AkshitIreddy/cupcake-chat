import { describe, expect, it } from 'vitest';

import {
  completeModelDescriptor,
  modelIsAvailableInChat,
  modelIsCurated,
  modelSize,
  modelTasks,
  publisherForModel,
  publisherLogoAsset,
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
});
