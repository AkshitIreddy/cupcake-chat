#!/usr/bin/env node
/**
 * Create and verify the ordinary-life owner showcase through the packaged app.
 *
 * The helper never reads credentials, changes the selected model/theme, launches
 * the app, or writes assistant text. Every assistant message is returned by the
 * authenticated runtime and then read back from persisted history.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from '@playwright/test';

/* global window, document, location */

const OWNER_PROFILE = resolve('E:/temp/cupcakeai-owner-test-20260902');
const DEFAULT_OUTPUT = resolve('E:/temp/cupcake-chat-everyday-v2-20260914');
const FIXTURE = resolve('scripts/fixtures/owner-everyday-v2-scenarios.json');
const MODELS = {
  groq: {
    id: 'openai-compatible:groq/openai/gpt-oss-120b',
    provider: 'groq',
    native: 'openai/gpt-oss-120b',
  },
  cohere: {
    id: 'cohere:command-a-plus-05-2026',
    provider: 'cohere',
    native: 'command-a-plus-05-2026',
  },
};
const PROFILE_SENTINELS = ['Data Cleanup Workshop', 'Neighborhood Repair Cafe'];
const ARCHIVE_PROJECTS = [
  'Community Pantry',
  'Small Business, Less Panic',
  'Study Rescue',
  'Next Job, Honestly',
  'Plans That Survive Reality',
  'Small Shop Control Room',
  'Private Team Notebook',
];
const ARCHIVE_CONVERSATIONS = {
  'Community Pantry': ['Grant report due at five'],
  'Small Business, Less Panic': ['One tiny change, again', 'The support inbox is on fire'],
  'Study Rescue': ['Can I still pass this semester?'],
  'Next Job, Honestly': ['One CV, two very different jobs'],
  'Plans That Survive Reality': ['A rainy Saturday in Mosswick'],
  'Small Shop Control Room': ['What do I reorder before Monday?'],
  'Private Team Notebook': ['What did we actually decide?'],
};
const LEGACY_EVIDENCE = resolve('E:/temp/cupcake-video-showcase-20260914/verification.json');
const ARCHIVE_TOKEN = 'ARCHIVE_NAMED_SHOWCASE';

const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};

if (args.includes('--self-test')) {
  selfTest();
  process.stdout.write('Everyday v2 helper self-tests passed.\n');
  process.exit(0);
}

const phase = option('--phase');
if (!['run', 'verify', 'quarantine-incomplete', 'archive-old'].includes(phase)) {
  throw new Error('--phase must be run, verify, quarantine-incomplete, or archive-old');
}
const port = Number(option('--port', '10131'));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('--port must be a non-privileged TCP port');
}
const profile = resolve(option('--profile', OWNER_PROFILE));
if (profile.toLowerCase() !== OWNER_PROFILE.toLowerCase()) {
  throw new Error(`Owner profile must be ${OWNER_PROFILE}`);
}
const output = resolve(option('--output', DEFAULT_OUTPUT));
assertChildOfETemp(output);
if (phase === 'run' && option('--execute') !== 'REAL_PROVIDER_CALLS') {
  throw new Error('Creation requires --execute REAL_PROVIDER_CALLS');
}
if (phase === 'archive-old' && option('--execute') !== ARCHIVE_TOKEN) {
  throw new Error(`Archival requires --execute ${ARCHIVE_TOKEN}`);
}
if (
  phase === 'quarantine-incomplete' &&
  option('--execute') !== 'QUARANTINE_INCOMPLETE_CONVERSATION'
) {
  throw new Error('Quarantine requires --execute QUARANTINE_INCOMPLETE_CONVERSATION');
}

