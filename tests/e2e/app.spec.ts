import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('home, navigation, command palette and explicit model picker work', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: /Good (morning|afternoon|evening), Akshit/ }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 640) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'Models' }).click();
  await expect(page.getByRole('heading', { name: 'Models', exact: true }).last()).toBeVisible();
  await expect(page.getByText('Cupcake never routes automatically.')).toBeVisible();

  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByPlaceholder('What would you like to do?').fill('Change model');
  await page.getByRole('button', { name: /Change model/ }).click();
  await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeVisible();
  await expect(page.getByText('There is no Auto mode.')).toBeVisible();
});

test('chat accepts multiline input and labels deterministic fixture mode', async ({ page }) => {
  await page.goto('/?view=chat');
  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('First line');
  await composer.press('Shift+Enter');
  await composer.type('Second line');
  await expect(composer).toHaveValue('First line\nSecond line');
  await composer.press('Enter');
  await expect(page.getByText('First line\nSecond line')).toBeVisible();
  await expect(page.getByText(/Deterministic fixture response/)).toBeVisible();
  await expect(
    page.getByText(/desktop bridge absent; no provider, file, or tool call can leave/i),
  ).toBeVisible();
});

test('offline mode hard-blocks cloud sends and never invents a local model', async ({ page }) => {
  await page.goto('/?view=settings');
  await page.getByRole('button', { name: 'General' }).click();
  await page.getByRole('switch', { name: 'Offline mode' }).click();
  await page.goto('/?view=chat');
  await expect(page.getByRole('button', { name: /Choose a local model/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(page.getByText(/Offline mode blocks cloud sends/)).toBeVisible();
});

test('keyboard navigation exposes regions, outline, and shortcut reference', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.getByRole('button', { name: 'Close shortcut reference' }).click();
  await page.keyboard.press('F6');
  await expect(page.locator('.shelf')).toBeFocused();
});

test('memory refuses NVIDIA and generic credential-shaped text', async ({ page }) => {
  await page.goto('/?view=memory');
  const answers = ['Provider key', 'nvapi-SYNTHETIC_TEST_VALUE_123456'];
  page.on('dialog', (dialog) => dialog.accept(answers.shift() ?? ''));
  await page.getByRole('button', { name: 'Add memory' }).click();
  await expect(page.getByText(/Credentials cannot be saved as memory/)).toBeVisible();
});

test('themes, reduced-motion contract and narrow layout avoid horizontal overflow', async ({
  page,
}) => {
  await page.goto('/?view=chat&theme=dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
});

test('primary screens have no serious or critical automated accessibility violations', async ({
  page,
}) => {
  for (const view of ['home', 'chat', 'memory', 'models', 'tools', 'settings']) {
    await page.goto(`/?view=${view}`);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      ({ impact }) => impact === 'critical' || impact === 'serious',
    );
    expect(blocking, `${view}: ${blocking.map(({ id }) => id).join(', ')}`).toEqual([]);
  }
});

test('every shipped theme keeps the chat surface AA-clean', async ({ page }) => {
  for (const theme of ['light', 'dark', 'minimal', 'classic']) {
    await page.goto(`/?view=chat&theme=${theme}`);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      ({ impact }) => impact === 'critical' || impact === 'serious',
    );
    expect(blocking, `${theme}: ${blocking.map(({ id }) => id).join(', ')}`).toEqual([]);
  }
});

test('live workspace windows long history and switches immutable branches', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, { __runtimeCalls: calls });
    const history = (branchId: string) =>
      branchId === 'branch-b'
        ? [
            {
              id: 'branch-b-message',
              branch_id: branchId,
              role: 'assistant',
              content: 'Sibling branch B is intact.',
            },
          ]
        : Array.from({ length: 500 }, (_, index) => ({
            id: `message-${index}`,
            branch_id: branchId,
            role: index % 2 ? 'assistant' : 'user',
            content: `Persisted turn ${index}`,
          }));
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
        window: {
          minimize: async () => {
            await Promise.resolve();
          },
          toggleMaximize: async () => {
            await Promise.resolve();
            return false;
          },
          close: async () => {
            await Promise.resolve();
          },
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
          request: async ({ method, params }: { method: string; params?: unknown }) => {
            await Promise.resolve();
            calls.push(method);
            const results: Record<string, unknown> = {
              'app.bootstrap': {
                selectedModelId: 'mock:cupcake-deterministic',
                projects: [
                  {
                    id: 'project-1',
                    name: 'Private project',
                    description: 'Boundary',
                    status: 'active',
                  },
                ],
                conversations: [
                  {
                    id: 'conversation-1',
                    title: 'Long history',
                    project_id: 'project-1',
                    status: 'active',
                  },
                ],
                models: [
                  {
                    id: 'mock:cupcake-deterministic',
                    provider: 'mock',
                    model: 'cupcake-deterministic',
                    display_name: 'Deterministic local',
                    privacy_route: 'local',
                    capabilities: ['chat'],
                    reasoning_presets: ['none'],
                  },
                ],
                tools: [],
                hardware: {},
                localRuntimes: [],
                suggestionsEnabled: false,
              },
              'tasks.list': [],
              'memory.list': [],
              'providers.status': { providers: [] },
              'settings.list': {},
              'migration.detect': { state: 'not_found', available: false },
              'artifacts.list': [],
              'developer.events': [],
              'conversations.get': {
                branches: [
                  { id: 'branch-a', conversation_id: 'conversation-1', name: 'Main' },
                  { id: 'branch-b', conversation_id: 'conversation-1', name: 'Sibling B' },
                ],
                activeBranchId: 'branch-a',
              },
              'conversations.list': [
                {
                  id: 'conversation-1',
                  title: 'Long history',
                  project_id: 'project-1',
                  status: 'active',
                },
              ],
              'chat.edit': {
                conversationId: 'conversation-1',
                branchId: 'branch-b',
                runId: 'edit-run',
              },
              'chat.regenerate': {
                conversationId: 'conversation-1',
                branchId: 'branch-b',
                runId: 'retry-run',
              },
            };
            if (method === 'chat.history')
              return {
                ok: true,
                result: history(
                  (params as { branchId?: string } | undefined)?.branchId ?? 'branch-a',
                ),
              };
            return { ok: true, result: results[method] };
          },
        },
      },
    });
  });
  await page.goto('/?view=chats');
  await page.locator('.chat-list__main').filter({ hasText: 'Long history' }).click();
  await expect(page.locator('.live-conversation')).toHaveAttribute('data-rendered-messages', '80');
  await expect(page.getByText('500 turns')).toBeVisible();

  const assistantTurn = page.locator('article.turn--assistant').filter({
    has: page.getByText('Persisted turn 499', { exact: true }),
  });
  await expect(assistantTurn.getByTitle('Edit')).toHaveCount(0);
  const userTurn = page.locator('article.turn--user').filter({
    has: page.getByText('Persisted turn 498', { exact: true }),
  });
  await expect(userTurn.getByTitle('Edit')).toBeVisible();

  await page.getByRole('button', { name: 'Sibling B' }).click();
  await expect(page.getByText('Sibling branch B is intact.')).toBeVisible();
  await expect(page.locator('article.turn--assistant').getByTitle('Edit')).toHaveCount(0);

  await page.getByRole('button', { name: 'Main' }).click();
  await expect(page.getByText('Persisted turn 498', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept('Edited sibling text'));
  await page
    .locator('article.turn--user')
    .filter({ has: page.getByText('Persisted turn 498', { exact: true }) })
    .getByTitle('Edit')
    .click();
  await expect(page.getByText('Sibling branch B is intact.')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __runtimeCalls: string[] }).__runtimeCalls),
  ).toContain('chat.edit');
});

