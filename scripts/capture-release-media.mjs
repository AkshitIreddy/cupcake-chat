#!/usr/bin/env node
/** Capture the already-running packaged recording profile, without fixtures or zoom. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';

const output = resolve('docs/media');
const browser = await chromium.connectOverCDP('http://127.0.0.1:10131');
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((item) => item.url().startsWith('https://tauri.localhost'));
assert(page, 'Start the packaged recording profile first');
const runtime = (method, params = {}) =>
  page.evaluate(
    async ({ method, params }) => {
      const response = await globalThis.window.cupcake.runtime.request({
        method,
        params,
        timeoutMs: 120000,
      });
      if (!response.ok) throw new Error(response.error?.message ?? method);
      return response.result;
    },
    { method, params },
  );
const nav = (name) =>
  page.locator('.shelf__nav').getByRole('button', { name, exact: true }).click();
const project = async (name) => {
  await nav('Projects');
  await page.locator('.project-card__select').filter({ hasText: name }).click();
};
const appearance = async (label, id) => {
  await nav('Settings');
  await page
    .locator('.settings-layout aside')
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  await page.locator('.theme-grid button').filter({ hasText: 'Minimal' }).click();
  await page.locator('.wallpaper-grid button').filter({ hasText: label }).click();
  await page.waitForFunction(
    (id) => globalThis.document.querySelector('.app-shell')?.getAttribute('data-wallpaper') === id,
    id,
  );
};
const receipt = { createdAt: new Date().toISOString(), screenshots: [] };
const capture = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(output, name), animations: 'disabled' });
  receipt.screenshots.push({
    name,
    wallpaper: await page.locator('.app-shell').getAttribute('data-wallpaper'),
  });
};
try {
  const identity = await page.evaluate(() => globalThis.window.cupcake.app.getInfo());
  assert(identity.packaged && identity.appVersion === '1.8.0');
  await mkdir(output, { recursive: true });
  await appearance('Cherry lacquer atelier', 'cherry-lacquer-atelier');
  await project('Anime rabbit holes');
  await nav('Chats');
  const chats = await runtime('conversations.list', {
    projectId: '01a0a167-b7d8-7e57-b2c9-6c7ce3f287e4',
    includeArchived: false,
    limit: 500,
  });
  const madara = chats.find((chat) => /madara|rinnegan|nagato/i.test(chat.title));
  assert(madara, 'Record the real Madara conversation first');
  await page.locator('.chat-list__main').filter({ hasText: madara.title }).click();
  await page.locator('.turn--assistant').first().waitFor();
  await page.locator('.conversation-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await capture('cupcake-chat-chat-cherry-lacquer.png');

  await appearance('Burgundy cinema lounge', 'burgundy-cinema-lounge');
  await project('Neighborhood Repair Cafe');
  await nav('Chats');
  await page
    .locator('.chat-list__main')
    .filter({ hasText: 'Thirty-six broken things, one Saturday' })
    .click();
  await page.locator('.turn--assistant').first().waitFor();
  await page.locator('.conversation-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await capture('cupcake-chat-group-burgundy-cinema.png');

  await appearance('Tidepool library', 'aquamarine-tidepool-library');
  await nav('Models');
  await page.locator('.model-atlas-hero').waitFor();
  await capture('cupcake-chat-models-tidepool.png');

  await appearance('Pistachio atelier', 'pistachio-atelier');
  await project('Anime rabbit holes');
  await nav('Artifacts');
  await page
    .getByRole('button', { name: 'Show artifacts from Anime rabbit holes', exact: true })
    .click();
  await page.locator('.artifact-list__item').filter({ hasText: 'ODM toy physics.py' }).click();
  await page.locator('.document-preview').waitFor();
  await capture('cupcake-chat-artifacts-pistachio.png');
  receipt.identity = identity;
  await writeFile(
    'E:/temp/cupcake-release-1.8-20260915/readme-media.json',
    JSON.stringify(receipt, null, 2),
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await browser.close();
}
