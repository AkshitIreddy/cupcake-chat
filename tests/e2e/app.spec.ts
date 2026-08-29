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
          request: async ({ method }: { method: string }) => {
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
                  calls.filter((item) => item === 'chat.history').length > 1
                    ? 'branch-b'
                    : 'branch-a',
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
  await page.getByRole('button', { name: 'Sibling B' }).click();
  await expect(page.getByText('Sibling branch B is intact.')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept('Edited sibling text'));
  await page.getByTitle('Edit').last().click();
  expect(
    await page.evaluate(() => (window as unknown as { __runtimeCalls: string[] }).__runtimeCalls),
  ).toContain('chat.edit');
});
