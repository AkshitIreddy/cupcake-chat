import { expect, test, type Page } from '@playwright/test';

type GroupScenario =
  'complete' | 'stop' | 'cloud' | 'unavailable' | 'all-disabled' | 'interrupted' | 'unloaded-local';

const ids = {
  project: '01a07000-0000-7000-8000-000000000001',
  conversation: '01a07000-0000-7000-8000-000000000002',
  branch: '01a07000-0000-7000-8000-000000000003',
  personaMira: '01a07000-0000-7000-8000-000000000004',
  personaReview: '01a07000-0000-7000-8000-000000000005',
  personaCloud: '01a07000-0000-7000-8000-000000000006',
  personaBroken: '01a07000-0000-7000-8000-000000000007',
  participantMira: '01a07000-0000-7000-8000-000000000008',
  participantReview: '01a07000-0000-7000-8000-000000000009',
  participantCloud: '01a07000-0000-7000-8000-00000000000a',
  participantBroken: '01a07000-0000-7000-8000-00000000000b',
};

async function installGroupBridge(page: Page, scenario: GroupScenario) {
  await page.addInitScript(
    ({ scenario, ids }) => {
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

      const now = '2026-09-05T10:00:00.000Z';
      const localModelId = 'openai-compatible:cupcake-local/qwen3-4b-q4-k-m';
      const cloudModelId = 'nvidia-nim:nvidia/nemotron-3-super-120b-a12b';
      const persona = (
        id: string,
        name: string,
        handle: string,
        role: string,
        modelId: string,
      ) => ({
        id,
        name,
        handle,
        avatar: '',
        role,
        description: `${role} for this conversation`,
        instructions: `Answer as the ${role}.`,
        speakWhen: `Speak when ${role.toLocaleLowerCase()} expertise is useful.`,
        personality: { preset: 'grounded', warmth: 0.5, brevity: 0.6, initiative: 0.5 },
        modelId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      const mira = persona(ids.personaMira, 'Mira', 'mira', 'Systems architect', localModelId);
      const reviewer = persona(
        ids.personaReview,
        'Mira',
        'mira-review',
        'Adversarial reviewer',
        localModelId,
      );
      const cloud = persona(
        ids.personaCloud,
        'Rhea',
        'rhea-cloud',
        'Cloud research lead',
        cloudModelId,
      );
      const broken = persona(
        ids.personaBroken,
        'Noor',
        'noor',
        'Privacy reviewer',
        'missing:private-model',
      );
      const participant = (
        id: string,
        item: ReturnType<typeof persona>,
        position: number,
        status: string = 'ready',
        enabled = true,
      ) => ({
        id,
        conversationId: ids.conversation,
        personaId: item.id,
        position,
        enabled,
        isLead: position === 0,
        addedAt: now,
        persona: item,
        availability: {
          status,
          message: status === 'ready' ? 'Ready to answer' : 'Choose an available model',
        },
      });
      let participants =
        scenario === 'cloud'
          ? [participant(ids.participantCloud, cloud, 0)]
          : scenario === 'unavailable' || scenario === 'all-disabled'
            ? [participant(ids.participantBroken, broken, 0, 'model_missing')]
            : [
                participant(ids.participantMira, mira, 0),
                participant(ids.participantReview, reviewer, 1),
              ];
      if (scenario === 'all-disabled')
        participants = participants.map((item) => ({ ...item, enabled: false }));
      const allPersonas = [mira, reviewer, cloud, broken];
      const conversation = {
        id: ids.conversation,
        title: 'Group QA table',
        project_id: ids.project,
        status: 'active',
        updated_at: now,
      };
      const branch = {
        id: ids.branch,
        conversation_id: ids.conversation,
        name: 'Main',
      };
      const localModel = {
        id: localModelId,
        provider: 'openai-compatible',
        model: 'qwen3-4b-q4-k-m',
        display_name: 'Qwen3 4B',
        privacy_route: 'local',
        context_window: 8192,
        capabilities: ['chat'],
      };
      const cloudModel = {
        id: cloudModelId,
        provider: 'nvidia-nim',
        model: 'nvidia/nemotron-3-super-120b-a12b',
        display_name: 'Nemotron 3 Super',
        privacy_route: 'cloud',
        context_window: 262144,
        capabilities: ['chat', 'reasoning'],
      };
      const logs: Array<{ method: string; params?: Record<string, unknown> }> = [];
      let eventHandler: EventHandler | undefined;
      let eventSequence = 1;
      let sendCount = 0;
      let activeTurnId: string | null = null;
      let pendingSend: ((value: RuntimeResponse) => void) | null = null;
      const history = JSON.parse(localStorage.getItem('cupcake-group-history') ?? '[]') as Array<
        Record<string, unknown>
      >;
      let persistedTurn = JSON.parse(
        localStorage.getItem('cupcake-group-turn') ?? 'null',
      ) as Record<string, unknown> | null;

      const speaker = (
        member: (typeof participants)[number],
        privacyRoute: 'local' | 'cloud' = 'local',
      ) => ({
        participantId: member.id,
        personaId: member.persona.id,
        name: member.persona.name,
        handle: member.persona.handle,
        avatar: member.persona.avatar,
        role: member.persona.role,
        modelId: member.persona.modelId,
        providerId: privacyRoute === 'cloud' ? 'nvidia-nim' : 'cupcake-local',
        privacyRoute,
      });
      const route = (member: (typeof participants)[number]) => ({
        participantId: member.id,
        persona: member.persona,
        model: {
          id: member.persona.modelId,
          provider: member.persona.modelId.startsWith('nvidia-nim')
            ? 'nvidia-nim'
            : 'cupcake-local',
          privacyRoute: member.persona.modelId.startsWith('nvidia-nim') ? 'cloud' : 'local',
          costClass: member.persona.modelId.startsWith('nvidia-nim') ? 'metered' : 'local',
        },
        selectionReason: null,
        attachmentCompatibility: 'not_applicable',
      });
      const ineligible = (member: (typeof participants)[number]) => ({
        ...route(member),
        attachmentCompatibility: 'incompatible',
        reasonCode: 'model_missing',
        message: 'The saved model is no longer available.',
        repairAction: 'Choose a ready model',
      });
      const emit = (type: string, payload: Record<string, unknown>) =>
        eventHandler?.({ sequence: eventSequence++, type, payload, timestamp: now });
      const save = () => {
        localStorage.setItem('cupcake-group-history', JSON.stringify(history));
        localStorage.setItem('cupcake-group-turn', JSON.stringify(persistedTurn));
      };
      const userMessage = (content: string, turnId: string) => ({
        id: `${turnId}-user`,
        branch_id: ids.branch,
        conversation_id: ids.conversation,
        role: 'user',
        content,
        state: 'complete',
        created_at: now,
      });
      const assistantMessage = (
        turnId: string,
        sequence: number,
        member: (typeof participants)[number],
        content: string,
        state: 'complete' | 'cancelled' = 'complete',
      ) => ({
        id: `${turnId}-assistant-${sequence}`,
        branch_id: ids.branch,
        conversation_id: ids.conversation,
        parent_message_id: `${turnId}-user`,
        run_id: turnId,
        role: 'assistant',
        content,
        state,
        model_id: member.persona.modelId,
        provider_id: member.persona.modelId.startsWith('nvidia-nim')
          ? 'nvidia-nim'
          : 'cupcake-local',
        created_at: now,
        canonical_metadata: {
          group: {
            turnId,
            sequence,
            selectionReasonCode: sequence === 1 ? 'specialist' : 'cross_check',
            selectionReason: sequence === 1 ? 'Primary specialist' : 'Distinct review',
            speaker: speaker(
              member,
              member.persona.modelId.startsWith('nvidia-nim') ? 'cloud' : 'local',
            ),
          },
        },
      });
      const memberState = (
        turnId: string,
        sequence: number,
        member: (typeof participants)[number],
        status: 'selected' | 'completed' | 'cancelled',
      ) => ({
        sequence,
        participantId: member.id,
        status,
        messageId: status === 'selected' ? null : `${turnId}-assistant-${sequence}`,
        selectionReasonCode: sequence === 1 ? 'specialist' : 'cross_check',
        selectionReason: sequence === 1 ? 'Primary specialist' : 'Distinct review',
        speaker: speaker(
          member,
          member.persona.modelId.startsWith('nvidia-nim') ? 'cloud' : 'local',
        ),
        usage: {},
        errorCode: null,
        createdAt: now,
        updatedAt: now,
      });
      const makeTurn = (
        turnId: string,
        status: 'running' | 'completed' | 'cancelled' | 'interrupted',
        members: Array<Record<string, unknown>>,
        content = '',
      ) => ({
        turnId,
        conversationId: ids.conversation,
        branchId: ids.branch,
        userMessageId: `${turnId}-user`,
        status,
        mode: 'mentions',
        digest: 'd'.repeat(64),
        planRevision: 'a'.repeat(64),
        rosterRevision: 1,
        maxReplies: 3,
        maxSelectorCalls: 0,
        selectorCalls: 0,
        responderCalls: members.length,
        selectorUsage: [],
        plan: {
          conversationId: ids.conversation,
          branchId: ids.branch,
          headMessageId: null,
          projectId: ids.project,
          rosterRevision: 1,
          strategy: 'mentions-only',
          mode: 'mentions',
          mentions: members.map((item) => item.participantId),
          selector: null,
          eligibleSpeakers: participants.map(route),
          ineligibleSpeakers: [],
          maxReplies: 3,
          maxSelectorCalls: 0,
          selectorMaxOutputTokens: 0,
          effectiveOffline: false,
          contentSha256: 'b'.repeat(64),
          attachmentBindings: [],
          referenceBindings: [],
          memoryIds: [],
          toolIds: [],
          maxOutputTokens: null,
          content,
        },
        createdAt: now,
        updatedAt: now,
        completedAt: status === 'running' ? null : now,
        members,
      });
      if (scenario === 'interrupted' && history.length === 0) {
        const turnId = '01a07000-0000-7000-8000-000000000099';
        const first = participants[0];
        history.push(userMessage('Resume safely after restart.', turnId));
        history.push(assistantMessage(turnId, 1, first, 'Partial before restart', 'cancelled'));
        persistedTurn = makeTurn(turnId, 'interrupted', [
          memberState(turnId, 1, first, 'cancelled'),
        ]);
        save();
      }
      const preflight = (params: Record<string, unknown>) => {
        const turnId = `01a07000-0000-7000-8000-${String(++sendCount).padStart(12, '0')}`;
        const chosen =
          scenario === 'unavailable' || scenario === 'all-disabled' ? [] : participants;
        const eligible = chosen.map(route);
        const blocked =
          scenario === 'unavailable' || scenario === 'all-disabled'
            ? participants.map(ineligible)
            : [];
        const cloudRequired = scenario === 'cloud';
        const lastMessage = history[history.length - 1];
        return {
          turnId,
          planRevision: 'a'.repeat(64),
          digest: 'd'.repeat(64),
          rosterRevision: 1,
          headMessageId: typeof lastMessage?.id === 'string' ? lastMessage.id : null,
          userMessageId: null,
          mode: 'mentions',
          strategy: 'mentions-only',
          maxReplies: 3,
          maxSelectorCalls: 0,
          selectorMaxOutputTokens: 0,
          selector: null,
          eligibleSpeakers: eligible,
          ineligibleSpeakers: blocked,
          sendable: blocked.length === 0,
          confirmationRequired: cloudRequired,
          confirmationToken: cloudRequired ? 'cloud-confirmation-token-1234567890' : null,
          expiresAt: '2026-09-05T10:05:00.000Z',
          disclosure: {
            selector: null,
            candidateRoutes: eligible,
            ineligibleRoutes: blocked,
            maxSelectorCalls: 0,
            selectorMaxOutputTokens: 0,
            maxReplies: 3,
          },
          __content: params.content,
        };
      };
      const completeSend = (params: Record<string, unknown>) => {
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        activeTurnId = turnId;
        const content = typeof params.content === 'string' ? params.content : '';
        history.push(userMessage(content, turnId));
        emit('group.turn.started', {
          runId: turnId,
          turnId,
          conversationId: ids.conversation,
          branchId: ids.branch,
          userMessageId: `${turnId}-user`,
          mode: 'mentions',
          maxReplies: 3,
          maxSelectorCalls: 0,
        });
        if (scenario === 'stop') {
          const first = participants[0];
          const snap = speaker(first);
          persistedTurn = makeTurn(turnId, 'running', [memberState(turnId, 1, first, 'selected')]);
          save();
          emit('group.speaker.selected', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence: 1,
            speaker: snap,
            selectionReasonCode: 'specialist',
            selectionReason: 'Primary specialist',
          });
          emit('group.speaker.started', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence: 1,
            speaker: snap,
          });
          emit('message.started', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence: 1,
            speaker: snap,
          });
          emit('message.delta', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence: 1,
            speaker: snap,
            delta: 'Partial answer',
          });
          return new Promise<RuntimeResponse>((resolve) => {
            pendingSend = resolve;
          });
        }
        const completedMembers: Array<Record<string, unknown>> = [];
        participants.forEach((member, index) => {
          const sequence = index + 1;
          const snap = speaker(
            member,
            member.persona.modelId.startsWith('nvidia-nim') ? 'cloud' : 'local',
          );
          const answer =
            sequence === 1
              ? `Answer from @${member.persona.handle}.`
              : `Review from @${member.persona.handle}.`;
          emit('group.speaker.selected', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence,
            speaker: snap,
            selectionReasonCode: sequence === 1 ? 'specialist' : 'cross_check',
            selectionReason: sequence === 1 ? 'Primary specialist' : 'Distinct review',
          });
          emit('group.speaker.started', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence,
            speaker: snap,
          });
          emit('message.started', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence,
            speaker: snap,
          });
          emit('message.delta', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence,
            speaker: snap,
            delta: answer,
          });
          const saved = assistantMessage(turnId, sequence, member, answer);
          history.push(saved);
          emit('message.completed', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence,
            speaker: snap,
            content: answer,
            message: saved,
          });
          emit('group.speaker.completed', {
            runId: turnId,
            turnId,
            conversationId: ids.conversation,
            sequence,
            speaker: snap,
            messageId: saved.id,
          });
          completedMembers.push(memberState(turnId, sequence, member, 'completed'));
        });
        persistedTurn = makeTurn(turnId, 'completed', completedMembers, content);
        save();
        emit('group.turn.completed', {
          runId: turnId,
          turnId,
          conversationId: ids.conversation,
        });
        activeTurnId = null;
        return Promise.resolve({
          ok: true,
          result: {
            turnId,
            conversationId: ids.conversation,
            branchId: ids.branch,
            userMessageId: `${turnId}-user`,
            status: 'completed',
          },
        });
      };

      Object.assign(window, { __groupQa: { logs } });
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
            status: () =>
              Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
            onStatus: () => () => undefined,
          },
          window: {
            minimize: () => Promise.resolve(undefined),
            toggleMaximize: () => Promise.resolve(false),
            close: () => Promise.resolve(undefined),
            isMaximized: () => Promise.resolve(false),
          },
          dialog: {
            openFiles: () => Promise.resolve([]),
            openDirectory: () => Promise.resolve(null),
            chooseSaveTarget: () => Promise.resolve(null),
            releaseHandle: () => Promise.resolve(undefined),
          },
          commands: {
            execute: () => Promise.resolve(undefined),
            onCommand: () => () => undefined,
          },
          runtime: {
            status: () => Promise.resolve({ state: 'ready', mode: 'broker', restartCount: 0 }),
            onEvent: (handler: EventHandler) => {
              eventHandler = handler;
              return () => {
                eventHandler = undefined;
              };
            },
            onStatus: () => () => undefined,
            cancel: async (turnId: string) => {
              await Promise.resolve();
              logs.push({ method: 'runtime.cancel', params: { turnId } });
              if (!activeTurnId || activeTurnId !== turnId || !pendingSend) return false;
              const first = participants[0];
              const saved = assistantMessage(turnId, 1, first, 'Partial answer', 'cancelled');
              history.push(saved);
              persistedTurn = makeTurn(turnId, 'cancelled', [
                memberState(turnId, 1, first, 'cancelled'),
              ]);
              save();
              emit('message.cancelled', {
                runId: turnId,
                turnId,
                conversationId: ids.conversation,
                sequence: 1,
                speaker: speaker(first),
                partialContent: 'Partial answer',
                message: saved,
              });
              emit('group.turn.cancelled', {
                runId: turnId,
                turnId,
                conversationId: ids.conversation,
              });
              const resolve = pendingSend;
              pendingSend = null;
              activeTurnId = null;
              resolve({
                ok: false,
                error: { code: 'CANCELLED', message: 'Group turn stopped', retryable: false },
              });
              return true;
            },
            request: async ({
              method,
              params = {},
            }: {
              method: string;
              params?: Record<string, unknown>;
            }): Promise<RuntimeResponse> => {
              logs.push({ method, params });
              const settings = {
                conversationId: ids.conversation,
                strategy: 'mentions-only',
                maxReplies: 3,
                leadParticipantId: participants[0]?.id ?? null,
                rosterRevision: 1,
                updatedAt: now,
              };
              const results: Record<string, unknown> = {
                'app.bootstrap': {
                  selectedModelId: scenario === 'unloaded-local' ? cloudModelId : localModelId,
                  projects: [{ id: ids.project, name: 'Atlas', description: '', status: 'active' }],
                  conversations: [conversation],
                  models: scenario === 'unloaded-local' ? [cloudModel] : [localModel, cloudModel],
                  tools: [],
                  hardware: {},
                  localRuntimes: [],
                  suggestionsEnabled: false,
                },
                'settings.list': { 'onboarding.completed_v1': true },
                'models.list': [cloudModel],
                'tasks.list': [],
                'memory.list': [],
                'providers.status': {
                  providers: [
                    { provider: 'nvidia-nim', configured: true },
                    { provider: 'cupcake-local', configured: true },
                  ],
                },
                'broker.permission_mode.get': { mode: 'guarded' },
                'migration.detect': { state: 'not_found', available: false },
                'local_models.cupcake.status': {
                  activeModelId: scenario === 'unloaded-local' ? null : 'qwen3-4b-q4-k-m',
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
                'artifacts.counts': { [ids.project]: 0 },
                'conversations.list': [conversation],
                'conversations.get': { branches: [branch], activeBranchId: ids.branch },
                'chat.history': history,
                'personas.list': allPersonas,
                'conversations.participants.list': participants,
                'conversations.group.settings.get': settings,
                'groups.turn.get': persistedTurn,
              };
              if (method === 'groups.turn.preflight')
                return { ok: true, result: preflight(params) };
              if (method === 'groups.turn.send') return completeSend(params);
              if (method === 'personas.create') {
                if (params.modelId !== localModelId)
                  return {
                    ok: false,
                    error: {
                      code: 'PERSONA_MODEL_NOT_FOUND',
                      message: 'An exact catalog route is required.',
                      retryable: false,
                    },
                  };
                return {
                  ok: true,
                  result: {
                    ...params,
                    id: '01a07000-0000-7000-8000-00000000000c',
                    createdAt: now,
                    updatedAt: now,
                    archivedAt: null,
                  },
                };
              }
              if (method === 'conversations.participants.add') {
                const saved = participant(ids.participantCloud, cloud, participants.length);
                participants = [...participants, saved];
                return { ok: true, result: saved };
              }
              return { ok: true, result: results[method] };
            },
          },
        },
      });
    },
    { scenario, ids },
  );
}

