import { expect, test } from '@playwright/test';

test('a disconnected selected model blocks sending and project cards keep global artifact totals', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const runtimeCalls: string[] = [];
    Object.assign(window, { __modelAvailabilityCalls: runtimeCalls });
    Object.defineProperty(window, 'cupcake', {
      value: {
        apiVersion: 1,
        platform: 'win32',
        app: {
          getInfo: async () => {
            await Promise.resolve();
            return {
              apiVersion: 1,
              appVersion: 'test',
              platform: 'win32',
              packaged: false,
              runtime: 'ready',
            };
          },
        },
        workspace: {
          status: async () => {
            await Promise.resolve();
            return { state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 };
          },
          onStatus: () => () => {},
        },
        window: {
          minimize: async () => {},
          toggleMaximize: async () => {
            await Promise.resolve();
            return false;
          },
          close: async () => {},
          isMaximized: async () => {
            await Promise.resolve();
            return false;
          },
        },
        dialog: {
          openFiles: async () => {
            await Promise.resolve();
            return [];
          },
          openDirectory: async () => {
            await Promise.resolve();
            return null;
          },
          chooseSaveTarget: async () => {
            await Promise.resolve();
            return null;
          },
          releaseHandle: async () => {},
        },
        commands: { execute: async () => {}, onCommand: () => () => {} },
        runtime: {
          status: async () => {
            await Promise.resolve();
            return { state: 'ready', mode: 'broker', restartCount: 0 };
          },
          cancel: async () => {
            await Promise.resolve();
            return true;
          },
          onEvent: () => () => {},
          onStatus: () => () => {},
          request: async ({ method }: { method: string }) => {
            await Promise.resolve();
            runtimeCalls.push(method);
            const openAiModel = {
              id: 'openai:gpt-6-astra',
              provider: 'openai',
              model: 'gpt-6-astra',
              display_name: 'GPT-6 Astra',
              privacy_route: 'cloud',
              context_window: 1_050_000,
              capabilities: ['chat', 'reasoning'],
            };
            const results: Record<string, unknown> = {
              'app.bootstrap': {
                selectedModelId: openAiModel.id,
                projects: [
                  { id: 'northstar', name: 'Northstar', description: '', status: 'active' },
                  { id: 'atlas', name: 'Atlas', description: '', status: 'active' },
                ],
                artifactCounts: { northstar: 2, atlas: 1 },
                conversations: [],
                models: [openAiModel],
                tools: [],
                hardware: {},
                localRuntimes: [],
                suggestionsEnabled: false,
              },
              'models.list': [openAiModel],
              'tasks.list': [],
              'memory.list': [],
              'providers.status': {
                providers: [{ provider: 'openai', configured: false }],
              },
              'settings.list': {},
              'broker.permission_mode.get': { mode: 'guarded' },
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
            return { ok: true, result: results[method] };
          },
        },
      },
    });
  });

  await page.goto('/');
  await expect(page.locator('.home-hero')).toBeVisible();
  await expect(
    page.locator('.project-mini-grid button').filter({ hasText: 'Northstar' }),
  ).toContainText('2 artifacts');
  await expect(
    page.locator('.project-mini-grid button').filter({ hasText: 'Atlas' }),
  ).toContainText('1 artifact');

  await expect(page.getByRole('button', { name: /GPT-6 Astra unavailable/ })).toBeVisible();
  await page.getByLabel('Message Cupcake').fill('This must stay as a draft');
  await expect(
    page.getByRole('button', { name: 'Choose a ready model before sending' }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as unknown as { __modelAvailabilityCalls: string[] }).__modelAvailabilityCalls,
    ),
  ).not.toContain('chat.send');

  await page.keyboard.press('Control+M');
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await expect(picker.getByText('Current model unavailable')).toBeVisible();
  await expect(picker.getByText('Connect OpenAI to use this route')).toBeVisible();
});
