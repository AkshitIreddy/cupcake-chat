#!/usr/bin/env node
/**
 * Build the real CupcakeAI owner showcase through an already-running packaged app.
 *
 * This script deliberately does not launch or stop CupcakeAI. The coordinating
 * operator owns the packaged-app lifecycle and the GPU lock. Hosted credentials
 * enter only through the visible, masked provider sheet and are never logged or
 * copied. All product data is created through the packaged renderer's approved
 * desktop bridge.
 */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const OWNER_PROFILE = resolve('E:/temp/cupcakeai-owner-test-20260902');
const DEFAULT_OUTPUT = resolve('E:/temp/cupcakeai-owner-showcase-20260905');
const DEFAULT_KEY_FILE = resolve('C:/Users/akshi/Desktop/Code Palace/Commonly used Keys.txt');
const PROVIDERS = {
  openai: {
    displayName: 'OpenAI',
    aliases: ['openai', 'open ai'],
    modelPreferences: ['gpt-6-astra'],
  },
  anthropic: {
    displayName: 'Anthropic',
    aliases: ['anthropic', 'claude'],
    modelPreferences: ['claude-sonnet-5'],
  },
  google: {
    displayName: 'Google Gemini',
    rowName: 'Google',
    aliases: ['google', 'google gemini', 'gemini'],
    modelPreferences: ['gemini-3.8-flash'],
  },
  cohere: {
    displayName: 'Cohere',
    aliases: ['cohere production', 'cohere_production', 'cohere trial', 'cohere'],
    modelPreferences: ['command-a-plus-05-2026'],
  },
  'nvidia-nim': {
    displayName: 'NVIDIA NIM',
    aliases: ['nvidia nim', 'nvidia_nim', 'nvidia-nim', 'nim'],
    modelPreferences: [
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'deepseek-ai/deepseek-v4-flash-0731',
      'moonshotai/kimi-k3',
    ],
  },
  mistral: {
    displayName: 'Mistral',
    aliases: ['mistral', 'mistral ai'],
    modelPreferences: ['mistral-medium-3-5'],
  },
  xai: {
    displayName: 'xAI',
    aliases: ['xai', 'x ai', 'grok'],
    modelPreferences: ['grok-4.6'],
  },
  groq: {
    displayName: 'Groq',
    aliases: ['groq', 'groq cloud', 'groqcloud'],
    modelPreferences: ['openai/gpt-oss-20b'],
    freeOnlyModelIds: ['openai/gpt-oss-20b'],
  },
  openrouter: {
    displayName: 'OpenRouter',
    aliases: ['openrouter', 'open router'],
    modelPreferences: ['nvidia/nemotron-3.5-lightning:free'],
    freeOnlyModelIds: ['nvidia/nemotron-3.5-lightning:free'],
  },
  cloudflare: {
    displayName: 'Cloudflare Workers AI',
    aliases: [
      'cloudflare workers ai',
      'cloudflare workers',
      'cloudflare worker',
      'cloudflare ai gateway',
      'cloudflare ai',
      'workers ai',
      'cloud flare',
      'cloudfare workers ai',
      'cloudfare worker',
      'cloudfare',
      'cloudflare',
    ],
    modelPreferences: ['@cf/meta/llama-3.1-8b-instruct-fp8'],
    freeOnlyModelIds: ['@cf/meta/llama-3.1-8b-instruct-fp8'],
    requiredCredentialFields: ['accountId'],
  },
};

const PROJECTS = {
  planning: {
    name: '[LIVE] Northstar Launch Studio',
    description:
      'A real hosted-model workspace for evidence-aware research synthesis, product planning, dependency review, and decision-ready execution briefs.',
  },
  coding: {
    name: '[LIVE] Harbor Data Reliability Lab',
    description:
      'A real hosted-model workspace for reproducible data analysis, defensive code, validation strategy, and useful saved implementation artifacts.',
  },
  grounding: {
    name: '[LIVE] Atlas Grounded Decision Room',
    description:
      'A real hosted-model workspace that turns a generated source memo into a pinned artifact, then asks another turn to reason only from that revision.',
  },
  local: {
    name: '[LOCAL CUDA] Private Studio Notebook',
    description:
      'A private, offline workspace for a real Cupcake Local CUDA model. Prompts and generated artifacts remain on this Windows profile.',
  },
};