test('configured NIM catalog enables an explicitly confirmed model', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    Object.assign(window, { __nimRuntimeCalls: calls });
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
        window: {
          minimize: async () => {
            await Promise.resolve();
          },
          toggleMaximize: async () => {
            await Promise.resolve();
            return false;
          },
          close: async () => {
            await Promise.resolve();
          },
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
          releaseHandle: async () => {
            await Promise.resolve();
          },
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
          request: async ({ method, params }: { method: string; params?: unknown }) => {
            await Promise.resolve();
            calls.push({ method, params });
            const result: Record<string, unknown> = {
              'app.bootstrap': {
                selectedModelId: 'nvidia-nim:nvidia/nemotron-3-nano-30b-a3b',
                projects: [],
                conversations: [],
                models: [
                  {
                    id: 'mock:cupcake-deterministic',
                    provider: 'mock',
                    model: 'cupcake-deterministic',
                    display_name: 'Deterministic local',
                    privacy_route: 'local',
                    capabilities: ['chat'],
                  },
                ],
                tools: [],
                hardware: {},
                localRuntimes: [],
                suggestionsEnabled: false,
              },
              'tasks.list': [],
              'memory.list': [],
              'providers.status': {
                providers: [{ provider: 'nvidia-nim', configured: true }],
              },
              'providers.catalog.refresh': {
                catalog: {
                  models: [
                    {
                      id: 'nvidia-nim:nvidia/nemotron-3-nano-30b-a3b',
                      provider: 'nvidia-nim',
                      model: 'nvidia/nemotron-3-nano-30b-a3b',
                      display_name: 'Nemotron 3 Nano',
                      privacy_route: 'cloud',
                      capabilities: { streaming: true },
                      metadata: { chat_compatibility: 'unknown' },
                    },
                  ],
                },
              },
              'settings.list': {},
              'migration.detect': { state: 'not_found', available: false },
              'models.select': {},
            };
            return { ok: true, result: result[method] };
          },
        },
      },
    });
  });

  await page.goto('/');
  await page.keyboard.press('Control+M');
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  const nim = picker.getByRole('button', { name: /NVIDIA NIM/ });
  await expect(nim).toBeEnabled();
  await expect(nim).toHaveClass(/is-active/);
  await nim.click();

  const compatibility = page.getByRole('dialog', {
    name: 'Confirm unverified model compatibility',
  });
  await expect(compatibility).toBeVisible();
  const confirm = compatibility.getByRole('button', { name: 'Confirm and select' });
  await expect(confirm).toBeDisabled();
  const acknowledgement = compatibility.getByRole('checkbox', {
    name: /I checked the model information and accept the unverified compatibility/,
  });
  await acknowledgement.check();
  await expect(acknowledgement).toBeChecked();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(compatibility).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeHidden();
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __nimRuntimeCalls: Array<{ method: string; params?: unknown }> })
        .__nimRuntimeCalls,
  );
  expect(calls).toContainEqual({
    method: 'models.select',
    params: {
      modelId: 'nvidia-nim:nvidia/nemotron-3-nano-30b-a3b',
      compatibilityConfirmed: true,
    },
  });
  const memoryList = calls.find((item) => item.method === 'memory.list');
  expect(memoryList?.params).not.toMatchObject({ states: expect.arrayContaining(['disabled']) });
});

