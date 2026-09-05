import { expect, test } from '@playwright/test';

test('opening a chat binds its project through context refresh, preflight, and send', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      'cupcake-workspace-settings',
      JSON.stringify({ onboardingCompleted: true }),
    );
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    Object.assign(window, { __runtimeRequests: requests });

    const projects = [
      { id: 'project-a', name: 'Northstar', description: 'Default project', status: 'active' },
      { id: 'project-b', name: 'Atlas', description: 'Conversation project', status: 'active' },
    ];
    const conversations = [
      {
        id: 'conversation-b',
        title: 'Atlas decision room',
        project_id: 'project-b',
        status: 'active',
      },
    ];

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
          cancel: () => Promise.resolve(true),
          onEvent: () => () => undefined,
          onStatus: () => () => undefined,
          request: ({
            method,
            params,
          }: {
            method: string;
            params?: Record<string, unknown>;
          }) => {
            requests.push({ method, params });
            const results: Record<string, unknown> = {
              'app.bootstrap': {
                selectedModelId: 'openai:gpt-5.4-mini',
                projects,
                conversations,
                models: [
                  {
                    id: 'openai:gpt-5.4-mini',
                    provider: 'openai',
                    model: 'gpt-5.4-mini',
                    display_name: 'GPT-5.4 mini',
                    privacy_route: 'cloud',
                    context_window: 128000,
                    capabilities: ['chat', 'reasoning'],
                  },
                ],
                tools: [],
                hardware: {},
                localRuntimes: [],
                suggestionsEnabled: false,
              },
              'settings.list': { 'onboarding.completed_v1': true },
              'tasks.list': [],
              'providers.status': {
                providers: [{ provider: 'openai', configured: true, catalog: { models: [] } }],
              },
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
              'developer.events': [],
              'conversations.get': {
                branches: [
                  { id: 'branch-b', conversation_id: 'conversation-b', name: 'Main' },
                ],
                activeBranchId: 'branch-b',
              },
              'conversations.list': conversations,
              'chat.history': [],
              'artifacts.list': [],
              'chat.preflight': {
                confirmationToken: 'atlas-send-token',
                disclosure: { privacyRoute: 'cloud', costClass: 'metered' },
                outboundIntent: {
                  provider: 'openai',
                  modelId: 'openai:gpt-5.4-mini',
                  privacyRoute: 'cloud',
                  costClass: 'metered',
                  projectId: 'project-b',
                  conversationId: 'conversation-b',
                  branchId: 'branch-b',
                  contentSha256: 'atlas-content',
                  attachmentHandleIds: [],
                  attachmentBindings: [],
                  referenceIds: [],
                  referenceBindings: [],
                  memoryIds: [],
                  toolIds: [],
                },
              },
              'chat.send': {
                conversationId: 'conversation-b',
                branchId: 'branch-b',
                runId: 'atlas-run',
              },
            };
            if (method === 'memory.list') {
              const projectId = params?.projectId;
              return Promise.resolve({
                ok: true,
                result:
                  projectId === 'project-b'
                    ? [
                        {
                          id: 'atlas-memory',
                          key: 'atlas-scope',
                          content: 'Atlas only',
                          kind: 'fact',
                          state: 'active',
                          confidence: 1,
                          scope: { kind: 'project', project_id: 'project-b' },
                        },
                      ]
                    : [],
              });
            }
            if (method === 'artifacts.list' && params?.projectId === 'project-b') {
              return Promise.resolve({
                ok: false,
                error: {
                  code: 'INJECTED_CONTEXT_FAILURE',
                  message: 'Injected Atlas artifact refresh failure.',
                },
              });
            }
            return Promise.resolve({ ok: true, result: results[method] });
          },
        },
      },
    });
  });

  await page.goto('/?view=chats');
  await page.locator('.chat-list__main').filter({ hasText: 'Atlas decision room' }).click();

  await expect(page.locator('.chat-header h1')).toHaveText('Atlas decision room');
  await expect(page.locator('.chat-project')).toContainText('Atlas');
  await expect(page.locator('.composer-chip').filter({ hasText: 'Atlas' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'Conversation opened, but its supporting context could not be refreshed',
  );
  expect(pageErrors).toEqual([]);

  await page.getByLabel('Message Cupcake').fill('Use the Atlas project context.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm cloud destination' })).toBeVisible();

  const preflight = await page.evaluate(() =>
    (
      window as unknown as {
        __runtimeRequests: Array<{ method: string; params?: Record<string, unknown> }>;
      }
    ).__runtimeRequests.find(({ method }) => method === 'chat.preflight'),
  );
  expect(preflight?.params).toMatchObject({
    projectId: 'project-b',
    conversationId: 'conversation-b',
    branchId: 'branch-b',
  });

  await page.getByRole('button', { name: 'Confirm one send' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __runtimeRequests: Array<{ method: string; params?: Record<string, unknown> }>;
          }
        ).__runtimeRequests.find(({ method }) => method === 'chat.send'),
      ),
    )
    .toMatchObject({
      params: {
        projectId: 'project-b',
        conversationId: 'conversation-b',
        branchId: 'branch-b',
      },
    });

  const scopedRefreshes = await page.evaluate(() =>
    (
      window as unknown as {
        __runtimeRequests: Array<{ method: string; params?: Record<string, unknown> }>;
      }
    ).__runtimeRequests.filter(({ method }) => method === 'memory.list' || method === 'artifacts.list'),
  );
  expect(scopedRefreshes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: 'memory.list', params: expect.objectContaining({ projectId: 'project-b' }) }),
      expect.objectContaining({ method: 'artifacts.list', params: { projectId: 'project-b' } }),
    ]),
  );
});