async function openGroupChat(page: Page) {
  await page.goto('/?view=chats');
  await page.locator('.chat-list__main').filter({ hasText: 'Group QA table' }).click();
  await expect(page.getByTestId('participant-tray')).toBeVisible();
  await expect(page.getByLabel('Message Cupcake')).toBeVisible();
}

async function chooseMention(page: Page, handle: string) {
  const composer = page.getByLabel('Message Cupcake');
  await composer.fill(`@${handle.slice(0, 2)}`);
  await expect(page.getByTestId('group-mention-menu')).toBeVisible();
  const option = page
    .getByRole('option')
    .filter({ has: page.getByText(`@${handle}`, { exact: true }) });
  await option.click();
  await expect(composer).toHaveValue(new RegExp(`^@${handle}\\s`));
}

test('mention routing preserves duplicate-name identity, keyboard focus, order, and speaker rows', async ({
  page,
}) => {
  await installGroupBridge(page, 'complete');
  await openGroupChat(page);

  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('@mi');
  const menu = page.getByTestId('group-mention-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByText('@mira', { exact: true })).toBeVisible();
  await expect(menu.getByText('@mira-review', { exact: true })).toBeVisible();
  await expect(menu.getByText('Systems architect', { exact: true })).toBeVisible();
  await expect(menu.getByText('Adversarial reviewer', { exact: true })).toBeVisible();
  await composer.press('End');
  await composer.press('Enter');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(/^@mira-review\s/);

  await composer.fill('@unknown Keep this ordinary.');
  await composer.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(composer).toHaveValue('@unknown Keep this ordinary.');

  await composer.fill('  🧁 @mi');
  await composer.press('Home');
  await composer.press('Enter');
  await composer.fill(`${await composer.inputValue()} @mi`);
  await composer.press('End');
  await composer.press('Enter');
  await composer.fill(`${await composer.inputValue()} compare the architecture.`);
  await page.getByRole('button', { name: 'Send group message' }).click();

  await expect(page.getByText('Answer from @mira.', { exact: true })).toBeVisible();
  await expect(page.getByText('Review from @mira-review.', { exact: true })).toBeVisible();
  const assistantTurns = page.locator('.turn--assistant').filter({ hasText: /from @mira/ });
  await expect(assistantTurns).toHaveCount(2);
  await expect(assistantTurns.nth(0).locator('.message-meta')).toContainText('Systems architect');
  await expect(assistantTurns.nth(1).locator('.message-meta')).toContainText(
    'Adversarial reviewer',
  );
  await expect(page.getByText(/replied$/)).toContainText('Mira and Mira replied');

  const calls = await page.evaluate(
    () =>
      (window as unknown as { __groupQa: { logs: Array<{ method: string; params: unknown }> } })
        .__groupQa.logs,
  );
  const preflight = calls.find((call) => call.method === 'groups.turn.preflight');
  expect(preflight).toBeTruthy();
  const preflightParams = preflight?.params as {
    content: string;
    mentions: Array<{ personaId: string; start: number; end: number; token: string }>;
  };
  expect(preflightParams.content.startsWith('  🧁 ')).toBe(true);
  expect(preflightParams.mentions.map((mention) => mention.personaId)).toEqual([
    ids.personaMira,
    ids.personaReview,
  ]);
  for (const mention of preflightParams.mentions)
    expect(preflightParams.content.slice(mention.start, mention.end)).toBe(mention.token);
  expect(calls.filter((call) => call.method === 'groups.turn.send')).toHaveLength(1);
  expect(calls.filter((call) => call.method === 'chat.send')).toHaveLength(0);

  await page.reload();
  await page.locator('.chat-list__main').filter({ hasText: 'Group QA table' }).click();
  await expect(page.getByText('Answer from @mira.', { exact: true })).toBeVisible();
  await expect(page.getByText('Review from @mira-review.', { exact: true })).toBeVisible();
});

test('stop preserves the committed turn and a second group response remains stoppable', async ({
  page,
}) => {
  await installGroupBridge(page, 'stop');
  await openGroupChat(page);
  const composer = page.getByLabel('Message Cupcake');

  for (const prompt of ['Stop the first response.', 'Stop the second response too.']) {
    await chooseMention(page, 'mira');
    await composer.fill(`${await composer.inputValue()} ${prompt}`);
    await page.getByRole('button', { name: 'Send group message' }).click();
    await expect(page.getByTestId('group-stop')).toBeVisible();
    await page.getByTestId('group-stop').click();
    await expect(page.getByTestId('group-turn-rail')).toContainText('Group turn stopped');
    await expect(page.getByText('Response stopped', { exact: true }).last()).toBeVisible();
    await expect(composer).toHaveValue('');
    await expect(page.getByText(/not sent/i)).toHaveCount(0);
  }

  const calls = await page.evaluate(
    () => (window as unknown as { __groupQa: { logs: Array<{ method: string }> } }).__groupQa.logs,
  );
  expect(calls.filter((call) => call.method === 'groups.turn.send')).toHaveLength(2);
  expect(calls.filter((call) => call.method === 'runtime.cancel')).toHaveLength(2);
  await page.reload();
  await page.locator('.chat-list__main').filter({ hasText: 'Group QA table' }).click();
  await expect(page.getByText('Response stopped', { exact: true })).toHaveCount(2);
});

test('cloud routes require an explicit bound confirmation and unavailable mentions cannot start', async ({
  page,
}) => {
  await installGroupBridge(page, 'cloud');
  await openGroupChat(page);
  await chooseMention(page, 'rhea-cloud');
  const composer = page.getByLabel('Message Cupcake');
  await composer.fill(`${await composer.inputValue()} assess current sources.`);
  await page.getByRole('button', { name: 'Send group message' }).click();
  const disclosure = page.getByTestId('group-disclosure');
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText('Confirm possible destinations');
  await expect(disclosure).toContainText('nvidia-nim');
  const sendsBefore = await page.evaluate(() =>
    (
      window as unknown as {
        __groupQa: { logs: Array<{ method: string; params?: Record<string, unknown> }> };
      }
    ).__groupQa.logs.filter((call) => call.method === 'groups.turn.send'),
  );
  expect(sendsBefore).toHaveLength(0);
  await page.getByTestId('group-confirm').click();
  await expect(page.getByText('Answer from @rhea-cloud.', { exact: true })).toBeVisible();
  const sendsAfter = await page.evaluate(() =>
    (
      window as unknown as {
        __groupQa: { logs: Array<{ method: string; params: Record<string, unknown> }> };
      }
    ).__groupQa.logs.filter((call) => call.method === 'groups.turn.send'),
  );
  expect(sendsAfter).toHaveLength(1);
  expect(sendsAfter[0]?.params.confirmationToken).toBe('cloud-confirmation-token-1234567890');
});

test('unavailable and disabled rosters remain group-scoped and never fall through to solo chat', async ({
  page,
}) => {
  await installGroupBridge(page, 'all-disabled');
  await openGroupChat(page);
  const composer = page.getByLabel('Message Cupcake');
  await expect(page.getByRole('button', { name: 'Send group message' })).toBeVisible();
  await composer.fill('@no');
  await expect(page.getByTestId('group-mention-menu')).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(page.getByText('No matches', { exact: true })).toBeVisible();
  await composer.press('Enter');
  await expect(composer).toHaveValue('@no');
  const calls = await page.evaluate(
    () => (window as unknown as { __groupQa: { logs: Array<{ method: string }> } }).__groupQa.logs,
  );
  expect(calls.filter((call) => call.method === 'chat.send')).toHaveLength(0);
  expect(calls.filter((call) => call.method === 'groups.turn.send')).toHaveLength(0);
});

test('an unavailable enabled member is identified and cannot be selected from the keyboard', async ({
  page,
}) => {
  await installGroupBridge(page, 'unavailable');
  await openGroupChat(page);
  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('@no');
  const option = page.getByRole('option').filter({ hasText: '@noor' });
  await expect(option).toHaveAttribute('aria-disabled', 'true');
  await composer.press('Enter');
  await expect(page.getByRole('alert')).toContainText('needs attention');
  await expect(composer).toHaveValue('@no');
  const calls = await page.evaluate(
    () => (window as unknown as { __groupQa: { logs: Array<{ method: string }> } }).__groupQa.logs,
  );
  expect(calls.filter((call) => call.method === 'groups.turn.preflight')).toHaveLength(0);
  expect(calls.filter((call) => call.method === 'groups.turn.send')).toHaveLength(0);
});

test('an interrupted persisted turn is visible after reload and never resumes itself', async ({
  page,
}) => {
  await installGroupBridge(page, 'interrupted');
  await openGroupChat(page);
  await expect(page.getByTestId('group-turn-rail')).toContainText(
    'Group turn interrupted by restart',
  );
  await expect(page.getByText('Partial before restart', { exact: true })).toBeVisible();
  await expect(page.getByText('Response stopped', { exact: true })).toBeVisible();
  await page.reload();
  await page.locator('.chat-list__main').filter({ hasText: 'Group QA table' }).click();
  await expect(page.getByTestId('group-turn-rail')).toContainText(
    'Group turn interrupted by restart',
  );
  const calls = await page.evaluate(
    () => (window as unknown as { __groupQa: { logs: Array<{ method: string }> } }).__groupQa.logs,
  );
  expect(calls.filter((call) => call.method === 'groups.turn.send')).toHaveLength(0);
});

test('add Cupcake separates ready and repairable personas and persists the chosen identity', async ({
  page,
}) => {
  await installGroupBridge(page, 'complete');
  await openGroupChat(page);
  await page.getByTestId('add-cupcake').click();
  const dialog = page.getByTestId('add-cupcake-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Ready' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  const rheaCard = dialog.locator('article').filter({ hasText: '@rhea-cloud' });
  await rheaCard.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('participant-tray')).toContainText('Rhea');
  const addCalls = await page.evaluate(() =>
    (
      window as unknown as {
        __groupQa: { logs: Array<{ method: string; params?: Record<string, unknown> }> };
      }
    ).__groupQa.logs.filter((call) => call.method === 'conversations.participants.add'),
  );
  expect(addCalls).toHaveLength(1);
  expect(addCalls[0]?.params?.personaId).toBe(ids.personaCloud);
});

test('a local Cupcake can be configured without loading its installed model', async ({
  page,
}, testInfo) => {
  await installGroupBridge(page, 'unloaded-local');
  await openGroupChat(page);
  await page.getByTestId('add-cupcake').click();
  await page.getByRole('button', { name: 'Create a Cupcake', exact: true }).first().click();
  const editor = page.getByTestId('persona-editor');
  await editor.getByLabel('Name', { exact: true }).fill('Juniper');
  await editor.getByRole('textbox', { name: 'Handle', exact: true }).fill('juniper');
  await editor.getByLabel('Role', { exact: true }).fill('Private local reviewer');
  await editor.getByRole('button', { name: /Choose an exact model/ }).click();
  await editor.getByLabel('Show routes that need setup or loading').check();
  await editor.getByRole('option').filter({ hasText: 'Qwen3 4B' }).click();
  await expect(editor.locator('.persona-editor__preview')).toContainText('Qwen3 4B');
  await page.screenshot({
    path: `E:/temp/cupcake-overhaul-20260905/local-persona-${testInfo.project.name}.png`,
  });
  await editor.getByRole('button', { name: 'Create Cupcake', exact: true }).click();
  await expect(editor).toBeHidden();
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __groupQa: { logs: Array<{ method: string; params?: Record<string, unknown> }> };
        }
      ).__groupQa.logs,
  );
  expect(
    calls.filter((call) => call.method === 'personas.create').map((call) => call.params?.modelId),
  ).toEqual(['openai-compatible:cupcake-local/qwen3-4b-q4-k-m']);
  expect(
    calls.filter((call) =>
      ['local_models.cupcake.load', 'groups.turn.send', 'chat.send'].includes(call.method),
    ),
  ).toEqual([]);
});

test('narrow group controls remain operable without page overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'narrow-window', 'Narrow-window visual regression');
  await installGroupBridge(page, 'complete');
  await openGroupChat(page);
  await page.getByTestId('group-settings').click();
  await expect(page.getByText('Who should answer?', { exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: 'E:\\temp\\cupcake-overhaul-20260905\\group-chat-qa\\narrow-group-controls.png',
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('@mi');
  await expect(page.getByTestId('group-mention-menu')).toBeVisible();
  await page.screenshot({
    path: 'E:\\temp\\cupcake-overhaul-20260905\\group-chat-qa\\narrow-mention-menu.png',
    fullPage: true,
  });
});
