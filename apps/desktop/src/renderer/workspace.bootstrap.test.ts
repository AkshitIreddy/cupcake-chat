import { describe, expect, it } from 'vitest';
import { recoverWorkspaceSupportRequest } from './workspace';

describe('workspace bootstrap isolation', () => {
  it('keeps provider data when an auxiliary memory request is rejected', async () => {
    const [memory, providers] = await Promise.all([
      recoverWorkspaceSupportRequest(
        'Memory',
        Promise.reject(new Error('invalid MemoryState value')),
        [],
      ),
      recoverWorkspaceSupportRequest(
        'Providers',
        Promise.resolve({ providers: [{ provider: 'nvidia-nim', configured: true }] }),
        { providers: [] as Array<{ provider: string; configured: boolean }> },
      ),
    ]);

    expect(memory.value).toEqual([]);
    expect(memory.failure).toContain('invalid MemoryState value');
    expect(providers.failure).toBeUndefined();
    expect(providers.value.providers).toEqual([{ provider: 'nvidia-nim', configured: true }]);
  });
});