const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
assertFixture(fixture);
const requestedIds = option('--ids', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const scenarios = fixture.scenarios.filter(
  (scenario) => !requestedIds.length || requestedIds.includes(scenario.id),
);
if (!scenarios.length) throw new Error('No matching scenarios');

await mkdir(output, { recursive: true });
const evidence = {
  schemaVersion: 1,
  collection: 'owner-everyday-v2',
  phase,
  profile,
  fixtureSha256: sha256(await readFile(FIXTURE)),
  startedAt: new Date().toISOString(),
  app: null,
  scenarios: [],
  archivedProjects: [],
  archivedConversations: [],
  quarantinedConversations: [],
  inventory: null,
  outcome: 'failed',
  failure: null,
};
let browser;
let lastGroqAt = 0;

try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await packagedPage(browser);
  evidence.app = await assertPackagedApp(page);
  await assertOwnerCollection(page);

  if (phase === 'run') {
    const models = modelArray(await request(page, 'models.list', {}, 180_000));
    const selectedModels = Object.fromEntries(
      Object.entries(MODELS).map(([route, desired]) => [route, exactReadyModel(models, desired)]),
    );
    for (const [route, model] of Object.entries(selectedModels)) {
      if (!model && scenarios.some((scenario) => scenario.route === route)) {
        throw new Error(`Required ready route is missing: ${MODELS[route].id}`);
      }
    }
    for (const scenario of scenarios) {
      const result = await runScenario(
        page,
        projectDefinition(fixture, scenario.project),
        scenario,
        selectedModels[scenario.route],
      );
      evidence.scenarios.push(result);
      await persistEvidence();
    }
    evidence.outcome = 'completed';
  } else if (phase === 'verify') {
    for (const scenario of scenarios) {
      evidence.scenarios.push(
        await verifyScenario(page, projectDefinition(fixture, scenario.project), scenario),
      );
    }
    if (!requestedIds.length) evidence.inventory = await currentInventory(page);
    evidence.outcome = 'verified';
  } else if (phase === 'quarantine-incomplete') {
    assert.equal(scenarios.length, 1, 'Quarantine exactly one scenario with --ids');
    const scenario = scenarios[0];
    const project = await exactProject(page, projectDefinition(fixture, scenario.project));
    const conversations = await request(page, 'conversations.list', {
      projectId: project.id,
      includeArchived: true,
      limit: 500,
    });
    const matches = conversations.filter(
      (conversation) => conversation.title === scenario.title && !isArchived(conversation),
    );
    assert.equal(matches.length, 1, 'Expected one active conversation to quarantine');
    const state = await request(page, 'conversations.get', {
      conversationId: matches[0].id,
    });
    const branchId = state.activeBranchId ?? state.branches?.[0]?.id;
    const history = await request(page, 'chat.history', { branchId });
    const incompletePrompt = scenario.prompts.find((prompt) => {
      const user = history.some((message) => message.role === 'user' && message.content === prompt);
      const assistant = assistantAfterPrompt(history, prompt);
      return (
        user &&
        (!assistant ||
          assistant.state !== 'complete' ||
          !['stop', 'end_turn'].includes(assistant.canonical_metadata?.finishReason))
      );
    });
    assert(incompletePrompt, 'Conversation has no incomplete guarded turn');
    const artifacts = await request(page, 'artifacts.list', { projectId: project.id });
    assert(
      !artifacts.some(
        (artifact) =>
          artifact.conversation_id === matches[0].id || artifact.conversationId === matches[0].id,
      ),
      'Conversation already owns an artifact; refusing quarantine',
    );
    await request(page, 'conversations.archive', {
      conversationId: matches[0].id,
      archived: true,
    });
    evidence.quarantinedConversations.push({
      id: matches[0].id,
      title: matches[0].title,
      reason: 'Persisted provider output_limit turn; preserved as archived evidence',
    });
    evidence.outcome = 'quarantined';
  } else {
    // Do not remove the richer collection until the replacement is complete.
    for (const scenario of fixture.scenarios) {
      await verifyScenario(page, projectDefinition(fixture, scenario.project), scenario);
    }
    const legacy = JSON.parse(await readFile(LEGACY_EVIDENCE, 'utf8'));
    const legacyByProjectAndTitle = new Map(
      legacy.results.map((item) => [`${item.projectId}\n${item.title}`, item]),
    );
    const before = await request(page, 'projects.list', { includeArchived: true });
    const candidates = ARCHIVE_PROJECTS.map((name) => {
      const matches = before.filter((project) => project.name === name);
      assert.equal(matches.length, 1, `Expected exactly one old project named ${name}`);
      return matches[0];
    });
    const conversationSets = [];
    for (const project of candidates) {
      const expectedTitles = ARCHIVE_CONVERSATIONS[project.name];
      const conversations = await request(page, 'conversations.list', {
        projectId: project.id,
        includeArchived: true,
        limit: 500,
      });
      const active = conversations.filter((conversation) => !isArchived(conversation));
      const expected = conversations.filter((conversation) =>
        expectedTitles.includes(conversation.title),
      );
      const activeExpected = expected.filter((conversation) => !isArchived(conversation));
      const extras = active.filter((conversation) => !expectedTitles.includes(conversation.title));
      const emptyDrafts = conversations.filter(
        (conversation) => conversation.title === 'New conversation',
      );
      assert.deepEqual(
        expected.map((conversation) => conversation.title).sort(),
        [...expectedTitles].sort(),
        `Expected showcase conversations differ: ${project.name}`,
      );
      if (isArchived(project)) {
        assert.equal(
          activeExpected.length,
          0,
          `Archived project has an active showcase conversation: ${project.name}`,
        );
      } else {
        assert.equal(
          activeExpected.length,
          expected.length,
          `Active project has an already archived showcase conversation: ${project.name}`,
        );
      }
      assert(
        extras.every((conversation) => conversation.title === 'New conversation'),
        `Unexpected active conversation in outgoing project: ${project.name}`,
      );
      for (const conversation of emptyDrafts) {
        assert.equal(
          conversation.title,
          'New conversation',
          `Unexpected active conversation in outgoing project: ${project.name}`,
        );
        const state = await request(page, 'conversations.get', {
          conversationId: conversation.id,
        });
        const branches =
          state.branches ??
          (await request(page, 'conversations.branches', {
            conversationId: conversation.id,
          }));
        for (const branch of branches) {
          assert.equal(
            (await request(page, 'chat.history', { branchId: branch.id })).length,
            0,
            `New conversation contains user content: ${conversation.id}`,
          );
        }
      }
      for (const conversation of expected) {
        const receipt = legacyByProjectAndTitle.get(`${project.id}\n${conversation.title}`);
        assert(receipt, `Legacy receipt does not identify ${conversation.title}`);
        assert.equal(
          receipt.conversationId,
          conversation.id,
          `Conversation ID differs from preserved receipt: ${conversation.title}`,
        );
      }
      conversationSets.push({
        project,
        targets: [...expected, ...emptyDrafts],
        emptyIds: new Set(emptyDrafts.map((item) => item.id)),
      });
    }
    for (const { project, targets, emptyIds } of conversationSets) {
      for (const conversation of targets) {
        if (!isArchived(conversation)) {
          await request(page, 'conversations.archive', {
            conversationId: conversation.id,
            archived: true,
          });
        }
        evidence.archivedConversations.push({
          id: conversation.id,
          projectId: project.id,
          title: conversation.title,
          reason: emptyIds.has(conversation.id) ? 'abandoned empty draft' : 'outgoing showcase',
        });
      }
      if (!isArchived(project)) {
        await request(page, 'projects.archive', { projectId: project.id, archived: true });
      }
      evidence.archivedProjects.push({ id: project.id, name: project.name });
    }
    const after = await request(page, 'projects.list', { includeArchived: true });
    for (const item of evidence.archivedProjects) {
      assert(
        isArchived(after.find((project) => project.id === item.id)),
        `Archive failed: ${item.name}`,
      );
    }
    const globalConversations = await request(page, 'conversations.list', {
      includeArchived: true,
      limit: 2000,
    });
    for (const item of evidence.archivedConversations) {
      assert(
        isArchived(globalConversations.find((conversation) => conversation.id === item.id)),
        `Conversation archive failed: ${item.title}`,
      );
    }
    for (const kept of PROFILE_SENTINELS) {
      assert(
        after.some((project) => project.name === kept && !isArchived(project)),
        `Feature-diversity project was archived unexpectedly: ${kept}`,
      );
    }
    evidence.outcome = 'archived';
  }
} catch (error) {
  evidence.failure = safeError(error);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await persistEvidence();
  await browser?.close().catch(() => undefined);
  process.stdout.write(
    `${JSON.stringify(
      {
        phase,
        outcome: evidence.outcome,
        receipt: join(output, `everyday-v2-${phase}.json`),
        conversations: evidence.scenarios.map((item) => ({
          title: item.title,
          replies: item.assistantReplies,
          route: item.route,
        })),
        archivedProjects: evidence.archivedProjects.map((item) => item.name),
        failure: evidence.failure,
      },
      null,
      2,
    )}\n`,
  );
}

