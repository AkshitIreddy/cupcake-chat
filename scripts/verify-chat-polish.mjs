#!/usr/bin/env node
import { acquireWorkspaceLock, workPath } from './lib/workspace.mjs';
if (!process.argv.includes('--self-test')) await acquireWorkspaceLock('verify-chat-polish');

/** Attach to the packaged historical profile. Executes its real Python test action. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';

/* global document, window, performance, requestAnimationFrame, cancelAnimationFrame, getComputedStyle */
const output = resolve(workPath('demo/replay/native-verified'));
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:10131');
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().includes('tauri.localhost'));
assert(page);
const receipt = { outcome: 'failed' };
const nav = (name) => page.locator('.shelf').getByRole('button', { name, exact: true }).click();
try {
  const info = await page.evaluate(() => window.cupcake.app.getInfo());
  assert(info.packaged && info.appVersion === '1.8.0');
  await nav('Projects');
  await page
    .locator('.project-card__select')
    .filter({ hasText: 'Rome beyond the battlefield' })
    .click();
  await nav('Chats');
  await page
    .locator('.chat-list__main')
    .filter({ hasText: 'When would a Roman fort run out of grain?' })
    .click();
  await page.locator('.markdown-code-block').waitFor();
  if (!process.argv.includes('--live')) {
    const equation = page.locator('.turn--assistant').last().locator('.katex-display');
    await equation.waitFor();
    receipt.equation = await equation.innerText();
    await equation.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, 'display-equation.png') });
  }
  await page.waitForTimeout(350);
  receipt.header = await page.evaluate(async () => {
    const outer = document.querySelector('.app-content'),
      pane = document.querySelector('.conversation-scroll'),
      title = document.querySelector('.chat-header h1');
    const before = title.getBoundingClientRect().top;
    pane.scrollTop = pane.scrollHeight;
    pane.querySelector('.turn:last-child').scrollIntoView({ block: 'center' });
    outer.scrollTop = 200;
    await new Promise(requestAnimationFrame);
    return {
      before,
      after: title.getBoundingClientRect().top,
      outerTop: outer.getBoundingClientRect().top,
      outerScroll: outer.scrollTop,
      overflow: getComputedStyle(outer).overflow,
    };
  });
  assert.equal(receipt.header.outerScroll, 0, 'Outer chat container moved');
  assert(
    Math.abs(receipt.header.before - receipt.header.after) < 1,
    'Chat title moved during message scroll',
  );
  assert(receipt.header.after >= receipt.header.outerTop, 'Chat title is cropped');
  receipt.paragraphWidths = await page
    .locator('.turn--assistant .rich-markdown > p')
    .evaluateAll((paragraphs) =>
      paragraphs.map((paragraph) => {
        const container = paragraph.parentElement;
        const style = getComputedStyle(container);
        return {
          width: paragraph.getBoundingClientRect().width,
          available:
            container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          maxWidth: getComputedStyle(paragraph).maxWidth,
        };
      }),
    );
  assert(receipt.paragraphWidths.length > 0);
  for (const paragraph of receipt.paragraphWidths) {
    assert.equal(paragraph.maxWidth, 'none');
    assert(
      Math.abs(paragraph.width - paragraph.available) < 2,
      'Paragraph leaves unused bubble width',
    );
  }
  const run = page
    .locator('.markdown-code-block')
    .getByRole('button', { name: 'Run tests', exact: true })
    .first();
  const artifactCount = () =>
    page.evaluate(async () => {
      const result = await window.cupcake.runtime.request({
        method: 'artifacts.list',
        params: { projectId: '01a0a1f1-3cfe-77e3-9074-da159fbc8b2f' },
      });
      if (!result.ok) throw Error('Artifact inventory failed');
      return result.result.length;
    });
  const artifactsBefore = await artifactCount();
  await run.scrollIntoViewIfNeeded();
  await run.click();
  await page
    .locator('.markdown-code-result')
    .filter({ hasText: '8 tests passed' })
    .waitFor({ timeout: 60000 });
  receipt.python = await page.locator('.markdown-code-result').first().innerText();
  receipt.artifacts = { before: artifactsBefore, after: await artifactCount() };
  assert.equal(
    receipt.artifacts.before,
    receipt.artifacts.after,
    'Rerunning saved chat code created a duplicate artifact',
  );
  assert(receipt.python.includes('Baseline (600 men) → 30 days; 900 men → 20 days'));
  await page.locator('.markdown-code-result').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'chat-python-result.png') });

  if (process.argv.includes('--live')) {
    const question = 'How much longer would that grain last with only 400 people?';
    assert.equal(
      await page.locator('.turn--user').filter({ hasText: question }).count(),
      0,
      'Do not duplicate a saved live probe',
    );
    await page.locator('button.model-chip:not(.group-model-chip)').click();
    await page.locator('.model-picker input[placeholder]').fill('groq');
    await page.locator('.model-picker__list button').filter({ hasText: 'gpt-oss-120b' }).click();
    await page.getByRole('textbox', { name: 'Message Cupcake', exact: true }).fill(question);
    await page.evaluate(() => {
      const state = {
        frames: 0,
        emptyLists: 0,
        headerCrops: 0,
        seen: [],
        frame: 0,
        started: performance.now(),
      };
      window.__streamAudit = state;
      const sample = () => {
        const target = document.querySelector('.turn--assistant:last-of-type .rich-markdown');
        state.frames++;
        if (target?.getAttribute('aria-busy') === 'true') {
          state.seen.push(target.innerText.length);
          if ([...target.querySelectorAll('li')].some((n) => !n.textContent.trim()))
            state.emptyLists++;
        }
        if (
          document.querySelector('.chat-header h1').getBoundingClientRect().top <
          document.querySelector('.app-content').getBoundingClientRect().top
        )
          state.headerCrops++;
        state.frame = requestAnimationFrame(sample);
      };
      sample();
    });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.locator('.turn--user').filter({ hasText: question }).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.turn--assistant').length >= 2 &&
        !document.querySelector('.streaming-caret'),
      null,
      { timeout: 180000 },
    );
    await page.waitForTimeout(300);
    receipt.stream = await page.evaluate(() => {
      cancelAnimationFrame(window.__streamAudit.frame);
      return window.__streamAudit;
    });
    assert(receipt.stream.seen.length > 0, 'No real streaming frames observed');
    assert.equal(receipt.stream.emptyLists, 0);
    assert.equal(receipt.stream.headerCrops, 0);
    receipt.answer = await page.locator('.turn--assistant').last().innerText();
    await page.screenshot({ path: join(output, 'live-answer.png') });
  }
  await nav('Home');
  receipt.homeProjects = await page.locator('.project-mini-grid button').allInnerTexts();
  assert(receipt.homeProjects.some((text) => text.includes('Mongols') && text.includes('1 chat')));
  assert(receipt.homeProjects.some((text) => text.includes('Viking') && text.includes('2 chats')));
  receipt.outcome = 'passed';
} catch (error) {
  receipt.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, 'evidence.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}
console.log(JSON.stringify(receipt));
