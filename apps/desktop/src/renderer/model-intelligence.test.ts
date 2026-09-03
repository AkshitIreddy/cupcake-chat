import { describe, expect, it } from 'vitest';

import {
  benchmarkRatingsForModel,
  modelIsAvailableInChat,
  publisherForModel,
} from './model-intelligence';
import type { ModelDescriptor } from './types';

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'nvidia-nim:moonshotai/kimi-k2.6',
    runtimeModelId: 'nvidia-nim:moonshotai/kimi-k2.6',
    provider: 'NVIDIA NIM',
    name: 'Kimi K2.6',
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
    expect(publisherForModel(model())).toBe('Moonshot AI');
  });

  it('keeps raw benchmark names beside capability-specific cupcake ratings', () => {
    const ratings = benchmarkRatingsForModel(model()) ?? [];
    expect(ratings.find((rating) => rating.capability === 'coding')).toMatchObject({
      cupcakes: 5,
      confidence: 'medium',
    });
    expect(ratings.flatMap((rating) => rating.benchmarks)).toContain(
      'SWE-Bench Verified 80.2',
    );
  });

  it('hides disconnected and specialized routes from the picker by default', () => {
    expect(modelIsAvailableInChat(model())).toBe(true);
    expect(modelIsAvailableInChat(model({ status: 'setup' }))).toBe(false);
    expect(modelIsAvailableInChat(model({ chatCompatibility: 'non_chat' }))).toBe(false);
  });
});