async function runScenario(page, projectSpec, scenario, model) {
  const project = await ensureProject(page, projectSpec);
  const conversation = await ensureConversation(page, project.id, scenario.title);
  if (isArchived(conversation)) throw new Error(`Conversation was archived: ${scenario.title}`);
  const replies = [];
  for (const prompt of scenario.prompts) {
    const history = await request(page, 'chat.history', { branchId: conversation.branchId });
    const existing = assistantAfterPrompt(history, prompt);
    if (existing) {
      assertRoute(existing, model);
      replies.push(existing);
      continue;
    }
    if (history.some((message) => message.role === 'user' && message.content === prompt)) {
      throw new Error(`Incomplete persisted turn; refusing retry: ${scenario.title}`);
    }
    if (scenario.route === 'groq' && lastGroqAt) {
      const remaining = 65_000 - (Date.now() - lastGroqAt);
      if (remaining > 0) await delay(remaining);
    }
    const params = {
      content: prompt,
      projectId: project.id,
      conversationId: conversation.id,
      branchId: conversation.branchId,
      modelId: model.id,
      personalityPreset: 'warm',
      personalityInstructions:
        "Talk like a capable, relaxed helper in an ordinary conversation. Do the concrete work. Use the user's details, keep corrections, and make the result easy to use. Avoid canned encouragement, corporate language, repetitive summaries, and a wall of headings. A small bit of personality is welcome when it fits. Never claim you sent a message, cooked, booked, paid, or completed a physical task. Keep ordinary replies around 120 to 220 words; the requested final note may be up to 350 words.",
      reasoningEffort: 'none',
      offline: false,
      enabledToolIds: [],
      toolIds: [],
      memoryIds: [],
      attachments: [],
      attachmentHandles: [],
      references: [],
      referenceIds: [],
      maxOutputTokens: scenario.route === 'cohere' ? 2400 : 1200,
    };
    const preflight = await request(page, 'chat.preflight', params);
    assert(preflight.confirmationToken && preflight.outboundIntent, 'Bound preflight missing');
    params.outboundConfirmationToken = preflight.confirmationToken;
    params.outboundIntent = preflight.outboundIntent;
    if (scenario.route === 'groq') lastGroqAt = Date.now();
    const result = await request(page, 'chat.send', params, 600_000);
    assertComplete(result.message);
    assertRoute(result.message, model);
    conversation.branchId = result.branchId;
    const persisted = (
      await request(page, 'chat.history', { branchId: conversation.branchId })
    ).find((message) => message.id === result.message.id);
    assertComplete(persisted);
    assertRoute(persisted, model);
    replies.push(persisted);
  }
  const artifact = scenario.artifact
    ? await ensureArtifact(page, project.id, conversation.id, scenario.artifact, replies.at(-1))
    : null;
  return scenarioEvidence(project, conversation, scenario, replies, artifact);
}