const SCENARIOS = {
  cohere: {
    project: 'planning',
    title: '[LIVE • COHERE] From research brief to 14-day launch plan',
    artifact: 'Northstar launch plan — Cohere.md',
    artifactKind: 'report',
    prompts: [
      `You are helping a two-person accessibility software team plan a careful beta for “Northstar”, an offline-first reading companion for students. Create a compact research-and-planning brief with: the target user and job-to-be-done, five assumptions to validate, an interview plan, success and guardrail metrics, the smallest credible beta, and a risk register. Distinguish observations, assumptions, and decisions. Use polished Markdown that can be saved as a project brief.`,
      `Now stress-test that brief. Identify the three dependencies most likely to invalidate the plan, then turn the surviving work into a realistic 14-day table with owner (Founder or Engineer), deliverable, evidence required, and a stop/go gate. Preserve the original privacy and accessibility intent. Return a self-contained final plan, not commentary about revising it.`,
    ],
  },
  anthropic: {
    project: 'planning',
    title: '[LIVE • ANTHROPIC] Assumption audit for an accessible beta',
    artifact: 'Northstar assumption audit — Anthropic.md',
    artifactKind: 'report',
    prompts: [
      `Act as a product research lead reviewing an offline-first reading companion for students. Draft an assumption map covering user value, accessibility, trust, adoption, and operational feasibility. For each assumption, give the cheapest ethical test and the signal that would disconfirm it. Keep it concise and decision-ready.`,
      `Challenge your map as a skeptical accessibility advocate. Correct any weak or paternalistic framing, prioritize the first six interviews, and produce a final research protocol with consent, observation prompts, exit criteria, and an evidence log template.`,
    ],
  },
  openai: {
    project: 'coding',
    title: '[LIVE • OPENAI] Defensive CSV quality analyzer',
    artifact: 'harbor_quality_report.py',
    artifactKind: 'code',
    prompts: [
      `Design a dependency-free Python 3.12 command-line program named harbor_quality_report.py. It must read a CSV with columns timestamp, sensor_id, reading, and status; stream rows without loading the full file; report malformed rows, duplicate timestamp/sensor pairs, per-sensor count/min/max/mean, and status counts; use Decimal for readings; and emit deterministic JSON. Explain the design briefly, then provide the complete program in one fenced code block.`,
      `Review that program for hostile input and reproducibility. Fix CSV formula text, blank or enormous fields, invalid Unicode replacement behavior, non-finite decimals, stable ordering, atomic output, and useful exit codes. Return the complete final program only, with a short module docstring and argparse help.`,
    ],
  },
  'nvidia-nim': {
    project: 'coding',
    title: '[LIVE • NVIDIA NIM] Sensor data triage and Python quality check',
    artifact: 'harbor_sensor_triage.py',
    artifactKind: 'code',
    maxOutputTokens: 6144,
    requiredPromptIndexes: [2, 3],
    preserveAfterFailedQualityReview: true,
    modelPreferences: [
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'deepseek-ai/deepseek-v4-flash-0731',
      'moonshotai/kimi-k3',
    ],
    prompts: [
      `Analyze this small incident sample and state what is supported by the data before proposing code:\n\ntimestamp,sensor_id,reading,status\n2026-08-11T10:00:00Z,A17,18.2,ok\n2026-08-11T10:01:00Z,A17,91.4,alert\n2026-08-11T10:01:00Z,A17,91.4,alert\n2026-08-11T10:02:00Z,B04,,missing\n2026-08-11T10:03:00Z,B04,19.1,ok\n2026-08-11T10:04:00Z,A17,not-a-number,error\n\nThen write a dependency-free Python 3.12 function that accepts CSV text and returns a JSON-serializable quality report with duplicates, invalid readings, missing readings, status counts, and per-sensor valid-reading statistics. Include type hints and preserve source row numbers.`,
      `Turn that into a complete, production-minded harbor_sensor_triage.py module. Add an argparse CLI, deterministic JSON output, tests runnable with “python -m unittest”, clear error handling, and no third-party packages. Keep the evidence claims limited to the supplied rows. Return the complete final module in one fenced code block followed by a short test command.`,
      `The saved answer stopped in the middle of the module. Produce a complete compact replacement, at most 180 lines, in exactly one closed Python code block. Include the analyzer, CLI and embedded unittest classes. Validate finite readings and malformed rows. Explicitly count every valid row, including duplicates, in sensor statistics: the supplied A17 values are 18.2, 91.4 and 91.4, so its count is 3 and mean is 67.0; separately flag the repeated timestamp/sensor pair. Include tests for those exact facts, missing and invalid readings, non-finite input, bad headers and empty input. Running python -m unittest harbor_sensor_triage must execute the tests. Do not claim they passed until the app actually runs them.`,
      `Review found concrete defects in the saved module. Return a corrected complete harbor_sensor_triage.py in exactly one closed Python code block, at most 180 lines, with no prose outside the block. Preserve the dependency-free Python 3.12 analyzer, deterministic JSON CLI, type hints, and embedded unittest classes. Apply these exact semantics and tests:

- CSV physical row numbers include the header as row 1. In the supplied sample, the repeated A17 timestamp/sensor pair is row 4 duplicating row 3, the missing B04 reading is row 5, and the nonnumeric A17 reading is row 7.
- Require the header to be exactly timestamp,sensor_id,reading,status in that order. Treat rows with the wrong field count, including short or wide rows, as malformed without calling string methods on None.
- Treat a row such as ,,, as malformed because required identity/status fields are blank. Count a missing reading only when timestamp, sensor_id, and status are otherwise populated and the reading field alone is blank. Count nonnumeric or non-finite populated readings as invalid readings.
- Include every structurally valid finite-reading row in sensor statistics even when its timestamp/sensor pair is a duplicate. The sample A17 count is the integer 3 and its mean is 67.0. Keep duplicate reporting separate.
- Tests must assert integer counts directly, never call len() on an integer. Cover the exact supplied row numbers and statistics, the ,,, case, short and wide rows, missing-only-reading classification, nonnumeric and non-finite readings, bad headers, empty input, and deterministic output.
- The module must contain no undefined names. If BrokenPipeError handling uses os.devnull, import os; otherwise avoid os entirely. Running python -m unittest harbor_sensor_triage must discover and execute the embedded tests.

Do not claim tests passed; the app will run the saved immutable artifact in its Windows sandbox and record the result.`,
    ],
    task: {
      prompt:
        '[SHOWCASE] Review the project artifact harbor_sensor_triage.py in a sandbox, run its embedded unittest suite, and record observed pass/fail evidence. Do not mark the task complete unless execution actually finishes.',
      workKind: 'code_execution',
      toolStages: 2,
    },
  },
  'nvidia-nim-grounding': {
    providerId: 'nvidia-nim',
    project: 'grounding',
    title: '[LIVE • NVIDIA NIM] Revision-pinned Atlas decision brief',
    artifact: 'Atlas pilot source memo — NVIDIA NIM.md',
    artifactKind: 'document',
    modelPreferences: [
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'deepseek-ai/deepseek-v4-flash-0731',
      'moonshotai/kimi-k3',
      'nvidia/nemotron-3-super-120b-a12b',
    ],
    prompts: [
      `Create a fictional but internally consistent source memo for “Atlas Library Pilot”. Include exactly six dated facts, three stakeholder quotes clearly labeled as fictional, a budget table totaling $48,000, two unresolved questions, and a decision deadline. Put the memo date at the top and make it suitable for an artifact-grounding demonstration. Do not add recommendations yet.`,
      `Using only the pinned Atlas source memo artifact supplied as context, write a decision brief with: supported facts, unresolved questions, arithmetic check, three risks, and a recommendation. Cite each claim by the memo section heading. If the artifact does not support a claim, label it unknown. End with one plain-text line in this exact form: “Decision memory: <one sentence describing the recommended next decision and its evidence gate>”.`,
    ],
    groundSecondTurn: true,
    memory: {
      key: 'showcase.atlas-grounded-decision',
      pattern: '^Decision memory:\\s*(.+)$',
    },
  },
  google: {
    project: 'grounding',
    title: '[LIVE • GEMINI] Grounded decision memo with revision pinning',
    artifact: 'Atlas source memo — Gemini.md',
    artifactKind: 'document',
    reasoningEffort: 'low',
    prompts: [
      `Create a fictional but internally consistent source memo for “Atlas Library Pilot”. Include exactly six dated facts, three stakeholder quotes clearly labeled as fictional, a budget table totaling $48,000, two unresolved questions, and a decision deadline. Put the memo date at the top and make it suitable for a document-grounding demonstration. Do not add recommendations yet.`,
      `Using only the pinned Atlas source memo artifact supplied as context, write a decision brief with: supported facts, unresolved questions, arithmetic check, three risks, and a recommendation. Cite each claim by the memo section heading. If the artifact does not support a claim, label it unknown.`,
    ],
    groundSecondTurn: true,
  },
  mistral: {
    project: 'grounding',
    title: '[LIVE • MISTRAL] Source-bound pilot decision',
    artifact: 'Atlas pilot source memo — Mistral.md',
    artifactKind: 'document',
    prompts: [
      `Write a fictional source packet for an eight-week community library pilot. Include a scope statement, exactly five dated observations, a line-item budget that totals $36,500, three named constraints, and four open questions. Clearly mark every quote and organization as fictional. Add no recommendation.`,
      `Reason only from the pinned source artifact. Produce a one-page go/no-go brief that verifies the budget arithmetic, separates facts from unknowns, lists the top three risks, and cites the source section for each conclusion. Do not invent missing evidence.`,
    ],
    groundSecondTurn: true,
  },
  xai: {
    project: 'grounding',
    title: '[LIVE • XAI] Adversarial review of a source-bound decision',
    artifact: 'Atlas adversarial source packet — xAI.md',
    artifactKind: 'document',
    prompts: [
      `Create a fictional source packet for a privacy-preserving campus assistant pilot: four dated facts, a six-row cost table, three constraints, two dissenting stakeholder notes, and four explicit unknowns. Label invented names and quotes as fictional. Do not recommend a decision.`,
      `Audit the pinned source packet as a skeptical reviewer. Use only that artifact, verify arithmetic, identify unsupported leaps, and return a decision table with claim, support, uncertainty, and required next evidence. Label every inference.`,
    ],
    groundSecondTurn: true,
  },
  groq: {
    project: 'coding',
    title: '[LIVE • GROQ] Fast incident runbook quality pass',
    artifact: 'harbor-incident-runbook-groq.md',
    artifactKind: 'document',
    prompts: [
      `A harbor sensor service has these observed failure classes: malformed CSV rows, duplicate timestamp/sensor pairs, non-finite decimals, abrupt process termination during JSON write, and a downstream dashboard that treats missing data as zero. Draft a compact incident runbook with detection signals, immediate containment, evidence to preserve, a safe recovery action, and an owner for each class. Do not invent incidents or claim any check was run.`,
      `Stress-test the runbook for actions that could destroy evidence or conceal missing data. Return a final operator-ready Markdown runbook with “do not” guardrails, a severity rubric, rollback points, and a five-step post-incident review. Keep every statement tied to the supplied failure classes.`,
    ],
  },
  'groq-code-review': {
    providerId: 'groq',
    project: 'coding',
    title: '[LIVE • GROQ] Sensor quality repair with reviewed tests',
    artifact: 'harbor_quality_checked.py',
    artifactKind: 'code',
    pinnedSourceArtifact: 'harbor_sensor_triage.py',
    maxOutputTokens: 6144,
    modelPreferences: ['openai/gpt-oss-20b'],
    prompts: [
      `Act as an independent Python reviewer. Inspect only the pinned latest revision of harbor_sensor_triage.py and return a compact defect-and-acceptance brief; do not rewrite the module yet and do not claim tests ran. Check the implementation and embedded tests against this contract: CSV physical row numbers include the header as row 1; the supplied sample's duplicate is row 4 duplicating row 3, missing reading is row 5, and nonnumeric reading is row 7; the header must exactly equal timestamp,sensor_id,reading,status; short, wide, and blank-identity rows such as ,,, are malformed; a missing reading is counted only when timestamp, sensor_id, and status are populated; nonnumeric and non-finite populated readings are invalid; structurally valid finite duplicate rows still contribute to statistics; A17 count is the integer 3 and mean is 67.0; tests must assert integer values directly; every name and CLI error path must be defined. For each defect, state the cause and a concrete acceptance check.`,
      `Using the review and pinned source only as defect evidence, produce a clean independent replacement named harbor_quality_checked.py. Return exactly one closed Python code block and no prose outside it. Keep the entire module at or below 120 lines, dependency-free on Python 3.12, with type hints, a deterministic JSON CLI, and embedded unittest classes discoverable by python -m unittest harbor_quality_checked. Implement these exact rules: require the four headers in exact order; preserve physical row numbers with the header as row 1; record every wrong-width row and every row with blank timestamp, sensor_id, or status in malformed_rows with its physical row number and reason, without calling string methods on None and without silently dropping it; record a blank reading in missing_readings only when the other required fields are populated; record nonnumeric or non-finite populated readings in invalid_readings; report duplicate timestamp/sensor pairs with both the repeated row and first row. Include every structurally valid finite row in per-sensor count/min/max/mean even when it is a duplicate. Include every structurally valid row in status_counts even when its reading is missing or invalid; exclude malformed rows. Embed the six-row sample and tests proving duplicate row 4 points to row 3, missing row 5, invalid row 7, status counts ok=2, alert=2, missing=1 and error=1, A17 integer count 3 and mean 67.0, and B04 count 1. Also test the exact quoted CSV row ",,," (exactly three commas and four empty fields). Test separate short and wide rows by asserting their malformed row records without expecting sensor statistics from those malformed rows. In a missing-only-reading case with one finite A17 row and one blank A17 reading, assert A17 count is 1, not 2. Cover infinity/NaN, nonnumeric input, exact bad-header rejection, empty input, deterministic output, and CLI-safe defined names. Tests must assert integer counts directly. Do not claim the tests passed; the app will execute this exact saved revision in its Windows sandbox.`,
    ],
    task: {
      prompt:
        '[SHOWCASE] Run the embedded unittest suite in the exact saved artifact harbor_quality_checked.py and record observed Windows sandbox evidence. Do not mark complete unless execution actually succeeds.',
      workKind: 'code_execution',
      toolStages: 1,
    },
  },
  openrouter: {
    project: 'planning',
    title: '[LIVE • OPENROUTER FREE] One-pass beta decision card',
    artifact: 'northstar-beta-decision-card-openrouter.md',
    artifactKind: 'document',
    maxOutputTokens: 200,
    retryOnInterrupted: false,
    prompts: [
      `In at most 120 words, turn these facts into a decision card: two-person team; offline-first reading companion; keyboard and screen-reader flows are release gates; pilot lasts 14 days; no analytics leave the device; stop if three participants cannot complete import and read-aloud unaided. Use headings for Decision, Evidence gate, Stop condition, and Next action. Do not add facts.`,
    ],
  },
  cloudflare: {
    project: 'grounding',
    title: '[LIVE • CLOUDFLARE FREE ALLOCATION] Edge privacy checklist',
    artifact: 'atlas-edge-privacy-checklist-cloudflare.md',
    artifactKind: 'document',
    maxOutputTokens: 200,
    retryOnInterrupted: false,
    prompts: [
      `In at most 120 words, create an operator checklist from only these constraints: prompts use a named Cloudflare Workers AI route; API use is hosted, not local; the credential stays in the Windows-protected provider vault; provider availability and the daily free allocation can be exhausted; no automatic paid fallback is allowed. Include Before send, After response, and Stop conditions. Do not claim a test passed.`,
    ],
  },
  local: {
    project: 'local',
    title: '[LOCAL • CUDA] Private notes to a practical action brief',
    artifact: 'private-studio-action-brief.md',
    artifactKind: 'document',
    prompts: [
      `This is a private offline planning exercise. Turn these rough studio notes into a calm action brief: “prototype keyboard flow; verify screen-reader names; test 390px width; keep model choice explicit; close should exit; record what remains unproven.” Organize them into outcomes, checks, owners (Design or Engineering), and completion evidence. Do not claim any check has already passed.`,
      `Review that brief for ambiguity. Produce a final checklist in priority order with a concrete pass condition for every item, a small risks section, and a privacy note stating that this conversation used the selected local route. Keep it polished and concise.`,
    ],
  },
};

class ShowcaseSkip extends Error {
  constructor(outcome, message) {
    super(message);
    this.name = 'ShowcaseSkip';
    this.outcome = outcome;
  }
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `Usage:\n  node scripts/create-owner-showcase.mjs --self-test\n  node scripts/create-owner-showcase.mjs --list-key-providers\n  node scripts/create-owner-showcase.mjs --port <cdp-port> --phase hosted --providers groq,mistral,google\n  node scripts/create-owner-showcase.mjs --port <cdp-port> --phase hosted --providers openrouter,cloudflare\n  node scripts/create-owner-showcase.mjs --port <cdp-port> --phase local --gpu-marker "C:/.../gpu use.txt"\n  node scripts/create-owner-showcase.mjs --port <cdp-port> --phase verify\n\nThe packaged app must already be running against ${OWNER_PROFILE}.\n`,
  );
  process.exit(0);
}

