#!/usr/bin/env node
import { acquireWorkspaceLock, workPath } from './lib/workspace.mjs';
if (!process.argv.includes('--self-test'))
  await acquireWorkspaceLock('create-owner-video-showcase');

/* global window */
// Operational owner-profile helper. All assistant messages come from the real packaged runtime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { URL } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(workPath('qa/video-showcase'));
const scenarioFile = new URL('./fixtures/owner-video-scenarios.json', import.meta.url);
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const phase = option('--phase', 'verify');
assert(['run', 'verify', 'followup', 'closing'].includes(phase), 'Unknown phase');
const ids = option('--ids', '').split(',').filter(Boolean);
if (phase !== 'verify') assert.equal(option('--execute'), 'REAL_MODEL_CALLS');
const config = JSON.parse(await readFile(scenarioFile, 'utf8'));
assert.equal(new Set(config.scenarios.map((s) => s.id)).size, config.scenarios.length);
const selected = config.scenarios.filter((s) => !ids.length || ids.includes(s.id));
assert(selected.length, 'No selected scenarios');
await mkdir(root, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:10131');
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().startsWith('https://tauri.localhost'));
assert(page, 'Real packaged renderer missing');
let lastGroqAt = Date.now();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const req = (method, params = {}, timeoutMs = 120000) =>
  page.evaluate(
    async ({ method, params, timeoutMs }) => {
      const response = await window.cupcake.runtime.request({ method, params, timeoutMs });
      if (!response.ok) throw Error(`${method}:${response.error?.code ?? 'failed'}`);
      return response.result;
    },
    { method, params, timeoutMs },
  );