async function verifyScenario(page, projectSpec, scenario) {
  const project = await exactProject(page, projectSpec);
  const conversation = await exactConversation(page, project.id, scenario.title);
  const state = await request(page, 'conversations.get', { conversationId: conversation.id });
  const branches =
    state.branches ??
    (await request(page, 'conversations.branches', { conversationId: conversation.id }));
  const unique = new Map();
  for (const branch of branches) {
    for (const message of await request(page, 'chat.history', { branchId: branch.id })) {
      unique.set(message.id, message);
    }
  }
  const history = [...unique.values()];
  const replies = scenario.prompts.map((prompt) => {
    const assistant = assistantAfterPrompt(history, prompt);
    if (!assistant) throw new Error(`Missing real reply after a guarded prompt: ${scenario.title}`);
    assertRoute(assistant, MODELS[scenario.route]);
    return assistant;
  });
  assert.equal(
    history.filter((message) => message.role === 'user').length,
    scenario.prompts.length,
    `Unexpected user turn count: ${scenario.title}`,
  );
  let artifact = null;
  if (scenario.artifact) {
    const matches = (await request(page, 'artifacts.list', { projectId: project.id })).filter(
      (item) => (item.title ?? item.name) === scenario.artifact,
    );
    assert.equal(matches.length, 1, `Expected one artifact: ${scenario.artifact}`);
    artifact = await request(page, 'artifacts.get', {
      projectId: project.id,
      artifactId: matches[0].id,
    });
    assert.equal(
      sha256(artifact.content),
      sha256(replies.at(-1).content),
      'Artifact is not the final real reply',
    );
  }
  return scenarioEvidence(
    project,
    { ...conversation, branchId: state.activeBranchId },
    scenario,
    replies,
    artifact,
  );
}

