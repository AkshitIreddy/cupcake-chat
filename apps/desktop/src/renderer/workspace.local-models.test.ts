import { describe, expect, it } from 'vitest';
import {
  automaticRamBudgetGb,
  localModelActionRequest,
  mapCupcakeLocalModels,
  mapCupcakeRuntimePacks,
  mapDiscoveredRuntime,
  mapModel,
  mapDownloads,
  mapDownloadSnapshot,
  reconcileDownloadSnapshots,
  normalizeHardware,
} from './workspace';

describe('workspace local model integration', () => {
  it('keeps real progress when an older startup snapshot finishes later', () => {
    const live = mapDownloads({
      downloads: [
        { model_id: 'qwen', state: 'paused', bytes_downloaded: 196608, bytes_total: 639446688 },
      ],
    });
    expect(reconcileDownloadSnapshots(live, [], true)).toEqual(live);
    const old = mapDownloads({
      availableModels: [{ id: 'qwen', display_name: 'Qwen' }],
      downloads: [{ model_id: 'qwen', state: 'downloading', bytes_downloaded: 0 }],
    });
    expect(reconcileDownloadSnapshots(live, old, true)[0]).toMatchObject({
      name: 'Qwen',
      state: 'paused',
      bytesReceived: 196608,
    });
    expect(reconcileDownloadSnapshots(live, [], false)).toEqual([]);
  });
  it('keeps CUDA companion controls tied to their file and resume tied to the parent pack', () => {
    const [companion] = mapDownloads({
      availableRuntimes: [
        { id: 'cuda-pack', companions: [{ id: 'cuda-dlls', display_name: 'CUDA libraries' }] },
      ],
      downloads: [
        { model_id: 'cuda-dlls', state: 'paused', bytes_downloaded: 512, bytes_total: 2048 },
      ],
    });
    expect(companion).toMatchObject({
      id: 'cuda-dlls',
      parentId: 'cuda-pack',
      kind: 'runtime',
      name: 'CUDA libraries',
      state: 'paused',
      bytesReceived: 512,
    });
    expect(
      mapDownloadSnapshot(
        { model_id: 'cuda-dlls', state: 'downloading', bytes_downloaded: 1024 },
        companion,
      ),
    ).toMatchObject({
      id: 'cuda-dlls',
      parentId: 'cuda-pack',
      name: 'CUDA libraries',
      totalBytes: 2048,
      bytesReceived: 1024,
    });
  });

  it('retains paused and failed downloads even when the model catalog is unavailable', () => {
    const rows = mapDownloads({
      downloads: [
        { model_id: 'paused-model', state: 'paused', bytes_downloaded: 1024, bytes_total: 4096 },
        { model_id: 'failed-model', state: 'failed', error_detail: 'Connection interrupted' },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'paused-model', state: 'paused', bytesReceived: 1024 });
    expect(rows[1]).toMatchObject({
      id: 'failed-model',
      state: 'failed',
      error: 'Connection interrupted',
    });
  });

  const cupcakeLocal = mapModel({
    id: 'cupcake-local:qwen3-4b-q4-k-m',
    provider: 'cupcake_local',
    model: 'qwen3-4b-q4-k-m',
    display_name: 'Qwen3 4B · Q4_K_M',
    privacy_route: 'local',
    context_window: 131_072,
    metadata: { runtime_kind: 'cupcake_local', lifecycle_state: 'installed' },
  });

  it('preserves Cupcake Local catalog identity and managed model key', () => {
    expect(cupcakeLocal).toEqual(
      expect.objectContaining({
        provider: 'Cupcake Local',
        route: 'Local',
        runtimeModelId: 'qwen3-4b-q4-k-m',
      }),
    );
  });

  it('keeps an incomplete live catalog row from crashing the Models page', () => {
    expect(
      mapModel({
        id: 'nvidia-nim:publisher/model-with-partial-metadata',
        model: 'publisher/model-with-partial-metadata',
      }),
    ).toEqual(
      expect.objectContaining({
        id: 'nvidia-nim:publisher/model-with-partial-metadata',
        provider: 'Unknown',
        name: 'publisher/model-with-partial-metadata',
      }),
    );
  });

  it('keeps named compatible hosts visible as the serving provider', () => {
    expect(
      mapModel({
        id: 'openai-compatible:groq/openai/gpt-oss-20b',
        provider: 'openai-compatible',
        model: 'openai/gpt-oss-20b',
        display_name: 'GPT-OSS 20B via Groq',
        privacy_route: 'self_hosted',
        metadata: { endpoint_id: 'groq' },
      }),
    ).toEqual(
      expect.objectContaining({
        provider: 'Groq',
        route: 'Cloud',
      }),
    );
  });

  it('routes load and unload through the app-managed Cupcake Local lifecycle', () => {
    expect(localModelActionRequest('load', cupcakeLocal)).toEqual({
      method: 'local_models.cupcake.load',
      params: { modelId: 'qwen3-4b-q4-k-m' },
    });
    expect(localModelActionRequest('unload', cupcakeLocal)).toEqual({
      method: 'local_models.cupcake.unload',
      params: {},
    });
    expect(localModelActionRequest('download', cupcakeLocal)).toEqual({
      method: 'local_models.cupcake.download',
      params: { artifactId: 'qwen3-4b-q4-k-m', artifactKind: 'model' },
    });
    expect(localModelActionRequest('resume', cupcakeLocal)).toEqual({
      method: 'local_models.cupcake.download',
      params: { artifactId: 'qwen3-4b-q4-k-m', artifactKind: 'model' },
    });
  });

  it('forwards the explicit VRAM and RAM placement policy when loading', () => {
    expect(
      localModelActionRequest('load', cupcakeLocal, {
        allowRamFallback: false,
        ramLimitMode: 'manual',
        maxRamGb: 20,
      }),
    ).toEqual({
      method: 'local_models.cupcake.load',
      params: {
        modelId: 'qwen3-4b-q4-k-m',
        allowRamFallback: false,
        ramLimitMode: 'manual',
        maxRamGb: 20,
        gpuLayers: 'all',
      },
    });
  });

  it('uses a dynamic available-memory budget in automatic RAM mode', () => {
    const gib = 1024 ** 3;
    expect(automaticRamBudgetGb({ ramBytes: 32 * gib, availableRamBytes: 21.4 * gib }, 4)).toBe(
      17.4,
    );
    expect(automaticRamBudgetGb({ ramBytes: 16 * gib, availableRamBytes: 5 * gib }, 4)).toBe(1);
    expect(automaticRamBudgetGb({ ramBytes: 16 * gib, availableRamBytes: 3 * gib }, 4)).toBe(0);
    expect(automaticRamBudgetGb({ ramBytes: 64 * gib }, 8)).toBe(48);
  });

  it('lets the runtime calculate the live limit instead of forwarding a fixed ceiling in auto mode', () => {
    expect(
      localModelActionRequest('load', cupcakeLocal, {
        allowRamFallback: true,
        ramLimitMode: 'auto',
        maxRamGb: 24,
        reserveSystemRamGb: 6,
      }),
    ).toEqual({
      method: 'local_models.cupcake.load',
      params: {
        modelId: 'qwen3-4b-q4-k-m',
        allowRamFallback: true,
        ramLimitMode: 'auto',
        reserveSystemRamGb: 6,
      },
    });
  });

  it('normalizes the complete hardware report emitted by Cupcake Local', () => {
    expect(
      normalizeHardware({
        system_ram_gb: 32,
        available_ram_gb: 20,
        free_disk_gb: 120,
        cpu_name: 'AMD Ryzen 9',
        os_name: 'Windows',
      }),
    ).toEqual({
      ramBytes: 32 * 1024 ** 3,
      availableRamBytes: 20 * 1024 ** 3,
      diskAvailableBytes: 120 * 1024 ** 3,
      cpu: 'AMD Ryzen 9',
      os: 'Windows',
    });
  });

  it('normalizes Python hardware fields for the Models UI', () => {
    expect(
      normalizeHardware({
        system_ram_gb: 31.75,
        vram_gb: 11.99,
        available_vram_gb: 8.25,
        gpu_name: 'NVIDIA GeForce RTX 4070',
        cpu_threads: 16,
        cpu_architecture: 'x86_64',
        disk_available_bytes: 400_000_000_000,
        windows_version: 'Windows 11 24H2',
        acceleration: ['cuda'],
      }),
    ).toEqual({
      ramBytes: 31.75 * 1024 ** 3,
      vramBytes: 11.99 * 1024 ** 3,
      availableVramBytes: 8.25 * 1024 ** 3,
      gpu: 'NVIDIA GeForce RTX 4070',
      cpu: '16 threads',
      cpuArchitecture: 'x86_64',
      diskAvailableBytes: 400_000_000_000,
      windowsVersion: 'Windows 11 24H2',
      acceleration: ['cuda'],
    });
  });

  it('maps discovered runtime state for the Models screen', () => {
    expect(
      mapDiscoveredRuntime({
        id: 'cupcake-local',
        kind: 'cupcake_llama_cpp',
        state: 'ready',
        models: ['qwen3-4b-q4-k-m'],
      }),
    ).toEqual({
      id: 'cupcake-local',
      name: 'Cupcake Local',
      status: 'ready',
      models: ['qwen3-4b-q4-k-m'],
      detail: undefined,
    });
  });

  it('maps the signed model catalog to real artifact ids and lifecycle state', () => {
    const [model] = mapCupcakeLocalModels({
      activeModelId: null,
      availableModels: [
        {
          id: 'qwen3-8b-q4-k-m',
          display_name: 'Qwen3 8B · Q4_K_M',
          parameter_billions: 8,
          quantization: 'Q4_K_M',
          size_bytes: 5_027_783_488,
          context_window: 131_072,
          capability_tags: ['text', 'chat'],
          task_tags: ['code'],
          license: 'Apache-2.0',
          source: 'https://example.invalid/qwen',
          source_revision: 'pinned-revision',
        },
      ],
      recommendations: [
        {
          model_id: 'qwen3-8b-q4-k-m',
          classification: 'recommended',
          estimated_ram_gb: 8,
          estimated_vram_gb: 7.5,
          estimated_disk_gb: 5.4,
          likely_speed_class: 'fast',
          reasons: ['ideal device fit'],
        },
      ],
    });

    expect(model).toEqual(
      expect.objectContaining({
        id: 'cupcake-local:qwen3-8b-q4-k-m',
        runtimeModelId: 'qwen3-8b-q4-k-m',
        provider: 'Cupcake Local',
        status: 'catalog',
        fit: 'recommended',
        fitReason: 'ideal device fit',
      }),
    );
  });

  it('does not present completed download history as an active Qwen download', () => {
    const [model] = mapCupcakeLocalModels({
      availableModels: [{ id: 'qwen3-8b-q4-k-m', display_name: 'Qwen3 8B' }],
      downloads: [
        {
          model_id: 'qwen3-8b-q4-k-m',
          state: 'completed',
          bytes_downloaded: 5_000,
          bytes_total: 5_000,
        },
      ],
    });

    expect(model?.status).toBe('catalog');
    expect(model?.download).toBeUndefined();
  });

  it('exposes required CUDA companion terms with the acceleration pack', () => {
    const packs = mapCupcakeRuntimePacks({
      availableRuntimes: [
        {
          id: 'llama.cpp:b10679:windows-x64-cuda-12.4',
          version: 'b10679',
          backend: 'cuda-12',
          size_bytes: 250,
          license: 'MIT',
          companions: [
            {
              size_bytes: 390,
              license_requires_acceptance: true,
              license_url: 'https://docs.nvidia.com/cuda/eula/index.html',
            },
          ],
        },
      ],
      runtimeRecommendations: [
        {
          runtime_id: 'llama.cpp:b10679:windows-x64-cuda-12.4',
          compatible: true,
          recommended: true,
          reasons: ['driver verified'],
        },
      ],
    });

    expect(packs[0]).toEqual(
      expect.objectContaining({
        status: 'catalog',
        version: 'b10679',
        totalDownloadBytes: 640,
        recommended: true,
        licenseUrls: ['https://docs.nvidia.com/cuda/eula/index.html'],
      }),
    );
  });

  it('does not present completed runtime-pack history as downloading', () => {
    const [runtime] = mapCupcakeRuntimePacks({
      availableRuntimes: [{ id: 'llama.cpp:b10679:windows-x64-cuda-13.3', backend: 'cuda-13' }],
      downloads: [
        {
          model_id: 'llama.cpp:b10679:windows-x64-cuda-13.3',
          state: 'completed',
        },
      ],
    });

    expect(runtime?.status).toBe('catalog');
  });

  it('uses the registered endpoint model id while a local model is loaded', () => {
    const [model] = mapCupcakeLocalModels({
      activeModelId: 'qwen3-4b-q4-k-m',
      availableModels: [
        {
          id: 'qwen3-4b-q4-k-m',
          display_name: 'Qwen3 4B',
          context_window: 8192,
        },
      ],
    });

    expect(model).toBeDefined();
    if (!model) throw new Error('expected a mapped local model');
    expect(model.id).toBe('openai-compatible:cupcake-local/qwen3-4b-q4-k-m');
    expect(model.runtimeModelId).toBe('qwen3-4b-q4-k-m');
    expect(model.status).toBe('ready');
  });

  it('preserves a selected local route while its model waits for just-in-time loading', () => {
    const routeId = 'openai-compatible:cupcake-local/qwen3-4b-q4-k-m';
    const [model] = mapCupcakeLocalModels(
      {
        activeModelId: null,
        availableModels: [
          {
            id: 'qwen3-4b-q4-k-m',
            display_name: 'Qwen3 4B',
            context_window: 8192,
          },
        ],
        models: [{ id: 'qwen3-4b-q4-k-m' }],
      },
      routeId,
    );

    expect(model).toEqual(
      expect.objectContaining({ id: routeId, selected: true, status: 'installed' }),
    );
  });
});
