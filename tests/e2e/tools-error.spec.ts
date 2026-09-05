import { expect, test } from '@playwright/test';

test('tool toggle stays unchanged when the desktop bridge rejects persistence', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'cupcake-workspace-settings',
      JSON.stringify({ onboardingCompleted: true }),
    );
    Object.defineProperty(window, 'cupcake', {
      value: {
        apiVersion: 1,
        platform: 'win32',
        app: {
          getInfo: () =>
            Promise.resolve({
              apiVersion: 1,
              appVersion: 'test',
              platform: 'win32',
              packaged: false,
              runtime: 'ready',
            }),
        },
        workspace: {
          status: () => Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
          setup: () => Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
          setupWithoutPassword: () =>
            Promise.resolve({
              state: 'unlocked',
              failedAttempts: 0,
              retryAfterMs: 0,
            }),
          unlock: () => Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
          onStatus: () => () => undefined,
        },
        window: {
          minimize: () => Promise.resolve(),
          toggleMaximize: () => Promise.resolve(false),
          close: () => Promise.resolve(),
          isMaximized: () => Promise.resolve(false),
        },
        dialog: {
          openFiles: () => Promise.resolve([]),
          openDirectory: () => Promise.resolve(null),
          chooseSaveTarget: () => Promise.resolve(null),
          releaseHandle: () => Promise.resolve(),
        },
        commands: { execute: () => Promise.resolve(), onCommand: () => () => undefined },
        runtime: {
          status: () => Promise.resolve({ state: 'ready', mode: 'broker', restartCount: 0 }),
          cancel: () => Promise.resolve(true),
          onEvent: () => () => undefined,
          onStatus: () => () => undefined,
          request: ({ method }: { method: string }) => {
            if (method === 'settings.set') {
              return Promise.resolve({
                ok: false,
                error: { code: 'INJECTED_REFUSAL', message: 'Injected bridge refusal.' },
              });
            }
            const results: Record<string, unknown> = {
              'app.bootstrap': {
                selectedModelId: null,
                projects: [],
                conversations: [],
                models: [],
                tools: [
                  {
                    id: 'files',
                    name: 'files',
                    display_name: 'Files & folders',
                    description: 'Read approved files and folders.',
                    provider: 'native',
                    kind: 'native',
                    effects: ['filesystem.read'],
                    required_grants: ['selected folders'],
                    enabled: true,
                  },
                ],
                hardware: {},
                localRuntimes: [],
                suggestionsEnabled: false,
              },
              'tasks.list': [],
              'memory.list': [],
              'providers.status': { providers: [] },
              'settings.list': { 'onboarding.completed_v1': true },
              'migration.detect': { state: 'not_found', available: false },
              'local_models.cupcake.status': {
                activeModelId: null,
                availableModels: [],
                models: [],
                recommendations: [],
                downloads: [],
                availableRuntimes: [],
                runtimes: [],
                runtimeRecommendations: [],
                hardware: {},
              },
              'artifacts.list': [],
              'developer.events': [],
            };
            return Promise.resolve({ ok: true, result: results[method] });
          },
        },
      },
    });
  });

  await page.goto('/?view=tools');
  const toggle = page.getByRole('switch', { name: 'Enable Files & folders' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('Injected bridge refusal.');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
});
