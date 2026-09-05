import { describe, expect, it } from 'vitest';
import {
  applyRuntimeStartupSettings,
  normalizeArtifactCounts,
  recoverWorkspaceSupportRequest,
  type WorkspaceSettings,
} from './workspace';

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

  it('hydrates the saved identity, scene and offline boundary before readiness', () => {
    const current = {
      theme: 'light',
      wallpaper: 'none',
      reducedMotion: false,
      scrollbarMode: 'slim',
      onboardingCompleted: false,
      profile: { displayName: 'Fixture name', role: '', bio: '', avatar: 'atlas:0' },
      assistantAvatar: 'atlas:1',
    } as WorkspaceSettings;

    const hydrated = applyRuntimeStartupSettings(current, {
      'appearance.theme': 'cupcake-dark',
      'appearance.wallpaper': 'copper-workshop',
      'appearance.scrollbars': 'minimal',
      'accessibility.reduced_motion': true,
      'onboarding.completed_v1': true,
      'profile.display_name': 'Saved owner',
      'profile.role': 'Research lead',
      'profile.avatar': 'atlas:12',
      'assistant.avatar': 'atlas:9',
      'privacy.default_mode': 'offline',
    });

    expect(hydrated).toMatchObject({
      theme: 'dark',
      wallpaper: 'copper-workshop',
      offline: true,
      reducedMotion: true,
      scrollbarMode: 'minimal',
      onboardingCompleted: true,
      profile: {
        displayName: 'Saved owner',
        role: 'Research lead',
        avatar: 'atlas:12',
      },
      assistantAvatar: 'atlas:9',
    });
  });

  it('keeps authoritative counts for every project and rejects malformed totals', () => {
    expect(
      normalizeArtifactCounts({
        northstar: 2,
        atlas: 1,
        negative: -1,
        partial: 1.5,
        unknown: 'many',
      }),
    ).toEqual({ northstar: 2, atlas: 1 });
  });
});