const option = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};
if (args.includes('--self-test')) {
  runSelfTests();
  process.stdout.write('Owner showcase guard self-tests passed.\n');
  process.exit(0);
}
if (args.includes('--list-key-providers')) {
  const inspectedKeyFile = resolve(option('--key-file', DEFAULT_KEY_FILE));
  const inspected = await parseAuthorizedCredentials(inspectedKeyFile);
  const providers = [...inspected.entries()]
    .filter(([provider, credential]) => missingCredentialFields(provider, credential).length === 0)
    .map(([provider]) => provider)
    .sort();
  const incompleteProviders = [...inspected.entries()]
    .filter(([provider, credential]) => missingCredentialFields(provider, credential).length > 0)
    .map(([provider]) => provider)
    .sort();
  clearCredentialMap(inspected);
  process.stdout.write(
    `${JSON.stringify({ count: providers.length, providers, incompleteProviders }, null, 2)}\n`,
  );
  process.exit(0);
}
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
const keyFile = resolve(option('--key-file', DEFAULT_KEY_FILE));
const requestedProviders = new Set(
  String(option('--providers', ''))
    .split(',')
    .map((item) => normalizeProviderId(item))
    .filter(Boolean),
);
if (phase === 'hosted' && requestedProviders.size === 0) {
  throw new Error('--providers is required for hosted phase so quota use is explicit');
}
for (const provider of requestedProviders) {
  if (!(provider in PROVIDERS)) throw new Error(`Unsupported provider selection: ${provider}`);
}

await mkdir(output, { recursive: true });
const evidence = {
  schemaVersion: 1,
  profile,
  phase,
  startedAt: new Date().toISOString(),
  cdpPort: port,
  packagedRenderer: false,
  providers: [],
  demos: [],
  screenshots: [],
  localRuntime: null,
  failures: [],
};

