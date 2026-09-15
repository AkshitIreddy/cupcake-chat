#!/usr/bin/env node
import { acquireWorkspaceLock, workPath } from './lib/workspace.mjs';
if (!process.argv.includes('--self-test')) await acquireWorkspaceLock('verify-release-1.8');

/**
 * Final, attach-only Cupcake Chat 1.8 acceptance helper.
 *
 * This script never starts or closes the application. By default it only prints
 * its plan. Pass --execute after the packaged app is already exposing WebView2
 * CDP. The broker fault and durable sandbox task are separately opt-in because
 * they intentionally restart an owned child process and add one task receipt.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);
const execute = argv.includes('--execute');
const faultTest = argv.includes('--fault-test');
const taskTest = argv.includes('--task-test');
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const port = Number(option('--port', '10131'));
const hostPid = Number(option('--host-pid', '0'));
const cdp = option('--cdp', `http://127.0.0.1:${port}`);
const output = resolve(option('--output', workPath('qa/refresh/release-1.8')));
const receiptPath = resolve(output, 'release-1.8-verification.json');

const VERSION = '1.8.0';
const DEFAULT_ADVISORS = [
  'Pip',
  'Sage',
  'Quill',
  'Patch',
  'Tally',
  'Muse',
  'Scout',
  'Circuit',
  'Pantry',
  'Roam',
  'Frame',
  'Orbit',
  'Ledger',
  'Launch',
  'Gather',
];
const ODM_ARTIFACT_TITLE = 'ODM toy physics.py';
const ODM_TASK_PROMPT = 'Verify final 1.8 simulation';

const plannedChecks = [
  'attach to the existing packaged Windows renderer; never launch or close the app',
  `app.getInfo reports packaged win32 version ${VERSION}`,
  'personas.list contains 15 everyday and 24 historical advisors with substantive prompts',
  'Settings > General replays onboarding and truthfully shows unsigned updates unavailable',
  'provider setup leaves and resumes the provider chapter without saving or testing a key',
  'local setup leaves for Models, resumes, advances, and can be skipped cleanly',
  ...(faultTest
    ? [
        'validate the exact broker and app host through CIM, stop only that owned broker, and observe recovery without reloading',
      ]
    : []),
  ...(taskTest
    ? [
        'create at most one exact final ODM verification task and require seven passing native Python tests on the saved revision',
      ]
    : []),
];

if (argv.includes('--help')) {
  process.stdout.write(
    [
      'Cupcake Chat 1.8 attach-only verifier',
      '',
      'Dry run:',
      '  node scripts/verify-release-1.8.mjs',
      '',
      'Core UI and native checks:',
      `  node scripts/verify-release-1.8.mjs --execute --port ${port}`,
      '',
      'Optional owned-broker restart check:',
      `  node scripts/verify-release-1.8.mjs --execute --fault-test --host-pid <CupcakeAI PID> --port ${port}`,
      '',
      'Optional durable ODM sandbox task:',
      `  node scripts/verify-release-1.8.mjs --execute --task-test --port ${port}`,
      '',
      `Default receipt: ${receiptPath}`,
      '',
    ].join('\n'),
  );
  process.exit(0);
}

if (!execute) {
  process.stdout.write(
    `${JSON.stringify(
      {
        execute: false,
        message:
          'Dry run only. Start the final packaged app with remote debugging, then add --execute.',
        cdp,
        output,
        faultTest,
        taskTest,
        faultTestRequires: '--host-pid <the packaged CupcakeAI.exe PID>',
        plannedChecks,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

assert(
  Number.isSafeInteger(port) && port >= 1024 && port <= 65535,
  '--port must be a non-privileged TCP port',
);
if (faultTest) {
  assert(
    Number.isSafeInteger(hostPid) && hostPid > 0,
    '--fault-test requires --host-pid with the packaged CupcakeAI.exe process ID',
  );
}

await mkdir(output, { recursive: true });

const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  cdp,
  output,
  flags: { faultTest, taskTest },
  app: null,
  advisors: null,
  onboarding: null,
  updater: null,
  runtimeRecovery: faultTest ? null : { skipped: true },
  odmTask: taskTest ? null : { skipped: true },
  checks: [],
  failures: [],
  screenshots: [],
};

let browser;
let page;
let originalSetupStep;
let setupStepCaptured = false;

try {
  browser = await chromium.connectOverCDP(cdp);
  page = await packagedPage(browser, 30_000);
  page.setDefaultTimeout(30_000);

  await checkPackagedIdentity();
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 180_000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();

  originalSetupStep = await page.evaluate(() =>
    globalThis.sessionStorage.getItem('cupcake.setup.step'),
  );
  setupStepCaptured = true;

  await checkDefaultAdvisors();
  await checkSettingsOnboardingAndUpdater();
  await checkHistoricalPortraitPersistence();

  if (faultTest) await checkRuntimeRecovery();
  if (taskTest) await checkOdmSandboxTask();
} catch (reason) {
  receipt.failures.push({
    name: 'harness-error',
    message: sanitize(reason instanceof Error ? reason.stack || reason.message : reason),
  });
} finally {
  if (page) {
    await page
      .evaluate(() => {
        const release = globalThis.__cupcakeRelease18StatusRelease;
        if (typeof release === 'function') release();
        delete globalThis.__cupcakeRelease18StatusRelease;
      })
      .catch(() => undefined);
    if (setupStepCaptured) {
      await page
        .evaluate((value) => {
          if (value === null) globalThis.sessionStorage.removeItem('cupcake.setup.step');
          else globalThis.sessionStorage.setItem('cupcake.setup.step', value);
        }, originalSetupStep)
        .catch(() => undefined);
    }
  }
  await browser?.close().catch(() => undefined);
  receipt.finishedAt = new Date().toISOString();
  receipt.passed = receipt.failures.length === 0;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!receipt.passed) process.exitCode = 1;

async function checkPackagedIdentity() {
  const identity = await page.evaluate(async () => {
    const api = globalThis.window.cupcake;
    return {
      tauri: '__TAURI_INTERNALS__' in globalThis.window,
      fixture: Boolean(globalThis.document.querySelector('.fixture-banner')),
      bridge: Boolean(api?.runtime?.request && api?.runtime?.status && api?.app?.getInfo),
      info: api?.app?.getInfo ? await api.app.getInfo() : null,
      runtime: api?.runtime?.status ? await api.runtime.status() : null,
      href: globalThis.location.href,
    };
  });
  receipt.app = identity;
  requireCheck(
    'packaged-windows-1.8',
    identity.tauri &&
      !identity.fixture &&
      identity.bridge &&
      identity.info?.packaged === true &&
      identity.info?.platform === 'win32' &&
      identity.info?.appVersion === VERSION &&
      identity.runtime?.mode === 'broker' &&
      identity.runtime?.state === 'ready' &&
      Number.isSafeInteger(identity.runtime?.pid),
    identity,
    true,
  );
}

async function checkDefaultAdvisors() {
  const personas = await runtime('personas.list', { includeArchived: true });
  assert(Array.isArray(personas), 'personas.list did not return an array');
  const advisors = DEFAULT_ADVISORS.map((name) => {
    const matches = personas.filter(
      (item) => item?.name === name && item.handle === name.toLowerCase() && !item?.archivedAt,
    );
    assert.equal(matches.length, 1, `Expected one active default advisor named ${name}`);
    const persona = matches[0];
    return {
      name,
      handle: persona.handle,
      roleLength: String(persona.role ?? '').trim().length,
      descriptionLength: String(persona.description ?? '').trim().length,
      instructionsLength: String(persona.instructions ?? '').trim().length,
      speakWhenLength: String(persona.speakWhen ?? '').trim().length,
      combinedPromptLength:
        String(persona.instructions ?? '').trim().length +
        String(persona.speakWhen ?? '').trim().length,
      modelIdPresent: Boolean(String(persona.modelId ?? '').trim()),
    };
  });
  const promptQuality = advisors.every(
    (item) =>
      item.roleLength >= 12 &&
      item.descriptionLength >= 70 &&
      item.instructionsLength >= 300 &&
      item.speakWhenLength >= 220 &&
      item.combinedPromptLength >= 600 &&
      item.modelIdPresent,
  );
  receipt.advisors = {
    expectedNames: DEFAULT_ADVISORS,
    activePersonaCount: personas.filter((item) => !item?.archivedAt).length,
    advisors,
  };
  requireCheck('fifteen-default-advisors', advisors.length === 15, receipt.advisors, true);
  requireCheck('default-advisor-prompt-depth', promptQuality, { advisors }, true);
  const history = personas.filter(
    (item) =>
      !item.archivedAt &&
      /^(egyptian|greek|roman|viking|mongol|medieval)_/u.test(item.handle) &&
      item.avatar?.startsWith('product:art/history/'),
  );
  requireCheck(
    '24-historical-advisors',
    history.length === 24 &&
      new Set(history.map((item) => item.avatar)).size === 24 &&
      history.every(
        (item) => item.instructions.length >= 700 && item.speakWhen.includes('Stay quiet'),
      ),
    { count: history.length, names: history.map((item) => item.name) },
    true,
  );
}

async function checkHistoricalPortraitPersistence() {
  const before = await runtime('settings.list');
  const choices = [
    {
      selector: '.avatar-picker:not(.avatar-picker--assistant) button[data-tooltip^="Flavia"]',
      key: 'profile.avatar',
      value: 'product:art/history/roman-1.webp',
    },
    {
      selector: '.avatar-picker--assistant button[data-tooltip^="Milo"]',
      key: 'assistant.avatar',
      value: 'product:art/history/roman-0.webp',
    },
  ];
  try {
    await page.locator('.shelf').getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .locator('.settings-layout aside')
      .getByRole('button', { name: 'Profile', exact: true })
      .click();
    for (const choice of choices) {
      await page.locator(choice.selector).scrollIntoViewIfNeeded();
      await page.locator(choice.selector).click();
      await page.waitForFunction(
        (selector) => globalThis.document.querySelector(selector)?.classList.contains('is-active'),
        choice.selector,
      );
    }
    await screenshot('historical-portraits-selected.png');
    await page.reload();
    await page.locator('.app-shell').waitFor({ timeout: 120000 });
    const saved = await runtime('settings.list');
    requireCheck(
      'historical-portraits-persist',
      choices.every((choice) => saved[choice.key] === choice.value),
      Object.fromEntries(choices.map((choice) => [choice.key, saved[choice.key]])),
      true,
    );
  } finally {
    for (const choice of choices)
      await runtime('settings.set', { key: choice.key, value: before[choice.key] });
    await page.reload();
    await page.locator('.app-shell').waitFor({ timeout: 120000 });
  }
}

async function checkSettingsOnboardingAndUpdater() {
  const existingTour = page.locator('.onboarding-layer');
  if (await existingTour.isVisible().catch(() => false)) {
    await existingTour.getByRole('button', { name: 'Skip onboarding' }).click();
    await existingTour.waitFor({ state: 'hidden' });
  }

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('.settings-layout');
  await settings.waitFor({ state: 'visible' });
  await settings.locator('aside').getByRole('button', { name: 'General', exact: true }).click();

  const nativeStatus = await page.evaluate(() => globalThis.window.cupcake.app.updates.status());
  const updateCard = page.getByRole('region', { name: 'Cupcake Chat updates' });
  await updateCard.waitFor({ state: 'visible' });
  await updateCard.getByText('Updates start with the first release.', { exact: true }).waitFor();
  const updaterUi = {
    text: sanitize(await updateCard.innerText()),
    actionCount: await updateCard.locator('.release-updates__action').count(),
  };
  receipt.updater = { nativeStatus, ui: updaterUi };
  requireCheck(
    'unsigned-updater-truthful',
    nativeStatus?.configured === false &&
      nativeStatus?.currentVersion === VERSION &&
      updaterUi.actionCount === 0 &&
      /Updates start with the first release/iu.test(updaterUi.text) &&
      !/Unavailable|cannot verify|not configured/iu.test(updaterUi.text),
    receipt.updater,
    true,
  );
  await screenshot('01-settings-general-updater.png');

  await page.evaluate(() => globalThis.sessionStorage.removeItem('cupcake.setup.step'));
  await settings.getByRole('button', { name: 'Replay onboarding', exact: true }).click();
  const tour = page.locator('.onboarding-layer');
  await tour.waitFor({ state: 'visible' });
  await waitForTourStep('welcome');

  const map = tour.getByRole('navigation', { name: 'Onboarding chapters' });
  await map.getByRole('button').filter({ hasText: 'Cloud providers' }).click();
  await waitForTourStep('providers');
  await screenshot('02-onboarding-providers.png');

  await tour
    .locator('.onboarding-provider-guide')
    .getByRole('button')
    .filter({ hasText: 'Groq' })
    .click();
  await tour.waitFor({ state: 'hidden' });
  const providerDialog = page
    .getByRole('dialog')
    .filter({ has: page.locator('#provider-setup-title') });
  await providerDialog.waitFor({ state: 'visible' });
  const providerTitle = (await providerDialog.locator('#provider-setup-title').innerText()).trim();
  assert(/Groq/iu.test(providerTitle), `Expected Groq setup, received ${providerTitle}`);
  await screenshot('03-onboarding-groq-dialog.png');
  await providerDialog.getByRole('button', { name: 'Close provider setup' }).click();
  await providerDialog.waitFor({ state: 'hidden' });
  await tour.waitFor({ state: 'visible' });
  await waitForTourStep('providers');

  await map.getByRole('button').filter({ hasText: 'Optional · run models on this PC' }).click();
  await waitForTourStep('runtime');
  await tour.getByRole('button', { name: /Set up local models and runtimes/iu }).click();
  await tour.waitFor({ state: 'hidden' });
  await page.locator('.models-page').waitFor({ state: 'visible' });

  const resume = page.getByRole('button', { name: 'Continue setup', exact: true });
  await resume.waitFor({ state: 'visible' });
  await screenshot('04-onboarding-models-resume.png');
  await resume.click();
  await tour.waitFor({ state: 'visible' });
  await waitForTourStep('runtime');

  await tour.getByRole('button', { name: 'Continue', exact: true }).click();
  await waitForTourStep('projects');
  await tour.getByRole('button', { name: 'Skip this step', exact: true }).click();
  await waitForTourStep('tools-memory');
  await tour.getByRole('button', { name: 'Skip onboarding' }).click();
  await tour.waitFor({ state: 'hidden' });

  receipt.onboarding = {
    providerChapter: 'resumed after closing Groq setup',
    localChapter: 'left for Models and resumed from Continue setup',
    finalObservedStepBeforeClose: 'tools-memory',
    providerTitle,
  };
  requireCheck('onboarding-replay-provider-local-resume', true, receipt.onboarding);
}

async function checkRuntimeRecovery() {
  const before = await page.evaluate(async () => {
    const status = await globalThis.window.cupcake.runtime.status();
    const models = await globalThis.window.cupcake.runtime.request({
      method: 'models.list',
      params: {},
      timeoutMs: 120_000,
    });
    const token = globalThis.crypto.randomUUID();
    globalThis.__cupcakeRelease18DocumentToken = token;
    globalThis.__cupcakeRelease18Statuses = [status];
    globalThis.__cupcakeRelease18StatusRelease = globalThis.window.cupcake.runtime.onStatus(
      (next) => globalThis.__cupcakeRelease18Statuses.push(next),
    );
    return { status, models, token };
  });
  assert.equal(before.status?.state, 'ready', 'Broker must be ready before the fault test');
  assert.equal(before.status?.mode, 'broker', 'Fault test requires the real broker');
  assert(Number.isSafeInteger(before.status?.pid), 'Runtime status has no owned broker PID');
  assert(before.models?.ok === true, 'models.list failed before broker restart');
  const groqBefore = groqModels(before.models.result);
  assert(groqBefore.length > 0, 'No Groq model exists before the broker restart');

  const ownership = await validateOwnedBroker({
    brokerPid: before.status.pid,
    expectedHostPid: hostPid,
    expectedPort: port,
  });
  requireCheck('fault-target-owned-broker', ownership.valid, ownership, true);

  await stopExactOwnedBroker({
    brokerPid: before.status.pid,
    expectedHostPid: hostPid,
    expectedBrokerPath: ownership.broker.executablePath,
  });

  const recovered = await waitFor(
    async () => {
      const status = await page.evaluate(() => globalThis.window.cupcake.runtime.status());
      return status?.state === 'ready' &&
        status?.mode === 'broker' &&
        Number.isSafeInteger(status?.pid) &&
        status.pid !== before.status.pid &&
        status.restartCount > before.status.restartCount
        ? status
        : null;
    },
    180_000,
    'a new ready broker generation',
  );

  // Do not call providers.status here. The workspace recovery hook must do that
  // first; otherwise a direct models.list could mask the original recovery bug.
  const groqAfter = await waitFor(
    async () => {
      const result = await runtime('models.list');
      const matches = groqModels(result);
      return matches.length ? matches : null;
    },
    120_000,
    'Groq model rehydration by the workspace recovery hook',
  );

  const documentEvidence = await page.evaluate(() => ({
    token: globalThis.__cupcakeRelease18DocumentToken,
    statuses: globalThis.__cupcakeRelease18Statuses ?? [],
    navigationType: globalThis.performance.getEntriesByType('navigation')[0]?.type ?? null,
  }));
  assert.equal(
    documentEvidence.token,
    before.token,
    'The renderer document reloaded during recovery',
  );
  assert(
    documentEvidence.statuses.some((item) => item?.state !== 'ready'),
    'No interrupted/non-ready runtime status event was observed',
  );
  assert(
    documentEvidence.statuses.some(
      (item) =>
        item?.state === 'ready' &&
        item?.pid === recovered.pid &&
        item?.restartCount === recovered.restartCount,
    ),
    'The recovered ready generation was not observed through runtime.onStatus',
  );

  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.locator('.models-page').waitFor({ state: 'visible' });
  const clearFilters = page.getByRole('button', { name: 'Clear filters', exact: true });
  if (await clearFilters.isVisible()) await clearFilters.click();
  const search = page.getByRole('textbox', { name: 'Find a model', exact: true });
  await search.fill('Groq');
  await waitFor(
    async () =>
      (await page.locator('.model-card').filter({ hasText: 'Groq' }).count()) > 0 ||
      (await page.locator('.model-recommendation').filter({ hasText: 'Groq' }).count()) > 0,
    30_000,
    'Groq in the recovered Models UI',
  );
  await screenshot('05-runtime-recovery-groq.png');

  receipt.runtimeRecovery = {
    ownership,
    before: before.status,
    recovered,
    statusEvents: documentEvidence.statuses,
    sameDocument: true,
    navigationType: documentEvidence.navigationType,
    groqBefore: groqBefore.map(modelIdentity),
    groqAfter: groqAfter.map(modelIdentity),
  };
  requireCheck('runtime-recovered-without-reload', true, receipt.runtimeRecovery);
}

async function checkOdmSandboxTask() {
  const projects = await runtime('projects.list', { includeArchived: false });
  const artifacts = [];
  for (const project of projects) {
    const projectArtifacts = await runtime('artifacts.list', { projectId: project.id, limit: 500 });
    for (const artifact of projectArtifacts) {
      if (artifact?.title === ODM_ARTIFACT_TITLE) artifacts.push({ project, artifact });
    }
  }
  assert.equal(
    artifacts.length,
    1,
    `Expected one active ${ODM_ARTIFACT_TITLE} artifact, found ${artifacts.length}`,
  );
  const { project, artifact } = artifacts[0];
  assert(artifact.head_revision_id, 'ODM artifact has no saved head revision');
  const snapshot = await runtime('artifacts.get', {
    projectId: project.id,
    artifactId: artifact.id,
    revisionId: artifact.head_revision_id,
  });
  assert.equal(snapshot?.revision?.id, artifact.head_revision_id, 'ODM saved revision mismatch');

  const listed = await runtime('tasks.list', { limit: 1000 });
  const exactPrompt = listed.filter((item) => item?.spec?.prompt === ODM_TASK_PROMPT);
  assert(exactPrompt.length <= 1, `Duplicate exact final ODM tasks found: ${exactPrompt.length}`);

  let runId;
  let created = false;
  let executionResult = null;
  if (exactPrompt.length === 1) {
    runId = exactPrompt[0].run_id ?? exactPrompt[0].runId;
    assert(runId, 'Existing final ODM task has no run ID');
  } else {
    const createdTask = await runtime(
      'tasks.create',
      {
        prompt: ODM_TASK_PROMPT,
        projectId: project.id,
        artifactId: artifact.id,
        revisionId: artifact.head_revision_id,
        workKind: 'code_execution',
        toolStages: 1,
        background: true,
      },
      120_000,
    );
    runId = createdTask?.run?.run_id ?? createdTask?.run?.runId;
    assert(runId, 'Created final ODM task has no run ID');
    created = true;
    const executeParams = { runId };
    const execution = createdTask.execution;
    if (execution?.status === 'approval_required') {
      const challenge = execution.approvalChallenge ?? execution.approval_challenge;
      assert(challenge && execution.preflight, 'Broker returned an incomplete approval challenge');
      executeParams.brokerPreflight = execution.preflight;
      executeParams.brokerApproval = Object.fromEntries(
        ['approval_id', 'nonce', 'intent_digest', 'preflight_digest', 'token'].map((key) => {
          const camel = key.replace(/_([a-z])/gu, (_match, letter) => letter.toUpperCase());
          const value = challenge[key] ?? challenge[camel];
          assert(value, `Missing bound broker approval field ${key}`);
          return [key, value];
        }),
      );
    }
    executionResult = await runtime('tasks.execute', executeParams, 900_000);
  }

  const saved = await runtime('tasks.get', { runId }, 120_000);
  const proof = verifyOdmTaskProof(saved, project.id, artifact);
  receipt.odmTask = {
    created,
    repeatGuard: created ? 'created one exact task' : 'reused and verified the one exact task',
    projectId: project.id,
    artifactId: artifact.id,
    revisionId: artifact.head_revision_id,
    runId,
    proof,
    executionStatus: executionResult?.execution?.status ?? null,
  };
  requireCheck('odm-seven-test-native-sandbox-receipt', true, receipt.odmTask);
}

function verifyOdmTaskProof(saved, projectId, artifact) {
  assert.equal(saved?.status, 'succeeded', 'Final ODM task is not succeeded');
  const spec = saved.spec ?? {};
  assert.equal(spec.prompt, ODM_TASK_PROMPT, 'Final ODM task prompt changed');
  assert.equal(spec.project_id ?? spec.projectId, projectId, 'Final ODM task project mismatch');
  assert.equal(
    spec.work_kind ?? spec.workKind,
    'code_execution',
    'Final ODM task is not code execution',
  );
  const inputs = (spec.steps ?? []).flatMap(
    (step) => step?.arguments?.artifactInputs ?? step?.arguments?.artifact_inputs ?? [],
  );
  assert(
    inputs.some(
      (input) =>
        input?.artifactId === artifact.id && input?.revisionId === artifact.head_revision_id,
    ),
    'Final ODM task is not bound to the saved head revision',
  );
  const evidence = saved.tool_evidence ?? saved.toolEvidence;
  assert.equal(evidence?.status, 'succeeded', 'Final ODM task lacks successful tool evidence');
  assert.equal(evidence?.exitStatus, 0, 'Final ODM sandbox exited unsuccessfully');
  assert.equal(evidence?.tool, 'python.run', 'Final ODM task did not use python.run');
  assert.equal(
    evidence?.nativeTool,
    'native.sandbox.python',
    'Final ODM task did not use native.sandbox.python',
  );
  assert.equal(evidence?.artifactId, artifact.id, 'Final ODM evidence artifact mismatch');
  assert.equal(
    evidence?.revisionId,
    artifact.head_revision_id,
    'Final ODM evidence revision mismatch',
  );
  assert.equal(evidence?.testSummary?.successful, true, 'Final ODM tests were not successful');
  assert.equal(
    evidence?.testSummary?.run,
    7,
    'Final ODM verification must run exactly seven tests',
  );
  assert(
    Array.isArray(evidence?.provenance) && evidence.provenance.length > 0,
    'Final ODM task lacks native provenance',
  );
  return {
    status: saved.status,
    exitStatus: evidence.exitStatus,
    tool: evidence.tool,
    nativeTool: evidence.nativeTool,
    testSummary: evidence.testSummary,
    provenance: evidence.provenance,
  };
}

async function validateOwnedBroker({ brokerPid, expectedHostPid, expectedPort }) {
  const powershell = [
    '$ErrorActionPreference = "Stop"',
    `$hostPid = [uint32]${expectedHostPid}`,
    `$brokerPid = [uint32]${brokerPid}`,
    '$hostProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $hostPid"',
    '$brokerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $brokerPid"',
    '$webviews = @(Get-CimInstance Win32_Process -Filter "Name = \'msedgewebview2.exe\'")',
    '$all = @($hostProcess; $brokerProcess) + $webviews',
    '$all | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', powershell],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const host = rows.find((item) => Number(item?.ProcessId) === expectedHostPid);
  const broker = rows.find((item) => Number(item?.ProcessId) === brokerPid);
  assert(host, `CIM could not find caller-supplied host PID ${expectedHostPid}`);
  assert(broker, `CIM could not find runtime broker PID ${brokerPid}`);

  const hostPath = String(host.ExecutablePath ?? '');
  const brokerPath = String(broker.ExecutablePath ?? '');
  const hostName = String(host.Name ?? '').toLowerCase();
  const brokerName = String(broker.Name ?? '').toLowerCase();
  const packagedRoot = dirname(hostPath);
  const brokerRelative = relative(packagedRoot, brokerPath);
  const brokerInsidePackage =
    brokerRelative !== '' &&
    brokerRelative !== '..' &&
    !isAbsolute(brokerRelative) &&
    !brokerRelative.startsWith(`..\\`) &&
    !brokerRelative.startsWith('../');

  const byPid = new Map(rows.map((item) => [Number(item.ProcessId), item]));
  const isHostDescendant = (candidate) => {
    let parent = Number(candidate?.ParentProcessId);
    const seen = new Set();
    while (parent > 0 && !seen.has(parent)) {
      if (parent === expectedHostPid) return true;
      seen.add(parent);
      parent = Number(byPid.get(parent)?.ParentProcessId ?? 0);
    }
    return false;
  };
  const debugWebviews = rows.filter(
    (item) =>
      String(item?.Name ?? '').toLowerCase() === 'msedgewebview2.exe' &&
      isHostDescendant(item) &&
      String(item?.CommandLine ?? '').includes(`--remote-debugging-port=${expectedPort}`),
  );

  const valid =
    hostName === 'cupcakeai.exe' &&
    basename(hostPath).toLowerCase() === 'cupcakeai.exe' &&
    brokerName === 'cupcake-tool-broker.exe' &&
    basename(brokerPath).toLowerCase() === 'cupcake-tool-broker.exe' &&
    Number(broker.ParentProcessId) === expectedHostPid &&
    brokerInsidePackage &&
    /(^|[\\/])sidecars([\\/]|$)/iu.test(brokerRelative) &&
    debugWebviews.length > 0;

  return {
    valid,
    host: {
      processId: Number(host.ProcessId),
      name: host.Name,
      executablePath: hostPath,
    },
    broker: {
      processId: Number(broker.ProcessId),
      parentProcessId: Number(broker.ParentProcessId),
      name: broker.Name,
      executablePath: brokerPath,
      relativeToHostExecutable: brokerRelative,
    },
    cdpOwnership: {
      port: expectedPort,
      matchingDescendantWebViewPids: debugWebviews.map((item) => Number(item.ProcessId)),
    },
  };
}

async function stopExactOwnedBroker({ brokerPid, expectedHostPid, expectedBrokerPath }) {
  assert(Number.isSafeInteger(brokerPid) && brokerPid > 0, 'Refusing to stop an invalid PID');
  assert(
    Number.isSafeInteger(expectedHostPid) && expectedHostPid > 0,
    'Refusing to stop a broker without its validated host PID',
  );
  const encodedPath = Buffer.from(expectedBrokerPath, 'utf8').toString('base64');
  const powershell = [
    '$ErrorActionPreference = "Stop"',
    `$brokerPid = [uint32]${brokerPid}`,
    `$hostPid = [uint32]${expectedHostPid}`,
    `$expectedPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedPath}"))`,
    '$process = Get-CimInstance Win32_Process -Filter "ProcessId = $brokerPid"',
    'if ($null -eq $process) { throw "Validated broker no longer exists" }',
    'if ($process.Name -ine "cupcake-tool-broker.exe") { throw "Validated PID changed identity" }',
    'if ([uint32]$process.ParentProcessId -ne $hostPid) { throw "Validated broker changed parent" }',
    'if ($process.ExecutablePath -ine $expectedPath) { throw "Validated broker changed path" }',
    'Stop-Process -Id $brokerPid -Force -ErrorAction Stop',
  ].join('; ');
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', powershell],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
  );
}

function groqModels(value) {
  return (Array.isArray(value) ? value : (value?.models ?? [])).filter(
    (item) =>
      item?.id?.startsWith('openai-compatible:groq/') && item?.metadata?.endpoint_id === 'groq',
  );
}

function modelIdentity(item) {
  return {
    id: item?.id ?? item?.model_id ?? null,
    provider: item?.provider ?? item?.metadata?.provider ?? null,
    model: item?.model ?? null,
  };
}

async function waitForTourStep(step) {
  const tour = page.locator('.onboarding-layer');
  await waitFor(
    async () => ((await tour.getAttribute('data-onboarding-step')) === step ? true : null),
    30_000,
    `onboarding step ${step}`,
  );
}

async function runtime(method, params = {}, timeoutMs = 120_000) {
  return page.evaluate(
    async ({ method, params, timeoutMs }) => {
      const response = await globalThis.window.cupcake.runtime.request({
        method,
        params,
        timeoutMs,
      });
      if (!response?.ok) {
        throw new Error(
          `${method}: ${response?.error?.code ?? 'RUNTIME_REQUEST_FAILED'}: ${response?.error?.message ?? 'Unknown runtime error'}`,
        );
      }
      return response.result;
    },
    { method, params, timeoutMs },
  );
}

async function screenshot(name) {
  const path = resolve(output, name);
  await page.screenshot({ path, animations: 'disabled' });
  receipt.screenshots.push(path);
}

function requireCheck(name, passed, evidence = {}, fatal = false) {
  const item = { name, passed: Boolean(passed), evidence };
  receipt.checks.push(item);
  if (!passed) {
    receipt.failures.push(item);
    if (fatal) throw new Error(`Required check failed: ${name}`);
  }
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (reason) {
      lastError = reason;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${sanitize(lastError)}` : ''}`);
}

async function packagedPage(connectedBrowser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = connectedBrowser.contexts().flatMap((context) => context.pages());
    const candidate = pages.find((item) => item.url().startsWith('https://tauri.localhost'));
    if (candidate) return candidate;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('The CDP target does not expose a https://tauri.localhost packaged renderer');
}

function sanitize(value) {
  return String(value)
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, '[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(-4000);
}