test('discovered LM Studio model keeps its canonical id through selection and chat', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    Object.assign(window, { __localModelRuntimeCalls: calls });
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
          request: async ({ method, params }: { method: string; params?: unknown }) => {
            await Promise.resolve();
            calls.push({ method, params });
            const canonicalId =
              'openai-compatible:lm_studio-http---127-0-0-1-1234/google/gemma-3n-e4b';
            const results: Record<string, unknown> = {
              'app.bootstrap': {
                selectedModelId: 'mock:cupcake-deterministic',
                projects: [],
                conversations: [],
                models: [
                  {
                    id: 'mock:cupcake-deterministic',
                    provider: 'mock',
                    model: 'cupcake-deterministic',
                    display_name: 'Deterministic local',
                    privacy_route: 'local',
                    capabilities: ['chat'],
                  },
                ],
                tools: [],
                hardware: {},
                localRuntimes: [],
                suggestionsEnabled: false,
              },
              'tasks.list': [],
              'memory.list': [],
              'providers.status': { providers: [] },
              'settings.list': {},
              'migration.detect': { state: 'not_found', available: false },
              'local_models.discover': {
                endpoints: [
                  {
                    id: 'lm_studio:http://127.0.0.1:1234',
                    kind: 'lm_studio',
                    state: 'ready',
                    models: ['google/gemma-3n-e4b'],
                  },
                ],
                models: [
                  {
                    id: canonicalId,
                    provider: 'openai-compatible',
                    model: 'google/gemma-3n-e4b',
                    display_name: 'Gemma 3n E4B',
                    privacy_route: 'local',
                    context_window: 32_768,
                    capabilities: { streaming: true },
                    metadata: {
                      runtime_kind: 'lm_studio',
                      runtime_loaded: true,
                      endpoint_id: 'lm_studio-http---127-0-0-1-1234',
                    },
                  },
                ],
              },
              'models.select': {},
              'conversations.create': {
                conversation: {
                  id: 'conversation-local',
                  title: 'Local chat',
                  status: 'active',
                },
                branch: {
                  id: 'branch-local',
                  conversation_id: 'conversation-local',
                  name: 'Main',
                },
              },
              'chat.send': {
                conversationId: 'conversation-local',
                branchId: 'branch-local',
                content: 'Local response',
              },
              'chat.history': [],
              'conversations.list': [],
              'conversations.get': { branches: [], activeBranchId: 'branch-local' },
              'artifacts.list': [],
              'developer.events': [],
            };
            return { ok: true, result: results[method] };
          },
        },
      },
    });
  });

  await page.goto('/?view=models');
  const gemma = page.locator('.model-card').filter({ hasText: 'Gemma 3n E4B' });
  await expect(gemma).toBeVisible();
  await gemma.getByRole('button', { name: 'Make default' }).click();
  await expect(gemma.getByText('Default model')).toBeVisible();

  if ((page.viewportSize()?.width ?? 1440) < 960) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'Chats' }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).last().click();
  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('Reply locally');
  await composer.press('Enter');

  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __localModelRuntimeCalls: Array<{ method: string; params?: Record<string, unknown> }>;
        }
      ).__localModelRuntimeCalls,
  );
  const canonicalId = 'openai-compatible:lm_studio-http---127-0-0-1-1234/google/gemma-3n-e4b';
  expect(calls).toContainEqual({
    method: 'models.select',
    params: { modelId: canonicalId, compatibilityConfirmed: false },
  });
  expect(calls.find((call) => call.method === 'chat.send')?.params).toMatchObject({
    modelId: canonicalId,
  });
});