function complete(message) {
  assert(
    message?.role === 'assistant' && message.state === 'complete' && message.content?.trim(),
    'Missing complete real assistant',
  );
  assert(
    ['stop', 'end_turn'].includes(message.canonical_metadata?.finishReason),
    'Truncated or unsuccessful model finish',
  );
  assert(message.provider_id && message.model_id, 'Missing actual response route');
  assert(!String(message.provider_id).includes('mock'), 'Fixture response rejected');
  return message;
}
async function saveJson(name, value) {
  await writeFile(join(root, name), JSON.stringify(value, null, 2));
}
async function projectFor(scenario, create) {
  const matches = (await req('projects.list', { includeArchived: true })).filter(
    (p) => p.name === scenario.project,
  );
  assert(matches.length <= 1, 'Duplicate showcase project');
  if (matches.length) {
    assert(!matches[0].archived_at, 'Owner archived the project');
    return matches[0];
  }
  assert(create, `Missing project: ${scenario.project}`);
  return req('projects.create', {
    name: scenario.project,
    description: scenario.projectDescription,
  });
}
async function conversationFor(scenario, project, create) {
  const matches = (
    await req('conversations.list', { projectId: project.id, includeArchived: true, limit: 500 })
  ).filter((c) => c.title === scenario.title);
  assert(matches.length <= 1, 'Duplicate showcase conversation');
  if (!matches.length) {
    assert(create, `Missing conversation: ${scenario.title}`);
    const made = await req('conversations.create', {
      projectId: project.id,
      title: scenario.title,
    });
    return { ...made.conversation, branchId: made.branch.id };
  }
  assert(matches[0].status !== 'archived', 'Owner archived conversation');
  const state = await req('conversations.get', { conversationId: matches[0].id });
  return { ...matches[0], branchId: state.activeBranchId ?? state.branches[0].id };
}
async function inputFor(scenario, project, conversation, create) {
  const name = scenario.inputName;
  const matches = (await req('artifacts.list', { projectId: project.id })).filter(
    (a) => a.title === name,
  );
  assert(matches.length <= 1, 'Duplicate input artifact');
  if (matches.length) {
    const found = await req('artifacts.get', { projectId: project.id, artifactId: matches[0].id });
    assert.equal(
      found.content,
      scenario.inputText,
      'Input changed; refusing to silently replace it',
    );
    return found;
  }
  assert(create, 'Missing synthetic source artifact');
  return req('artifacts.create', {
    projectId: project.id,
    conversationId: conversation.id,
    title: name,
    kind: 'document',
    mimeType: 'text/markdown',
    content: scenario.inputText,
    authorKind: 'user',
  });
}
async function modelFor(scenario) {
  const models = await req('models.list');
  const override = option('--model-id');
  if (override) {
    assert(scenario.provider !== 'local', 'Local examples cannot be rerouted');
    const model = models.find((m) => m.id === override);
    assert(model && model.privacy_route === 'cloud', 'Explicit cloud model missing');
    return model;
  }
  if (scenario.provider === 'local') {
    const marker = await readFile('C:/Users/akshi/Desktop/Code Palace/gpu use.txt', 'utf8');
    assert.equal(marker.trim(), 'yes', 'GPU lock must be held by coordinating operator');
    const state = await req('local_models.cupcake.status');
    assert.equal(state.endpoint.state, 'ready', 'Exact local model must be loaded by operator');
    const candidates = models.filter(
      (m) => m.privacy_route === 'local' && String(m.id).toLowerCase().includes('qwen3'),
    );
    assert.equal(candidates.length, 1, 'Ambiguous local route');
    return candidates[0];
  }
  const id =
    scenario.provider === 'groq'
      ? 'openai-compatible:groq/openai/gpt-oss-120b'
      : 'cohere:command-a-plus-05-2026';
  const model = models.find((m) => m.id === id);
  assert(model, `Requested model missing: ${id}`);
  return model;
}
function afterPrompt(history, prompt) {
  const index = history.findIndex((m) => m.role === 'user' && m.content === prompt);
  if (index < 0) return null;
  const tail = history.slice(index + 1);
  const end = tail.findIndex((m) => m.role === 'user');
  const response = (end < 0 ? tail : tail.slice(0, end)).find((m) => m.role === 'assistant');
  assert(response, 'Prior user submission has no response; refusing automatic retry');
  return complete(response);
}
async function send(scenario, project, conversation, input, model, prompt, memoryIds = []) {
  const history = await req('chat.history', { branchId: conversation.branchId });
  const prior = afterPrompt(history, prompt);
  if (prior) return prior;
  const groq = model.id.startsWith('openai-compatible:groq/');
  if (groq) {
    // The UI group lane can reserve this shared free-tier route between batches.
    while (true) {
      let reserved = false;
      try {
        reserved =
          JSON.parse(await readFile(join(root, 'groq-ui-reservation.json'), 'utf8')).active ===
          true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!reserved) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (groq && lastGroqAt) {
    const remaining = 65000 - (Date.now() - lastGroqAt);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  }
  const params = {
    content: prompt,
    projectId: project.id,
    conversationId: conversation.id,
    branchId: conversation.branchId,
    modelId: model.id,
    personalityPreset: 'warm',
    personalityInstructions:
      'Be an approachable, competent helper. Do the concrete work from the supplied evidence. Make it easy to act on. Be specific and lightly warm without catchphrases. Do not invent facts or imply actions were performed. Keep ordinary replies around 220 words and final deliverables around 500; code may be longer. Treat supplied synthetic records as the scenario evidence, not as real personal information. Calculate carefully; state unresolved assumptions plainly.',
    reasoningEffort: 'none',
    offline: scenario.provider === 'local',
    maxOutputTokens:
      model.provider === 'cohere' ? 12000 : scenario.artifactKind === 'code' ? 6000 : 3000,
    enabledToolIds: [],
    toolIds: [],
    memoryIds,
    attachments: [],
    attachmentHandles: [],
    references: [{ type: 'artifact', id: input.artifact.id, revisionId: input.revision.id }],
    referenceIds: [input.artifact.id],
  };
  if (scenario.provider !== 'local') {
    const preflight = await req('chat.preflight', params);
    assert(
      preflight.confirmationToken && preflight.outboundIntent,
      'Bound outbound preflight missing',
    );
    params.outboundConfirmationToken = preflight.confirmationToken;
    params.outboundIntent = preflight.outboundIntent;
  }
  lastGroqAt = groq ? Date.now() : lastGroqAt;
  const response = await req('chat.send', params, 600000);
  const message = complete(response.message);
  assert.equal(message.model_id, model.model, 'Unexpected model route');
  assert.equal(message.provider_id, model.provider, 'Unexpected serving provider');
  conversation.branchId = response.branchId;
  return message;
}
function outputContent(scenario, message) {
  if (scenario.artifactKind !== 'code') return { content: message.content, transformation: 'none' };
  const blocks = [...message.content.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return { content: message.content, transformation: 'none' };
  assert.equal(blocks.length, 1, 'Need one complete Python source block');
  return { content: blocks[0][1].trimEnd() + '\n', transformation: 'extract-single-python-fence' };
}
async function saveOutput(scenario, project, conversation, message) {
  complete(message);
  const derived = outputContent(scenario, message);
  const matches = (await req('artifacts.list', { projectId: project.id })).filter(
    (a) => a.title === scenario.artifactTitle,
  );
  assert(matches.length <= 1, 'Duplicate output artifact');
  const common = {
    projectId: project.id,
    sourceMessageId: message.id,
    content: derived.content,
    authorKind: 'assistant',
  };
  let snapshot;
  if (matches.length) {
    const previous = await req('artifacts.get', {
      projectId: project.id,
      artifactId: matches[0].id,
    });
    snapshot =
      previous.content === derived.content
        ? previous
        : await req('artifacts.revise', {
            ...common,
            artifactId: matches[0].id,
            expectedRevisionId: previous.revision.id,
            changeSummary: 'Update from the completed conversation response',
          });
  } else
    snapshot = await req('artifacts.create', {
      ...common,
      conversationId: conversation.id,
      title: scenario.artifactTitle,
      kind: scenario.artifactKind,
      mimeType: scenario.artifactKind === 'code' ? 'text/x-python' : 'text/markdown',
    });
  assert.equal(snapshot.content, derived.content);
  return {
    id: snapshot.artifact.id,
    revisionId: snapshot.revision.id,
    sourceMessageId: message.id,
    sourceSha256: hash(message.content),
    contentSha256: hash(derived.content),
    transformation: derived.transformation,
  };
}
async function runScenario(scenario) {
  assert(scenario.provider !== 'group', 'Group scenarios use the actual UI group lane');
  const project = await projectFor(scenario, true);
  const conversation = await conversationFor(scenario, project, true);
  let input = await inputFor(scenario, project, conversation, true);
  if (phase === 'closing') {
    const output = (await req('artifacts.list', { projectId: project.id })).find(
      (a) => a.title === scenario.artifactTitle,
    );
    assert(output, 'Review the saved deliverable before requesting next steps');
    input = await req('artifacts.get', { projectId: project.id, artifactId: output.id });
  }
  const model = await modelFor(scenario);
  let memoryIds = [];
  if (scenario.feature.includes('memory')) {
    const budget = scenario.id === 'private-subscription-cleanup';
    const key = budget
      ? 'Budget discussions: totals first, no lecture'
      : 'Meeting decisions: named owners, explicit unknowns';
    let memory = (await req('memory.list', { projectId: project.id })).find((m) => m.key === key);
    if (!memory)
      memory = await req('memory.remember', {
        projectId: project.id,
        scope: 'project',
        explicit: true,
        key,
        content: budget
          ? 'For budget discussions in this synthetic project, show totals first and keep the tone matter-of-fact. Protect work tools and backups when comparing optional cuts.'
          : 'In this project, assign a named owner only when the meeting notes explicitly do so. Leave unassigned actions marked unassigned; distinguish decisions from proposals.',
        kind: 'preference',
      });
    memoryIds = [memory.id];
  }
  const receipt = {
    id: scenario.id,
    projectId: project.id,
    conversationId: conversation.id,
    title: scenario.title,
    inputArtifactId: input.artifact.id,
    modelId: model.id,
    startedAt: new Date().toISOString(),
    messages: [],
    outputs: [],
    memoryIds,
  };
  const prompts =
    phase !== 'run' ? [(await readFile(option('--prompt-file'), 'utf8')).trim()] : scenario.prompts;
  for (let index = 0; index < prompts.length; index++) {
    if (phase === 'run' && scenario.id === 'truthful-cv-branches' && index === 3) {
      const branches = await req('conversations.branches', { conversationId: conversation.id });
      let branch = branches.find((item) => item.name === 'Customer success direction');
      if (!branch)
        branch = await req('conversations.branch', {
          conversationId: conversation.id,
          fromMessageId: receipt.messages.at(-1).id,
          name: 'Customer success direction',
        });
      receipt.fork = {
        parentMessageId: branch.forked_from_message_id,
        branchId: branch.id,
        name: branch.name,
      };
      conversation.branchId = branch.id;
    }
    const message = await send(
      scenario,
      project,
      conversation,
      input,
      model,
      prompts[index],
      memoryIds,
    );
    receipt.messages.push({
      id: message.id,
      provider: message.provider_id,
      model: message.model_id,
      contentSha256: hash(message.content),
      content: message.content,
    });
    if (phase !== 'closing' && (index === scenario.revisionAt || index === prompts.length - 1))
      receipt.outputs.push(await saveOutput(scenario, project, conversation, message));
    await saveJson(`${scenario.id}-${phase}.json`, receipt);
    console.log(
      JSON.stringify({
        scenario: scenario.id,
        turn: index + 1,
        complete: true,
        characters: message.content.length,
      }),
    );
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.branchId = conversation.branchId;
  await saveJson(`${scenario.id}-${phase}.json`, receipt);
}
async function verifyScenario(scenario) {
  const project = await projectFor(scenario, false);
  const conversation = await conversationFor(scenario, project, false);
  const input = await inputFor(scenario, project, conversation, false);
  const branches = await req('conversations.branches', { conversationId: conversation.id });
  const messages = new Map();
  for (const branch of branches) {
    for (const message of await req('chat.history', { branchId: branch.id }))
      messages.set(message.id, message);
  }
  const history = [...messages.values()];
  const allAssistants = history.filter((m) => m.role === 'assistant');
  const assistants = allAssistants.filter(
    (m) =>
      m.state === 'complete' && ['stop', 'end_turn'].includes(m.canonical_metadata?.finishReason),
  );
  assistants.forEach(complete);
  assert(assistants.length >= 4, `Too little substantive conversation: ${scenario.id}`);
  const matches = (await req('artifacts.list', { projectId: project.id })).filter(
    (a) => a.title === scenario.artifactTitle,
  );
  assert.equal(matches.length, 1);
  const snapshot = await req('artifacts.get', { projectId: project.id, artifactId: matches[0].id });
  let source = assistants.find((m) => {
    // Exploratory code replies can contain several snippets; only a complete
    // single-file response can directly match the saved executable artifact.
    try {
      return outputContent(scenario, m).content === snapshot.content;
    } catch {
      return false;
    }
  });
  let editorial = null;
  if (!source) {
    editorial = JSON.parse(
      await readFile(join(root, 'editorial', `${scenario.id}-receipt.json`), 'utf8'),
    );
    assert.equal(editorial.authorKind, 'user');
    assert.equal(editorial.artifactId, snapshot.artifact.id);
    assert.equal(editorial.revisionId, snapshot.revision.id);
    assert.equal(editorial.contentSha256, hash(snapshot.content));
    source = assistants.find(
      (m) => m.id === editorial.sourceMessageId && hash(m.content) === editorial.sourceSha256,
    );
  }
  assert(source, 'Output has no completed real response source');
  return {
    id: scenario.id,
    title: scenario.title,
    projectId: project.id,
    conversationId: conversation.id,
    branchId: conversation.branchId,
    branches: branches.map((b) => ({ id: b.id, name: b.name })),
    userTurns: history.filter((m) => m.role === 'user').length,
    assistantReplies: assistants.length,
    preservedPartialReplies: allAssistants
      .filter((m) => !assistants.includes(m))
      .map((m) => ({ id: m.id, state: m.state, finishReason: m.canonical_metadata?.finishReason })),
    inputArtifactId: input.artifact.id,
    outputArtifactId: snapshot.artifact.id,
    revisionId: snapshot.revision.id,
    sourceMessageId: source.id,
    editorialReview: editorial
      ? {
          authorKind: editorial.authorKind,
          previousRevisionId: editorial.previousRevisionId,
          transformation: editorial.transformation,
        }
      : null,
    contentSha256: hash(snapshot.content),
    routes: [...new Set(assistants.map((m) => `${m.provider_id}:${m.model_id}`))],
  };
}
try {
  const info = await page.evaluate(() => window.cupcake.app.getInfo());
  assert(info.packaged, 'Development or fixture renderer rejected');
  const cleanup = JSON.parse(await readFile(join(root, 'cleanup-receipt.json'), 'utf8'));
  assert.equal(cleanup.profile, workPath('profiles/test'));
  const before = JSON.parse(
    await readFile(join(root, 'before-cleanup/configuration.json'), 'utf8'),
  );
  const current = await req('projects.list', { includeArchived: true });
  assert(
    !current.some((p) => before.projects.some((q) => p.id === q.id)),
    'Old workspace content is present',
  );
  if (phase === 'verify') {
    const results = [];
    for (const scenario of selected) results.push(await verifyScenario(scenario));
    await saveJson('verification.json', {
      packagedApp: info,
      observedAt: new Date().toISOString(),
      results,
    });
    console.log(
      JSON.stringify({
        verified: results.length,
        replies: results.reduce((n, s) => n + s.assistantReplies, 0),
      }),
    );
  } else for (const scenario of selected) await runScenario(scenario);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
