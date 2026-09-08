#!/usr/bin/env node
/**
 * Create a warmer, everyday CupcakeAI showcase through a running packaged app.
 *
 * The coordinating operator owns app startup/shutdown, provider credentials, local
 * model load/unload, and the GPU lock. This script never reads credentials, launches
 * CupcakeAI, or retries an incomplete model turn. Hosted group turns go through the
 * product disclosure UI; direct turns use the same bound runtime preflight as the UI.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const OWNER_PROFILE = resolve('E:/temp/cupcakeai-owner-test-20260902');
const DEFAULT_OUTPUT = resolve('E:/temp/cupcakeai-owner-everyday-showcase-20260908');
const OWNER_SENTINEL = {
  id: '01a07025-0334-7ee4-8c90-4b65b1115a40',
  name: '[LIVE] Harbor Data Reliability Lab',
};
const GROQ_MODEL = 'openai/gpt-oss-20b';
const COHERE_MODEL = 'command-a-plus-05-2026';

const PROJECTS = {
  littleThings: {
    name: 'Small Things, Sorted',
    description:
      'Useful, low-drama help for meals, chores, errands, and the decisions that somehow eat an evening.',
  },
  adventures: {
    name: 'Pocket Adventures',
    description:
      'Small creative plans that fit a real day, a phone camera, a change of weather, and an ordinary budget.',
  },
  privateReset: {
    name: 'Private Reset Room',
    description:
      'Practical local-only help for getting unstuck without sending the conversation to a cloud provider.',
  },
};

const DINNER = {
  title: 'Friday dinner without the group-chat spiral',
  artifact: 'Friday dinner — final plan.md',
  prompts: {
    first:
      'five of us are eating at my apartment on friday. we have about ₹2,500, one vegetarian, no oven, and one very nervous beginner cook. can you two rescue us from another 70-message planning chat?',
    correction:
      'small correction: the vegetarian guest is actually vegan, and someone else will be 45 minutes late. i care much more about a relaxed evening than an impressive menu.',
    mentionSuffix:
      ', make the final call for me: one menu, a shopping list by aisle, and four jobs i can paste into our chat. give the beginner the least stressful job.',
    quiet: 'perfect, i have enough to shop. no more replies needed.',
  },
};

const DIRECT_SCENARIOS = {
  reset: {
    project: 'littleThings',
    title: 'Make Sunday feel lighter',
    artifact: 'A 20-minute apartment rescue.md',
    providerChoices: [
      { provider: 'groq', model: GROQ_MODEL },
      { provider: 'mistral', model: 'mistral-medium-3-5' },
    ],
    prompts: [
      'my apartment is messy enough that i keep walking between rooms and starting nothing. i have maybe 20 minutes and low energy. where do i start?',
      'laundry is impossible tonight. the visual mess is mostly paper, delivery packaging, and random things with no obvious home.',
      'that still feels like too much sorting. can we make the win smaller and leave the hard decisions for another day?',
      'yes, that feels doable. give me the final 20-minute version i can glance at once, plus a tiny stopping ritual for tomorrow morning.',
    ],
  },
  photoWalk: {
    project: 'adventures',
    title: 'A photo walk for grey weather',
    artifact: 'Grey-day phone photo walk.md',
    providerChoices: [
      { provider: 'cohere', model: COHERE_MODEL },
      { provider: 'google', model: 'gemini-3.8-flash' },
      { provider: 'mistral', model: 'mistral-medium-3-5' },
    ],
    prompts: [
      'i want to leave the house and take photos, but the sky is completely grey and i only have my phone. can we make that the idea instead of fighting it?',
      'it is a very ordinary neighborhood, no scenic route. i like small human details, but i am shy about photographing strangers.',
      'light rain might start halfway through and an hour suddenly sounds ambitious. can you make it work as a 35-minute walk?',
      'nice. give me the pocket version: a loose route, seven shots in a satisfying order, one playful rule, and a quick way to choose my best three later.',
    ],
  },
  localReset: {
    project: 'privateReset',
    title: 'A gentle reset that stays on this computer',
    artifact: 'Private 20-minute reset.md',
    local: true,
    prompts: [
      'i have bounced between messages, dishes, and half-finished tabs for an hour. i do not need a life overhaul; i just want the next hour to be less annoying.',
      'dishes can wait. the real friction is 14 browser tabs, three unanswered messages, and a bag i need ready for tomorrow morning.',
      'i am tempted to do all three messages properly right now. that is probably how i ended up stuck.',
      'okay. give me the final private 20-minute reset, a visible finish line, and one sentence i can send when a message needs more thought.',
    ],
  },
};

const PERSONAS = {
  host: {
    name: 'Maple',
    handle: 'maple_host',
    avatar: 'atlas:6',
    role: 'Decisive, considerate host',
    description: 'Turns competing preferences into one hospitable plan people can actually follow.',
    instructions:
      'Make a clear choice when the tradeoffs are known. Respect dietary constraints, uneven confidence, real budgets, and late arrivals. Use plain language and rough price bands when prices are unknown. Never claim shopping, cooking, or checking happened.',
    speakWhen:
      'Speak when the group needs a decision, a practical sequence, fair jobs, or a concise plan to share.',
    personality: { preset: 'warm', warmth: 0.72, brevity: 0.7, initiative: 0.7 },
  },
  realist: {
    name: 'Basil',
    handle: 'basil_realist',
    avatar: 'atlas:13',
    role: 'Kitchen realist',
    description:
      'Catches timing, equipment, dietary, and beginner-friendliness problems before dinner.',
    instructions:
      'Add only useful corrections or alternatives. Check that the plan works without an oven, protects vegan food, gives beginners a safe job, and does not leave the host cooking all evening. Do not repeat the host or invent local prices.',
    speakWhen:
      'Speak when a meal plan has a hidden timing, equipment, dietary, workload, or shopping problem. Stay quiet once those issues are resolved.',
    personality: { preset: 'concise', warmth: 0.56, brevity: 0.82, initiative: 0.48 },
  },
  reset: {
    name: 'Pip',
    handle: 'pip_reset',
    avatar: 'atlas:3',
    role: 'Small-win planner',
    description:
      'Makes an overwhelming room feel finite without turning it into a lifestyle project.',
    instructions:
      'Be warm, practical, and specific. Reduce scope when the user says a plan is too much. Prefer visible relief, temporary holding places, timers, and a clean stopping point over perfect organization. Never imply the user completed a step or diagnose their mood.',
    speakWhen:
      'Speak whenever the user asks for a smaller, calmer household plan or revises a constraint.',
    personality: { preset: 'warm', warmth: 0.78, brevity: 0.72, initiative: 0.5 },
  },
  photoWalk: {
    name: 'Lumen',
    handle: 'lumen_walks',
    avatar: 'atlas:9',
    role: 'Observant photo-walk companion',
    description:
      'Finds a small visual game in ordinary streets, modest gear, and imperfect weather.',
    instructions:
      'Offer concrete, achievable phone-photography prompts. Respect privacy around strangers, adapt to weather and energy, and explain visual ideas in everyday language. Keep the tone curious and lightly playful. Do not claim a place or photo was observed.',
    speakWhen:
      'Speak when a creative outing needs a theme, a smaller route, or a useful constraint.',
    personality: { preset: 'warm', warmth: 0.7, brevity: 0.62, initiative: 0.58 },
  },
  localReset: {
    name: 'Nori',
    handle: 'nori_private',
    avatar: 'atlas:16',
    role: 'Private practical reset',
    description: 'Helps untangle a busy hour while keeping the conversation on this computer.',
    instructions:
      'Be kind, grounded, and practical rather than therapeutic. Protect the user from expanding a short reset into a full productivity system. Choose what to ignore, give a visible finish line, and never imply work was completed.',
    speakWhen: 'Speak when directly asked for a private, bounded reset or a simpler next step.',
    personality: { preset: 'warm', warmth: 0.74, brevity: 0.75, initiative: 0.42 },
  },
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `Usage:\n  node scripts/create-owner-everyday-showcase.mjs --self-test\n  node scripts/create-owner-everyday-showcase.mjs --port <cdp-port> --phase hosted --execute REAL_PROVIDER_CALLS\n  node scripts/create-owner-everyday-showcase.mjs --port <cdp-port> --phase local --execute REAL_LOCAL_INFERENCE --gpu-marker "C:/.../gpu use.txt"\n  node scripts/create-owner-everyday-showcase.mjs --port <cdp-port> --phase verify\n\nThe packaged app must already be running against ${OWNER_PROFILE}. Hosted creation uses Groq and Cohere for the dinner group, then prefers already-connected generous routes for direct chats. It never connects providers or reads keys.\n`,
  );
  process.exit(0);
}

if (args.includes('--self-test')) {
  runSelfTests();
  process.stdout.write('Everyday showcase guard self-tests passed.\n');
  process.exit(0);
}

const option = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};

const phase = option('--phase');
if (!['hosted', 'local', 'verify'].includes(phase)) {
  throw new Error('--phase must be hosted, local, or verify');
}
const port = Number(option('--port'));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('--port must be a non-privileged TCP port');
}
const profile = resolve(option('--profile', OWNER_PROFILE));
if (profile.toLowerCase() !== OWNER_PROFILE.toLowerCase()) {
  throw new Error(`This harness is restricted to the owner test profile: ${OWNER_PROFILE}`);
}
const output = resolve(option('--output', DEFAULT_OUTPUT));
assertUnderETemp(output, '--output');
if (phase === 'hosted' && option('--execute') !== 'REAL_PROVIDER_CALLS') {
  throw new Error('Hosted creation requires --execute REAL_PROVIDER_CALLS');
}
if (phase === 'local' && option('--execute') !== 'REAL_LOCAL_INFERENCE') {
  throw new Error('Local creation requires --execute REAL_LOCAL_INFERENCE');
}

await mkdir(output, { recursive: true });
const evidence = {
  schemaVersion: 1,
  scenario: 'owner-everyday-showcase-v1',
  profile,
  phase,
  startedAt: new Date().toISOString(),
  packagedApp: null,
  projects: [],
  conversations: [],
  artifacts: [],
  group: null,
  localRuntime: null,
  screenshots: [],
  outcome: 'failed',
  failure: null,
};

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await packagedPage(browser);
  evidence.packagedApp = await assertRealPackagedApp(page);
  await assertExactOwnerProfile(page);

  if (phase === 'hosted') {
    const privacy = await runtimeRequest(page, 'settings.get', { key: 'privacy.default_mode' });
    if (privacy?.value === 'offline') {
      throw new Error('Turn off Offline mode before the explicitly authorized hosted showcase');
    }
    const models = modelArray(await runtimeRequest(page, 'models.list', {}, 180_000));
    const groq = selectExactReadyModel(models, 'groq', GROQ_MODEL);
    const cohere = selectExactReadyModel(models, 'cohere', COHERE_MODEL);
    if (!groq || !cohere) {
      throw new Error('The dinner group requires connected, ready Groq and Cohere routes');
    }
    const dinner = await runDinnerGroup(page, groq, cohere, output);
    recordResult(evidence, dinner);
    for (const scenarioId of ['reset', 'photoWalk']) {
      const scenario = DIRECT_SCENARIOS[scenarioId];
      const model = chooseReadyModel(models, scenario.providerChoices);
      if (!model) {
        throw new Error(`No preferred ready hosted route is available for ${scenario.title}`);
      }
      const result = await runSoloScenario(page, scenarioId, scenario, model, 'hosted');
      recordResult(evidence, result);
    }
    evidence.outcome = 'completed';
  } else if (phase === 'local') {
    const markerPath = option('--gpu-marker');
    if (!markerPath) throw new Error('--gpu-marker is required for local phase');
    const markerState = (await readFile(resolve(markerPath), 'utf8')).trim().toLowerCase();
    if (markerState !== 'yes') {
      throw new Error('GPU marker must already be yes; the coordinating operator owns the lock');
    }
    const privacy = await runtimeRequest(page, 'settings.get', { key: 'privacy.default_mode' });
    if (privacy?.value !== 'offline') {
      throw new Error('Local showcase requires Offline mode to be visibly enabled');
    }
    const localStatus = await runtimeRequest(
      page,
      'local_models.cupcake.status',
      { verifyIntegrity: true },
      180_000,
    );
    const hardware = await runtimeRequest(page, 'local_models.hardware', {}, 120_000);
    const models = modelArray(await runtimeRequest(page, 'models.list', {}, 180_000));
    const localModel = chooseLoadedLocalModel(models, localStatus);
    const gpu = String(hardware?.gpu_name ?? hardware?.gpuName ?? hardware?.gpu ?? '');
    const acceleration = Array.isArray(hardware?.acceleration) ? hardware.acceleration : [];
    const backend = String(
      localStatus?.activeRuntime?.backend ??
        localStatus?.active_runtime?.backend ??
        localStatus?.runtime?.backend ??
        '',
    );
    if (
      !localModel ||
      !/nvidia/iu.test(gpu) ||
      ![...acceleration, backend].some((item) => /cuda/iu.test(String(item)))
    ) {
      throw new Error(
        'Local showcase requires the exact loaded Cupcake Local model on NVIDIA CUDA',
      );
    }
    evidence.localRuntime = {
      modelId: localModel.id,
      gpu: sanitize(gpu),
      acceleration: acceleration.map(sanitize),
      backend: safeToken(backend),
    };
    const result = await runSoloScenario(
      page,
      'localReset',
      DIRECT_SCENARIOS.localReset,
      localModel,
      'local',
    );
    recordResult(evidence, result);
    evidence.outcome = 'completed';
  } else {
    await verifyPersistedShowcase(page, evidence, output);
    evidence.outcome = 'verified';
  }
} catch (error) {
  evidence.failure = safeError(error);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  const receipt = join(output, `everyday-showcase-${phase}-evidence.json`);
  await writeFile(receipt, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await browser?.close().catch(() => undefined);
  process.stdout.write(
    `${JSON.stringify(
      {
        phase,
        outcome: evidence.outcome,
        receipt,
        projects: evidence.projects.map((item) => item.name),
        conversations: evidence.conversations.map((item) => ({
          title: item.title,
          route: item.route,
          turns: item.assistantTurns,
        })),
        failure: evidence.failure,
      },
      null,
      2,
    )}\n`,
  );
}

async function runDinnerGroup(page, groq, cohere, outputDirectory) {
  const project = await ensureProject(page, PROJECTS.littleThings);
  const conversation = await ensureConversation(page, project.id, DINNER.title);
  if (conversation.status === 'archived') {
    throw new Error('The owner archived the dinner chat; refusing to revive it');
  }
  const host = await ensurePersona(page, { ...PERSONAS.host, modelId: groq.id });
  const realist = await ensurePersona(page, { ...PERSONAS.realist, modelId: cohere.id });
  const roster = await ensureDinnerRoster(page, conversation.id, host, realist);
  await openConversation(page, DINNER.title);

  const first = await ensureGroupTurn(page, conversation, DINNER.prompts.first, {
    mode: 'smart',
    expectedParticipants: [roster.host, roster.realist],
    minReplies: 1,
    maxReplies: 2,
  });
  const correction = await ensureGroupTurn(page, conversation, DINNER.prompts.correction, {
    mode: 'smart',
    expectedParticipants: [roster.host, roster.realist],
    minReplies: 1,
    maxReplies: 2,
  });
  const mentionPrompt = `@${PERSONAS.host.handle}${DINNER.prompts.mentionSuffix}`;
  const finalChoice = await ensureGroupTurn(page, conversation, mentionPrompt, {
    mode: 'mentions',
    mentionParticipant: roster.host,
    mentionSuffix: DINNER.prompts.mentionSuffix,
    expectedParticipants: [roster.host],
    minReplies: 1,
    maxReplies: 1,
  });
  const quiet = await ensureGroupTurn(page, conversation, DINNER.prompts.quiet, {
    mode: 'smart',
    expectedParticipants: [roster.host, roster.realist],
    minReplies: 0,
    maxReplies: 0,
    disclosureMaxReplies: 2,
    acceptedStatuses: ['waiting_for_you'],
  });
  const finalMessage = finalChoice.messages.at(-1);
  if (!finalMessage) throw new Error('The dinner plan has no final group response');
  const artifact = await ensureArtifact(
    page,
    project.id,
    conversation.id,
    DINNER.artifact,
    'document',
    finalMessage,
  );
  const screenshot = await captureConversation(page, DINNER.title, outputDirectory, 'dinner-group');
  return {
    project,
    conversation,
    artifact,
    screenshot,
    group: {
      personas: [safePersona(host), safePersona(realist)],
      strategy: 'smart-selective',
      maxReplies: 2,
      turns: [first, correction, finalChoice, quiet].map(groupTurnEvidence),
    },
    route: 'Groq + Cohere group',
    assistantTurns:
      first.messages.length + correction.messages.length + finalChoice.messages.length,
  };
}

async function runSoloScenario(page, scenarioId, scenario, model, routeType) {
  const project = await ensureProject(page, PROJECTS[scenario.project]);
  const conversation = await ensureConversation(page, project.id, scenario.title);
  if (conversation.status === 'archived') {
    throw new Error(`The owner archived ${scenario.title}; refusing to revive it`);
  }
  const persona = await ensurePersona(page, { ...PERSONAS[scenarioId], modelId: model.id });
  const participant = await ensureSoloRoster(page, conversation.id, persona);
  const assistants = [];
  for (const prompt of scenario.prompts) {
    const turn = await ensureGroupTurn(page, conversation, prompt, {
      mode: 'smart',
      expectedParticipants: [participant],
      minReplies: 1,
      maxReplies: 1,
    });
    assistants.push(turn.messages[0]);
  }
  const finalAssistant = assistants.at(-1);
  const artifact = await ensureArtifact(
    page,
    project.id,
    conversation.id,
    scenario.artifact,
    'document',
    finalAssistant,
  );
  return {
    project,
    conversation,
    artifact,
    route: routeType === 'local' ? 'Cupcake Local · NVIDIA CUDA' : hostedRouteLabel(model),
    assistantTurns: assistants.length,
    finalContentSha256: sha256(finalAssistant.content),
    group: {
      personas: [safePersona(persona)],
      strategy: 'smart-selective',
      maxReplies: 1,
    },
  };
}

async function ensureGroupTurn(page, conversation, prompt, expectation) {
  const existing = await existingGroupTurn(page, conversation.branchId, prompt);
  if (existing) return verifyGroupTurn(existing, expectation);

  await openConversation(page, conversation.title);
  const composer = page.getByRole('textbox', { name: 'Message Cupcake', exact: true });
  if (expectation.mode === 'mentions') {
    await composer.fill('@');
    const menu = page
      .getByTestId('group-mention-menu')
      .getByRole('listbox', { name: 'Mention a Cupcake or your work' });
    await menu.waitFor({ timeout: 30_000 });
    const choice = menu
      .getByRole('option')
      .filter({ hasText: expectation.mentionParticipant.persona.name });
    if ((await choice.count()) !== 1) throw new Error('Exact dinner host mention is unavailable');
    await choice.click();
    await composer.press('End');
    if ((await composer.inputValue()).endsWith(' ')) await composer.press('Backspace');
    await page.keyboard.insertText(expectation.mentionSuffix);
  } else {
    await composer.fill(prompt);
  }
  if ((await composer.inputValue()) !== prompt) {
    throw new Error('Composer text does not match the guarded everyday prompt');
  }
  await page.getByRole('button', { name: 'Send group message', exact: true }).click();
  const dialog = page.getByTestId('group-disclosure');
  const sendDeadline = Date.now() + 60_000;
  while (Date.now() < sendDeadline) {
    if (await dialog.isVisible()) {
      await assertGroupDisclosure(dialog, expectation);
      await dialog.getByTestId('group-confirm').click();
      await dialog.waitFor({ state: 'hidden', timeout: 600_000 });
      break;
    }
    if (await existingGroupTurn(page, conversation.branchId, prompt)) break;
    await delay(250);
  }
  const persisted = await waitForGroupTurn(page, conversation.branchId, prompt, 600_000);
  return verifyGroupTurn(persisted, expectation);
}

async function existingGroupTurn(page, branchId, prompt) {
  const history = await runtimeRequest(page, 'chat.history', { branchId });
  const users = history.filter((message) => message.role === 'user' && message.content === prompt);
  if (users.length > 1) throw new Error('An everyday group prompt appears more than once');
  if (!users.length) return null;
  const turnId = users[0]?.canonical_metadata?.group?.turnId;
  if (!turnId) throw new Error('Existing group prompt has no durable turn ID; refusing retry');
  const turn = await runtimeRequest(page, 'groups.turn.get', { turnId });
  return { turn, history };
}

async function waitForGroupTurn(page, branchId, prompt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const existing = await existingGroupTurn(page, branchId, prompt);
    if (existing && existing.turn.status !== 'running') return existing;
    await delay(750);
  }
  throw new Error('Timed out before the group turn became durable');
}

function verifyGroupTurn(existing, expectation) {
  const accepted = expectation.acceptedStatuses ?? ['completed'];
  if (!accepted.includes(existing.turn.status)) {
    throw new Error(`Group turn ended in ${safeToken(existing.turn.status) || 'unknown state'}`);
  }
  assert.equal(existing.turn.mode, expectation.mode);
  const members = Array.isArray(existing.turn.members) ? existing.turn.members : [];
  const completed = members.filter((member) => member.status === 'completed');
  if (completed.length < expectation.minReplies || completed.length > expectation.maxReplies) {
    throw new Error('Group reply count is outside the guarded range');
  }
  const allowed = new Set(expectation.expectedParticipants.map((item) => item.id));
  for (const member of completed) {
    if (!allowed.has(member.participantId))
      throw new Error('Unexpected Cupcake answered dinner chat');
  }
  const messages = completed.map((member) => {
    const message = existing.history.find((item) => item.id === member.messageId);
    assertCompleteAssistant(message);
    if (message?.canonical_metadata?.group?.turnId !== existing.turn.turnId) {
      throw new Error('Group response provenance does not match its turn');
    }
    const participant = expectation.expectedParticipants.find(
      (item) => item.id === member.participantId,
    );
    if (member.speaker?.modelId !== participant?.persona?.modelId) {
      throw new Error('Group response does not match the Cupcake exact model route');
    }
    return message;
  });
  if (
    expectation.mode === 'mentions' &&
    completed[0]?.participantId !== expectation.mentionParticipant.id
  ) {
    throw new Error('Direct mention reached the wrong Cupcake');
  }
  if (expectation.maxReplies === 0 && messages.length !== 0) {
    throw new Error('Closing dinner turn produced an unwanted reply');
  }
  return { turn: existing.turn, messages };
}

async function assertGroupDisclosure(dialog, expectation) {
  const candidates = dialog.locator('.disclosure-candidates article');
  const expectedCount =
    expectation.mode === 'mentions' ? 1 : expectation.expectedParticipants.length;
  assert.equal(await candidates.count(), expectedCount, 'Unexpected disclosure route count');
  const text = await dialog.innerText();
  for (const participant of expectation.expectedParticipants) {
    assert.match(text, new RegExp(escapeRegex(participant.persona.name), 'u'));
  }
  if (expectation.mode === 'mentions') {
    assert.match(text, /Only the Cupcakes you mentioned will receive this turn/u);
  } else {
    assert.match(
      text,
      new RegExp(
        `At most ${expectation.disclosureMaxReplies ?? expectation.maxReplies} will reply`,
        'u',
      ),
    );
  }
}

async function ensureSoloRoster(page, conversationId, persona) {
  let participants = await runtimeRequest(page, 'conversations.participants.list', {
    conversationId,
  });
  if (participants.some((item) => item.enabled && item.personaId !== persona.id)) {
    throw new Error('Solo showcase chat has an unrelated enabled Cupcake; refusing to change it');
  }
  let participant = participants.find((item) => item.personaId === persona.id);
  if (!participant) {
    await runtimeRequest(page, 'conversations.participants.add', {
      conversationId,
      personaId: persona.id,
      enabled: true,
    });
    participants = await runtimeRequest(page, 'conversations.participants.list', {
      conversationId,
    });
    participant = participants.find((item) => item.personaId === persona.id);
  }
  if (!participant?.enabled || participant.availability?.status !== 'ready') {
    throw new Error(`${persona.name} is not ready on the exact selected route`);
  }
  const settings = await runtimeRequest(page, 'conversations.group.settings.set', {
    conversationId,
    strategy: 'smart-selective',
    maxReplies: 1,
    leadParticipantId: participant.id,
  });
  assert.equal(settings.strategy, 'smart-selective');
  assert.equal(settings.maxReplies, 1);
  assert.equal(settings.leadParticipantId, participant.id);
  return participant;
}

async function ensureDinnerRoster(page, conversationId, host, realist) {
  let participants = await runtimeRequest(page, 'conversations.participants.list', {
    conversationId,
  });
  const allowed = new Set([host.id, realist.id]);
  if (participants.some((item) => item.enabled && !allowed.has(item.personaId))) {
    throw new Error('Dinner chat has an unrelated enabled Cupcake; refusing to change it');
  }
  for (const persona of [host, realist]) {
    if (!participants.some((item) => item.personaId === persona.id)) {
      await runtimeRequest(page, 'conversations.participants.add', {
        conversationId,
        personaId: persona.id,
        enabled: true,
      });
    }
  }
  participants = await runtimeRequest(page, 'conversations.participants.list', {
    conversationId,
  });
  const hostParticipant = participants.find((item) => item.personaId === host.id);
  const realistParticipant = participants.find((item) => item.personaId === realist.id);
  for (const item of [hostParticipant, realistParticipant]) {
    if (!item?.enabled || item?.availability?.status !== 'ready') {
      throw new Error(`${item?.persona?.name ?? 'A dinner Cupcake'} is not ready`);
    }
  }
  const ordered = [hostParticipant.id, realistParticipant.id];
  const remainder = participants
    .filter((item) => !ordered.includes(item.id))
    .sort((left, right) => left.position - right.position)
    .map((item) => item.id);
  await runtimeRequest(page, 'conversations.participants.reorder', {
    conversationId,
    participantIds: [...ordered, ...remainder],
  });
  const settings = await runtimeRequest(page, 'conversations.group.settings.set', {
    conversationId,
    strategy: 'smart-selective',
    maxReplies: 2,
    leadParticipantId: hostParticipant.id,
  });
  assert.equal(settings.strategy, 'smart-selective');
  assert.equal(settings.maxReplies, 2);
  assert.equal(settings.leadParticipantId, hostParticipant.id);
  return { host: hostParticipant, realist: realistParticipant };
}

async function ensurePersona(page, desired) {
  const personas = await runtimeRequest(page, 'personas.list', { includeArchived: true });
  const matches = personas.filter((item) => item.handle === desired.handle);
  if (matches.length > 1) throw new Error(`Duplicate Cupcake handle: @${desired.handle}`);
  if (!matches.length) return runtimeRequest(page, 'personas.create', desired);
  const current = matches[0];
  if (current.archivedAt)
    throw new Error(`The owner archived @${desired.handle}; refusing to revive it`);
  const expected = [
    'name',
    'avatar',
    'role',
    'description',
    'instructions',
    'speakWhen',
    'modelId',
  ];
  if (
    expected.some((key) => current[key] !== desired[key]) ||
    JSON.stringify(current.personality) !== JSON.stringify(desired.personality)
  ) {
    throw new Error(`Cupcake handle collision or drift: @${desired.handle}`);
  }
  return current;
}

async function ensureProject(page, desired) {
  const projects = await runtimeRequest(page, 'projects.list', { includeArchived: true });
  const matches = projects.filter((item) => item.name === desired.name);
  if (matches.length > 1) throw new Error(`Duplicate everyday project: ${desired.name}`);
  if (!matches.length) return runtimeRequest(page, 'projects.create', desired);
  if (matches[0].status === 'archived' || matches[0].description !== desired.description) {
    throw new Error(`Everyday project was changed by the owner: ${desired.name}`);
  }
  return matches[0];
}

async function ensureConversation(page, projectId, title) {
  const conversations = await runtimeRequest(page, 'conversations.list', {
    projectId,
    includeArchived: true,
    limit: 500,
  });
  const matches = conversations.filter((item) => item.title === title);
  if (matches.length > 1) throw new Error(`Duplicate everyday conversation: ${title}`);
  if (!matches.length) {
    const created = await runtimeRequest(page, 'conversations.create', { title, projectId });
    return { ...created.conversation, branchId: created.branch.id };
  }
  const state = await runtimeRequest(page, 'conversations.get', {
    conversationId: matches[0].id,
  });
  const branchId = state.activeBranchId ?? state.branches?.[0]?.id;
  if (!branchId) throw new Error(`Conversation has no active branch: ${title}`);
  return { ...matches[0], branchId };
}

async function ensureArtifact(page, projectId, conversationId, title, kind, assistant) {
  assertCompleteAssistant(assistant);
  const artifacts = await runtimeRequest(page, 'artifacts.list', { projectId });
  const matches = artifacts.filter((item) => (item.title ?? item.name) === title);
  if (matches.length > 1) throw new Error(`Duplicate everyday artifact: ${title}`);
  if (matches.length) {
    const history = await runtimeRequest(page, 'artifacts.history', {
      projectId,
      artifactId: matches[0].id,
    });
    const source = history.find(
      (revision) =>
        (revision.source_message_id ?? revision.sourceMessageId) === assistant.id &&
        sha256(revision.content ?? '') === sha256(assistant.content),
    );
    if (!source) throw new Error(`Existing artifact has different provenance: ${title}`);
    return runtimeRequest(page, 'artifacts.get', {
      projectId,
      artifactId: matches[0].id,
      revisionId: source.id,
    });
  }
  return runtimeRequest(page, 'artifacts.create', {
    projectId,
    conversationId,
    sourceMessageId: assistant.id,
    title,
    kind,
    mimeType: 'text/markdown',
    content: assistant.content,
    authorKind: 'assistant',
  });
}

async function verifyPersistedShowcase(page, target, outputDirectory) {
  for (const [key, projectDefinition] of Object.entries(PROJECTS)) {
    const projects = await runtimeRequest(page, 'projects.list', { includeArchived: true });
    const project = projects.find(
      (item) => item.name === projectDefinition.name && item.status !== 'archived',
    );
    if (!project || project.description !== projectDefinition.description) {
      throw new Error(`Missing or changed everyday project: ${projectDefinition.name}`);
    }
    target.projects.push({ id: project.id, name: project.name });
    const scenarios = Object.values(DIRECT_SCENARIOS).filter((item) => item.project === key);
    for (const scenario of scenarios) {
      const verified = await verifySoloScenario(page, project, scenario);
      target.conversations.push(verified.conversation);
      target.artifacts.push(verified.artifact);
      const screenshot = await captureConversation(
        page,
        scenario.title,
        outputDirectory,
        slugify(scenario.title),
      );
      target.screenshots.push(screenshot);
    }
    if (key === 'littleThings') {
      const dinner = await verifyDinnerScenario(page, project);
      target.conversations.push(dinner.conversation);
      target.artifacts.push(dinner.artifact);
      target.group = dinner.group;
      const screenshot = await captureConversation(
        page,
        DINNER.title,
        outputDirectory,
        'dinner-group-verified',
      );
      target.screenshots.push(screenshot);
    }
  }
}

async function verifySoloScenario(page, project, scenario) {
  const conversation = await exactConversation(page, project.id, scenario.title);
  const participants = await runtimeRequest(page, 'conversations.participants.list', {
    conversationId: conversation.id,
  });
  const enabled = participants.filter((item) => item.enabled);
  if (enabled.length !== 1) throw new Error(`Expected one enabled Cupcake in ${scenario.title}`);
  const assistants = [];
  for (const prompt of scenario.prompts) {
    const existing = await existingGroupTurn(page, conversation.branchId, prompt);
    if (!existing) throw new Error(`Missing group turn in ${scenario.title}`);
    const verified = verifyGroupTurn(existing, {
      mode: 'smart',
      expectedParticipants: enabled,
      minReplies: 1,
      maxReplies: 1,
    });
    assistants.push(verified.messages[0]);
  }
  const artifact = await exactArtifactWithSource(
    page,
    project.id,
    scenario.artifact,
    assistants.at(-1),
  );
  return {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      assistantTurns: assistants.length,
      route: safeToken(assistants.at(-1).provider_id || assistants.at(-1).model_id),
    },
    artifact,
  };
}

async function verifyDinnerScenario(page, project) {
  const conversation = await exactConversation(page, project.id, DINNER.title);
  const expectations = [
    [DINNER.prompts.first, 'smart', 1, 2],
    [DINNER.prompts.correction, 'smart', 1, 2],
    [`@${PERSONAS.host.handle}${DINNER.prompts.mentionSuffix}`, 'mentions', 1, 1],
    [DINNER.prompts.quiet, 'smart', 0, 0],
  ];
  const allMessages = [];
  const turnEvidence = [];
  for (const [prompt, mode, minReplies, maxReplies] of expectations) {
    const existing = await existingGroupTurn(page, conversation.branchId, prompt);
    if (!existing) throw new Error(`Missing dinner turn: ${sha256(prompt).slice(0, 12)}`);
    const members = Array.isArray(existing.turn.members) ? existing.turn.members : [];
    const completed = members.filter((item) => item.status === 'completed');
    if (completed.length < minReplies || completed.length > maxReplies) {
      throw new Error('Persisted dinner reply count is outside its expected range');
    }
    if (mode === 'mentions' && existing.turn.mode !== 'mentions') {
      throw new Error('Persisted final dinner decision is not a direct mention');
    }
    if (maxReplies === 0 && existing.turn.status !== 'waiting_for_you') {
      throw new Error('Persisted dinner closing turn did not stay quiet');
    }
    const messages = completed.map((member) => {
      const message = existing.history.find((item) => item.id === member.messageId);
      assertCompleteAssistant(message);
      return message;
    });
    allMessages.push(...messages);
    turnEvidence.push(groupTurnEvidence({ turn: existing.turn, messages }));
  }
  const artifact = await exactArtifactWithSource(
    page,
    project.id,
    DINNER.artifact,
    allMessages.at(-1),
  );
  return {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      assistantTurns: allMessages.length,
      route: 'group',
    },
    artifact,
    group: { turns: turnEvidence },
  };
}

async function exactConversation(page, projectId, title) {
  const conversations = await runtimeRequest(page, 'conversations.list', {
    projectId,
    includeArchived: true,
    limit: 500,
  });
  const matches = conversations.filter(
    (item) => item.title === title && item.status !== 'archived',
  );
  if (matches.length !== 1) throw new Error(`Expected one active conversation: ${title}`);
  const state = await runtimeRequest(page, 'conversations.get', {
    conversationId: matches[0].id,
  });
  const branchId = state.activeBranchId ?? state.branches?.[0]?.id;
  if (!branchId) throw new Error(`Conversation has no branch: ${title}`);
  return { ...matches[0], branchId };
}

async function exactArtifactWithSource(page, projectId, title, assistant) {
  const artifacts = await runtimeRequest(page, 'artifacts.list', { projectId });
  const matches = artifacts.filter((item) => (item.title ?? item.name) === title);
  if (matches.length !== 1) throw new Error(`Expected one artifact: ${title}`);
  const history = await runtimeRequest(page, 'artifacts.history', {
    projectId,
    artifactId: matches[0].id,
  });
  const source = history.find(
    (revision) =>
      (revision.source_message_id ?? revision.sourceMessageId) === assistant.id &&
      sha256(revision.content ?? '') === sha256(assistant.content),
  );
  if (!source) throw new Error(`Artifact provenance mismatch: ${title}`);
  return {
    id: matches[0].id,
    title,
    revisionId: source.id,
    sourceMessageId: assistant.id,
    contentSha256: sha256(source.content),
  };
}

function recordResult(target, result) {
  if (!target.projects.some((item) => item.id === result.project.id)) {
    target.projects.push({ id: result.project.id, name: result.project.name });
  }
  target.conversations.push({
    id: result.conversation.id,
    title: result.conversation.title,
    route: result.route,
    assistantTurns: result.assistantTurns,
    finalContentSha256: result.finalContentSha256 ?? null,
  });
  target.artifacts.push({
    id: result.artifact.artifact.id,
    title: result.artifact.artifact.title ?? result.artifact.artifact.name,
    revisionId: result.artifact.revision.id,
    sourceMessageId:
      result.artifact.revision.sourceMessageId ?? result.artifact.revision.source_message_id,
    contentSha256: sha256(result.artifact.revision.content),
  });
  if (result.group) target.group = result.group;
  if (result.screenshot) target.screenshots.push(result.screenshot);
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
    const code = safeToken(response?.error?.code) || 'RUNTIME_REQUEST_FAILED';
    throw new Error(`${method}: ${code}: ${sanitize(response?.error?.message)}`);
  }
  return response.result;
}

async function packagedPage(connectedBrowser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pages = connectedBrowser.contexts().flatMap((context) => context.pages());
    const candidate =
      pages.find((item) => /tauri\.localhost/iu.test(item.url())) ??
      pages.find((item) => item.url() !== 'about:blank');
    if (candidate) return candidate;
    await delay(100);
  }
  throw new Error('CDP did not expose the packaged CupcakeAI renderer');
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
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 180_000 });
  if (
    await page
      .locator('input[type="password"]:visible')
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error('Owner profile is locked; this harness never submits workspace passwords');
  }
  return {
    version: safeToken(identity.info.appVersion),
    packaged: true,
    runtimeMode: 'broker',
    rendererOrigin: new globalThis.URL(identity.url).origin,
  };
}

async function assertExactOwnerProfile(page) {
  const projects = await runtimeRequest(page, 'projects.list', { includeArchived: true });
  const matches = projects.filter((item) => item.id === OWNER_SENTINEL.id);
  if (
    matches.length !== 1 ||
    matches[0].name !== OWNER_SENTINEL.name ||
    matches[0].status === 'archived'
  ) {
    throw new Error('Owner-profile sentinel mismatch; refusing to touch another profile');
  }
  if (projects.some((item) => item.name === OWNER_SENTINEL.name && item.id !== OWNER_SENTINEL.id)) {
    throw new Error('Duplicate owner sentinel breaks profile identity');
  }
}

async function openConversation(page, title) {
  if (await page.getByRole('heading', { name: title, exact: true }).isVisible()) return;
  const projectKey =
    title === DINNER.title
      ? 'littleThings'
      : Object.values(DIRECT_SCENARIOS).find((scenario) => scenario.title === title)?.project;
  if (!projectKey) throw new Error('Unknown showcase conversation');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Projects', exact: true }).first().click();
  await page
    .locator('.project-card__select')
    .filter({ hasText: PROJECTS[projectKey].name })
    .click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  const row = page.locator('.chat-list__main').filter({ hasText: title });
  await row.waitFor({ timeout: 60_000 });
  if ((await row.count()) !== 1) throw new Error(`Expected one chat row for ${title}`);
  await row.click();
  await page.getByRole('textbox', { name: 'Message Cupcake', exact: true }).waitFor({
    timeout: 60_000,
  });
}

async function captureConversation(page, title, outputDirectory, slug) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 180_000 });
  await openConversation(page, title);
  const path = join(outputDirectory, `${slug}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

function modelArray(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.models) ? value.models : [];
}

function selectExactReadyModel(models, provider, nativeModelId) {
  const candidates = models.filter((model) => {
    const observedProvider = normalizeProvider(model.provider ?? String(model.id).split(':')[0]);
    const observedModel = String(
      model.model ??
        (String(model.id).includes(':')
          ? String(model.id).slice(String(model.id).indexOf(':') + 1)
          : model.id),
    );
    return observedProvider === provider && observedModel === nativeModelId && modelReady(model);
  });
  if (candidates.length > 1)
    throw new Error(`Ambiguous ready model route: ${provider}/${nativeModelId}`);
  return candidates[0] ?? null;
}

function chooseReadyModel(models, preferences) {
  for (const choice of preferences) {
    const exact = selectExactReadyModel(models, choice.provider, choice.model);
    if (exact) return exact;
  }
  return null;
}

function chooseLoadedLocalModel(models, status) {
  const activeId = String(status?.activeModelId ?? status?.active_model_id ?? '');
  return (
    models.find(
      (model) =>
        modelReady(model) &&
        localRoute(model) &&
        (model.id === activeId || model.runtimeModelId === activeId),
    ) ??
    models.find((model) => modelReady(model) && localRoute(model) && model.metadata?.runtime_loaded)
  );
}

function modelReady(model) {
  if (model?.available === false || model?.enabled === false) return false;
  const status = String(model?.availability?.status ?? model?.status ?? '').toLowerCase();
  return !['unavailable', 'not_configured', 'not_loaded', 'offline_blocked', 'error'].includes(
    status,
  );
}

function localRoute(model) {
  return (
    /cupcake local/iu.test(String(model?.provider ?? '')) ||
    ['local', 'cupcake_local', 'cupcake_llama_cpp'].includes(
      String(model?.route ?? model?.providerId ?? '').toLowerCase(),
    )
  );
}

function assertExpectedRoute(message, model, routeType) {
  assertCompleteAssistant(message);
  const expectedNative = String(
    model.model ??
      (String(model.id).includes(':')
        ? String(model.id).slice(String(model.id).indexOf(':') + 1)
        : model.id),
  );
  if (message.model_id && message.model_id !== expectedNative) {
    throw new Error('Persisted response does not match the selected native model');
  }
  if (routeType === 'hosted') {
    const expectedProvider = normalizeProvider(model.provider ?? String(model.id).split(':')[0]);
    const actualProvider = normalizeProvider(message.provider_id);
    if (actualProvider && actualProvider !== expectedProvider) {
      throw new Error('Persisted response does not match the selected provider');
    }
  }
}

function assistantAfterPrompt(history, prompt) {
  const index = history.findIndex(
    (message) => message.role === 'user' && message.content === prompt,
  );
  if (index < 0) return null;
  const next = history.slice(index + 1).findIndex((message) => message.role === 'user');
  const end = next < 0 ? history.length : index + 1 + next;
  return history.slice(index + 1, end).find(isCompleteAssistant) ?? null;
}

function assertCompleteAssistant(message) {
  if (!isCompleteAssistant(message)) {
    const state = safeToken(message?.state) || 'missing';
    const reason = safeToken(message?.canonical_metadata?.finishReason) || 'missing';
    throw new Error(`Assistant response is incomplete (${state}/${reason})`);
  }
}

function isCompleteAssistant(message) {
  return (
    message?.role === 'assistant' &&
    Boolean(String(message?.content ?? '').trim()) &&
    message?.state === 'complete' &&
    ['stop', 'end_turn'].includes(message?.canonical_metadata?.finishReason)
  );
}

function groupTurnEvidence(result) {
  return {
    turnId: result.turn.turnId,
    mode: result.turn.mode,
    status: result.turn.status,
    selectorCalls: Array.isArray(result.turn.selectorUsage) ? result.turn.selectorUsage.length : 0,
    replies: result.messages.length,
    messageIds: result.messages.map((item) => item.id),
    contentSha256: result.messages.map((item) => sha256(item.content)),
  };
}

function safePersona(persona) {
  return {
    id: persona.id,
    name: persona.name,
    handle: persona.handle,
    role: persona.role,
    modelId: persona.modelId,
  };
}

function hostedRouteLabel(model) {
  return `${sanitize(model.provider)} · ${sanitize(model.model ?? model.id)}`;
}

function normalizeProvider(value) {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/gu, ' ')
    .replace(/[^a-z0-9 ]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (['google gemini', 'gemini'].includes(normalized)) return 'google';
  if (['nvidia', 'nim', 'nvidia nim'].includes(normalized)) return 'nvidia-nim';
  return normalized.replaceAll(' ', '-');
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80);
}

function assertUnderETemp(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const root = resolve('E:/temp');
  const child = resolve(path);
  const rel = relative(root, child);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} must be a child of ${root}`);
  }
}

function sanitize(value) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|nvapi|AIza|key|token)[-_A-Za-z0-9+/=.]{12,}\b/gu, '[redacted]')
    .replace(/[A-Za-z0-9_+/-]{40,}={0,2}/gu, '[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, 1000);
}

function safeError(error) {
  return sanitize(error instanceof Error ? error.message : error) || 'Unknown failure';
}

function safeToken(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._:/-]/gu, '')
    .slice(0, 200);
}

function sha256(value) {
  return createHash('sha256')
    .update(String(value ?? ''), 'utf8')
    .digest('hex');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function runSelfTests() {
  const user = (content) => ({ role: 'user', content });
  const assistant = (content, finishReason = 'stop') => ({
    id: `a-${content}`,
    role: 'assistant',
    content,
    state: 'complete',
    canonical_metadata: { finishReason },
  });
  assert.equal(assistantAfterPrompt([user('hello'), assistant('hi')], 'hello').content, 'hi');
  assert.equal(
    assistantAfterPrompt([user('hello'), { ...assistant('cut'), state: 'interrupted' }], 'hello'),
    null,
  );
  assert.doesNotThrow(() => assertCompleteAssistant(assistant('done', 'end_turn')));
  assert.throws(() => assertCompleteAssistant(assistant('', 'stop')), /incomplete/u);
  assert.doesNotThrow(() =>
    assertExpectedRoute(
      { ...assistant('routed'), model_id: GROQ_MODEL, provider_id: 'groq' },
      { id: `groq:${GROQ_MODEL}`, model: GROQ_MODEL, provider: 'groq' },
      'hosted',
    ),
  );
  assert.equal(normalizeProvider('Google Gemini'), 'google');
  assert.equal(normalizeProvider('Groq Cloud'), 'groq-cloud');
  assert.throws(() => assertUnderETemp('E:/temp', 'test'), /child/u);
  assert.doesNotThrow(() => assertUnderETemp('E:/temp/cupcake-proof', 'test'));
  assert.equal(slugify('A photo walk for grey weather'), 'a-photo-walk-for-grey-weather');
  assert.equal(
    chooseReadyModel(
      [{ id: 'cohere:command-a-plus-05-2026', provider: 'cohere', model: COHERE_MODEL }],
      [
        { provider: 'google', model: 'missing' },
        { provider: 'cohere', model: COHERE_MODEL },
      ],
    ).provider,
    'cohere',
  );
}
