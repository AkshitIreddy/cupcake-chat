import { expect, test, type Page } from '@playwright/test';

const projectId = '01a08000-0000-7000-8000-000000000002';
const savedTitle = 'Tiny wins';

async function installMemoryBridge(page: Page) {
  await page.addInitScript(
    ({ projectId, savedTitle }) => {
      localStorage.setItem(
        'cupcake-workspace-settings',
        JSON.stringify({ onboardingCompleted: true }),
      );

      type RuntimeEvent = {
        sequence: number;
        type: string;
        payload: Record<string, unknown>;
        timestamp: string;
      };
      type RuntimeResponse = {
        ok: boolean;
        result?: unknown;
        error?: { code: string; message: string; retryable: boolean };
      };
      type EventHandler = (event: RuntimeEvent) => void;
      type RuntimeMemory = {
        id: string;
        key: string;
        content: string;
        kind: string;
        state: string;
        confidence: number;
        scope: {
          kind: string;
          project_id: string | null;
          conversation_id: string | null;
        };
      };

      const handlers = new Set<EventHandler>();
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const now = '2026-09-08T10:00:00.000Z';
      const globalMemory: RuntimeMemory = {
        id: 'global-memory',
        key: 'Global tone',
        content: 'Keep answers direct.',
        kind: 'preference',
        state: 'active',
        confidence: 1,
        scope: { kind: 'global', project_id: null, conversation_id: null },
      };
      let projectMemories: RuntimeMemory[] = [];
      let nextMemoryId = 1;
      let eventSequence = 0;
      let eventRefreshPending = false;
      const qa = {
        calls,
        eventListCalls: [] as Array<Record<string, unknown>>,
        eventRefreshCompleted: 0,
        projectRefreshCompleted: 0,
        latestRestoredId: '',
      };

      const emitMemoryEvent = (type: 'memory.saved' | 'memory.forgotten') => {
        window.setTimeout(() => {
          eventRefreshPending = true;
          const event = {
            sequence: ++eventSequence,
            type,
            payload: { projectId },
            timestamp: now,
          };
          handlers.forEach((handler) => handler(event));
        }, 0);
      };

      const memoryList = (params: Record<string, unknown>) =>
        params.projectId === projectId ? [globalMemory, ...projectMemories] : [globalMemory];

      const target = window as typeof window & { __memoryProjectQa?: typeof qa };
      target.__memoryProjectQa = qa;
      window.cupcake = {
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
          openExternal: () => Promise.resolve(),
        },
        workspace: {
          status: () => Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
          setup: () => Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
          setupWithoutPassword: () =>
            Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
          unlock: () => Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
          onStatus: () => () => undefined,
          changePassword: () =>
            Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
          disableProtection: () =>
            Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
        },
        window: {
          isMaximized: () => Promise.resolve(false),
          minimize: () => Promise.resolve(),
          toggleMaximize: () => Promise.resolve(false),
          close: () => Promise.resolve(),
          onCloseRequested: () => () => undefined,
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
          onEvent: (handler: EventHandler) => {
            handlers.add(handler);
            return () => handlers.delete(handler);
          },
          onStatus: () => () => undefined,
          request: async ({
            method,
            params = {},
          }: {
            method: string;
            params?: Record<string, unknown>;
          }): Promise<RuntimeResponse> => {
            calls.push({ method, params });
            if (method === 'memory.list') {
              const result = memoryList(params);
              if (eventRefreshPending) {
                eventRefreshPending = false;
                qa.eventListCalls.push(params);
                await new Promise((resolve) => window.setTimeout(resolve, 20));
                qa.eventRefreshCompleted += 1;
              } else if (params.projectId === projectId) {
                qa.projectRefreshCompleted += 1;
              }
              return { ok: true, result };
            }
            if (method === 'memory.remember') {
              const id = `project-memory-${nextMemoryId++}`;
              const textParam = (value: unknown, fallback: string) =>
                typeof value === 'string' ? value : fallback;
              const saved: RuntimeMemory = {
                id,
                key: textParam(params.key, savedTitle),
                content: textParam(params.content, ''),
                kind: textParam(params.kind, 'preference').toLowerCase(),
                state: 'active',
                confidence: 1,
                scope: {
                  kind: 'project',
                  project_id: textParam(params.projectId, ''),
                  conversation_id: null,
                },
              };
              projectMemories = [saved, ...projectMemories];
              qa.latestRestoredId = id;
              emitMemoryEvent('memory.saved');
              return { ok: true, result: saved };
            }
            if (method === 'memory.forget') {
              projectMemories = projectMemories.filter((item) => item.id !== params.memoryId);
              emitMemoryEvent('memory.forgotten');
              return { ok: true, result: null };
            }

            const project = (id: string, name: string) => ({
              id,
              name,
              description: `${name} workspace`,
              status: 'active',
              created_at: now,
              updated_at: now,
            });
            const results: Record<string, unknown> = {
              'app.bootstrap': {
                selectedModelId: null,
                projects: [
                  project('01a08000-0000-7000-8000-000000000001', 'Inbox'),
                  project(projectId, 'Small Things'),
                ],
                conversations: [],
                models: [],
                tools: [],
                hardware: {},
                localRuntimes: [],
                suggestionsEnabled: false,
              },
              'settings.list': {},
              'conversations.list': [],
              'models.list': [],
              'tasks.list': [],
              'providers.status': { providers: [] },
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
              'personas.list': [],
              'developer.events': [],
              'artifacts.list': [],
              'artifacts.counts': {},
            };
            return { ok: true, result: results[method] };
          },
        },
      };
    },
    { projectId, savedTitle },
  );
}

