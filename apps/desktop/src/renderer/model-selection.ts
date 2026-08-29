import type { ModelDescriptor } from './types';

export interface ModelSelectionOptions {
  compatibilityConfirmed?: boolean;
}

/**
 * Product commands always address the catalog descriptor, not a provider's
 * native model key. The native key is reserved for runtime management calls
 * such as LM Studio load and unload.
 */
export function canonicalModelId(model: ModelDescriptor): string {
  return model.id;
}

export function requiresCompatibilityAcknowledgement(model: ModelDescriptor): boolean {
  return model.provider === 'NVIDIA NIM' && model.chatCompatibility === 'unknown';
}

export function modelSelectionParams(
  model: ModelDescriptor,
  acknowledged: boolean,
): { modelId: string; compatibilityConfirmed: boolean } {
  return {
    modelId: canonicalModelId(model),
    compatibilityConfirmed: requiresCompatibilityAcknowledgement(model) && acknowledged,
  };
}

/**
 * Merge refreshed descriptors without losing the authoritative persisted choice.
 *
 * A selected model can arrive after bootstrap (for example, dynamic NVIDIA NIM
 * or local discovery). The desired ID therefore remains meaningful even when
 * it is not present in the first catalog fragment. A newer user selection wins
 * over an older bootstrap snapshot while a background refresh is in flight.
 */
export function mergeModelDescriptors(
  current: ModelDescriptor[],
  incoming: ModelDescriptor[],
  desiredSelectedId?: string | null,
): ModelDescriptor[] {
  const currentSelectedId = current.find((model) => model.selected)?.id;
  const selectedId = desiredSelectedId ?? currentSelectedId;
  const incomingIds = new Set(incoming.map((model) => model.id));
  const merged = [...current.filter((model) => !incomingIds.has(model.id)), ...incoming];
  return merged.map((model) => ({ ...model, selected: model.id === selectedId }));
}

/** Coalesces duplicate requests while releasing failed keys for an explicit retry. */
export function createKeyedRequestCoalescer() {
  const pending = new Map<string, Promise<void>>();
  return (key: string, operation: () => Promise<void>): Promise<void> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const request = operation().finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
    return request;
  };
}
