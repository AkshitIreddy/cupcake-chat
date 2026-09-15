#!/usr/bin/env node
/* global window, document */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import {
  installReplayTransport,
  armReplay,
  startReplay,
  feedReplay,
  completeReplay,
} from './demo-chat-transport.mjs';

const require = createRequire('E:/temp/cupcake-gifsmith/package.json');
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:10131',
  defaultViewport: null,
});
const page = (await browser.pages()).find((p) => p.url().includes('tauri.localhost'));
const output = 'E:/temp/cupcake-chat-demo-refresh-20260916';
const checks = [];
const request = (method, params = {}) =>
  page.evaluate(
    async ({ method, params }) => {
      const response = await window.cupcake.runtime.request({ method, params });
      if (!response.ok) throw Error(response.error?.message);
      return response.result;
    },
    { method, params },
  );
const value = () => page.$eval('textarea[aria-label="Message Cupcake"]', (node) => node.value);
const fresh = async () => {
  await page.click('button.new-chat');
  await page.waitForFunction(
    () =>
      !document.querySelector('.turn--user') &&
      document.querySelector('.chat-header h1')?.textContent.trim() === 'New conversation',
  );
};
try {
  await mkdir(output, { recursive: true });
  await request('models.select', { modelId: 'google:gemini-3.8-flash' });
  await page.reload();
  await page.waitForSelector('button.new-chat');
  await fresh();
  assert.equal(await page.$('.conversation .empty-state'), null);
  assert.equal(await page.$eval('.conversation', (node) => node.textContent.trim()), '');
  await page.screenshot({ path: `${output}/empty-chat.png` });
  checks.push('Empty chat has no starter panel');
  const conversation = await request('conversations.get', {
    conversationId: '01a0a20e-7101-7b4c-b188-2b24e95cb120',
  });
  const history = await request('chat.history', { branchId: conversation.activeBranchId });
  const source = {
    user: history.find((m) => m.role === 'user'),
    assistant: history.find((m) => m.role === 'assistant'),
    routeId: 'google:gemini-3.8-flash',
  };
  await installReplayTransport(page);
  await armReplay(page, source);
  await page.type('textarea[aria-label="Message Cupcake"]', source.user.content);
  await page.waitForSelector('button[aria-label="Send message"]:not(:disabled)');
  await page.click('button[aria-label="Send message"]');
  await startReplay(page);
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="Message Cupcake"]').value === '',
  );
  checks.push('Composer clears while send promise is pending');
  await page.type('textarea[aria-label="Message Cupcake"]', 'What about their horses?');
  await feedReplay(page, source.assistant.content);
  await completeReplay(page);
  assert.equal(await value(), 'What about their horses?');
  checks.push('Completing a response preserves a newly typed follow-up');
  await page.evaluate(() => window.__cupcakeTransportReplay.cleanup());
  await page.reload();
  await page.waitForSelector('button.new-chat');
  await fresh();
  await page.evaluate(() => {
    const native = window.cupcake.runtime.request;
    window.__restoreSendProbe = () => {
      window.cupcake.runtime.request = native;
    };
    window.cupcake.runtime.request = (request) =>
      request.method === 'chat.send'
        ? new Promise((resolve) => {
            window.__failSendProbe = () =>
              resolve({
                ok: false,
                error: {
                  code: 'PROVIDER_ERROR',
                  message: 'Intentional send failure for local regression check',
                },
              });
          })
        : native(request);
  });
  await page.type('textarea[aria-label="Message Cupcake"]', 'A draft to recover');
  await page.waitForSelector('button[aria-label="Send message"]:not(:disabled)');
  await page.click('button[aria-label="Send message"]');
  await page.waitForFunction(() => Boolean(window.__failSendProbe));
  assert.equal(await value(), '');
  await page.evaluate(() => window.__failSendProbe());
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="Message Cupcake"]').value ===
      'A draft to recover',
  );
  checks.push('Failed send restores the draft');
  await page.evaluate(() => window.__restoreSendProbe());
  await page.reload();
  await page.waitForSelector('button.new-chat');
  await fresh();
  await writeFile(
    `${output}/chat-behavior.json`,
    JSON.stringify({ checks, passed: true }, null, 2),
  );
  console.log(JSON.stringify({ checks, passed: true }));
} finally {
  await page
    .evaluate(() => {
      window.__cupcakeTransportReplay?.cleanup();
      window.__restoreSendProbe?.();
    })
    .catch(() => {});
  await browser.disconnect();
}
