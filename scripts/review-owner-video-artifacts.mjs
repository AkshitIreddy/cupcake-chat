#!/usr/bin/env node
/* global window */
// Save reviewed documents as editor revisions, never as model messages.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const root = 'E:/temp/cupcake-video-showcase-20260914';
const args = process.argv.slice(2);
assert.equal(args[0], '--execute');
assert.equal(args[1], 'REVIEWED_EDITOR_REVISIONS');
const ids = args[2]?.split(',');
assert(ids?.length, 'Specify reviewed scenario IDs');
const config = JSON.parse(await readFile('scripts/fixtures/owner-video-scenarios.json', 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const browser = await chromium.connectOverCDP('http://127.0.0.1:10131');
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith('https://tauri.localhost'));
  assert(page);
  const info = await page.evaluate(() => window.cupcake.app.getInfo());
  assert(info.packaged);
  const req = (method, params = {}) =>
    page.evaluate(
      async ({ method, params }) => {
        const response = await window.cupcake.runtime.request({
          method,
          params,
          timeoutMs: 120000,
        });
        if (!response.ok) throw Error(`${method}:${response.error?.code}`);
        return response.result;
      },
      { method, params },
    );
  const projects = await req('projects.list');
  const before = JSON.parse(
    await readFile(join(root, 'before-cleanup/configuration.json'), 'utf8'),
  );
  assert(
    !projects.some((p) => before.projects.some((q) => q.id === p.id)),
    'Old workspace present',
  );
  for (const id of ids) {
    const scenario = config.scenarios.find((s) => s.id === id);
    assert(scenario && scenario.artifactKind === 'document');
    const project = projects.find((p) => p.name === scenario.project);
    assert(project);
    const artifact = (await req('artifacts.list', { projectId: project.id })).find(
      (a) => a.title === scenario.artifactTitle,
    );
    assert(artifact);
    const previous = await req('artifacts.get', { projectId: project.id, artifactId: artifact.id });
    const content = await readFile(join(root, 'editorial', `${id}.md`), 'utf8');
    assert(content.trim() && content !== previous.content, 'No new reviewed content');
    const conversation = (
      await req('conversations.list', { projectId: project.id, limit: 500 })
    ).find((c) => c.title === scenario.title);
    const state = await req('conversations.get', { conversationId: conversation.id });
    const history = await req('chat.history', {
      branchId: state.activeBranchId ?? state.branches[0].id,
    });
    const source = history.find(
      (m) =>
        m.role === 'assistant' &&
        m.state === 'complete' &&
        ['stop', 'end_turn'].includes(m.canonical_metadata?.finishReason) &&
        m.content === previous.content,
    );
    assert(source, 'Expected an unchanged real model document before editorial review');
    const revised = await req('artifacts.revise', {
      projectId: project.id,
      artifactId: artifact.id,
      expectedRevisionId: previous.revision.id,
      content,
      authorKind: 'user',
      changeSummary:
        'Edited in Artifacts: reconcile the document against supplied facts and make the plan usable',
    });
    assert.equal(revised.content, content);
    assert.equal(revised.revision.author_kind, 'user');
    const receipt = {
      id,
      projectId: project.id,
      artifactId: artifact.id,
      sourceMessageId: source.id,
      previousRevisionId: previous.revision.id,
      revisionId: revised.revision.id,
      sourceSha256: hash(source.content),
      contentSha256: hash(content),
      authorKind: 'user',
      transformation: 'reviewed-editor-revision',
      originalContent: source.content,
      reviewedContent: content,
      observedAt: new Date().toISOString(),
    };
    await writeFile(
      join(root, 'editorial', `${id}-receipt.json`),
      JSON.stringify(receipt, null, 2),
    );
    console.log(
      JSON.stringify({
        id,
        artifactId: artifact.id,
        revisionId: revised.revision.id,
        authorKind: 'user',
      }),
    );
  }
} finally {
  await browser.close();
}
