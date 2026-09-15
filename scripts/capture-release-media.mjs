#!/usr/bin/env node
import { acquireWorkspaceLock, workPath } from './lib/workspace.mjs';
if (!process.argv.includes('--self-test')) await acquireWorkspaceLock('capture-release-media');

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
const nav = (name) => page.locator('.shelf').getByRole('button', { name, exact: true }).click();
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
  await page.locator('.theme-grid button').filter({ hasText: 'Cupcake Light' }).click();
  await page.locator('.wallpaper-grid button').filter({ hasText: label }).click();
  await page.waitForFunction(
    (id) => globalThis.document.querySelector('.app-shell')?.getAttribute('data-wallpaper') === id,
    id,
  );
};
const receipt = { createdAt: new Date().toISOString(), screenshots: [] };
const capture = async (name) => {
  await page.locator('.app-content').evaluate((element) => {
    element.scrollTop = 0;
  });
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
  const allRecent = page
    .locator('.shelf')
    .getByRole('button', { name: 'Show all chats in sidebar' });
  if ((await allRecent.getAttribute('aria-pressed')) !== 'true') await allRecent.click();
  await appearance('Roman cupcake camp', 'history-roman-camp');
  await project('Rome beyond the battlefield');
  await nav('Chats');
  const chats = await runtime('conversations.list', {
    projectId: '01a0a1f1-3cfe-77e3-9074-da159fbc8b2f',
    includeArchived: false,
    limit: 500,
  });
  const featured = chats.find((chat) => chat.title === 'How did Rome keep an army fed?');
  assert(featured, 'Prepare the real history conversation first');
  await page.locator('.chat-list__main').filter({ hasText: featured.title }).click();
  await page.locator('.turn--assistant').first().waitFor();
  await page.locator('.conversation-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await capture('cupcake-chat-roman.png');

  await appearance('Rose castle garden', 'history-medieval-garden');
  await project('Rome beyond the battlefield');
  await nav('Chats');
  await page
    .locator('.chat-list__main')
    .filter({ hasText: 'Winning battles, losing the war' })
    .click();
  await page.locator('.turn--assistant').first().waitFor();
  await page.locator('.conversation-scroll').evaluate((element) => {
    const assistant = element.querySelector('.turn--assistant');
    element.scrollTop +=
      assistant.getBoundingClientRect().top - element.getBoundingClientRect().top - 12;
  });
  await capture('cupcake-chat-group-rose.png');

  await appearance('Viking cupcake fjord', 'history-viking-fjord');
  await nav('Models');
  await page.locator('.model-atlas-hero').waitFor();
  await capture('cupcake-chat-models-viking.png');

  await appearance('Aegean cupcake harbor', 'history-greek-harbor');
  await project('Rome beyond the battlefield');
  await nav('Artifacts');
  await page
    .getByRole('button', { name: 'Show artifacts from Rome beyond the battlefield', exact: true })
    .click();
  await page.locator('.artifact-list__item').filter({ hasText: 'Siege supplies.py' }).click();
  await page.getByPlaceholder('Find in this project', { exact: true }).fill('Siege');
  await page.locator('.document-preview').waitFor();
  await capture('cupcake-chat-artifacts-greek.png');
  await appearance('Nile cupcake landing', 'history-egyptian-nile');
  await nav('Tools');
  await page
    .locator('.toolbar')
    .getByRole('button', { name: 'History workshop', exact: true })
    .click();
  await page
    .locator('.history-era-tabs')
    .getByRole('button', { name: 'Egypt', exact: true })
    .click();
  await page.locator('.history-heading').scrollIntoViewIfNeeded();
  await page.locator('.app-content').evaluate((e) => {
    const h = e.querySelector('.history-heading');
    e.scrollTop += h.getBoundingClientRect().top - e.getBoundingClientRect().top - 94;
  });
  await page.waitForTimeout(600);
  await page.screenshot({
    path: join(output, 'cupcake-chat-workshop-egypt.png'),
    animations: 'disabled',
  });
  receipt.screenshots.push({
    name: 'cupcake-chat-workshop-egypt.png',
    wallpaper: 'history-egyptian-nile',
  });
  await appearance('Steppe cupcake camp', 'history-mongol-steppe');
  await nav('Chats');
  await page
    .locator('.chat-list__main')
    .filter({ hasText: 'Winning battles, losing the war' })
    .click();
  await page.locator('button.participant-add').click();
  await page.getByRole('combobox', { name: 'Advisor era' }).selectOption('mongol');
  await capture('cupcake-chat-advisors-mongol.png');
  await page.getByRole('button', { name: 'Close Add Cupcake' }).click();
  await appearance('Roman cupcake camp', 'history-roman-camp');
  await nav('Home');
  receipt.identity = identity;
  await writeFile(workPath('qa/release/readme-media.json'), JSON.stringify(receipt, null, 2));
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await browser.close();
}