async function ensureProject(page, desired) {
  const projects = await request(page, 'projects.list', { includeArchived: true });
  const matches = projects.filter((project) => project.name === desired.name);
  if (matches.length > 1) throw new Error(`Duplicate project: ${desired.name}`);
  if (!matches.length) return request(page, 'projects.create', desired);
  if (isArchived(matches[0]) || matches[0].description !== desired.description) {
    throw new Error(`Existing everyday project changed: ${desired.name}`);
  }
  return matches[0];
}

async function exactProject(page, desired) {
  const matches = (await request(page, 'projects.list', { includeArchived: true })).filter(
    (project) => project.name === desired.name && !isArchived(project),
  );
  assert.equal(matches.length, 1, `Expected one active project: ${desired.name}`);
  assert.equal(
    matches[0].description,
    desired.description,
    `Project description changed: ${desired.name}`,
  );
  return matches[0];
}

async function ensureConversation(page, projectId, title) {
  const matches = (
    await request(page, 'conversations.list', { projectId, includeArchived: true, limit: 500 })
  ).filter((conversation) => conversation.title === title);
  const active = matches.filter((conversation) => !isArchived(conversation));
  if (active.length > 1) throw new Error(`Duplicate active conversation: ${title}`);
  if (!active.length) {
    const created = await request(page, 'conversations.create', { projectId, title });
    return { ...created.conversation, branchId: created.branch.id };
  }
  const state = await request(page, 'conversations.get', { conversationId: active[0].id });
  const branchId = state.activeBranchId ?? state.branches?.[0]?.id;
  if (!branchId) throw new Error(`No active branch: ${title}`);
  return { ...active[0], branchId };
}

async function exactConversation(page, projectId, title) {
  const matches = (
    await request(page, 'conversations.list', { projectId, includeArchived: true, limit: 500 })
  ).filter((conversation) => conversation.title === title && !isArchived(conversation));
  assert.equal(matches.length, 1, `Expected one active conversation: ${title}`);
  return matches[0];
}

async function ensureArtifact(page, projectId, conversationId, title, assistant) {
  assertComplete(assistant);
  const matches = (await request(page, 'artifacts.list', { projectId })).filter(
    (item) => (item.title ?? item.name) === title,
  );
  if (matches.length > 1) throw new Error(`Duplicate artifact: ${title}`);
  if (matches.length) {
    const current = await request(page, 'artifacts.get', { projectId, artifactId: matches[0].id });
    if (sha256(current.content) === sha256(assistant.content)) return current;
    const state = await request(page, 'conversations.get', { conversationId });
    const branches =
      state.branches ?? (await request(page, 'conversations.branches', { conversationId }));
    const priorReplies = [];
    for (const branch of branches) {
      priorReplies.push(
        ...(await request(page, 'chat.history', { branchId: branch.id })).filter(
          (message) => message.role === 'assistant',
        ),
      );
    }
    assert(
      priorReplies.some((message) => sha256(message.content) === sha256(current.content)),
      `Existing artifact is not traceable to this conversation: ${title}`,
    );
    return request(page, 'artifacts.revise', {
      projectId,
      artifactId: matches[0].id,
      expectedRevisionId: current.revision.id,
      sourceMessageId: assistant.id,
      content: assistant.content,
      authorKind: 'assistant',
      changeSummary: 'Save the corrected final answer from the conversation',
    });
  }
  return request(page, 'artifacts.create', {
    projectId,
    conversationId,
    sourceMessageId: assistant.id,
    title,
    kind: 'document',
    mimeType: 'text/markdown',
    content: assistant.content,
    authorKind: 'assistant',
  });
}

