#!/usr/bin/env node
/**
 * Accept the real packaged owner-profile group-chat showcase over an existing CDP port.
 *
 * The coordinating operator owns the app lifecycle, credentials, and GPU lock. This
 * harness never launches the app, connects a provider, loads a model, retries a model
 * call, or writes generated response text outside the owner profile. It uses the
 * visible product disclosure for each outbound turn and records only redacted proof.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const OWNER_PROFILE = resolve('E:/temp/cupcakeai-owner-test-20260902');
const OUTPUT_ROOT = resolve('E:/temp/cupcakeai-owner-group-showcase-20260905');
const HARBOR_PROJECT = {
  id: '01a07025-0334-7ee4-8c90-4b65b1115a40',
  name: '[LIVE] Harbor Data Reliability Lab',
};
const CONVERSATION_TITLE = '[GROUP] A small launch council';
const GROQ_MODEL = 'openai/gpt-oss-20b';
const COHERE_MODEL = 'command-a-plus-05-2026';

const SMART_PROMPT =
  'Harbor has 48 hours to respond to malformed CSV rows, duplicate timestamp/sensor pairs, non-finite readings, and a dashboard that treats missing values as zero. Work as a small launch council: the planner should propose a prioritized three-step rollout with owners and stop/go evidence; then the independent critic should add the most dangerous assumption and one falsification check without repeating the plan. Keep the whole council response concise, preserve evidence, and do not claim any test was run.';
const CRITIC_HANDLE = 'quill';
const FOLLOWUP_SUFFIX =
  ', review the council’s stop/go gates. Name the weakest gate, replace it with one measurable threshold, and state what evidence would reverse your judgment. Keep it under 120 words.';
const FOLLOWUP_PROMPT = `@${CRITIC_HANDLE}${FOLLOWUP_SUFFIX}`;
const QUIET_PROMPT = 'Thanks, that is all. No further replies are needed.';

const PERSONAS = {
  planner: {
    name: 'Mara',
    handle: 'mara',
    avatar: 'atlas:4',
    role: 'Launch planner',
    description: 'Turns operational evidence into a bounded rollout plan.',
    instructions:
      'Prioritize actions, name owners, and define observable stop/go evidence. Never imply a test, deployment, or incident occurred unless the conversation supplies that evidence.',
    speakWhen:
      'Speak first when a request needs sequencing, ownership, rollback points, or a practical launch decision.',
    personality: { preset: 'concise', warmth: 0.55, brevity: 0.78, initiative: 0.7 },
  },
  critic: {
    name: 'Quill',
    handle: CRITIC_HANDLE,
    avatar: 'atlas:11',
    role: 'Independent evidence critic',
    description: 'Challenges weak gates and unsupported operational claims.',
    instructions:
      'Add a distinct skeptical review. Identify unsupported assumptions, propose falsification checks, and protect missing-data semantics. Do not repeat the planner or claim unobserved work passed.',
    speakWhen:
      'Speak after a plan when an independent risk check, measurable threshold, or disconfirming test would change the decision.',
    personality: { preset: 'precise', warmth: 0.35, brevity: 0.82, initiative: 0.62 },
  },
  local: {
    name: 'Juniper',
    handle: 'juniper',
    avatar: 'atlas:15',
    role: 'Private local reviewer',
    description: 'A private local reviewer for follow-up work that should stay on this computer.',
    instructions:
      'Review local-only material conservatively. Separate observed evidence from assumptions and keep recommendations concise.',
    speakWhen: 'Speak only when directly mentioned for a private local review.',
    personality: { preset: 'balanced', warmth: 0.48, brevity: 0.72, initiative: 0.35 },
  },
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `Usage:\n  node scripts/accept-owner-group-showcase.mjs --self-test\n  node scripts/accept-owner-group-showcase.mjs --port <cdp-port> [--output ${OUTPUT_ROOT}]\n\nThe packaged app must already be running against ${OWNER_PROFILE}. The harness performs two Smart turns and one direct-mention turn, and never retries an existing prompt.\n`,
  );
  process.exit(0);
}

if (args.includes('--self-test')) {
  runSelfTests();
  process.stdout.write('Owner group showcase guard self-tests passed.\n');
  process.exit(0);
}

const option = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};

const port = Number(option('--port'));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('--port must be a non-privileged TCP port');
}
const profile = resolve(option('--profile', OWNER_PROFILE));
if (profile.toLowerCase() !== OWNER_PROFILE.toLowerCase()) {
  throw new Error(`This harness is restricted to the owner test profile: ${OWNER_PROFILE}`);
}
const output = resolve(option('--output', OUTPUT_ROOT));
assertUnderETemp(output, '--output');
await mkdir(output, { recursive: true });

const evidence = {
  schemaVersion: 1,
  scenario: 'owner-group-launch-council-v1',
  profile,
  project: HARBOR_PROJECT,
  conversationTitle: CONVERSATION_TITLE,
  startedAt: new Date().toISOString(),
  packagedApp: null,
  profileProof: null,
  setup: null,
  turns: [],
  optionalLocalPersona: null,
  screenshots: [],
  outcome: 'failed',
  failure: null,
};

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await packagedPage(browser);
  evidence.packagedApp = await assertRealPackagedApp(page);
  const ownerProject = await assertExactOwnerProfile(page);
  evidence.profileProof = {
    method: 'immutable-owner-project-sentinel',
    projectId: ownerProject.id,
    projectName: ownerProject.name,
  };

  let conversation = await findConversation(page, ownerProject.id);
  if (conversation?.status === 'archived') {
    throw new Error('The owner archived this group showcase; refusing to unarchive or rerun it');
  }
  let existing = conversation ? await inspectExistingScenario(page, conversation) : null;
  if (existing?.complete) {
    evidence.turns = existing.turnEvidence;
    evidence.setup = existing.setupEvidence;
    evidence.optionalLocalPersona = existing.optionalLocalPersona;
    const screenshot = await captureConversation(page, CONVERSATION_TITLE, output, 'complete');
    evidence.screenshots.push(screenshot);
    evidence.outcome = 'already_completed';
  } else {
    if (existing?.promptSeenButIncomplete) {
      throw new Error(
        'A showcase prompt already exists without complete accepted group evidence; refusing automatic retry',
      );
    }
    const models = modelArray(await runtimeRequest(page, 'models.list', {}, 180_000));
    const groqModel = selectExactHostedModel(models, 'groq', GROQ_MODEL);
    const cohereModel = selectExactHostedModel(models, 'cohere', COHERE_MODEL);
    if (!groqModel || !cohereModel) {
      throw new Error('Exact connected Groq and Cohere showcase models must both be available');
    }

    if (!conversation) {
      const created = await runtimeRequest(
        page,
        'conversations.create',
        { title: CONVERSATION_TITLE, projectId: HARBOR_PROJECT.id },
        120_000,
      );
      conversation = { ...created.conversation, branchId: created.branch.id };
    }
    const setup = await ensureHostedCouncil(page, conversation, groqModel, cohereModel);
    evidence.setup = setupEvidence(setup, groqModel, cohereModel);
    await openConversation(page, CONVERSATION_TITLE);

    existing = await inspectExistingScenario(page, conversation);
    let smartTurn = existing.smart;
    if (!smartTurn) {
      const disclosure = await sendSmartTurnThroughUi(page, output, {
        planner: setup.plannerParticipant,
        critic: setup.criticParticipant,
        groqModel,
        cohereModel,
      });
      evidence.screenshots.push(disclosure);
      smartTurn = await waitForPersistedTurn(page, conversation.branchId, SMART_PROMPT, 600_000);
    }
    const smartEvidence = await verifyGroupTurn(
      page,
      conversation.branchId,
      SMART_PROMPT,
      smartTurn,
      {
        mode: 'smart',
        expectedParticipants: [setup.plannerParticipant, setup.criticParticipant],
        expectedModels: new Map([
          [setup.plannerParticipant.id, groqModel.id],
          [setup.criticParticipant.id, cohereModel.id],
        ]),
        responderCalls: 2,
        maxSelectorCalls: 2,
        selectorCallRange: [1, 2],
        expectedHandlesInOrder: [PERSONAS.planner.handle, PERSONAS.critic.handle],
      },
    );
    evidence.turns.push(smartEvidence);

    existing = await inspectExistingScenario(page, conversation);
    let mentionTurn = existing.mention;
    if (!mentionTurn) {
      const disclosure = await sendMentionTurnThroughUi(page, output, {
        critic: setup.criticParticipant,
        cohereModel,
      });
      evidence.screenshots.push(disclosure);
      mentionTurn = await waitForPersistedTurn(
        page,
        conversation.branchId,
        FOLLOWUP_PROMPT,
        600_000,
      );
    }
    const mentionEvidence = await verifyGroupTurn(
      page,
      conversation.branchId,
      FOLLOWUP_PROMPT,
      mentionTurn,
      {
        mode: 'mentions',
        expectedParticipants: [setup.criticParticipant],
        expectedModels: new Map([[setup.criticParticipant.id, cohereModel.id]]),
        responderCalls: 1,
        maxSelectorCalls: 0,
        selectorCallRange: [0, 0],
        expectedHandlesInOrder: [PERSONAS.critic.handle],
      },
    );
    evidence.turns.push(mentionEvidence);

    existing = await inspectExistingScenario(page, conversation);
    let quietTurn = existing.quiet;
    if (!quietTurn) {
      const disclosure = await sendQuietTurnThroughUi(page, output, {
        planner: setup.plannerParticipant,
        critic: setup.criticParticipant,
        groqModel,
        cohereModel,
      });
      evidence.screenshots.push(disclosure);
      quietTurn = await waitForPersistedTurn(page, conversation.branchId, QUIET_PROMPT, 600_000, [
        'waiting_for_you',
      ]);
    }
    const quietEvidence = await verifyQuietTurn(
      page,
      conversation.branchId,
      QUIET_PROMPT,
      quietTurn,
      setup.plannerParticipant,
      groqModel,
    );
    evidence.turns.push(quietEvidence);

    evidence.optionalLocalPersona = await addOptionalConfiguredQwenPersona(
      page,
      conversation,
      models,
    );
    const finalScreenshot = await captureConversation(
      page,
      CONVERSATION_TITLE,
      output,
      'launch-council',
    );
    evidence.screenshots.push(finalScreenshot);
    evidence.outcome = 'completed';
  }
} catch (error) {
  evidence.failure = safeError(error);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  const manifest = join(output, 'owner-group-showcase-evidence.json');
  await writeFile(manifest, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await browser?.close().catch(() => undefined);
  process.stdout.write(
    `${JSON.stringify(
      {
        outcome: evidence.outcome,
        turns: evidence.turns.map((turn) => ({
          mode: turn.mode,
          status: turn.status,
          responderCalls: turn.responderCalls,
          selectorCalls: turn.selectorCalls,
          speakers: turn.messages.map((message) => message.speaker.name),
        })),
        optionalLocalPersona: evidence.optionalLocalPersona?.outcome ?? null,
        manifest,
        failure: evidence.failure,
      },
      null,
      2,
    )}\n`,
  );
}

async function runtimeRequest(page, method, params = {}, timeoutMs = 120_000) {
  const response = await page.evaluate(
    async ({ requestMethod, requestParams, requestTimeout }) => {
      const api = globalThis.window.cupcake?.runtime;
      if (!api) return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '' } };
      return api.request({
        method: requestMethod,
        params: requestParams,
        timeoutMs: requestTimeout,
      });
    },
    { requestMethod: method, requestParams: params, requestTimeout: timeoutMs },
  );
  if (!response?.ok) {
    throw new Error(
      `${method}: ${safeToken(response?.error?.code) || 'RUNTIME_REQUEST_FAILED'}: ${safeToken(
        response?.error?.message,
      )}`,
    );
  }
  return response.result;
}

async function packagedPage(browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page =
      pages.find((candidate) => /tauri\.localhost/iu.test(candidate.url())) ??
      pages.find((candidate) => candidate.url() !== 'about:blank');
    if (page) return page;
    await delay(100);
  }
  throw new Error('The CDP endpoint did not expose the packaged CupcakeAI renderer');
}

async function assertRealPackagedApp(page) {
  const identity = await page.evaluate(async () => {
    const api = globalThis.window.cupcake;
    return {
      tauri: '__TAURI_INTERNALS__' in globalThis.window,
      bridge: Boolean(api?.runtime?.request),
      fixtureBanner: Boolean(globalThis.document.querySelector('.fixture-banner')),
      info: api?.app?.getInfo ? await api.app.getInfo() : null,
      runtime: api?.runtime?.status ? await api.runtime.status() : null,
      url: globalThis.location.href,
    };
  });
  if (
    !identity.tauri ||
    !identity.bridge ||
    identity.fixtureBanner ||
    identity.info?.packaged !== true ||
    identity.runtime?.mode !== 'broker' ||
    identity.runtime?.state !== 'ready'
  ) {
    throw new Error('A real ready packaged Tauri app and broker are required');
  }
  await waitForWorkbench(page);
  return {
    version: safeToken(identity.info.appVersion),
    packaged: true,
    runtimeMode: 'broker',
    runtimeState: 'ready',
    runtimePidObserved: Number.isSafeInteger(identity.runtime.pid),
    rendererOrigin: new globalThis.URL(identity.url).origin,
  };
}

async function waitForWorkbench(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 180_000 });
  if (
    await page
      .locator('input[type="password"]:visible')
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error('Owner profile is locked; this harness never submits workspace passwords');
  }
}

async function assertExactOwnerProfile(page) {
  const projects = await runtimeRequest(page, 'projects.list', { includeArchived: true }, 120_000);
  const exactId = projects.filter((project) => project.id === HARBOR_PROJECT.id);
  if (
    exactId.length !== 1 ||
    exactId[0].name !== HARBOR_PROJECT.name ||
    exactId[0].status === 'archived'
  ) {
    throw new Error(
      'Owner-profile sentinel mismatch; refusing to mutate a different or reconstructed profile',
    );
  }
  const conflicting = projects.filter(
    (project) => project.name === HARBOR_PROJECT.name && project.id !== HARBOR_PROJECT.id,
  );
  if (conflicting.length) throw new Error('Duplicate Harbor project breaks owner-profile identity');
  return exactId[0];
}

async function findConversation(page, projectId) {
  const conversations = await runtimeRequest(
    page,
    'conversations.list',
    { projectId, includeArchived: true, limit: 500 },
    120_000,
  );
  const matches = conversations.filter((item) => item.title === CONVERSATION_TITLE);
  if (matches.length > 1) throw new Error(`Duplicate showcase conversation: ${CONVERSATION_TITLE}`);
  if (!matches.length) return null;
  const state = await runtimeRequest(
    page,
    'conversations.get',
    { conversationId: matches[0].id },
    120_000,
  );
  const branchId = state.activeBranchId ?? state.branches?.[0]?.id;
  if (!branchId) throw new Error('The showcase conversation has no active branch');
  return { ...matches[0], branchId };
}

async function inspectExistingScenario(page, conversation) {
  const history = await runtimeRequest(page, 'chat.history', { branchId: conversation.branchId });
  const smart = await existingTurnForPrompt(page, history, SMART_PROMPT);
  const mention = await existingTurnForPrompt(page, history, FOLLOWUP_PROMPT);
  const quiet = await existingTurnForPrompt(page, history, QUIET_PROMPT, ['waiting_for_you']);
  const promptSeenButIncomplete = [smart, mention, quiet].some((item) => item?.incomplete);
  if (mention && !smart) {
    throw new Error('The mention follow-up exists without its required Smart council turn');
  }
  if (!smart || !mention || !quiet || promptSeenButIncomplete) {
    return {
      complete: false,
      promptSeenButIncomplete,
      smart: smart?.turn,
      mention: mention?.turn,
      quiet: quiet?.turn,
    };
  }
  const participants = participantSnapshotsFromTurns([smart.turn, mention.turn]);
  const planner = participants.find((item) => item.persona.handle === PERSONAS.planner.handle);
  const critic = participants.find((item) => item.persona.handle === PERSONAS.critic.handle);
  if (!planner || !critic)
    throw new Error('Persisted group turns do not contain the exact council');
  const smartEvidence = await verifyGroupTurn(
    page,
    conversation.branchId,
    SMART_PROMPT,
    smart.turn,
    {
      mode: 'smart',
      expectedParticipants: [planner, critic],
      expectedModels: new Map([
        [planner.id, exactModelIdForParticipant(smart.turn, planner.id)],
        [critic.id, exactModelIdForParticipant(smart.turn, critic.id)],
      ]),
      responderCalls: 2,
      maxSelectorCalls: 2,
      selectorCallRange: [1, 2],
      expectedHandlesInOrder: [PERSONAS.planner.handle, PERSONAS.critic.handle],
    },
  );
  const mentionEvidence = await verifyGroupTurn(
    page,
    conversation.branchId,
    FOLLOWUP_PROMPT,
    mention.turn,
    {
      mode: 'mentions',
      expectedParticipants: [critic],
      expectedModels: new Map([[critic.id, exactModelIdForParticipant(mention.turn, critic.id)]]),
      responderCalls: 1,
      maxSelectorCalls: 0,
      selectorCallRange: [0, 0],
      expectedHandlesInOrder: [PERSONAS.critic.handle],
    },
  );
  assertNativeRoute(smartEvidence, PERSONAS.planner.handle, 'groq', GROQ_MODEL);
  assertNativeRoute(smartEvidence, PERSONAS.critic.handle, 'cohere', COHERE_MODEL);
  assertNativeRoute(mentionEvidence, PERSONAS.critic.handle, 'cohere', COHERE_MODEL);
  const quietEvidence = await verifyQuietTurn(
    page,
    conversation.branchId,
    QUIET_PROMPT,
    quiet.turn,
    planner,
    { id: exactSelectorModelId(quiet.turn) },
  );
  assertNativeSelectorRoute(quietEvidence, 'groq', GROQ_MODEL);
  const currentParticipants = await runtimeRequest(page, 'conversations.participants.list', {
    conversationId: conversation.id,
  });
  const local = currentParticipants.find((item) => item.persona?.handle === PERSONAS.local.handle);
  return {
    complete: true,
    promptSeenButIncomplete: false,
    smart: smart.turn,
    mention: mention.turn,
    turnEvidence: [smartEvidence, mentionEvidence, quietEvidence],
    setupEvidence: {
      plannerPersonaId: planner.personaId,
      criticPersonaId: critic.personaId,
      leadParticipantId: planner.id,
      strategy: 'smart-selective',
      maxReplies: 2,
    },
    optionalLocalPersona: local
      ? {
          outcome: 'already_present',
          personaId: local.personaId,
          modelId: local.persona.modelId,
          enabled: local.enabled,
          availability: local.availability?.status,
        }
      : { outcome: 'not_present' },
  };
}

async function existingTurnForPrompt(page, history, prompt, acceptedStatuses = ['completed']) {
  const users = history.filter((message) => message.role === 'user' && message.content === prompt);
  if (!users.length) return null;
  if (users.length !== 1)
    throw new Error('A showcase prompt appears more than once; refusing ambiguity');
  const group = canonicalMetadata(users[0]).group;
  if (!group?.turnId) return { incomplete: true, turn: null };
  const turn = await runtimeRequest(page, 'groups.turn.get', { turnId: group.turnId });
  return { incomplete: !acceptedStatuses.includes(turn.status), turn };
}

async function ensureHostedCouncil(page, conversation, groqModel, cohereModel) {
  const planner = await ensurePersona(page, { ...PERSONAS.planner, modelId: groqModel.id });
  const critic = await ensurePersona(page, { ...PERSONAS.critic, modelId: cohereModel.id });
  let participants = await runtimeRequest(page, 'conversations.participants.list', {
    conversationId: conversation.id,
  });
  const allowedPersonaIds = new Set([planner.id, critic.id]);
  const unrelatedEnabled = participants.filter(
    (item) => item.enabled && !allowedPersonaIds.has(item.personaId),
  );
  if (unrelatedEnabled.length) {
    throw new Error(
      'Showcase conversation has an unrelated enabled Cupcake; refusing to remove it',
    );
  }
  for (const persona of [planner, critic]) {
    if (!participants.some((item) => item.personaId === persona.id)) {
      await runtimeRequest(page, 'conversations.participants.add', {
        conversationId: conversation.id,
        personaId: persona.id,
        enabled: true,
      });
    }
  }
  participants = await runtimeRequest(page, 'conversations.participants.list', {
    conversationId: conversation.id,
  });
  const plannerParticipant = participants.find((item) => item.personaId === planner.id);
  const criticParticipant = participants.find((item) => item.personaId === critic.id);
  if (!plannerParticipant || !criticParticipant) throw new Error('Council roster did not persist');
  for (const participant of [plannerParticipant, criticParticipant]) {
    if (!participant.enabled || participant.availability?.status !== 'ready') {
      throw new Error(`${participant.persona.name} is not ready on its exact route`);
    }
  }
  const ordered = [plannerParticipant.id, criticParticipant.id];
  const remainder = participants
    .filter((item) => !ordered.includes(item.id))
    .sort((left, right) => left.position - right.position)
    .map((item) => item.id);
  await runtimeRequest(page, 'conversations.participants.reorder', {
    conversationId: conversation.id,
    participantIds: [...ordered, ...remainder],
  });
  const settings = await runtimeRequest(page, 'conversations.group.settings.set', {
    conversationId: conversation.id,
    strategy: 'smart-selective',
    maxReplies: 2,
    leadParticipantId: plannerParticipant.id,
  });
  assert.equal(settings.strategy, 'smart-selective');
  assert.equal(settings.maxReplies, 2);
  assert.equal(settings.leadParticipantId, plannerParticipant.id);
  return { planner, critic, plannerParticipant, criticParticipant, settings };
}

async function ensurePersona(page, desired) {
  const personas = await runtimeRequest(page, 'personas.list', { includeArchived: true });
  const matches = personas.filter((item) => item.handle === desired.handle);
  if (matches.length > 1) throw new Error(`Duplicate Cupcake handle: ${desired.handle}`);
  if (!matches.length) return runtimeRequest(page, 'personas.create', desired);
  const existing = matches[0];
  if (existing.archivedAt)
    throw new Error(`The owner archived @${desired.handle}; refusing to revive it`);
  const identityKeys = ['name', 'role', 'description', 'modelId'];
  if (identityKeys.some((key) => existing[key] !== desired[key])) {
    throw new Error(`Cupcake handle collision with an owner-created persona: @${desired.handle}`);
  }
  const keys = ['name', 'avatar', 'role', 'description', 'instructions', 'speakWhen', 'modelId'];
  const changed = keys.some((key) => existing[key] !== desired[key]);
  const personalityChanged =
    JSON.stringify(existing.personality) !== JSON.stringify(desired.personality);
  if (!changed && !personalityChanged) return existing;
  return runtimeRequest(page, 'personas.update', { personaId: existing.id, ...desired });
}

async function sendSmartTurnThroughUi(page, output, setup) {
  const composer = page.getByRole('textbox', { name: 'Message Cupcake', exact: true });
  await composer.fill(SMART_PROMPT);
  await page.getByRole('button', { name: 'Send group message', exact: true }).click();
  const dialog = page.getByTestId('group-disclosure');
  await dialog.waitFor({ timeout: 120_000 });
  await assertDisclosure(dialog, {
    mode: 'smart',
    names: [setup.planner.persona.name, setup.critic.persona.name],
    modelIds: [setup.groqModel.id, setup.cohereModel.id],
    candidateCount: 2,
  });
  const path = join(output, 'smart-turn-disclosure.png');
  await page.screenshot({ path, fullPage: true });
  await dialog.getByRole('heading', { name: 'Confirm possible destinations' }).waitFor();
  await dialog.getByTestId('group-confirm').click();
  await dialog.waitFor({ state: 'hidden', timeout: 360_000 });
  return path;
}

async function sendMentionTurnThroughUi(page, output, setup) {
  const composer = page.getByRole('textbox', { name: 'Message Cupcake', exact: true });
  await composer.fill('@');
  const mentionPopup = page.getByTestId('group-mention-menu');
  const menu = mentionPopup.getByRole('listbox', { name: 'Mention a Cupcake or your work' });
  await menu.waitFor({ timeout: 30_000 });
  const option = menu.getByRole('option').filter({ hasText: setup.critic.persona.name });
  if ((await option.count()) !== 1)
    throw new Error('The exact critic mention option is unavailable');
  await option.click();
  await composer.press('End');
  if ((await composer.inputValue()).endsWith(' ')) await composer.press('Backspace');
  await page.keyboard.insertText(FOLLOWUP_SUFFIX);
  if ((await composer.inputValue()) !== FOLLOWUP_PROMPT) {
    throw new Error('Structured mention text does not match the frozen follow-up prompt');
  }
  await page.getByRole('button', { name: 'Send group message', exact: true }).click();
  const dialog = page.getByTestId('group-disclosure');
  await dialog.waitFor({ timeout: 120_000 });
  await assertDisclosure(dialog, {
    mode: 'mentions',
    names: [setup.critic.persona.name],
    modelIds: [setup.cohereModel.id],
    candidateCount: 1,
  });
  const path = join(output, 'critic-mention-disclosure.png');
  await page.screenshot({ path, fullPage: true });
  await dialog.getByRole('heading', { name: 'Confirm possible destinations' }).waitFor();
  await dialog.getByTestId('group-confirm').click();
  await dialog.waitFor({ state: 'hidden', timeout: 360_000 });
  return path;
}

async function sendQuietTurnThroughUi(page, output, setup) {
  const composer = page.getByRole('textbox', { name: 'Message Cupcake', exact: true });
  await composer.fill(QUIET_PROMPT);
  await page.getByRole('button', { name: 'Send group message', exact: true }).click();
  const dialog = page.getByTestId('group-disclosure');
  await dialog.waitFor({ timeout: 120_000 });
  await assertDisclosure(dialog, {
    mode: 'smart',
    names: [setup.planner.persona.name, setup.critic.persona.name],
    modelIds: [setup.groqModel.id, setup.cohereModel.id],
    candidateCount: 2,
  });
  const path = join(output, 'quiet-turn-disclosure.png');
  await page.screenshot({ path, fullPage: true });
  await dialog.getByRole('heading', { name: 'Confirm possible destinations' }).waitFor();
  await dialog.getByTestId('group-confirm').click();
  await dialog.waitFor({ state: 'hidden', timeout: 360_000 });
  return path;
}

async function assertDisclosure(dialog, expected) {
  const candidates = dialog.locator('.disclosure-candidates article');
  assert.equal(
    await candidates.count(),
    expected.candidateCount,
    'Unexpected disclosed route count',
  );
  const text = await dialog.innerText();
  for (const name of expected.names) assert.match(text, new RegExp(escapeRegExp(name), 'u'));
  for (const modelId of expected.modelIds) {
    assert.match(text, new RegExp(escapeRegExp(modelId), 'u'));
  }
  if (expected.mode === 'smart') {
    assert.match(text, /Up to 2 short decisions/u);
    assert.match(text, /At most 2 will reply/u);
  } else {
    assert.match(text, /Only the Cupcakes you mentioned will receive this turn/u);
    assert.match(text, /Sequential, in mention order/u);
  }
}

async function waitForPersistedTurn(
  page,
  branchId,
  prompt,
  timeoutMs,
  acceptedStatuses = ['completed'],
) {
  const deadline = Date.now() + timeoutMs;
  let observed = null;
  while (Date.now() < deadline) {
    const history = await runtimeRequest(page, 'chat.history', { branchId }, 120_000);
    const result = await existingTurnForPrompt(page, history, prompt);
    if (result?.turn) {
      observed = result.turn;
      if (acceptedStatuses.includes(result.turn.status)) return result.turn;
      if (result.turn.status !== 'running') return result.turn;
    }
    await delay(750);
  }
  if (observed) return observed;
  throw new Error('Timed out before the confirmed group turn became durable');
}

async function verifyQuietTurn(page, branchId, prompt, turn, planner, groqModel) {
  assert.equal(turn.status, 'waiting_for_you', 'Acknowledgment turn did not stay quiet');
  assert.equal(turn.mode, 'smart');
  assert.equal(turn.maxReplies, 2);
  assert.equal(turn.maxSelectorCalls, 2);
  assert.equal(turn.selectorCalls, 1, 'Quiet turn must use exactly one bounded selector decision');
  assert.equal(turn.responderCalls, 0, 'Quiet turn made an unwanted responder call');
  assert.deepEqual(turn.members, [], 'Quiet turn persisted an unwanted member response');
  const selector = turn.plan?.selector;
  assert.equal(selector?.participantId, planner.id);
  assert.equal(selector?.model?.id, groqModel.id);
  const history = await runtimeRequest(page, 'chat.history', { branchId });
  const user = history.filter((message) => message.role === 'user' && message.content === prompt);
  assert.equal(user.length, 1, 'Quiet prompt must appear exactly once');
  assert.equal(canonicalMetadata(user[0]).group?.turnId, turn.turnId);
  return {
    turnId: turn.turnId,
    userMessageId: turn.userMessageId,
    promptSha256: sha256(prompt),
    mode: turn.mode,
    status: turn.status,
    rosterRevision: turn.rosterRevision,
    planRevision: turn.planRevision,
    digest: turn.digest,
    maxReplies: turn.maxReplies,
    maxSelectorCalls: turn.maxSelectorCalls,
    selectorCalls: turn.selectorCalls,
    responderCalls: turn.responderCalls,
    selector: {
      participantId: selector.participantId,
      personaId: selector.persona?.id,
      name: selector.persona?.name,
      handle: selector.persona?.handle,
      modelId: selector.model?.id,
      providerId: selector.model?.provider,
      privacyRoute: selector.model?.privacyRoute,
    },
    selectorUsage: safeUsageEvidence(turn.selectorUsage),
    messages: [],
    completedAt: turn.completedAt,
  };
}

async function verifyGroupTurn(page, branchId, prompt, turn, expected) {
  assert.equal(turn.status, 'completed', 'Group turn did not complete');
  assert.equal(turn.mode, expected.mode, 'Group turn mode changed');
  assert.equal(turn.maxReplies, 2, 'Group reply cap changed');
  assert.equal(turn.maxSelectorCalls, expected.maxSelectorCalls, 'Selector cap changed');
  assert.equal(turn.responderCalls, expected.responderCalls, 'Unexpected responder call count');
  assert.ok(
    turn.selectorCalls >= expected.selectorCallRange[0] &&
      turn.selectorCalls <= expected.selectorCallRange[1],
    'Unexpected selector call count',
  );
  assert.equal(turn.members.length, expected.expectedParticipants.length);
  const history = await runtimeRequest(page, 'chat.history', { branchId });
  const user = history.filter((message) => message.role === 'user' && message.content === prompt);
  assert.equal(user.length, 1, 'Frozen prompt must appear exactly once');
  assert.equal(canonicalMetadata(user[0]).group?.turnId, turn.turnId);
  const byParticipant = new Map(expected.expectedParticipants.map((item) => [item.id, item]));
  const messages = [];
  for (const member of turn.members) {
    assert.equal(member.status, 'completed');
    const participant = byParticipant.get(member.participantId);
    assert.ok(participant, 'Unexpected group responder');
    assert.equal(member.speaker?.personaId, participant.personaId);
    assert.equal(member.speaker?.handle, participant.persona.handle);
    assert.equal(member.speaker?.modelId, expected.expectedModels.get(member.participantId));
    const message = history.find((item) => item.id === member.messageId);
    assertCompleteAssistant(message);
    const group = canonicalMetadata(message).group;
    assert.equal(group?.turnId, turn.turnId);
    assert.equal(group?.sequence, member.sequence);
    assert.equal(group?.speaker?.participantId, member.participantId);
    assert.equal(group?.speaker?.modelId, member.speaker.modelId);
    messages.push({
      messageId: message.id,
      sequence: member.sequence,
      speaker: {
        participantId: member.participantId,
        personaId: member.speaker.personaId,
        name: member.speaker.name,
        handle: member.speaker.handle,
        role: member.speaker.role,
        modelId: member.speaker.modelId,
        providerId: member.speaker.providerId,
        privacyRoute: member.speaker.privacyRoute,
      },
      selectionReasonCode: member.selectionReasonCode,
      finishReason: canonicalMetadata(message).finishReason,
      contentSha256: sha256(message.content),
      contentCharacters: message.content.length,
      usage: safeUsageEvidence(member.usage, canonicalMetadata(message).usage),
    });
  }
  messages.sort((left, right) => left.sequence - right.sequence);
  assert.deepEqual(
    messages.map((message) => message.speaker.handle),
    expected.expectedHandlesInOrder,
    'Group speakers did not follow the fixed council order',
  );
  return {
    turnId: turn.turnId,
    userMessageId: turn.userMessageId,
    promptSha256: sha256(prompt),
    mode: turn.mode,
    status: turn.status,
    rosterRevision: turn.rosterRevision,
    planRevision: turn.planRevision,
    digest: turn.digest,
    maxReplies: turn.maxReplies,
    maxSelectorCalls: turn.maxSelectorCalls,
    selectorCalls: turn.selectorCalls,
    responderCalls: turn.responderCalls,
    selectorUsage: safeUsageEvidence(turn.selectorUsage),
    messages,
    completedAt: turn.completedAt,
  };
}

async function addOptionalConfiguredQwenPersona(page, conversation, priorModels) {
  const models = modelArray(await runtimeRequest(page, 'models.list', {}, 180_000));
  const status = await runtimeRequest(page, 'local_models.cupcake.status', {}, 120_000);
  const active = String(status.activeModelId ?? status.active_model_id ?? '');
  const local = models.find((model) => {
    const id = String(model.id ?? '');
    const native = nativeModelId(model);
    const configured =
      model.metadata?.runtime_loaded === true ||
      id === active ||
      native === active ||
      ['installed', 'ready', 'benchmarked', 'offline'].includes(String(model.status ?? ''));
    return (
      configured &&
      privacyRoute(model) === 'local' &&
      /qwen/iu.test(`${id} ${native} ${model.name}`)
    );
  });
  if (!local) {
    return {
      outcome: 'skipped_not_configured',
      checkedModelCount: priorModels.length,
      inferenceCalls: 0,
    };
  }
  const persona = await ensurePersona(page, { ...PERSONAS.local, modelId: local.id });
  let participants = await runtimeRequest(page, 'conversations.participants.list', {
    conversationId: conversation.id,
  });
  if (!participants.some((item) => item.personaId === persona.id)) {
    await runtimeRequest(page, 'conversations.participants.add', {
      conversationId: conversation.id,
      personaId: persona.id,
      enabled: false,
    });
  }
  participants = await runtimeRequest(page, 'conversations.participants.list', {
    conversationId: conversation.id,
  });
  const participant = participants.find((item) => item.personaId === persona.id);
  if (!participant) throw new Error('Optional local Qwen participant did not persist');
  return {
    outcome:
      participant.availability?.status === 'ready' ? 'added_disabled_ready' : 'added_disabled',
    participantId: participant.id,
    personaId: persona.id,
    modelId: local.id,
    availability: participant.availability?.status,
    enabled: participant.enabled,
    inferenceCalls: 0,
  };
}

async function openConversation(page, title) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbench(page);
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  const row = page.locator('.chat-list__main').filter({ hasText: title });
  await row.waitFor({ timeout: 60_000 });
  await row.click();
  await page.locator('.chat-main').waitFor({ timeout: 60_000 });
  await page.getByTestId('participant-tray').waitFor({ timeout: 60_000 });
  await page.getByRole('textbox', { name: 'Message Cupcake', exact: true }).waitFor({
    timeout: 60_000,
  });
}

async function captureConversation(page, title, output, suffix) {
  await openConversation(page, title);
  const path = join(output, `group-${suffix}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

function selectExactHostedModel(models, providerId, exactNativeId) {
  const matches = models.filter((model) => {
    const provider = normalizeProvider(model.provider ?? model.metadata?.provider);
    const endpoint = normalizeProvider(model.metadata?.endpoint_id ?? model.metadata?.endpointId);
    const id = String(model.id ?? '');
    const namedRoute =
      provider === 'openai-compatible' &&
      (endpoint === providerId || id.toLowerCase().startsWith(`openai-compatible:${providerId}/`));
    return (
      privacyRoute(model) === 'cloud' &&
      nativeModelId(model) === exactNativeId &&
      (provider === providerId || namedRoute) &&
      String(model.chat_compatibility ?? model.metadata?.chat_compatibility ?? 'chat') !==
        'non_chat'
    );
  });
  if (matches.length > 1) throw new Error(`Ambiguous exact ${providerId} model route`);
  return matches[0] ?? null;
}

function participantSnapshotsFromTurns(turns) {
  const values = new Map();
  for (const turn of turns) {
    for (const member of turn.members ?? []) {
      const speaker = member.speaker ?? {};
      if (!values.has(member.participantId)) {
        values.set(member.participantId, {
          id: member.participantId,
          personaId: speaker.personaId,
          enabled: true,
          persona: {
            id: speaker.personaId,
            name: speaker.name,
            handle: speaker.handle,
            role: speaker.role,
            modelId: speaker.modelId,
          },
        });
      }
    }
  }
  return [...values.values()];
}

function exactModelIdForParticipant(turn, participantId) {
  const members = (turn.members ?? []).filter((item) => item.participantId === participantId);
  if (members.length !== 1) throw new Error('Durable member model snapshot is ambiguous');
  return members[0].speaker?.modelId;
}

function exactSelectorModelId(turn) {
  const modelId = turn?.plan?.selector?.model?.id;
  if (!modelId) throw new Error('Durable Smart selector route is absent');
  return modelId;
}

function assertNativeRoute(turnEvidence, handle, provider, nativeId) {
  const message = turnEvidence.messages.find((item) => item.speaker.handle === handle);
  if (!message) throw new Error(`Required @${handle} response is absent`);
  const routeProvider = normalizeProvider(message.speaker.providerId);
  const modelId = String(message.speaker.modelId ?? '');
  const native = nativeModelId({ id: modelId, provider: routeProvider });
  const namedProvider = modelId.toLowerCase().startsWith(`openai-compatible:${provider}/`);
  if (native !== nativeId || (routeProvider !== provider && !namedProvider)) {
    throw new Error(`@${handle} did not use the frozen ${provider} route`);
  }
}

function assertNativeSelectorRoute(turnEvidence, provider, nativeId) {
  const selector = turnEvidence.selector;
  if (!selector) throw new Error('Durable Smart selector evidence is absent');
  const routeProvider = normalizeProvider(selector.providerId);
  const modelId = String(selector.modelId ?? '');
  const native = nativeModelId({ id: modelId, provider: routeProvider });
  const namedProvider = modelId.toLowerCase().startsWith(`openai-compatible:${provider}/`);
  if (native !== nativeId || (routeProvider !== provider && !namedProvider)) {
    throw new Error(`Quiet turn did not use the frozen ${provider} selector route`);
  }
}

function setupEvidence(setup, groqModel, cohereModel) {
  return {
    plannerPersonaId: setup.planner.id,
    criticPersonaId: setup.critic.id,
    leadParticipantId: setup.plannerParticipant.id,
    strategy: setup.settings.strategy,
    maxReplies: setup.settings.maxReplies,
    rosterRevision: setup.settings.rosterRevision,
    routes: [
      { participantId: setup.plannerParticipant.id, provider: 'groq', modelId: groqModel.id },
      { participantId: setup.criticParticipant.id, provider: 'cohere', modelId: cohereModel.id },
    ],
  };
}

function assertCompleteAssistant(message) {
  if (!message || message.role !== 'assistant' || !String(message.content ?? '').trim()) {
    throw new Error('A durable group member response is missing');
  }
  if (message.state !== 'complete') throw new Error('A group member response is not complete');
  const reason = canonicalMetadata(message).finishReason;
  if (!['stop', 'end_turn'].includes(reason)) {
    throw new Error(
      `A group member response ended with ${safeToken(reason) || 'no finish reason'}`,
    );
  }
}

function canonicalMetadata(message) {
  return message?.canonical_metadata ?? message?.canonicalMetadata ?? {};
}

function safeUsageEvidence(...values) {
  const counters = [];
  let eventCount = 0;
  const visit = (value, path = '') => {
    if (Array.isArray(value)) {
      eventCount += path.endsWith('events') ? value.length : 0;
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      if (
        typeof item === 'number' &&
        Number.isFinite(item) &&
        /token|cost|input|output|cached|total/iu.test(key)
      ) {
        counters.push({ path: next.slice(0, 160), value: item });
      } else {
        visit(item, next);
      }
    }
  };
  values.forEach((value, index) => visit(value, `source${index}`));
  return { eventCount, counters: counters.slice(0, 80) };
}

function modelArray(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.models) ? value.models : [];
}

function nativeModelId(model) {
  const id = String(model?.id ?? '');
  if (!id.includes(':')) return String(model?.model ?? id);
  const routeAndModel = id.slice(id.indexOf(':') + 1);
  const provider = normalizeProvider(model?.provider);
  if (provider === 'openai-compatible' && routeAndModel.includes('/')) {
    return routeAndModel.slice(routeAndModel.indexOf('/') + 1);
  }
  return String(model?.model ?? routeAndModel);
}

function privacyRoute(model) {
  return String(model?.privacy_route ?? model?.privacyRoute ?? '').toLowerCase();
}

function normalizeProvider(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_ ]+/gu, '-')
    .trim();
}

function safeError(error) {
  return { name: safeToken(error?.name) || 'Error', message: safeToken(error?.message) };
}

function safeToken(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/(?:sk|key|token|secret)[-_][A-Za-z0-9._-]{8,}/giu, '[redacted]')
    .slice(0, 500);
}

function sha256(value) {
  return createHash('sha256')
    .update(String(value ?? ''), 'utf8')
    .digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function assertUnderETemp(path, label) {
  const root = resolve('E:/temp').toLowerCase();
  const candidate = path.toLowerCase();
  if (!isAbsolute(path) || (candidate !== root && !candidate.startsWith(`${root}\\`))) {
    throw new Error(`${label} must be under E:\\temp`);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function runSelfTests() {
  const complete = {
    role: 'assistant',
    state: 'complete',
    content: 'Observed response',
    canonical_metadata: { finishReason: 'stop' },
  };
  assert.doesNotThrow(() => assertCompleteAssistant(complete));
  assert.throws(
    () => assertCompleteAssistant({ ...complete, state: 'streaming' }),
    /not complete/u,
  );
  assert.throws(
    () =>
      assertCompleteAssistant({
        ...complete,
        canonical_metadata: { finishReason: 'length' },
      }),
    /ended with length/u,
  );
  assert.equal(
    nativeModelId({
      id: 'openai-compatible:groq/openai/gpt-oss-20b',
      provider: 'openai-compatible',
    }),
    GROQ_MODEL,
  );
  assert.equal(
    nativeModelId({ id: 'cohere:command-a-plus-05-2026', provider: 'cohere' }),
    COHERE_MODEL,
  );
  const usage = safeUsageEvidence({ events: [{ usage: { input_tokens: 4, output_tokens: 7 } }] });
  assert.equal(usage.eventCount, 1);
  assert.deepEqual(
    usage.counters.map((item) => item.value),
    [4, 7],
  );
  assert.equal(FOLLOWUP_PROMPT, `@${CRITIC_HANDLE}${FOLLOWUP_SUFFIX}`);
  assert.match(FOLLOWUP_PROMPT, /^@quill, review/u);
  assert.match(SMART_PROMPT, /planner/u);
  assert.match(SMART_PROMPT, /independent critic/u);
  assert.equal(QUIET_PROMPT, 'Thanks, that is all. No further replies are needed.');
  assertUnderETemp(OUTPUT_ROOT, 'test output');
  assert.throws(() => assertUnderETemp(resolve('E:/temporary/not-allowed'), 'bad output'));
}
