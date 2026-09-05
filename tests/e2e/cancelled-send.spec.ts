import { expect, test, type Page } from '@playwright/test';

async function installCancelledSendBridge(page: Page, committed: boolean) {
  await page.addInitScript(
    ({ committed }) => {
      localStorage.setItem(
        'cupcake-workspace-settings',
        JSON.stringify({ onboardingCompleted: true }),
      );
      type EventHandler = (event: {
        sequence: number;
        type: string;
        payload: unknown;
        timestamp: string;
      }) => void;
      let eventHandler: EventHandler | undefined;
      let sendAttempt = 0;
      let finishPendingSend:
        | ((response: {
            ok: boolean;
            error: { code: string; message: string; retryable: boolean };
          }) => void)
        | undefined;
      let history: Array<Record<string, unknown>> = JSON.parse(
        localStorage.getItem('cupcake-cancelled-send-history') ?? '[]',
      ) as Array<Record<string, unknown>>;
      const conversation = {
        id: 'conversation-local',
        title: 'Local cancellation check',
        project_id: 'project-local',
        status: 'active',
      };
      const branch = {
        id: 'branch-local',
        conversation_id: 'conversation-local',
        name: 'Main',
      };
      const emit = (type: string, payload: unknown) =>
        eventHandler?.({
          sequence: Date.now(),
          type,
          payload,
          timestamp: new Date().toISOString(),
        });

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
            cancel: () => {
              if (committed && sendAttempt === 1 && finishPendingSend) {
                const user = {
                  id: 'user-saved',
                  branch_id: 'branch-local',
                  conversation_id: 'conversation-local',
                  role: 'user',
                  content: 'Keep the stopped request.',
                  state: 'complete',
                  created_at: new Date().toISOString(),
                };
                const assistant = {
                  id: 'assistant-stopped',
                  branch_id: 'branch-local',
                  conversation_id: 'conversation-local',
                  parent_message_id: 'user-saved',
                  run_id: 'run-1',
                  role: 'assistant',
                  content: '',
                  state: 'cancelled',
                  created_at: new Date().toISOString(),
                };
                history = [user, assistant];
                localStorage.setItem('cupcake-cancelled-send-history', JSON.stringify(history));
                emit('message.cancelled', {
                  runId: 'run-1',
                  message: assistant,
                  partialContent: '',
                });
                finishPendingSend({
                  ok: false,
                  error: {
                    code: 'CANCELLED',
                    message: 'The model run was cancelled',
                    retryable: false,
                  },
                });
                finishPendingSend = undefined;
              }
              return Promise.resolve(true);
            },
            onEvent: (handler: EventHandler) => {
              eventHandler = handler;
              return () => {
                eventHandler = undefined;
              };
            },
            onStatus: () => () => undefined,
            request: ({ method }: { method: string; params?: Record<string, unknown> }) => {
              const results: Record<string, unknown> = {
                'app.bootstrap': {
                  selectedModelId: 'openai-compatible:cupcake-local/qwen3-4b-q4-k-m',
                  projects: [
                    {
                      id: 'project-local',
                      name: 'Private Studio',
                      description: 'Local project',
                      status: 'active',
                    },
                  ],
                  conversations: [conversation],
                  models: [],
                  tools: [],
                  hardware: {},
                  localRuntimes: [],
                  suggestionsEnabled: false,
                },
                'settings.list': { 'onboarding.completed_v1': true },
                'tasks.list': [],
                'memory.list': [],
                'providers.status': { providers: [] },
                'broker.permission_mode.get': { mode: 'guarded' },
                'migration.detect': { state: 'not_found', available: false },
                'local_models.cupcake.status': {
                  activeModelId: 'qwen3-4b-q4-k-m',
                  availableModels: [
                    {
                      id: 'qwen3-4b-q4-k-m',
                      display_name: 'Qwen3 4B',
                      context_window: 8192,
                      capability_tags: ['text', 'chat'],
                    },
                  ],
                  models: [{ id: 'qwen3-4b-q4-k-m', integrity_verified: true }],
                  recommendations: [],
                  downloads: [],
                  availableRuntimes: [],
                  runtimes: [],
                  runtimeRecommendations: [],
                  hardware: {},
                },
                'developer.events': [],
                'artifacts.list': [],
                'artifacts.counts': { 'project-local': 0 },
                'conversations.list': [conversation],
                'conversations.get': { branches: [branch], activeBranchId: 'branch-local' },
              };
              if (method === 'chat.history') return Promise.resolve({ ok: true, result: history });
              if (method === 'chat.send') {
                sendAttempt += 1;
                if (!committed) {
                  return Promise.resolve({
                    ok: false,
                    error: {
                      code: 'CANCELLED',
                      message: 'Cancelled before the user turn was saved',
                      retryable: false,
                    },
                  });
                }
                emit('message.started', { runId: `run-${sendAttempt}` });
                return new Promise((resolve) => {
                  finishPendingSend = resolve;
                });
              }
              return Promise.resolve({ ok: true, result: results[method] });
            },
          },
        },
      });
    },
    { committed },
  );
}

test('a stopped persisted turn clears the draft and the next run remains stoppable', async ({
  page,
}) => {
  await installCancelledSendBridge(page, true);
  await page.goto('/?view=chats');
  await page.locator('.chat-list__main').filter({ hasText: 'Local cancellation check' }).click();

  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('Keep the stopped request.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(composer).toHaveValue('');
  await expect(page.getByText('Keep the stopped request.', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Response stopped', { exact: true })).toBeVisible();
  await expect(page.getByText('Starting response…', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Message not sent.', { exact: false })).toHaveCount(0);

  await page.reload();
  await page.locator('.chat-list__main').filter({ hasText: 'Local cancellation check' }).click();
  await expect(page.getByText('Response stopped', { exact: true })).toBeVisible();
  await expect(page.getByText('Starting response…', { exact: true })).toHaveCount(0);

  const nextComposer = page.getByLabel('Message Cupcake');
  await nextComposer.fill('Start another local response.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
});

test('a cancellation before persistence keeps the draft and reports it as unsent', async ({
  page,
}) => {
  await installCancelledSendBridge(page, false);
  await page.goto('/?view=chats');
  await page.locator('.chat-list__main').filter({ hasText: 'Local cancellation check' }).click();

  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('This draft never commits.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(composer).toHaveValue('This draft never commits.');
  await expect(page.getByRole('alert')).toContainText(
    'Message not sent. Your draft and file access are still available.',
  );
  await expect(page.locator('.turn--user')).toHaveCount(0);
});