function assistantAfterPrompt(history, prompt) {
  const index = history.findIndex(
    (message) => message.role === 'user' && message.content === prompt,
  );
  if (index < 0) return null;
  const tail = history.slice(index + 1);
  const nextUser = tail.findIndex((message) => message.role === 'user');
  const span = nextUser < 0 ? tail : tail.slice(0, nextUser);
  return span.find((message) => message.role === 'assistant') ?? null;
}

function assertComplete(message) {
  assert(message?.role === 'assistant', 'Assistant message missing');
  assert.equal(message.state, 'complete', 'Assistant reply is incomplete');
  assert(String(message.content ?? '').trim(), 'Assistant reply is empty');
  assert(
    ['stop', 'end_turn'].includes(message.canonical_metadata?.finishReason),
    'Assistant reply has no completed finish reason',
  );
  assert(message.provider_id && message.model_id, 'Assistant reply has no real route provenance');
  assert(!/mock|fixture/iu.test(message.provider_id), 'Synthetic response route rejected');
}

function assertRoute(message, model) {
  assertComplete(message);
  const expectedProvider =
    model.metadata?.provider_preset ?? model.provider ?? String(model.id).split(':')[0];
  const expectedNative =
    model.native ??
    model.model ??
    (String(model.id).includes(':')
      ? String(model.id).slice(String(model.id).indexOf(':') + 1)
      : model.id);
  assert.equal(normalizeProvider(message.provider_id), normalizeProvider(expectedProvider));
  assert.equal(message.model_id, expectedNative);
}

function scenarioEvidence(project, conversation, scenario, replies, artifact) {
  return {
    id: scenario.id,
    projectId: project.id,
    project: project.name,
    conversationId: conversation.id,
    branchId: conversation.branchId,
    title: scenario.title,
    userTurns: scenario.prompts.length,
    assistantReplies: replies.length,
    route: `${replies[0].provider_id}:${replies[0].model_id}`,
    messages: replies.map((message) => ({
      id: message.id,
      provider: message.provider_id,
      model: message.model_id,
      chars: message.content.length,
      contentSha256: sha256(message.content),
      content: message.content,
    })),
    artifact: artifact
      ? {
          id: artifact.artifact?.id ?? artifact.id,
          revisionId: artifact.revision?.id ?? null,
          title: artifact.artifact?.title ?? artifact.title,
          sourceMessageId: replies.at(-1).id,
          contentSha256: sha256(artifact.content),
        }
      : null,
  };
}

async function request(page, method, params = {}, timeoutMs = 120_000) {
  const result = await page.evaluate(
    async ({ method, params, timeoutMs }) =>
      window.cupcake.runtime.request({ method, params, timeoutMs }),
    { method, params, timeoutMs },
  );
  if (!result?.ok) {
    throw new Error(
      `${method}: ${result?.error?.code ?? 'FAILED'}: ${safeText(result?.error?.message)}`,
    );
  }
  return result.result;
}

async function packagedPage(connected) {
  const page = connected
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => /tauri\.localhost/iu.test(candidate.url()));
  if (!page) throw new Error('Packaged renderer is unavailable on CDP');
  return page;
}

async function assertPackagedApp(page) {
  const state = await page.evaluate(async () => ({
    tauri: '__TAURI_INTERNALS__' in window,
    fixture: Boolean(document.querySelector('.fixture-banner')),
    app: await window.cupcake?.app?.getInfo?.(),
    runtime: await window.cupcake?.runtime?.status?.(),
    url: location.href,
  }));
  assert(
    state.tauri && !state.fixture && state.app?.packaged === true,
    'Real packaged Tauri app required',
  );
  assert.equal(state.runtime?.mode, 'broker');
  assert.equal(state.runtime?.state, 'ready');
  return { version: state.app.appVersion, url: state.url, runtimeMode: state.runtime.mode };
}

async function assertOwnerCollection(page) {
  const projects = await request(page, 'projects.list', { includeArchived: true });
  for (const name of PROFILE_SENTINELS) {
    assert.equal(
      projects.filter((project) => project.name === name && !isArchived(project)).length,
      1,
      `Owner collection sentinel missing: ${name}`,
    );
  }
}

