#!/usr/bin/env node
/**
 * Verify the persisted repair-cafe group showcase in the packaged owner app.
 *
 * Default mode is read-only. Passing both --resume-prompt-file and
 * --resume-persona permits exactly one explicit @ mention turn through the UI.
 * The helper never creates artifacts. When duplicate output titles exist, an
 * explicit --artifact-id is required so another duplicate cannot be created.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

/* global window, document, location */

const PORT = 10131;
const PROFILE = resolve('E:/temp/cupcakeai-owner-test-20260902');
const OUTPUT = resolve('E:/temp/cupcake-video-showcase-20260914/group');
const FIXTURES = resolve('scripts/fixtures/owner-video-scenarios.json');
const CLEANUP_RECEIPT = resolve('E:/temp/cupcake-video-showcase-20260914/cleanup-receipt.json');
const OLD_CONFIGURATION = resolve(
  'E:/temp/cupcake-video-showcase-20260914/before-cleanup/configuration.json',
);
const HANDLES = ['mara_floor', 'quill_safe', 'remy_welcome'];

const artifactId = option('--artifact-id');
const resumePromptFile = option('--resume-prompt-file');
const resumePersona = option('--resume-persona');
assert.equal(
  Boolean(resumePromptFile),
  Boolean(resumePersona),
  '--resume-prompt-file and --resume-persona must be supplied together',
);
if (resumePersona) assert(HANDLES.includes(resumePersona), 'Unknown resume persona');

await mkdir(OUTPUT, { recursive: true });
let browser;
const evidence = {
  schemaVersion: 2,
  mode: resumePromptFile ? 'one-turn-resume' : 'verify-only',
  profile: PROFILE,
  startedAt: new Date().toISOString(),
  outcome: 'failed',
};

