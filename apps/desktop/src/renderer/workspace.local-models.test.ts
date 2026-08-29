import { describe, expect, it } from 'vitest';
import {
  localModelActionRequest,
  mapDiscoveredRuntime,
  mapModel,
  normalizeHardware,
} from './workspace';

describe('workspace local model integration', () => {
  const lmStudio = mapModel({
    id: 'openai-compatible:lm-studio-local/google/gemma-3n-e4b',
    provider: 'openai-compatible',
    model: 'google/gemma-3n-e4b',
    display_name: 'google/gemma-3n-e4b (LM Studio)',
    privacy_route: 'local',
    context_window: 32_768,
    metadata: { runtime_kind: 'lm_studio', endpoint_id: 'lm-studio-local' },
  });

  it('preserves LM Studio identity and native model key', () => {
    expect(lmStudio).toEqual(
      expect.objectContaining({
        provider: 'LM Studio',
        route: 'Local',
        runtimeModelId: 'google/gemma-3n-e4b',
      }),
    );
  });

  it('routes LM Studio load and unload through its native management API', () => {
    expect(localModelActionRequest('load', lmStudio)).toEqual({
      method: 'local_models.lm_studio.load',
      params: { model: 'google/gemma-3n-e4b' },
    });
    expect(localModelActionRequest('unload', lmStudio)).toEqual({
      method: 'local_models.lm_studio.unload',
      params: { model: 'google/gemma-3n-e4b' },
    });
  });

  it('normalizes Python hardware fields for the Models UI', () => {
    expect(
      normalizeHardware({
        system_ram_gb: 31.75,
        vram_gb: 11.99,
        gpu_name: 'NVIDIA GeForce RTX 4070',
        cpu_threads: 16,
        acceleration: ['cuda'],
      }),
    ).toEqual({
      ramBytes: 31.75 * 1024 ** 3,
      vramBytes: 11.99 * 1024 ** 3,
      gpu: 'NVIDIA GeForce RTX 4070',
      cpu: '16 threads',
      acceleration: ['cuda'],
    });
  });

  it('maps discovered runtime state for the Models screen', () => {
    expect(
      mapDiscoveredRuntime({
        id: 'lm_studio:http://127.0.0.1:1234',
        kind: 'lm_studio',
        state: 'ready',
        models: ['google/gemma-3n-e4b'],
      }),
    ).toEqual({
      id: 'lm_studio:http://127.0.0.1:1234',
      name: 'LM Studio',
      status: 'ready',
      models: ['google/gemma-3n-e4b'],
      detail: undefined,
    });
  });
});