let browser;
let page;
let credentials = new Map();
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await packagedPage(browser);
  await assertRealPackagedApp(page);
  evidence.packagedRenderer = true;

  if (phase === 'hosted') {
    credentials = await parseAuthorizedCredentials(keyFile);
    const statusBefore = await runtimeRequest(page, 'providers.status', {}, 120_000);
    const configuredBefore = configuredProviderIds(statusBefore);
    for (const providerId of requestedProviders) {
      const hasCredential = credentials.has(providerId);
      if (!configuredBefore.has(providerId) && !hasCredential) {
        evidence.providers.push({ provider: providerId, outcome: 'credential_absent' });
        continue;
      }
      const missingFields = missingCredentialFields(providerId, credentials.get(providerId));
      if (!configuredBefore.has(providerId) && missingFields.length > 0) {
        evidence.providers.push({
          provider: providerId,
          outcome: 'credential_incomplete',
          missingFields,
        });
        clearCredentialRecord(credentials.get(providerId));
        credentials.delete(providerId);
        continue;
      }
      if (!configuredBefore.has(providerId)) {
        const credential = credentials.get(providerId);
        const secretValues = credentialSecretValues(credential);
        try {
          const setup = await connectProviderThroughUi(page, providerId, credential, output);
          evidence.providers.push({ provider: providerId, outcome: 'connected', ...setup });
        } catch (error) {
          evidence.providers.push({
            provider: providerId,
            outcome: 'connection_failed',
            error: safeError(error, secretValues),
          });
        } finally {
          credentials.delete(providerId);
          clearCredentialRecord(credential);
        }
      } else {
        evidence.providers.push({ provider: providerId, outcome: 'already_connected' });
      }
    }
    clearCredentialMap(credentials);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorkbench(page);
    const status = await runtimeRequest(page, 'providers.status', {}, 180_000);
    const configured = configuredProviderIds(status);
    if (requestedProviders.has('nvidia-nim') && configured.has('nvidia-nim')) {
      await runtimeRequest(page, 'providers.catalog.refresh', { provider: 'nvidia-nim' }, 180_000);
    }
    const models = await runtimeRequest(page, 'models.list', {}, 180_000);
    for (const providerId of requestedProviders) {
      if (!configured.has(providerId)) continue;
      const providerScenarios = Object.entries(SCENARIOS).filter(
        ([scenarioId, scenario]) =>
          scenarioId !== 'local' && (scenario.providerId ?? scenarioId) === providerId,
      );
      for (const [scenarioId, scenario] of providerScenarios) {
        if (scenario.preserveAfterFailedQualityReview) {
          evidence.demos.push({
            provider: providerId,
            scenarioId,
            routeType: 'hosted',
            outcome: 'quality_review_failed_preserved',
          });
          continue;
        }
        const model = chooseHostedModel(models, providerId, scenario.modelPreferences);
        if (!model) {
          evidence.demos.push({
            provider: providerId,
            scenarioId,
            routeType: 'hosted',
            outcome: 'no_chat_model_available',
          });
          continue;
        }
        try {
          await runtimeRequest(
            page,
            'models.select',
            { modelId: model.id, compatibilityConfirmed: true },
            120_000,
          );
          const result = await runScenario(page, scenario, model, 'hosted');
          const screenshot = await captureConversation(page, scenario.title, output, scenarioId);
          evidence.screenshots.push(screenshot);
          evidence.demos.push({
            provider: providerId,
            scenarioId,
            modelId: model.id,
            providerNativeModelId: model.model ?? null,
            routeType: 'hosted',
            date: new Date().toISOString(),
            outcome: 'completed',
            projectId: result.project.id,
            conversationId: result.conversation.id,
            artifactId: result.artifact.artifact.id,
            artifactRevisionId: result.artifact.revision.id,
            pinnedSourceArtifactId: result.pinnedSourceArtifact?.artifact.id ?? null,
            pinnedSourceArtifactRevisionId: result.pinnedSourceArtifact?.revision.id ?? null,
            memoryId: result.memory?.id ?? null,
            memorySourceMessageId: result.memorySourceMessageId ?? null,
            taskRunId: result.task?.run_id ?? null,
            taskStatus: result.task?.status ?? null,
            assistantTurns: result.assistantTurns,
            finalContentSha256: sha256(result.finalAssistant.content),
            screenshot,
          });
        } catch (error) {
          evidence.demos.push({
            provider: providerId,
            scenarioId,
            modelId: model.id,
            routeType: 'hosted',
            date: new Date().toISOString(),
            outcome: error instanceof ShowcaseSkip ? error.outcome : 'failed',
            error: safeError(error),
          });
        }
      }
    }
  } else if (phase === 'local') {
    const marker = option('--gpu-marker');
    if (!marker) throw new Error('--gpu-marker is required for local phase');
    const markerState = (await readFile(resolve(marker), 'utf8')).trim().toLowerCase();
    if (markerState !== 'yes') {
      throw new Error('GPU marker must already be yes; the coordinating operator owns the lock');
    }
    const localStatus = await runtimeRequest(
      page,
      'local_models.cupcake.status',
      { verifyIntegrity: true },
      180_000,
    );
    const models = await runtimeRequest(page, 'models.list', {}, 180_000);
    const model = chooseLocalModel(models, localStatus);
    if (!model) throw new Error('No loaded Cupcake Local model is available for the local demo');
    const hardware = await runtimeRequest(page, 'local_models.hardware', {}, 120_000);
    const gpuName = hardwareGpuName(hardware);
    if (!/nvidia/iu.test(gpuName) || !hasCudaEvidence(hardware, localStatus)) {
      throw new Error('Local demo requires observed NVIDIA CUDA hardware/runtime evidence');
    }
    evidence.localRuntime = {
      activeModelId: String(localStatus.activeModelId ?? localStatus.active_model_id ?? model.id),
      modelId: model.id,
      gpu: gpuName,
      acceleration: safeStringArray(hardware.acceleration),
      runtime: safeLocalRuntime(localStatus),
    };
    await runtimeRequest(
      page,
      'models.select',
      { modelId: model.id, compatibilityConfirmed: true },
      120_000,
    );
    const result = await runScenario(page, SCENARIOS.local, model, 'local');
    const screenshot = await captureConversation(page, SCENARIOS.local.title, output, 'local-cuda');
    evidence.screenshots.push(screenshot);
    evidence.demos.push({
      provider: String(model.provider ?? 'cupcake_local'),
      modelId: model.id,
      routeType: 'local-cuda',
      date: new Date().toISOString(),
      outcome: 'completed',
      projectId: result.project.id,
      conversationId: result.conversation.id,
      artifactId: result.artifact.artifact.id,
      artifactRevisionId: result.artifact.revision.id,
      assistantTurns: result.assistantTurns,
      finalContentSha256: sha256(result.finalAssistant.content),
      screenshot,
    });
  } else {
    await verifyPersistedShowcase(page, evidence, output);
  }
} catch (error) {
  evidence.failures.push(safeError(error));
} finally {
  clearCredentialMap(credentials);
  evidence.finishedAt = new Date().toISOString();
  const evidenceSlug =
    phase === 'hosted' ? `hosted-${[...requestedProviders].sort().join('-')}` : phase;
  const manifestPath = join(output, `owner-showcase-${evidenceSlug}-evidence.json`);
  await writeFile(manifestPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await browser?.close().catch(() => undefined);
  const summary = {
    phase,
    manifest: manifestPath,
    providerOutcomes: evidence.providers.map(({ provider, outcome }) => ({ provider, outcome })),
    demoOutcomes: evidence.demos.map(({ provider, modelId, routeType, outcome }) => ({
      provider,
      modelId,
      routeType,
      outcome,
    })),
    screenshots: evidence.screenshots,
    failures: evidence.failures,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
if (
  evidence.failures.length ||
  evidence.demos.some((demo) => ['failed', 'incomplete'].includes(demo.outcome))
) {
  process.exitCode = 1;
}
if (phase === 'hosted' && !evidence.demos.some((demo) => demo.outcome === 'completed')) {
  process.exitCode = 1;
}

async function runtimeRequest(activePage, method, params = {}, timeoutMs = 120_000) {
  const response = await activePage.evaluate(
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

async function runScenario(activePage, scenario, model, routeType) {
  const project = await ensureProject(activePage, PROJECTS[scenario.project]);
  const conversation = await ensureConversation(activePage, project.id, scenario.title);
  if (conversation.status === 'archived') {
    throw new ShowcaseSkip(
      'skipped_archived',
      'The existing showcase conversation is archived and was preserved without inference',
    );
  }
  let branchId = conversation.branchId;
  let firstAssistant;
  let artifact;
  const pinnedSourceArtifact = scenario.pinnedSourceArtifact
    ? await findArtifact(activePage, project.id, scenario.pinnedSourceArtifact)
    : null;
  if (scenario.pinnedSourceArtifact && !pinnedSourceArtifact) {
    throw new Error(`Pinned source artifact is unavailable: ${scenario.pinnedSourceArtifact}`);
  }
  const assistants = [];
  const requiredIndexes = requiredPromptIndexes(scenario);
  for (let index = 0; index < scenario.prompts.length; index += 1) {
    if (!requiredIndexes.includes(index)) continue;
    const references = pinnedSourceArtifact
      ? [
          {
            id: pinnedSourceArtifact.artifact.id,
            type: 'artifact',
            revisionId: pinnedSourceArtifact.revision.id,
          },
        ]
      : [];
    if (index === 1 && scenario.groundSecondTurn) {
      if (!firstAssistant) throw new Error('Grounding source response is unavailable');
      artifact = await ensureArtifact(
        activePage,
        project.id,
        conversation.id,
        scenario,
        firstAssistant,
      );
      references.push({
        id: artifact.artifact.id,
        type: 'artifact',
        revisionId: artifact.revision.id,
      });
    }
    const turn = await ensureTurn(activePage, {
      content: scenario.prompts[index],
      model,
      modelId: model.id,
      projectId: project.id,
      conversationId: conversation.id,
      branchId,
      routeType,
      references,
      maxOutputTokens: scenario.maxOutputTokens,
      retryOnInterrupted: scenario.retryOnInterrupted !== false,
      reasoningEffort: scenario.reasoningEffort ?? 'none',
    });
    branchId = turn.branchId;
    assistants.push(turn.assistant);
    if (index === 0) firstAssistant = turn.assistant;
  }
  const finalAssistant = assistants.at(-1);
  if (!finalAssistant?.content?.trim()) throw new Error('Final model response is empty');
  assertCompleteAssistant(finalAssistant);
  const artifactSourceAssistant = scenario.groundSecondTurn ? firstAssistant : finalAssistant;
  if (!artifactSourceAssistant) throw new Error('Artifact source response is unavailable');
  artifact = await ensureArtifact(
    activePage,
    project.id,
    conversation.id,
    scenario,
    artifactSourceAssistant,
  );
  const memory = scenario.memory
    ? await ensureDecisionMemory(activePage, project.id, scenario.memory, finalAssistant)
    : null;
  const task =
    scenario.task && !args.includes('--skip-tasks')
      ? await ensureTask(activePage, project.id, scenario.task, artifact)
      : null;
  return {
    project,
    conversation: { ...conversation, branchId },
    artifact,
    pinnedSourceArtifact,
    memory,
    memorySourceMessageId: memory ? finalAssistant.id : null,
    task,
    finalAssistant,
    assistantTurns: assistants.length,
  };
}

async function ensureTurn(
  activePage,
  {
    content,
    model,
    modelId,
    projectId,
    conversationId,
    branchId,
    routeType,
    references,
    maxOutputTokens,
    retryOnInterrupted,
    reasoningEffort,
  },
) {
  let history = await runtimeRequest(activePage, 'chat.history', { branchId }, 120_000);
  const existing = assistantAfterPrompt(history, content);
  if (existing) return { assistant: existing, branchId };
  let prompt = content;
  if (history.some((message) => message.role === 'user' && message.content === content)) {
    if (!retryOnInterrupted) {
      throw new Error(
        'This short showcase turn has a prior provider interruption; retry is disabled',
      );
    }
    const recovery = recoveryPromptFor(content);
    const recovered = assistantAfterPrompt(history, recovery);
    if (recovered) return { assistant: recovered, branchId };
    if (history.some((message) => message.role === 'user' && message.content === recovery)) {
      throw new Error('This showcase turn has an unresolved prior provider interruption');
    }
    prompt = recovery;
  }
  const params = {
    content: prompt,
    modelId,
    projectId,
    conversationId,
    branchId,
    reasoningEffort,
    offline: routeType === 'local',
    enabledToolIds: [],
    memoryIds: [],
    toolIds: [],
    attachments: [],
    attachmentHandles: [],
    references,
    referenceIds: references.map((item) => item.id),
    maxOutputTokens,
  };
  if (routeType === 'hosted') {
    const preflight = await runtimeRequest(activePage, 'chat.preflight', params, 120_000);
    if (!preflight?.confirmationToken || !preflight?.outboundIntent) {
      throw new Error('Cloud disclosure preflight did not return a bound confirmation');
    }
    params.outboundConfirmationToken = preflight.confirmationToken;
    params.outboundIntent = preflight.outboundIntent;
  }
  const result = await runtimeRequest(activePage, 'chat.send', params, 600_000);
  const assistant = result?.message;
  if (!assistant || assistant.role !== 'assistant' || !String(assistant.content ?? '').trim()) {
    throw new Error('Provider completed without a persisted assistant response');
  }
  if (routeType === 'hosted' && assistant.model_id) {
    const expectedNative = String(
      model?.model ?? (modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId),
    );
    if (assistant.model_id !== expectedNative) {
      throw new Error('Persisted response model does not match the explicitly selected route');
    }
  }
  if (routeType === 'hosted') {
    const expectedProvider = normalizeProviderId(model?.provider ?? modelId.split(':')[0]);
    const observedProvider = normalizeProviderId(assistant.provider_id);
    if (observedProvider && observedProvider !== expectedProvider) {
      throw new Error('Persisted response provider does not match the explicitly selected route');
    }
  }
  history = await runtimeRequest(
    activePage,
    'chat.history',
    { branchId: result.branchId },
    120_000,
  );
  const persisted = history.find((message) => message.id === assistant.id) ?? assistant;
  assertCompleteAssistant(persisted);
  return { assistant: persisted, branchId: result.branchId };
}

async function ensureProject(activePage, definition) {
  const projects = await runtimeRequest(
    activePage,
    'projects.list',
    { includeArchived: true },
    120_000,
  );
  const matches = projects.filter((project) => project.name === definition.name);
  if (matches.length > 1) throw new Error(`Duplicate showcase project: ${definition.name}`);
  if (!matches.length) {
    return runtimeRequest(activePage, 'projects.create', definition, 120_000);
  }
  const project = matches[0];
  if (project.description !== definition.description) {
    return runtimeRequest(
      activePage,
      'projects.update',
      { projectId: project.id, description: definition.description },
      120_000,
    );
  }
  if (project.status === 'archived') {
    return runtimeRequest(
      activePage,
      'projects.archive',
      { projectId: project.id, archived: false },
      120_000,
    );
  }
  return project;
}

async function ensureConversation(activePage, projectId, title) {
  const conversations = await runtimeRequest(
    activePage,
    'conversations.list',
    { projectId, includeArchived: true, limit: 500 },
    120_000,
  );
  const matches = conversations.filter((conversation) => conversation.title === title);
  if (matches.length > 1) throw new Error(`Duplicate showcase conversation: ${title}`);
  let conversation;
  let branchId;
  if (!matches.length) {
    const created = await runtimeRequest(
      activePage,
      'conversations.create',
      { title, projectId },
      120_000,
    );
    conversation = created.conversation;
    branchId = created.branch.id;
  } else {
    conversation = matches[0];
    const state = await runtimeRequest(
      activePage,
      'conversations.get',
      { conversationId: conversation.id },
      120_000,
    );
    branchId = state.activeBranchId ?? state.branches?.[0]?.id;
  }
  if (!branchId) throw new Error(`Conversation has no active branch: ${title}`);
  return { ...conversation, branchId };
}

async function findArtifact(activePage, projectId, title) {
  const artifacts = await runtimeRequest(activePage, 'artifacts.list', { projectId }, 120_000);
  const matches = artifacts.filter((artifact) => (artifact.title ?? artifact.name) === title);
  if (matches.length > 1) throw new Error(`Duplicate showcase artifact: ${title}`);
  if (!matches.length) return null;
  return runtimeRequest(
    activePage,
    'artifacts.get',
    { projectId, artifactId: matches[0].id },
    120_000,
  );
}

async function ensureArtifact(activePage, projectId, conversationId, scenario, assistant) {
  assertCompleteAssistant(assistant);
  const existing = await findArtifact(activePage, projectId, scenario.artifact);
  if (!String(assistant.content ?? '').trim()) {
    throw new Error('Refusing to save an artifact without actual model output');
  }
  const content = artifactContent(scenario.artifactKind, assistant.content);
  if (existing) {
    const provenance = await verifyArtifactProvenance(
      activePage,
      projectId,
      existing.artifact,
      assistant,
      scenario.artifactKind,
    );
    if (provenance.proven) {
      return runtimeRequest(
        activePage,
        'artifacts.get',
        {
          projectId,
          artifactId: existing.artifact.id,
          revisionId: provenance.sourceRevisionId,
        },
        120_000,
      );
    }
    return runtimeRequest(
      activePage,
      'artifacts.revise',
      {
        projectId,
        artifactId: existing.artifact.id,
        expectedRevisionId: existing.revision.id,
        sourceMessageId: assistant.id,
        content,
        authorKind: 'assistant',
        changeSummary: 'Replace incomplete showcase output with a completed provider response',
      },
      120_000,
    );
  }
  return runtimeRequest(
    activePage,
    'artifacts.create',
    {
      projectId,
      conversationId,
      sourceMessageId: assistant.id,
      title: scenario.artifact,
      kind: scenario.artifactKind,
      mimeType: scenario.artifactKind === 'code' ? 'text/x-python' : 'text/markdown',
      content,
      authorKind: 'assistant',
    },
    120_000,
  );
}

function assertCompleteAssistant(assistant) {
  const issue = completeAssistantIssue(assistant);
  if (issue) throw new Error(issue);
}

function completeAssistantIssue(assistant) {
  if (!assistant || assistant.role !== 'assistant' || !String(assistant.content ?? '').trim()) {
    return 'Model response is missing a non-empty persisted assistant message';
  }
  if (assistant.state !== 'complete') {
    return 'Model response is not in the complete persisted state';
  }
  const reason = assistant.canonical_metadata?.finishReason;
  if (!['stop', 'end_turn'].includes(reason)) {
    return `Model response has no accepted terminal finish reason (${safeToken(reason) || 'missing'})`;
  }
  return null;
}

function isCompleteAssistant(assistant) {
  return completeAssistantIssue(assistant) === null;
}

function requiredPromptIndexes(scenario) {
  return scenario.requiredPromptIndexes ?? scenario.prompts.map((_, index) => index);
}

function recoveryPromptFor(prompt) {
  const promptId = sha256(prompt).slice(0, 12);
  return `The provider stopped after showcase request ${promptId}. Complete that exact request now without discussing the interruption.`;
}

function completeAssistantForPrompt(history, prompt) {
  const promptPresent = history.some(
    (message) => message.role === 'user' && message.content === prompt,
  );
  if (!promptPresent) return null;
  return (
    assistantAfterPrompt(history, prompt) ??
    assistantAfterPrompt(history, recoveryPromptFor(prompt))
  );
}

function inspectScenarioHistory(history, scenario) {
  const indexes = requiredPromptIndexes(scenario);
  const turns = indexes.map((index) => ({
    index,
    assistant: completeAssistantForPrompt(history, scenario.prompts[index]),
  }));
  const finalAssistant = turns.at(-1)?.assistant ?? null;
  const artifactSourceAssistant = scenario.groundSecondTurn
    ? (turns.find((turn) => turn.index === 0)?.assistant ?? null)
    : finalAssistant;
  return {
    complete: Boolean(
      finalAssistant && artifactSourceAssistant && turns.every((turn) => turn.assistant),
    ),
    requiredTurnCount: indexes.length,
    completeTurnCount: turns.filter((turn) => turn.assistant).length,
    partialAssistantCount: history.filter(
      (message) => message.role === 'assistant' && !isCompleteAssistant(message),
    ).length,
    finalAssistant,
    artifactSourceAssistant,
  };
}

function artifactContent(kind, content) {
  const text = String(content ?? '');
  if (kind !== 'code') return text;
  const blocks = [
    ...text.matchAll(
      /(?:^|\n)```(?:python|python3|py)?[\t ]*\r?\n([\s\S]*?)\r?\n```(?=\r?\n|$)/giu,
    ),
  ];
  if (blocks.length !== 1 || !blocks[0][1].trim()) {
    throw new Error('A Python artifact requires exactly one non-empty model-produced code block');
  }
  return `${blocks[0][1].trim()}\n`;
}

async function ensureDecisionMemory(activePage, projectId, definition, assistant) {
  const match = String(assistant.content ?? '').match(new RegExp(definition.pattern, 'imu'));
  const content = match?.[1]?.trim();
  if (!content) {
    throw new Error('Grounded response omitted the requested Decision memory line');
  }
  const memories = await runtimeRequest(
    activePage,
    'memory.list',
    {
      projectId,
      includeGlobal: false,
      states: ['active', 'candidate', 'superseded'],
      kinds: ['decision'],
      limit: 100,
    },
    120_000,
  );
  const matches = memories
    .filter((memory) => memory.key === definition.key)
    .sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0));
  const current = matches.find((memory) => ['active', 'candidate'].includes(memory.state));
  const currentSource = current?.evidence?.[0]?.source_id ?? current?.evidence?.[0]?.sourceId;
  if (current?.content === content && currentSource === assistant.id) return current;
  return runtimeRequest(
    activePage,
    'memory.remember',
    {
      key: definition.key,
      content,
      kind: 'decision',
      scope: 'project',
      projectId,
      sourceId: assistant.id,
      confidence: 1,
      explicit: true,
      sensitive: false,
    },
    120_000,
  );
}

async function ensureTask(activePage, projectId, definition, artifact) {
  const artifactId = artifact?.artifact?.id;
  const revisionId = artifact?.revision?.id;
  if (!artifactId || !revisionId) {
    throw new Error('A showcase task requires an exact saved artifact revision');
  }
  const tasks = await runtimeRequest(activePage, 'tasks.list', { limit: 200 }, 120_000);
  const matches = tasksBoundToArtifact(tasks, projectId, artifactId, revisionId);
  if (matches.length > 1) throw new Error('Duplicate showcase task detected');
  if (matches.length) return matches[0];
  const created = await runtimeRequest(
    activePage,
    'tasks.create',
    {
      prompt: definition.prompt,
      projectId,
      artifactId,
      revisionId,
      workKind: definition.workKind,
      estimatedSeconds: 90,
      toolStages: definition.toolStages,
      background: true,
    },
    120_000,
  );
  if (!created?.run?.run_id || !created.run.status) {
    throw new Error('Task creation did not return a durable run and observed status');
  }
  return created.run;
}

async function connectProviderThroughUi(activePage, providerId, credential, outputDirectory) {
  const secret = credential?.apiKey;
  if (!secret) throw new Error('No in-memory API credential is available');
  const definition = PROVIDERS[providerId];
  for (const field of definition.requiredCredentialFields ?? []) {
    if (!credential?.[field]) {
      throw new Error(`The authorized key file does not include the required ${field} field`);
    }
  }
  if (providerId === 'cloudflare' && !/^[a-f0-9]{32}$/iu.test(credential.accountId)) {
    throw new Error('The authorized Cloudflare account ID is not a valid 32-hex identifier');
  }
  await activePage.getByRole('button', { name: 'Settings', exact: true }).click();
  await activePage.getByRole('button', { name: 'Providers', exact: true }).click();
  const row = activePage
    .locator('.provider-row')
    .filter({ hasText: definition.rowName ?? definition.displayName });
  await row.waitFor({ timeout: 30_000 });
  if ((await row.count()) !== 1) {
    throw new Error(`Expected exactly one provider row for ${definition.displayName}`);
  }
  const status = await row.innerText();
  if (/connected/iu.test(status) && !/not connected/iu.test(status)) {
    return { modelCount: null, outcomeDetail: 'already connected in owner profile' };
  }
  await row.getByRole('button', { name: 'Connect', exact: true }).click();
  const dialog = activePage.getByRole('dialog', {
    name: new RegExp(`Connect ${escapeRegex(definition.displayName)}`, 'iu'),
  });
  await dialog.waitFor({ timeout: 30_000 });
  const keyInput = dialog.locator('input[name="api-key"]');
  const populatedInputs = [keyInput];
  try {
    await keyInput.fill(secret);
    if (credential.accountId) {
      const accountIdInput = dialog.locator('input[name="account-id"]');
      await accountIdInput.fill(credential.accountId);
      populatedInputs.push(accountIdInput);
    }
    if (definition.freeOnlyModelIds) {
      const modelIdInput = dialog.locator('input[name="model-id"]');
      await modelIdInput.fill(definition.freeOnlyModelIds[0]);
    }
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
    const verified = dialog.getByRole('heading', { name: 'Connection verified', exact: true });
    const alert = dialog.getByRole('alert');
    await Promise.race([
      verified.waitFor({ timeout: 180_000 }).then(() => 'verified'),
      alert.waitFor({ timeout: 180_000 }).then(() => 'error'),
    ]);
    if (await alert.isVisible().catch(() => false)) {
      throw new Error(`Provider setup failed: ${await alert.innerText()}`);
    }
    const capability = await dialog
      .locator('dt', { hasText: 'Capabilities' })
      .locator('..')
      .innerText();
    const modelCount = Number(capability.match(/(\d+) models/iu)?.[1] ?? 0) || null;
    await dialog.getByRole('button', { name: 'Save & connect', exact: true }).click();
    await dialog
      .getByRole('heading', { name: `${definition.displayName} is connected`, exact: true })
      .waitFor({ timeout: 180_000 });
    await dialog.getByRole('button', { name: 'Close provider setup', exact: true }).click();
    await row.getByText('Connected', { exact: true }).first().waitFor({ timeout: 60_000 });
    const screenshot = join(outputDirectory, `${providerId}-connected.png`);
    await activePage.screenshot({ path: screenshot });
    return { modelCount, screenshot };
  } catch (error) {
    await Promise.all(populatedInputs.map((input) => input.fill('').catch(() => undefined)));
    await dialog
      .getByRole('button', { name: 'Close provider setup', exact: true })
      .click()
      .catch(() => undefined);
    const screenshot = join(outputDirectory, `${providerId}-connection-failed.png`);
    await activePage.screenshot({ path: screenshot }).catch(() => undefined);
    throw error;
  }
}

async function captureConversation(activePage, title, outputDirectory, slug) {
  await activePage.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorkbench(activePage);
  await activePage.getByRole('button', { name: 'Chats', exact: true }).click();
  const row = activePage.locator('.chat-list__main').filter({ hasText: title });
  await row.waitFor({ timeout: 60_000 });
  await row.click();
  await activePage.locator('.chat-main').waitFor({ timeout: 60_000 });
  const path = join(outputDirectory, `${slug}-showcase-chat.png`);
  await activePage.screenshot({ path, fullPage: true });
  return path;
}

async function verifyArtifactProvenance(
  activePage,
  projectId,
  artifactRecord,
  expectedAssistant,
  artifactKind,
) {
  const history = await runtimeRequest(
    activePage,
    'artifacts.history',
    { projectId, artifactId: artifactRecord.id },
    120_000,
  );
  const revisions = Array.isArray(history) ? history : [];
  const expectedContent = artifactContent(artifactKind, expectedAssistant?.content);
  const expectedContentSha256 = sha256(expectedContent);
  const headRevisionId = artifactRecord.head_revision_id ?? artifactRecord.headRevisionId;
  const sourceCandidates = [];
  for (const revision of revisions) {
    if (revision.author_kind !== 'assistant') continue;
    const exposedSourceMessageId = revision.source_message_id ?? revision.sourceMessageId;
    if (exposedSourceMessageId && exposedSourceMessageId !== expectedAssistant?.id) continue;
    const snapshot = await runtimeRequest(
      activePage,
      'artifacts.get',
      { projectId, artifactId: artifactRecord.id, revisionId: revision.id },
      120_000,
    );
    if (sha256(String(snapshot?.content ?? '')) !== expectedContentSha256) continue;
    const lineage = inspectRevisionLineage(
      revisions,
      revision.id,
      headRevisionId,
      artifactRecord.id,
    );
    if (lineage.proven) {
      sourceCandidates.push({
        revision,
        lineage,
        sourceMessageMatched: exposedSourceMessageId === expectedAssistant?.id,
      });
    }
  }
  sourceCandidates.sort(
    (left, right) => left.lineage.manualRevisionCount - right.lineage.manualRevisionCount,
  );
  const source = sourceCandidates[0] ?? null;
  return {
    proven: Boolean(source),
    sourceRevisionId: source?.revision.id ?? null,
    sourceMessageMatched: source?.sourceMessageMatched ?? false,
    modelSourceContentMatched: Boolean(source),
    manualRevisionCount: source?.lineage.manualRevisionCount ?? 0,
    currentExecutionRevisionId: source?.lineage.currentExecutionRevisionId ?? null,
    revisionCount: revisions.length,
  };
}

function inspectRevisionLineage(revisions, sourceRevisionId, headRevisionId, artifactId) {
  if (!sourceRevisionId || !headRevisionId) {
    return { proven: false, reason: 'missing_revision_id', manualRevisionCount: 0 };
  }
  const byId = new Map();
  for (const revision of revisions) {
    if (!revision?.id || revision.artifact_id !== artifactId || byId.has(revision.id)) {
      return { proven: false, reason: 'invalid_revision_history', manualRevisionCount: 0 };
    }
    byId.set(revision.id, revision);
  }
  const descendants = [];
  const visited = new Set();
  let currentId = headRevisionId;
  while (currentId !== sourceRevisionId) {
    if (visited.has(currentId)) {
      return { proven: false, reason: 'revision_cycle', manualRevisionCount: 0 };
    }
    visited.add(currentId);
    const revision = byId.get(currentId);
    if (!revision) {
      return { proven: false, reason: 'source_not_in_head_lineage', manualRevisionCount: 0 };
    }
    descendants.push(revision);
    currentId = revision.parent_revision_id ?? revision.parentRevisionId;
    if (!currentId) {
      return { proven: false, reason: 'source_not_in_head_lineage', manualRevisionCount: 0 };
    }
  }
  const source = byId.get(sourceRevisionId);
  if (!source) {
    return { proven: false, reason: 'source_revision_missing', manualRevisionCount: 0 };
  }
  if (descendants.some((revision) => revision.author_kind !== 'user')) {
    return { proven: false, reason: 'non_manual_descendant', manualRevisionCount: 0 };
  }
  return {
    proven: true,
    reason: null,
    manualRevisionCount: descendants.length,
    currentExecutionRevisionId: headRevisionId,
  };
}

async function verifyTaskExecution(activePage, task, artifactRecord, expectedRevisionId) {
  if (!artifactRecord || task?.status !== 'succeeded' || !task?.run_id) {
    return {
      proven: false,
      outcome: task?.status === 'succeeded' ? 'artifact_unavailable' : 'not_succeeded',
    };
  }
  try {
    const result = await runtimeRequest(
      activePage,
      'tasks.execute',
      { runId: task.run_id },
      120_000,
    );
    const projectId = artifactRecord.project_id ?? artifactRecord.projectId;
    const artifactHistory = projectId
      ? await runtimeRequest(
          activePage,
          'artifacts.history',
          { projectId, artifactId: artifactRecord.id },
          120_000,
        )
      : [];
    const proven = hasTaskExecutionProof(
      result,
      artifactRecord,
      expectedRevisionId,
      artifactHistory,
    );
    return {
      proven,
      outcome: proven ? 'execution_proven' : 'status_without_execution_evidence',
    };
  } catch (error) {
    return { proven: false, outcome: 'evidence_unavailable', error: safeError(error) };
  }
}

function hasTaskExecutionProof(result, artifactRecord, expectedRevisionId, artifactHistory) {
  const evidence = result?.toolEvidence;
  const revisionId = safeToken(evidence?.revisionId);
  const revisionBelongsToArtifact = Array.isArray(artifactHistory)
    ? artifactHistory.some(
        (revision) => revision.id === revisionId && revision.artifact_id === artifactRecord?.id,
      )
    : false;
  return Boolean(
    result?.run?.status === 'succeeded' &&
    evidence?.status === 'succeeded' &&
    evidence?.exitStatus === 0 &&
    evidence?.testSummary?.successful === true &&
    Array.isArray(evidence?.provenance) &&
    evidence.provenance.length > 0 &&
    evidence?.tool === 'python.run' &&
    evidence?.nativeTool === 'native.sandbox.python' &&
    evidence?.artifactId === artifactRecord?.id &&
    revisionId === expectedRevisionId &&
    revisionBelongsToArtifact,
  );
}

function tasksBoundToArtifact(tasks, projectId, artifactId, revisionId) {
  if (!artifactId || !revisionId) return [];
  return tasks.filter((task) => {
    const spec = task?.spec;
    if (!spec || (spec.project_id ?? spec.projectId) !== projectId) return false;
    if ((spec.work_kind ?? spec.workKind) !== 'code_execution') return false;
    const steps = Array.isArray(spec.steps) ? spec.steps : [];
    return steps.some((step) => {
      if (step?.operation !== 'tool.python.run') return false;
      const values = step.arguments?.artifactInputs ?? step.arguments?.artifact_inputs;
      const inputs = Array.isArray(values) ? values : [];
      return inputs.some(
        (input) => input?.artifactId === artifactId && input?.revisionId === revisionId,
      );
    });
  });
}

async function verifyPersistedShowcase(activePage, manifest, outputDirectory) {
  const projects = await runtimeRequest(
    activePage,
    'projects.list',
    { includeArchived: true },
    120_000,
  );
  for (const definition of Object.values(PROJECTS)) {
    const project = projects.find((item) => item.name === definition.name);
    if (!project) continue;
    const conversations = await runtimeRequest(
      activePage,
      'conversations.list',
      { projectId: project.id, includeArchived: true, limit: 500 },
      120_000,
    );
    const artifacts = await runtimeRequest(activePage, 'artifacts.list', { projectId: project.id });
    const projectKey = Object.entries(PROJECTS).find(([, item]) => item === definition)?.[0];
    const projectScenarios = Object.entries(SCENARIOS).filter(
      ([, scenario]) => scenario.project === projectKey,
    );
    const memories = projectScenarios.some(([, scenario]) => scenario.memory)
      ? await runtimeRequest(
          activePage,
          'memory.list',
          {
            projectId: project.id,
            includeGlobal: false,
            states: ['active', 'candidate', 'superseded'],
            limit: 100,
          },
          120_000,
        )
      : [];
    const tasks = projectScenarios.some(([, scenario]) => scenario.task)
      ? await runtimeRequest(activePage, 'tasks.list', { limit: 200 }, 120_000)
      : [];
    const scenarioResults = [];
    for (const [scenarioId, scenario] of projectScenarios) {
      const matches = conversations.filter((conversation) => conversation.title === scenario.title);
      if (matches.length > 1) {
        scenarioResults.push({ scenarioId, outcome: 'duplicate_conversation' });
        continue;
      }
      const conversation = matches[0];
      if (!conversation) continue;
      const state = await runtimeRequest(
        activePage,
        'conversations.get',
        { conversationId: conversation.id },
        120_000,
      );
      const branchId = state.activeBranchId ?? state.branches?.[0]?.id;
      if (!branchId) {
        scenarioResults.push({
          scenarioId,
          conversationId: conversation.id,
          outcome: 'observed_incomplete',
          reason: 'missing_branch',
        });
        continue;
      }
      const history = await runtimeRequest(activePage, 'chat.history', { branchId }, 120_000);
      const inspection = inspectScenarioHistory(history, scenario);
      if (scenario.preserveAfterFailedQualityReview) {
        scenarioResults.push({
          scenarioId,
          conversationId: conversation.id,
          outcome: 'quality_review_failed_preserved',
          requiredTurnCount: inspection.requiredTurnCount,
          completeTurnCount: inspection.completeTurnCount,
          partialAssistantCount: inspection.partialAssistantCount,
        });
        continue;
      }
      const archived = conversation.status === 'archived';
      if (archived || !inspection.complete) {
        scenarioResults.push({
          scenarioId,
          conversationId: conversation.id,
          outcome: archived ? 'archived_preserved' : 'observed_incomplete',
          requiredTurnCount: inspection.requiredTurnCount,
          completeTurnCount: inspection.completeTurnCount,
          partialAssistantCount: inspection.partialAssistantCount,
        });
        continue;
      }
      const artifactRecord = artifacts.find(
        (artifact) => (artifact.title ?? artifact.name) === scenario.artifact,
      );
      const artifactProof = artifactRecord
        ? await verifyArtifactProvenance(
            activePage,
            project.id,
            artifactRecord,
            inspection.artifactSourceAssistant,
            scenario.artifactKind,
          )
        : { proven: false, revisionCount: 0 };
      const memoryProof = scenario.memory
        ? memories.some(
            (memory) =>
              memory.key === scenario.memory.key &&
              ['active', 'candidate'].includes(memory.state) &&
              (memory.evidence?.[0]?.source_id ?? memory.evidence?.[0]?.sourceId) ===
                inspection.finalAssistant.id,
          )
        : true;
      const taskCandidates = scenario.task
        ? tasksBoundToArtifact(
            tasks,
            project.id,
            artifactRecord?.id,
            artifactProof.currentExecutionRevisionId,
          )
        : [];
      let task = null;
      let taskProof = {
        outcome: scenario.task ? 'no_exact_artifact_task' : 'not_applicable',
        proven: false,
      };
      for (const candidate of taskCandidates) {
        const candidateProof = await verifyTaskExecution(
          activePage,
          candidate,
          artifactRecord,
          artifactProof.currentExecutionRevisionId,
        );
        task ??= candidate;
        taskProof = candidateProof;
        if (candidateProof.proven) {
          task = candidate;
          break;
        }
      }
      const proven =
        artifactProof.proven && memoryProof && (scenario.task ? taskProof.proven : true);
      let screenshot = null;
      if (proven) {
        screenshot = await captureConversation(
          activePage,
          conversation.title,
          outputDirectory,
          `verify-${scenarioId}`,
        );
        manifest.screenshots.push(screenshot);
      }
      scenarioResults.push({
        scenarioId,
        conversationId: conversation.id,
        outcome: proven ? 'persisted' : 'verification_failed',
        requiredTurnCount: inspection.requiredTurnCount,
        completeTurnCount: inspection.completeTurnCount,
        partialAssistantCount: inspection.partialAssistantCount,
        artifactId: artifactRecord?.id ?? null,
        artifactProvenance: artifactProof.proven,
        artifactProvenanceRevisionId: artifactProof.sourceRevisionId ?? null,
        modelSourceRevisionId: artifactProof.sourceRevisionId ?? null,
        modelSourceMessageMatched: artifactProof.sourceMessageMatched ?? false,
        modelSourceContentMatched: artifactProof.modelSourceContentMatched ?? false,
        manualRevisionCount: artifactProof.manualRevisionCount ?? 0,
        currentExecutionRevisionId: artifactProof.currentExecutionRevisionId ?? null,
        artifactRevisionCount: artifactProof.revisionCount,
        memoryProvenance: memoryProof,
        taskRunId: task?.run_id ?? null,
        taskStatus: task?.status ?? null,
        taskBindingCandidateCount: taskCandidates.length,
        taskExecutionProven: taskProof.proven,
        taskOutcome: taskProof.outcome,
        screenshot,
      });
    }
    const completeCandidates = scenarioResults.filter((item) =>
      ['persisted', 'verification_failed'].includes(item.outcome),
    );
    const verifiedScenarios = scenarioResults.filter((item) => item.outcome === 'persisted');
    const incompleteProof =
      completeCandidates.some((item) => item.outcome === 'verification_failed') ||
      scenarioResults.some((item) => item.outcome === 'duplicate_conversation');
    const completeAssistantTurns = scenarioResults.reduce(
      (total, item) => total + Number(item.completeTurnCount ?? 0),
      0,
    );
    const partialAssistantTurns = scenarioResults.reduce(
      (total, item) => total + Number(item.partialAssistantCount ?? 0),
      0,
    );
    manifest.demos.push({
      routeType: definition === PROJECTS.local ? 'local-cuda' : 'hosted',
      outcome: incompleteProof
        ? 'incomplete'
        : verifiedScenarios.length > 0
          ? 'persisted'
          : 'no_completed_showcase_observed',
      projectId: project.id,
      projectName: project.name,
      conversationCount: conversations.length,
      artifactCount: artifacts.length,
      completeAssistantTurns,
      partialAssistantTurns,
      verifiedScenarioCount: verifiedScenarios.length,
      observedIncompleteScenarioCount: scenarioResults.filter((item) =>
        ['observed_incomplete', 'archived_preserved', 'quality_review_failed_preserved'].includes(
          item.outcome,
        ),
      ).length,
      taskExecutionProofCount: scenarioResults.filter((item) => item.taskExecutionProven).length,
      scenarios: scenarioResults,
    });
  }
  await activePage.getByRole('button', { name: 'Projects', exact: true }).click();
  await activePage.getByRole('heading', { name: 'Projects', exact: true }).last().waitFor();
  const path = join(outputDirectory, 'persisted-showcase-projects.png');
  await activePage.screenshot({ path, fullPage: true });
  manifest.screenshots.push(path);
}

function chooseHostedModel(modelsValue, providerId, scenarioPreferences = undefined) {
  const models = Array.isArray(modelsValue) ? modelsValue : (modelsValue?.models ?? []);
  const candidates = models.filter((model) => {
    const provider = normalizeProviderId(model.provider ?? model.metadata?.provider);
    const endpointId = normalizeProviderId(
      model.metadata?.endpoint_id ?? model.metadata?.endpointId,
    );
    const namedCompatibleRoute =
      provider === 'openai-compatible' &&
      (endpointId === providerId ||
        String(model.id ?? '')
          .toLowerCase()
          .startsWith(`openai-compatible:${providerId}/`));
    const compatibility = String(
      model.chat_compatibility ?? model.metadata?.chat_compatibility ?? 'chat',
    );
    const privacyRoute = String(model.privacy_route ?? '').toLowerCase();
    return (
      (provider === providerId || namedCompatibleRoute) &&
      (namedCompatibleRoute ? privacyRoute !== 'local' : privacyRoute === 'cloud') &&
      compatibility !== 'non_chat'
    );
  });
  const definition = PROVIDERS[providerId];
  const preferences = scenarioPreferences ?? definition.modelPreferences;
  const allowed = definition.freeOnlyModelIds
    ? candidates.filter((model) =>
        definition.freeOnlyModelIds.includes(String(model.model ?? nativeModelId(model))),
      )
    : candidates;
  return rankModels(allowed, preferences)[0] ?? null;
}

function nativeModelId(model) {
  const id = String(model?.id ?? '');
  if (!id.includes(':')) return id;
  const routeAndModel = id.slice(id.indexOf(':') + 1);
  if (String(model?.provider ?? '') === 'openai-compatible' && routeAndModel.includes('/')) {
    return routeAndModel.slice(routeAndModel.indexOf('/') + 1);
  }
  return routeAndModel;
}

function chooseLocalModel(modelsValue, localStatus) {
  const models = Array.isArray(modelsValue) ? modelsValue : (modelsValue?.models ?? []);
  const active = String(localStatus.activeModelId ?? localStatus.active_model_id ?? '');
  const candidates = models.filter((model) => {
    const kind = String(model.metadata?.runtime_kind ?? model.provider ?? '');
    return (
      String(model.privacy_route ?? '').toLowerCase() === 'local' ||
      /cupcake[_ -]?(local|llama)/iu.test(kind) ||
      String(model.id ?? '').startsWith('openai-compatible:cupcake-local/')
    );
  });
  return (
    candidates.find((model) => model.id === active || model.model === active) ??
    candidates.find((model) => model.metadata?.runtime_loaded === true) ??
    null
  );
}

function rankModels(models, preferences) {
  return [...models].sort((left, right) => {
    const score = (model) => {
      const value =
        `${model.id ?? ''} ${model.model ?? ''} ${model.display_name ?? ''}`.toLowerCase();
      const index = preferences.findIndex((preference) => value.includes(preference.toLowerCase()));
      const verification = String(
        model.verification_state ?? model.metadata?.verification_state ?? '',
      );
      const verificationRank =
        {
          operationally_verified: 0,
          account_discoverable: 1,
          docs_verified_chat: 2,
          '': 3,
          stale: 5_000,
          unverified: 6_000,
        }[verification] ?? 4;
      return verificationRank + (index < 0 ? 1_000 : index * 10);
    };
    return score(left) - score(right) || String(left.id).localeCompare(String(right.id));
  });
}

async function parseAuthorizedCredentials(path) {
  const text = await readFile(path, 'utf8');
  const lines = text.split(/\r?\n/u);
  const candidates = new Map();
  let sectionProvider = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const delimited = line.match(/^([^:=]{2,80})\s*[:=]\s*(\S.*)$/u);
    if (delimited) {
      const provider =
        providerFromLabel(delimited[1]) ??
        (isCredentialFieldLabel(delimited[1]) ? sectionProvider : null);
      if (provider) {
        sectionProvider = provider;
        keepCredentialCandidate(
          candidates,
          provider,
          credentialFieldFromLabel(delimited[1], provider),
          delimited[2].trim(),
          credentialLabelPriority(delimited[1]),
        );
      }
      continue;
    }
    const exactProvider = providerFromExactLabel(line);
    if (exactProvider) {
      sectionProvider = exactProvider;
      const next = nextCredentialLine(lines, index + 1);
      if (next) {
        keepCredentialCandidate(
          candidates,
          exactProvider,
          credentialFieldFromLabel(line, exactProvider),
          next.value,
          credentialLabelPriority(line),
        );
        index = next.index;
      }
      continue;
    }
    const spaced = providerAndCredentialFromSpacedLine(line);
    if (spaced) {
      sectionProvider = spaced.provider;
      keepCredentialCandidate(
        candidates,
        spaced.provider,
        spaced.field,
        spaced.credential,
        credentialLabelPriority(spaced.label),
      );
    }
  }
  return new Map(
    [...candidates.entries()]
      .map(([provider, fields]) => [
        provider,
        Object.fromEntries(
          [...fields.entries()].map(([field, candidate]) => [field, candidate.credential]),
        ),
      ])
      .filter(([, credential]) => Boolean(credential.apiKey)),
  );
}

function providerAndCredentialFromSpacedLine(line) {
  const labels = providerCredentialLabels().sort((a, b) => b.label.length - a.label.length);
  for (const { provider, label, field } of labels) {
    const labelPattern = label
      .split(' ')
      .map((part) => escapeRegex(part))
      .join('[\\s_-]+');
    const match = line.match(new RegExp(`^${labelPattern}\\s+(.+)$`, 'iu'));
    if (!match) continue;
    const credential = match[1].trim();
    if (credential && !providerFromExactLabel(credential)) {
      return { provider, credential, label, field };
    }
  }
  return null;
}

function keepCredentialCandidate(candidates, provider, field, credential, priority) {
  const fields = candidates.get(provider) ?? new Map();
  const current = fields.get(field);
  if (!current || priority > current.priority) fields.set(field, { credential, priority });
  candidates.set(provider, fields);
}

function credentialFieldFromLabel(label, provider) {
  const normalized = normalizeLabel(label);
  if (provider === 'cloudflare' && /\baccount (id|identifier)\b/iu.test(normalized)) {
    return 'accountId';
  }
  return 'apiKey';
}

function isCredentialFieldLabel(label) {
  const normalized = normalizeLabel(label);
  return (
    /^(api )?(key|token|secret)$/u.test(normalized) ||
    /^(account (id|identifier))$/u.test(normalized)
  );
}

function credentialLabelPriority(label) {
  const normalized = normalizeLabel(label);
  if (/\bproduction\b/iu.test(normalized)) return 3;
  if (/\btrial\b/iu.test(normalized)) return 1;
  return 2;
}

function nextCredentialLine(lines, start) {
  for (let index = start; index < lines.length; index += 1) {
    const value = lines[index].trim();
    if (!value || value.startsWith('#')) continue;
    if (providerFromExactLabel(value) || /^([^:=]{2,80})\s*[:=]/u.test(value)) return null;
    return { index, value };
  }
  return null;
}

function providerLabels() {
  return Object.entries(PROVIDERS).flatMap(([provider, definition]) =>
    definition.aliases.map((alias) => ({ provider, label: normalizeLabel(alias) })),
  );
}

function providerCredentialLabels() {
  return providerLabels().flatMap(({ provider, label }) => {
    const labels = [
      { provider, label: `${label} api key`, field: 'apiKey' },
      { provider, label: `${label} api token`, field: 'apiKey' },
      { provider, label: `${label} token`, field: 'apiKey' },
      { provider, label, field: 'apiKey' },
    ];
    if (provider === 'cloudflare') {
      labels.push(
        { provider, label: `${label} account id`, field: 'accountId' },
        { provider, label: `${label} account identifier`, field: 'accountId' },
      );
    }
    return labels;
  });
}

function providerFromLabel(value) {
  const normalized = normalizeLabel(value).replace(
    /\b(api|key|token|production|trial|secret)\b/gu,
    ' ',
  );
  return providerLabels().find(({ label }) => normalized.includes(label))?.provider ?? null;
}

function providerFromExactLabel(value) {
  const normalized = normalizeLabel(value).replace(
    /\b(api|key|token|production|trial|secret|account|identifier|id)\b/gu,
    ' ',
  );
  return (
    providerLabels().find(({ label }) => normalizeLabel(normalized) === label)?.provider ?? null
  );
}

function credentialSecretValues(credential) {
  return Object.values(credential ?? {}).filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
}

function missingCredentialFields(providerId, credential) {
  const required = ['apiKey', ...(PROVIDERS[providerId]?.requiredCredentialFields ?? [])];
  return required.filter((field) => !credential?.[field]);
}

function clearCredentialRecord(credential) {
  if (!credential) return;
  for (const field of Object.keys(credential)) credential[field] = '';
}

function clearCredentialMap(records) {
  for (const credential of records.values()) clearCredentialRecord(credential);
  records.clear();
}

function configuredProviderIds(status) {
  const items = Array.isArray(status?.providers) ? status.providers : [];
  return new Set(
    items
      .filter((item) => item?.configured === true)
      .map((item) => normalizeProviderId(item.provider))
      .filter(Boolean),
  );
}

function normalizeProviderId(value) {
  const normalized = normalizeLabel(String(value ?? ''));
  if (['gemini', 'google gemini'].includes(normalized)) return 'google';
  if (['nvidia', 'nim', 'nvidia nim'].includes(normalized)) return 'nvidia-nim';
  if (normalized === 'claude') return 'anthropic';
  if (normalized === 'grok' || normalized === 'x ai') return 'xai';
  return normalized.replaceAll(' ', '-');
}

function normalizeLabel(value) {
  return String(value)
    .toLowerCase()
    .replace(/[_-]+/gu, ' ')
    .replace(/[^a-z0-9 ]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
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
  throw new Error('The CDP endpoint did not expose the packaged CupcakeAI renderer');
}

async function assertRealPackagedApp(activePage) {
  const identity = await activePage.evaluate(() => ({
    tauri: '__TAURI_INTERNALS__' in globalThis.window,
    bridge: Boolean(globalThis.window.cupcake?.runtime?.request),
    fixtureBanner: Boolean(globalThis.document.querySelector('.fixture-banner')),
    url: globalThis.location.href,
  }));
  if (!identity.tauri || !identity.bridge || identity.fixtureBanner) {
    throw new Error(
      'Refusing to seed a preview or fixture; a real packaged Tauri renderer is required',
    );
  }
  await waitForWorkbench(activePage);
}

async function waitForWorkbench(activePage) {
  await activePage.getByRole('button', { name: 'Settings', exact: true }).waitFor({
    timeout: 180_000,
  });
  const lock = activePage.locator('input[type="password"]:visible');
  if (await lock.isVisible().catch(() => false)) {
    throw new Error(
      'Owner profile is locked; this harness never reads or submits workspace passwords',
    );
  }
}

function assistantAfterPrompt(history, prompt) {
  const promptIndex = history.findIndex(
    (message) => message.role === 'user' && message.content === prompt,
  );
  if (promptIndex < 0) return null;
  const nextUserOffset = history
    .slice(promptIndex + 1)
    .findIndex((message) => message.role === 'user');
  const exchangeEnd = nextUserOffset < 0 ? history.length : promptIndex + 1 + nextUserOffset;
  return (
    history.slice(promptIndex + 1, exchangeEnd).find((message) => isCompleteAssistant(message)) ??
    null
  );
}

function hasCudaEvidence(hardware, status) {
  const values = [
    ...safeStringArray(hardware.acceleration),
    status.activeRuntime?.backend,
    status.active_runtime?.backend,
    status.runtime?.backend,
  ];
  return values.some((value) => /cuda/iu.test(String(value ?? '')));
}

function hardwareGpuName(hardware) {
  return String(hardware?.gpu_name ?? hardware?.gpuName ?? hardware?.gpu ?? '').trim();
}

function safeLocalRuntime(status) {
  const runtime = status.activeRuntime ?? status.active_runtime ?? status.runtime ?? {};
  return {
    id: safeToken(runtime.id),
    version: safeToken(runtime.version),
    backend: safeToken(runtime.backend),
  };
}

function safeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => sanitize(item)).filter(Boolean) : [];
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

function safeError(error, secrets = []) {
  const value = error instanceof Error ? error.message : String(error ?? '');
  return sanitize(redactValues(value, secrets)) || 'Unknown failure';
}

function redactValues(value, secrets = []) {
  let redacted = String(value ?? '');
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[redacted]');
  }
  return redacted;
}

function safeToken(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._:/-]/gu, '')
    .slice(0, 200);
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function runSelfTests() {
  const user = (id, content) => ({ id, role: 'user', content });
  const assistant = (id, content, state = 'complete', finishReason = 'stop') => ({
    id,
    role: 'assistant',
    content,
    state,
    canonical_metadata: finishReason === null ? {} : { finishReason },
  });

  assert.doesNotThrow(() => assertCompleteAssistant(assistant('a-stop', 'done')));
  assert.doesNotThrow(() =>
    assertCompleteAssistant(assistant('a-end', 'done', 'complete', 'end_turn')),
  );
  assert.throws(
    () => assertCompleteAssistant(assistant('a-length', 'partial', 'complete', 'length')),
    /terminal finish reason/u,
  );
  assert.throws(
    () => assertCompleteAssistant(assistant('a-stream', 'partial', 'streaming', 'stop')),
    /complete persisted state/u,
  );
  assert.throws(
    () => assertCompleteAssistant(assistant('a-missing', 'text', 'complete', null)),
    /terminal finish reason/u,
  );
  assert.throws(
    () => assertCompleteAssistant(assistant('a-cancelled', 'text', 'cancelled', 'stop')),
    /complete persisted state/u,
  );

  const boundedHistory = [
    user('u-1', 'first'),
    user('u-2', 'second'),
    assistant('a-2', 'second answer'),
  ];
  assert.equal(assistantAfterPrompt(boundedHistory, 'first'), null);
  assert.equal(assistantAfterPrompt(boundedHistory, 'second')?.id, 'a-2');

  const interruptedPrompt = 'make the artifact';
  const interruptedHistory = [
    user('u-original', interruptedPrompt),
    assistant('a-partial', 'unfinished', 'complete', 'length'),
    user('u-recovery', recoveryPromptFor(interruptedPrompt)),
    assistant('a-recovered', 'finished'),
  ];
  const interruptedInspection = inspectScenarioHistory(interruptedHistory, {
    prompts: [interruptedPrompt],
  });
  assert.equal(interruptedInspection.complete, true);
  assert.equal(interruptedInspection.completeTurnCount, 1);
  assert.equal(interruptedInspection.partialAssistantCount, 1);
  assert.equal(interruptedInspection.finalAssistant?.id, 'a-recovered');
  assert.notEqual(recoveryPromptFor('first request'), recoveryPromptFor('second request'));
  assert.equal(
    hardwareGpuName({ gpu_name: 'NVIDIA GeForce RTX 4070 Laptop GPU' }),
    'NVIDIA GeForce RTX 4070 Laptop GPU',
  );
  assert.equal(hardwareGpuName({ gpu: 'NVIDIA fallback' }), 'NVIDIA fallback');

  const optionalPromptScenario = {
    prompts: ['analysis', 'obsolete expansion', 'bounded correction'],
    requiredPromptIndexes: [0, 2],
  };
  assert.deepEqual(requiredPromptIndexes(SCENARIOS['nvidia-nim']), [2, 3]);
  assert.equal(SCENARIOS['nvidia-nim'].preserveAfterFailedQualityReview, true);
  assert.equal(SCENARIOS['groq-code-review'].providerId, 'groq');
  assert.deepEqual(SCENARIOS['groq-code-review'].modelPreferences, ['openai/gpt-oss-20b']);
  assert.equal(SCENARIOS['groq-code-review'].pinnedSourceArtifact, 'harbor_sensor_triage.py');
  assert.deepEqual(requiredPromptIndexes(SCENARIOS['groq-code-review']), [0, 1]);
  const optionalPromptInspection = inspectScenarioHistory(
    [
      user('u-analysis', 'analysis'),
      assistant('a-analysis', 'analysis complete'),
      user('u-obsolete', 'obsolete expansion'),
      assistant('a-obsolete', 'truncated', 'complete', 'length'),
      user('u-correction', 'bounded correction'),
      assistant('a-correction', 'correction complete'),
    ],
    optionalPromptScenario,
  );
  assert.equal(optionalPromptInspection.complete, true);
  assert.equal(optionalPromptInspection.requiredTurnCount, 2);
  assert.equal(optionalPromptInspection.completeTurnCount, 2);
  assert.equal(optionalPromptInspection.partialAssistantCount, 1);

  const reviewedCodeScenario = {
    prompts: ['partial analysis', 'partial expansion', 'first replacement', 'review correction'],
    requiredPromptIndexes: [2, 3],
  };
  const reviewedCodeHistory = [
    user('u-replacement', 'first replacement'),
    assistant('a-replacement', 'complete but review failed'),
  ];
  assert.equal(inspectScenarioHistory(reviewedCodeHistory, reviewedCodeScenario).complete, false);
  reviewedCodeHistory.push(
    user('u-review-correction', 'review correction'),
    assistant('a-review-correction', 'corrected module'),
  );
  const reviewedCodeInspection = inspectScenarioHistory(reviewedCodeHistory, reviewedCodeScenario);
  assert.equal(reviewedCodeInspection.complete, true);
  assert.equal(reviewedCodeInspection.finalAssistant?.id, 'a-review-correction');
  assert.equal(reviewedCodeInspection.artifactSourceAssistant?.id, 'a-review-correction');

  const linearHistory = [
    {
      id: 'source-revision',
      artifact_id: 'artifact-lineage',
      parent_revision_id: null,
      author_kind: 'assistant',
    },
    {
      id: 'manual-review',
      artifact_id: 'artifact-lineage',
      parent_revision_id: 'source-revision',
      author_kind: 'user',
    },
  ];
  assert.deepEqual(
    inspectRevisionLineage(linearHistory, 'source-revision', 'manual-review', 'artifact-lineage'),
    {
      proven: true,
      reason: null,
      manualRevisionCount: 1,
      currentExecutionRevisionId: 'manual-review',
    },
  );
  assert.equal(
    inspectRevisionLineage(
      [
        ...linearHistory,
        {
          id: 'unrelated-head',
          artifact_id: 'artifact-lineage',
          parent_revision_id: null,
          author_kind: 'user',
        },
      ],
      'source-revision',
      'unrelated-head',
      'artifact-lineage',
    ).proven,
    false,
  );
  assert.equal(
    inspectRevisionLineage(
      [linearHistory[0], { ...linearHistory[1], author_kind: 'assistant' }],
      'source-revision',
      'manual-review',
      'artifact-lineage',
    ).proven,
    false,
  );
  assert.equal(
    inspectRevisionLineage(linearHistory, 'source-revision', 'manual-review', 'wrong-artifact')
      .proven,
    false,
  );

  assert.equal(artifactContent('code', '```python\nvalue = 1\n```\n'), 'value = 1\n');
  assert.throws(() => artifactContent('code', '```python\nvalue = 1'), /exactly one non-empty/u);
  assert.throws(
    () => artifactContent('code', '```python\na = 1\n```\n```python\nb = 2\n```\n'),
    /exactly one non-empty/u,
  );

  const artifact = { id: 'artifact-1' };
  const taskResult = {
    run: { status: 'succeeded' },
    toolEvidence: {
      status: 'succeeded',
      exitStatus: 0,
      testSummary: { successful: true },
      provenance: ['sandbox:packaged-worker-appcontainer-job'],
      tool: 'python.run',
      nativeTool: 'native.sandbox.python',
      artifactId: artifact.id,
      revisionId: 'revision-1',
    },
  };
  const artifactHistory = [{ id: 'revision-1', artifact_id: artifact.id }];
  assert.equal(hasTaskExecutionProof(taskResult, artifact, 'revision-1', artifactHistory), true);
  assert.equal(
    hasTaskExecutionProof(
      { run: { status: 'succeeded' } },
      artifact,
      'revision-1',
      artifactHistory,
    ),
    false,
  );
  assert.equal(
    hasTaskExecutionProof(
      { ...taskResult, toolEvidence: { ...taskResult.toolEvidence, exitStatus: 1 } },
      artifact,
      'revision-1',
      artifactHistory,
    ),
    false,
  );
  assert.equal(
    hasTaskExecutionProof(taskResult, artifact, 'wrong-revision', artifactHistory),
    false,
  );
  const reviewedTaskResult = {
    ...taskResult,
    toolEvidence: {
      ...taskResult.toolEvidence,
      artifactId: 'artifact-lineage',
      revisionId: 'manual-review',
    },
  };
  assert.equal(
    hasTaskExecutionProof(
      reviewedTaskResult,
      { id: 'artifact-lineage' },
      'manual-review',
      linearHistory,
    ),
    true,
  );
  assert.equal(
    hasTaskExecutionProof(taskResult, { id: 'artifact-lineage' }, 'manual-review', linearHistory),
    false,
  );

  const boundTask = {
    run_id: 'run-bound',
    spec: {
      project_id: 'project-1',
      prompt: 'A UI-authored prompt whose wording is intentionally irrelevant.',
      work_kind: 'code_execution',
      steps: [
        {
          operation: 'tool.python.run',
          arguments: {
            artifactInputs: [{ artifactId: artifact.id, revisionId: 'revision-1' }],
          },
        },
      ],
    },
  };
  const wrongArtifactTask = {
    ...boundTask,
    run_id: 'run-wrong-artifact',
    spec: {
      ...boundTask.spec,
      prompt: SCENARIOS['nvidia-nim'].task.prompt,
      steps: [
        {
          operation: 'tool.python.run',
          arguments: {
            artifactInputs: [{ artifactId: 'wrong-artifact', revisionId: 'revision-1' }],
          },
        },
      ],
    },
  };
  assert.deepEqual(
    tasksBoundToArtifact(
      [wrongArtifactTask, boundTask],
      'project-1',
      artifact.id,
      'revision-1',
    ).map((task) => task.run_id),
    ['run-bound'],
  );
  assert.deepEqual(
    tasksBoundToArtifact([boundTask], 'project-1', artifact.id, 'wrong-revision'),
    [],
  );
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