try {
  const fixtures = JSON.parse(await readFile(FIXTURES, 'utf8'));
  const scenario = fixtures.scenarios.find((item) => item.id === 'repair-cafe-group');
  assert(scenario, 'repair-cafe-group fixture is missing');
  const cleanup = JSON.parse(await readFile(CLEANUP_RECEIPT, 'utf8'));
  const oldConfiguration = JSON.parse(await readFile(OLD_CONFIGURATION, 'utf8'));
  assert.equal(resolve(cleanup.profile).toLowerCase(), PROFILE.toLowerCase());

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await packagedPage(browser);
  evidence.packagedApp = await packagedAppEvidence(page);
  const req = (method, params = {}, timeoutMs = 120_000) =>
    request(page, method, params, timeoutMs);

  const projects = await req('projects.list', { includeArchived: true });
  const oldIds = new Set(oldConfiguration.projects.map((item) => item.id));
  assert(
    projects.every((item) => !oldIds.has(item.id)),
    'An old pre-cleanup project remains',
  );
  const projectMatches = projects.filter(
    (item) => item.name === scenario.project && !item.archived_at && !item.archivedAt,
  );
  assert.equal(projectMatches.length, 1, 'Expected one active repair-cafe project');
  const project = projectMatches[0];

  const conversations = await req('conversations.list', {
    projectId: project.id,
    includeArchived: true,
    limit: 500,
  });
  const conversationMatches = conversations.filter((item) => item.title === scenario.title);
  assert.equal(conversationMatches.length, 1, 'Expected one repair-cafe conversation');
  const conversation = conversationMatches[0];
  const conversationState = await req('conversations.get', { conversationId: conversation.id });
  const branches = await req('conversations.branches', { conversationId: conversation.id });

  const artifacts = await req('artifacts.list', { projectId: project.id });
  const sourceMatches = artifacts.filter((item) => item.title === scenario.inputName);
  assert.equal(sourceMatches.length, 1, 'Expected one source artifact');
  const source = await req('artifacts.get', {
    projectId: project.id,
    artifactId: sourceMatches[0].id,
  });
  assert.equal(source.content, scenario.inputText, 'Source artifact differs from the fixture');

  const outputMatches = artifacts.filter((item) => item.title === scenario.artifactTitle);
  assert(outputMatches.length > 0, 'Repair-cafe output artifact is missing');
  if (outputMatches.length > 1 && !artifactId) {
    throw new Error(
      `Duplicate output title; rerun with --artifact-id=<winner>. Candidates: ${outputMatches
        .map((item) => item.id)
        .join(', ')}`,
    );
  }
  const selected = artifactId
    ? outputMatches.find((item) => item.id === artifactId)
    : outputMatches[0];
  assert(selected, 'Explicit artifact ID is not a matching repair-cafe output');
  const output = await req('artifacts.get', { projectId: project.id, artifactId: selected.id });
  assertSourceFacts(output.content);

  const personas = await req('personas.list', { includeArchived: true });
  const selectedPersonas = HANDLES.map((handle) => {
    const matches = personas.filter((item) => item.handle === handle && !item.archivedAt);
    assert.equal(matches.length, 1, `Expected one active @${handle} persona`);
    return matches[0];
  });
  const roster = await req('conversations.participants.list', {
    conversationId: conversation.id,
  });
  const selectedRoster = selectedPersonas.map((persona) => {
    const participant = roster.find((item) => item.personaId === persona.id && item.enabled);
    assert(participant, `@${persona.handle} is not enabled in the group`);
    return participant;
  });

  const uniqueMessages = new Map();
  const turns = new Map();
  for (const branch of branches) {
    const history = await req('chat.history', { branchId: branch.id });
    for (const message of history) {
      uniqueMessages.set(message.id, message);
      const turnId = message.canonical_metadata?.group?.turnId;
      if (turnId && !turns.has(turnId)) turns.set(turnId, await req('groups.turn.get', { turnId }));
    }
  }
  const assistants = [...uniqueMessages.values()].filter((item) => item.role === 'assistant');
  assert(assistants.length >= 6, 'Fewer than six real group replies are persisted');
  assistants.forEach(assertCompleteAssistant);
  const smartSuccesses = [...turns.values()].filter(
    (turn) => turn.mode === 'smart' && turn.status === 'completed',
  );
  assert(smartSuccesses.length >= 1, 'No successful Smart-selection turn is persisted');
  assert(
    smartSuccesses.every(
      (turn) => turn.members.filter((item) => item.status === 'completed').length <= 2,
    ),
    'A Smart-selection turn exceeded maxReplies=2',
  );
  const selectionFailures = [...turns.values()].filter(
    (turn) => turn.mode === 'smart' && turn.status === 'selection_failed',
  );

  let resumedTurn = null;
  if (resumePromptFile) {
    const prompt = (await readFile(resolve(resumePromptFile), 'utf8')).trim();
    assert(prompt && !prompt.startsWith('@'), 'Resume prompt must contain plain text without @');
    const participant = selectedRoster[HANDLES.indexOf(resumePersona)];
    resumedTurn = await sendOneMentionTurn(
      page,
      req,
      project.name,
      conversation,
      conversationState.activeBranchId,
      participant,
      prompt,
    );
  }

  Object.assign(evidence, {
    cleanupGuard: { oldProjectIdsChecked: oldIds.size, oldProjectIdsPresent: 0 },
    project: { id: project.id, name: project.name },
    conversation: {
      id: conversation.id,
      title: conversation.title,
      activeBranchId: conversationState.activeBranchId,
      branchCount: branches.length,
    },
    sourceArtifact: snapshotEvidence(source),
    outputArtifact: {
      ...snapshotEvidence(output),
      duplicateTitleCount: outputMatches.length,
      candidateIds: outputMatches.map((item) => item.id),
    },
    personas: selectedPersonas.map(({ id, name, handle, role, modelId }) => ({
      id,
      name,
      handle,
      role,
      modelId,
    })),
    uniqueAssistantMessages: assistants.length,
    smartSuccesses: smartSuccesses.map(turnEvidence),
    selectionFailures: selectionFailures.map(turnEvidence),
    quietClosingProven: false,
    resumedTurn,
    outcome: 'completed',
  });
} catch (error) {
  evidence.failure = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  const receipt = resolve(OUTPUT, 'repair-cafe-group-verification.json');
  await writeFile(receipt, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await browser?.close().catch(() => undefined);
  process.stdout.write(`${JSON.stringify({ outcome: evidence.outcome, receipt }, null, 2)}\n`);
}

async function packagedPage(connected) {
  const page = connected
    .contexts()
    .flatMap((context) => context.pages())
    .find((item) => /tauri\.localhost/iu.test(item.url()));
  assert(page, 'Packaged renderer is unavailable on CDP');
  return page;
}

async function packagedAppEvidence(page) {
  const state = await page.evaluate(async () => ({
    tauri: '__TAURI_INTERNALS__' in window,
    fixture: Boolean(document.querySelector('.fixture-banner')),
    app: await window.cupcake?.app?.getInfo?.(),
    runtime: await window.cupcake?.runtime?.status?.(),
    url: location.href,
  }));
  assert(state.tauri && !state.fixture && state.app?.packaged === true);
  assert.equal(state.runtime?.mode, 'broker');
  assert.equal(state.runtime?.state, 'ready');
  return { version: state.app.appVersion, runtimeMode: state.runtime.mode, url: state.url };
}

async function sendOneMentionTurn(
  page,
  req,
  projectName,
  conversation,
  branchId,
  participant,
  text,
) {
  await page.getByRole('button', { name: 'Projects', exact: true }).first().click();
  await page.locator('.project-card__select').filter({ hasText: projectName }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.locator('.chat-list__main').filter({ hasText: conversation.title }).click();
  const composer = page.getByRole('textbox', { name: 'Message Cupcake', exact: true });
  await composer.fill('@');
  const menu = page
    .getByTestId('group-mention-menu')
    .getByRole('listbox', { name: 'Mention a Cupcake or your work' });
  await menu.waitFor({ timeout: 30_000 });
  await menu.getByRole('option').filter({ hasText: participant.persona.name }).click();
  await composer.press('End');
  if ((await composer.inputValue()).endsWith(' ')) await composer.press('Backspace');
  await page.keyboard.insertText(` ${text}`);
  const persistedPrompt = `@${participant.persona.handle} ${text}`;
  assert.equal(await composer.inputValue(), persistedPrompt);
  await page.getByRole('button', { name: 'Send group message', exact: true }).click();
  const disclosure = page.getByTestId('group-disclosure');
  await disclosure.waitFor({ timeout: 120_000 });
  await disclosure.getByTestId('group-confirm').click();
  await disclosure.waitFor({ state: 'hidden', timeout: 600_000 });
  const history = await req('chat.history', { branchId });
  const user = history.find((item) => item.role === 'user' && item.content === persistedPrompt);
  assert(user?.canonical_metadata?.group?.turnId, 'Resume turn was not persisted');
  const turn = await req('groups.turn.get', { turnId: user.canonical_metadata.group.turnId });
  assert.equal(turn.status, 'completed');
  assert.equal(turn.members.filter((item) => item.status === 'completed').length, 1);
  return turnEvidence(turn);
}

function assertSourceFacts(content) {
  const value = String(content)
    .toLowerCase()
    .replaceAll(',', '')
    .replaceAll('‑', '-')
    .replaceAll('–', '-')
    .replaceAll('\u00a0', ' ');
  const required = [
    '36 items',
    '12 lamps',
    '8 small appliances',
    '6 clothing repairs',
    '5 bicycles',
    '3 laptops',
    '2 items with no description',
    'asha',
    'ben',
    'noor',
    'ivo',
    'mei',
    'lina',
    'dev',
    '12:00',
    '11:00',
    '09:00',
    '10:00',
    '14:00',
    '14:30',
    '28 seated',
    'one step-free entrance',
    'two power circuits',
    'six worktables',
    'owners stay',
    '25 minutes',
    'not a guaranteed fix',
    'microwaves',
    'lithium battery packs',
    'plug or fuse check',
    'inr 5000',
    'inr 2000',
    'inr 1200',
    'inr 300',
    'inr 1500',
  ];
  for (const fact of required) assert(value.includes(fact), `Output misses source fact: ${fact}`);
  assert(!/\b(tom|luis|nia|saira|remy)\b|\b(toasters?|toys?)\b/u.test(value));
}

function assertCompleteAssistant(message) {
  assert.equal(message.state, 'complete');
  assert(String(message.content ?? '').trim());
  assert(['stop', 'end_turn'].includes(message.canonical_metadata?.finishReason));
  assert(message.provider_id && message.model_id, 'Assistant response lacks real route metadata');
}

function turnEvidence(turn) {
  return {
    turnId: turn.turnId,
    mode: turn.mode,
    status: turn.status,
    completedReplies: turn.members.filter((item) => item.status === 'completed').length,
    errorCode: turn.selectorUsage?.[0]?.errorCode ?? null,
  };
}

function snapshotEvidence(snapshot) {
  return {
    id: snapshot.artifact.id,
    title: snapshot.artifact.title,
    revisionId: snapshot.revision.id,
    contentSha256: sha256(snapshot.content),
    chars: snapshot.content.length,
  };
}

async function request(page, method, params = {}, timeoutMs = 120_000) {
  const response = await page.evaluate(
    async ({ method, params, timeoutMs }) =>
      window.cupcake.runtime.request({ method, params, timeoutMs }),
    { method, params, timeoutMs },
  );
  if (!response?.ok)
    throw new Error(
      `${method}: ${response?.error?.code ?? 'FAILED'}: ${response?.error?.message ?? ''}`,
    );
  return response.result;
}

function option(name) {
  const prefix = `${name}=`;
  const argument = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}