async function eventRefreshCount(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __memoryProjectQa: { eventRefreshCompleted: number };
        }
      ).__memoryProjectQa.eventRefreshCompleted,
  );
}

async function waitForNextMemoryRefresh(page: Page, previous: number) {
  await page.waitForFunction(
    (count) =>
      (
        window as typeof window & {
          __memoryProjectQa: { eventRefreshCompleted: number };
        }
      ).__memoryProjectQa.eventRefreshCompleted > count,
    previous,
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

test('project memory survives save events, forget, and restore refreshes', async ({ page }) => {
  await installMemoryBridge(page);
  await page.goto('/?view=projects');
  const project = page.locator('.project-card').filter({ hasText: 'Small Things' });
  await project.locator('.project-card__select').click();
  await expect(page.getByLabel('Active project: Small Things')).toBeVisible();
  await page.waitForFunction(
    () =>
      (
        window as typeof window & {
          __memoryProjectQa: { projectRefreshCompleted: number };
        }
      ).__memoryProjectQa.projectRefreshCompleted > 0,
  );

  await page.locator('.nav-item').filter({ hasText: 'Memory' }).click();
  await page.getByRole('button', { name: 'Add memory' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a memory' });
  await expect(dialog).toContainText('This memory will stay with the active project.');
  await dialog.getByLabel('Label').fill(savedTitle);
  await dialog.getByLabel('What should CupcakeAI remember?').fill('Celebrate useful progress.');

  let refreshCount = await eventRefreshCount(page);
  await dialog.getByRole('button', { name: 'Save memory' }).click();
  await waitForNextMemoryRefresh(page, refreshCount);
  const savedCard = page.locator('.memory-card').filter({ hasText: savedTitle });
  await expect(savedCard).toBeVisible();
  await expect(page.locator('.memory-group').filter({ hasText: 'Small Things' })).toContainText(
    savedTitle,
  );
  await expect(page.locator('.memory-card').filter({ hasText: 'Global tone' })).toBeVisible();
  await expect(page.locator('.memory-card').filter({ hasText: 'Global tone' })).toBeVisible();

  refreshCount = await eventRefreshCount(page);
  await savedCard.click();
  await page.getByRole('button', { name: 'Forget', exact: true }).click();
  await waitForNextMemoryRefresh(page, refreshCount);
  await expect(savedCard).toHaveCount(0);
  await expect(page.getByText('Memory removed.', { exact: true })).toBeVisible();

  refreshCount = await eventRefreshCount(page);
  await page.getByRole('button', { name: 'Undo forget', exact: true }).click();
  await waitForNextMemoryRefresh(page, refreshCount);
  const restoredCard = page.locator('.memory-card').filter({ hasText: savedTitle });
  await expect(restoredCard).toHaveCount(1);
  await expect(page.locator('.memory-group').filter({ hasText: 'Small Things' })).toContainText(
    savedTitle,
  );
  await expect(page.locator('.memory-card').filter({ hasText: 'Global tone' })).toBeVisible();
  await expect(page.locator('.memory-card').filter({ hasText: 'Global tone' })).toBeVisible();

  const qa = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __memoryProjectQa: {
            eventListCalls: Array<Record<string, unknown>>;
            latestRestoredId: string;
          };
        }
      ).__memoryProjectQa,
  );
  expect(qa.eventListCalls).toHaveLength(3);
  expect(qa.eventListCalls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        projectId,
        includeGlobal: true,
        states: ['active', 'candidate', 'superseded', 'expired'],
      }),
    ]),
  );
  for (const params of qa.eventListCalls) expect(params.projectId).toBe(projectId);

  await restoredCard.click();
  await page.getByRole('button', { name: 'Forget', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const calls = (
          window as typeof window & {
            __memoryProjectQa: {
              calls: Array<{ method: string; params: Record<string, unknown> }>;
            };
          }
        ).__memoryProjectQa.calls.filter((call) => call.method === 'memory.forget');
        const memoryId = calls[calls.length - 1]?.params.memoryId;
        return typeof memoryId === 'string' ? memoryId : null;
      }),
    )
    .toBe(qa.latestRestoredId);
});