async function currentInventory(page) {
  const projects = (await request(page, 'projects.list', { includeArchived: true })).filter(
    (project) => !isArchived(project),
  );
  const conversations = (
    await request(page, 'conversations.list', { includeArchived: false, limit: 2000 })
  ).filter((conversation) => !isArchived(conversation));
  const artifacts = [];
  for (const project of projects) {
    for (const artifact of await request(page, 'artifacts.list', { projectId: project.id })) {
      artifacts.push({ id: artifact.id, projectId: project.id, title: artifact.title });
    }
  }
  return {
    activeProjects: projects.map(({ id, name }) => ({ id, name })),
    activeConversations: conversations.map(({ id, project_id, projectId, title }) => ({
      id,
      projectId: projectId ?? project_id,
      title,
    })),
    artifacts,
  };
}

function modelArray(value) {
  return Array.isArray(value) ? value : (value?.models ?? []);
}

function exactReadyModel(models, desired) {
  const matches = models.filter(
    (model) =>
      model.id === desired.id &&
      model.available !== false &&
      model.enabled !== false &&
      !['unavailable', 'not_configured', 'error', 'offline_blocked'].includes(
        String(model.availability?.status ?? model.status ?? '').toLowerCase(),
      ),
  );
  assert(matches.length <= 1, `Ambiguous model: ${desired.id}`);
  return matches[0] ?? null;
}

function projectDefinition(config, id) {
  const project = config.projects.find((item) => item.id === id);
  if (!project) throw new Error(`Unknown project key: ${id}`);
  return { name: project.name, description: project.description };
}

function assertFixture(config) {
  assert.equal(config.scenarios.length, 6);
  assert.equal(new Set(config.scenarios.map((item) => item.id)).size, 6);
  assert.equal(new Set(config.scenarios.map((item) => item.title)).size, 6);
  for (const scenario of config.scenarios) {
    assert(['groq', 'cohere'].includes(scenario.route));
    assert(scenario.prompts.length >= 4 && scenario.prompts.length <= 6);
    assert(scenario.prompts.every((prompt) => prompt === prompt.trim() && prompt.length >= 35));
    projectDefinition(config, scenario.project);
  }
}

function isArchived(item) {
  return Boolean(item && (item.status === 'archived' || item.archived_at || item.archivedAt));
}

function normalizeProvider(value) {
  const name = String(value ?? '')
    .toLowerCase()
    .replaceAll('_', '-');
  return name === 'openai-compatible' ? 'groq' : name;
}

function safeError(error) {
  return { name: safeText(error?.name ?? 'Error'), message: safeText(error?.message ?? error) };
}

function safeText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|AIza|key|token)[-_A-Za-z0-9+/=.]{12,}\b/gu, '[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 1000);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertChildOfETemp(path) {
  if (!isAbsolute(path)) throw new Error('Output path must be absolute');
  const root = resolve('E:/temp');
  const rel = relative(root, resolve(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Output must be a child of ${root}`);
  }
}

async function persistEvidence() {
  await writeFile(
    join(output, `everyday-v2-${phase}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function selfTest() {
  assert.doesNotThrow(() => assertFixture(fixtureForTest()));
  const reply = {
    id: 'assistant-1',
    role: 'assistant',
    state: 'complete',
    content: 'Useful answer',
    provider_id: 'cohere',
    model_id: MODELS.cohere.native,
    canonical_metadata: { finishReason: 'stop' },
  };
  assert.equal(assistantAfterPrompt([{ role: 'user', content: 'hello' }, reply], 'hello'), reply);
  assert.doesNotThrow(() => assertRoute(reply, MODELS.cohere));
  assert.throws(() => assertChildOfETemp('E:/temp'), /child/u);
  assert.doesNotThrow(() => assertChildOfETemp('E:/temp/cupcake-proof'));
}

function fixtureForTest() {
  return {
    projects: [{ id: 'p', name: 'P', description: 'D' }],
    scenarios: Array.from({ length: 6 }, (_, index) => ({
      id: `s${index}`,
      project: 'p',
      title: `a natural title ${index}`,
      route: index % 2 ? 'groq' : 'cohere',
      prompts: Array.from(
        { length: 4 },
        (__, turn) => `this is a natural prompt with enough detail for turn ${turn}`,
      ),
    })),
  };
}
