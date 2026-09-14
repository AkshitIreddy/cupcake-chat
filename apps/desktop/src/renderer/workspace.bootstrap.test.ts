import { describe, expect, it } from 'vitest';
import {
  applyRuntimeStartupSettings,
  conversationsForProject,
  countActiveConversationsByProject,
  normalizeArtifactCounts,
  projectConversationCountsFromInventory,
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

  it.each([
    'history-roman-camp',
    'history-greek-harbor',
    'history-egyptian-nile',
    'history-viking-fjord',
    'history-mongol-steppe',
    'history-medieval-garden',
    'strawberry-cupcake-patisserie',
    'lavender-cloud-parlour',
    'ember-rain-cafe',
    'citrus-solar-studio',
  ] as const)('hydrates the %s scene without falling back to none', (wallpaper) => {
    const current = {
      theme: 'light',
      wallpaper: 'none',
      profile: { displayName: 'Owner', role: '', bio: '', avatar: 'atlas:0' },
      assistantAvatar: 'atlas:1',
    } as WorkspaceSettings;

    expect(
      applyRuntimeStartupSettings(current, { 'appearance.wallpaper': wallpaper }).wallpaper,
    ).toBe(wallpaper);
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

  it('counts active conversation summaries by project without loading project content', () => {
    expect(
      countActiveConversationsByProject([
        { project_id: 'studio', status: 'active' },
        { project_id: 'studio', status: 'active' },
        { project_id: 'pantry' },
        { project_id: 'pantry', status: 'archived' },
        { project_id: null, status: 'active' },
      ]),
    ).toEqual({ studio: 2, pantry: 1 });
    expect(
      projectConversationCountsFromInventory(
        [
          { project_id: 'studio', status: 'active' },
          { project_id: 'pantry', status: 'active' },
        ],
        2,
      ),
    ).toBeNull();
  });

  it('derives cross-project navigation lists from metadata without mixing project context', () => {
    const inventory = [
      {
        id: 'pantry-chat',
        title: 'Pantry',
        preview: '',
        updated: 'today',
        projectId: 'pantry',
      },
      {
        id: 'studio-chat',
        title: 'Studio',
        preview: '',
        updated: 'today',
        projectId: 'studio',
      },
      {
        id: 'loose-chat',
        title: 'Loose',
        preview: '',
        updated: 'today',
        projectId: null,
      },
    ];

    expect(conversationsForProject(inventory, 'pantry').map((item) => item.id)).toEqual([
      'pantry-chat',
    ]);
    expect(conversationsForProject(inventory, null).map((item) => item.id)).toEqual(['loose-chat']);
  });
});
