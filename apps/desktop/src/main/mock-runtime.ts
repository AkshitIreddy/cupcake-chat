import { EventEmitter } from 'node:events';
import type {
  RuntimeEvent,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeStatus,
} from '../shared/desktop-api';
import { uuidV7 } from './ids';

const MOCK_SENTENCE =
  'The desktop runtime is using its deterministic preview mode. Connect the packaged broker to run models and tools.';

export class MockRuntime extends EventEmitter {
  #sequence = 0;
  #closed = false;

  status(): RuntimeStatus {
    return {
      state: this.#closed ? 'stopped' : 'degraded',
      mode: 'mock',
      restartCount: 0,
      detail: this.#closed
        ? 'Preview runtime stopped'
        : 'Packaged broker unavailable; deterministic preview is active',
    };
  }

  async request<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
    if (this.#closed) return failure('RUNTIME_STOPPED', 'The preview runtime is stopped');

    if (request.method === 'system.bootstrap' || request.method === 'app.bootstrap') {
      return success({
        mode: 'mock',
        providers: ['openai', 'anthropic', 'gemini', 'xai', 'mistral', 'cohere'],
        localRuntimes: ['cupcake-local', 'ollama', 'lm-studio', 'vllm'],
        features: ['chat', 'projects', 'tasks', 'artifacts', 'memory', 'models', 'tools', 'search'],
      } as T);
    }

    if (request.method === 'chat.send') {
      const runId = uuidV7();
      this.#emit('message.started', { runId });
      const words = MOCK_SENTENCE.split(' ');
      for (const [index, word] of words.entries()) {
        await new Promise((resolve) => setTimeout(resolve, 14));
        this.#emit('message.delta', { runId, delta: `${index ? ' ' : ''}${word}` });
      }
      this.#emit('message.completed', { runId, content: MOCK_SENTENCE });
      return success({ runId, content: MOCK_SENTENCE } as T);
    }

    if (request.method === 'runtime.health') {
      return success({ healthy: true, mode: 'mock' } as T);
    }

    return failure('MOCK_METHOD_UNAVAILABLE', `Preview mode does not implement ${request.method}`);
  }

  cancel(targetId: string): boolean {
    if (this.#closed) return false;
    this.#emit('run.cancelled', { targetId });
    return true;
  }

  close(): void {
    this.#closed = true;
    this.removeAllListeners();
  }

  #emit(type: string, payload: unknown): void {
    const event: RuntimeEvent = {
      sequence: ++this.#sequence,
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.emit('event', event);
  }
}

function success<T>(result: T): RuntimeResponse<T> {
  return { ok: true, result };
}

function failure<T>(code: string, message: string): RuntimeResponse<T> {
  return { ok: false, error: { code, message, retryable: false } };
}
