#!/usr/bin/env node
import { acquireWorkspaceLock, workPath } from './lib/workspace.mjs';
if (!process.argv.includes('--self-test')) await acquireWorkspaceLock('run-owner-video-code-task');

/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

assert.equal(process.argv[2], 'EXECUTE_REVIEWED_SANDBOX_TESTS');
const root = workPath('qa/video-showcase');
const id = 'donor-csv-validator';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const scenario = JSON.parse(
  await readFile('scripts/fixtures/owner-video-scenarios.json', 'utf8'),
).scenarios.find((s) => s.id === id);
const run = JSON.parse(await readFile(join(root, `${id}-run.json`), 'utf8'));
const source = run.messages[2];
assert(source && source.provider === 'openai-compatible');
const blocks = [...source.content.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)];
assert.equal(blocks.length, 1, 'Expected one original model draft');
const original = blocks[0][1].trimEnd() + '\n';
const content = await readFile(join(root, 'editorial', `${id}.py`), 'utf8');
assert(content.startsWith('"""In-memory donor CSV validator'));
const browser = await chromium.connectOverCDP('http://127.0.0.1:10131');
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith('https://tauri.localhost'));
  assert(page);
  assert((await page.evaluate(() => window.cupcake.app.getInfo())).packaged);
  const req = (method, params = {}, timeoutMs = 120000) =>
    page.evaluate(
      async ({ method, params, timeoutMs }) => {
        const response = await window.cupcake.runtime.request({ method, params, timeoutMs });
        if (!response.ok) throw Error(`${method}:${response.error?.code}`);
        return response.result;
      },
      { method, params, timeoutMs },
    );
  const project = await req('projects.get', { projectId: run.projectId });
  assert.equal(project.name, scenario.project);
  assert(
    !(await req('artifacts.list', { projectId: project.id })).some(
      (a) => a.title === scenario.artifactTitle,
    ),
    'Refusing duplicate artifact or automatic test retry',
  );
  const draft = await req('artifacts.create', {
    projectId: project.id,
    conversationId: run.conversationId,
    title: scenario.artifactTitle,
    kind: 'code',
    mimeType: 'text/x-python',
    content: original,
    sourceMessageId: source.id,
    authorKind: 'assistant',
  });
  const revised = await req('artifacts.revise', {
    projectId: project.id,
    artifactId: draft.artifact.id,
    expectedRevisionId: draft.revision.id,
    content,
    authorKind: 'user',
    changeSummary:
      'Edited in Artifacts: reviewed implementation and embedded tests; original model draft preserved',
  });
  assert.equal(revised.content, content);
  await writeFile(
    join(root, 'editorial', `${id}-receipt.json`),
    JSON.stringify(
      {
        id,
        projectId: project.id,
        artifactId: revised.artifact.id,
        sourceMessageId: source.id,
        previousRevisionId: draft.revision.id,
        revisionId: revised.revision.id,
        sourceSha256: hash(source.content),
        contentSha256: hash(content),
        authorKind: 'user',
        transformation: 'reviewed-editor-revision',
        originalContent: source.content,
        reviewedContent: content,
        observedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const created = await req('tasks.create', {
    prompt: `Run the Python unit tests in saved artifact ${scenario.artifactTitle}.`,
    projectId: project.id,
    artifactId: revised.artifact.id,
    revisionId: revised.revision.id,
    workKind: 'code_execution',
    toolStages: 1,
    background: true,
  });
  const runId = created.run.run_id;
  assert(runId, 'Durable task ID missing');
  const params = { runId };
  const execution = created.execution;
  if (execution.status === 'approval_required') {
    const challenge = execution.approvalChallenge ?? execution.approval_challenge;
    assert(challenge && execution.preflight);
    params.brokerPreflight = execution.preflight;
    params.brokerApproval = Object.fromEntries(
      ['approval_id', 'nonce', 'intent_digest', 'preflight_digest', 'token'].map((key) => {
        const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        const value = challenge[key] ?? challenge[camel];
        assert(value, `Missing bound approval field: ${key}`);
        return [key, value];
      }),
    );
  }
  const result = await req('tasks.execute', params, 900000);
  await writeFile(
    join(root, 'donor-sandbox-task.json'),
    JSON.stringify(
      {
        runId,
        artifactId: revised.artifact.id,
        revisionId: revised.revision.id,
        sourceSha256: hash(content),
        observedAt: new Date().toISOString(),
        result,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      runId,
      executionStatus: result.execution?.status,
      runtimeStatus: result.run?.status,
    }),
  );
} finally {
  await browser.close();
}
