#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:42620';
const output = resolve(process.argv[3] ?? 'artifacts/screenshots');
const widths = [360, 768, 1024, 1440, 1920];
const themes = ['light', 'dark', 'minimal', 'classic'];
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

async function open(path) {
  await page.goto(`${baseURL}${path}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
}

async function full(name) {
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: false });
}

async function assertViewport(name) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: innerHeight,
  }));
  if (metrics.scrollWidth > metrics.clientWidth) {
    throw new Error(`${name} overflows horizontally: ${JSON.stringify(metrics)}`);
  }
  const composer = await page.locator('.chat-composer-wrap').boundingBox();
  if (!composer || composer.y + composer.height > metrics.height + 1) {
    throw new Error(`${name} composer is clipped: ${JSON.stringify({ composer, metrics })}`);
  }
}

for (const theme of themes) {
  for (const width of widths) {
    const height = width <= 480 ? 844 : width >= 1800 ? 1080 : 900;
    await page.setViewportSize({ width, height });
    await open(`/?view=chat&theme=${theme}`);
    await assertViewport(`chat-${theme}-${width}`);
    await full(`chat-${theme}-${width}x${height}`);
  }
}

// Semantic close-ups at the primary desktop width cover the visible chat
// workbench at readable scale before the full-frame composition is reviewed.
await page.setViewportSize({ width: 1440, height: 900 });
await open('/?view=chat&theme=light');
await page.locator('.shelf').screenshot({ path: join(output, 'chat-closeup-shelf.png') });
await page.locator('.chat-header').screenshot({ path: join(output, 'chat-closeup-header.png') });
await page.locator('#turn-user-1').screenshot({ path: join(output, 'chat-closeup-request.png') });
await page.locator('#turn-answer').screenshot({ path: join(output, 'chat-closeup-answer.png') });
await page.evaluate(() =>
  document.getElementById('turn-answer')?.scrollIntoView({ block: 'start', behavior: 'instant' }),
);
await full('chat-light-1440-answer-navigation');
await open('/?view=chat&theme=light');
await page
  .locator('.chat-composer-wrap')
  .screenshot({ path: join(output, 'chat-closeup-composer.png') });
await page.getByRole('button', { name: /Context/ }).click();
await page.locator('.context-panel').screenshot({ path: join(output, 'chat-closeup-context.png') });
await full('chat-light-1440-context');

await open('/?view=home&theme=light');
await full('home-light-1440x900');
await open('/?view=settings&theme=light');
await full('settings-light-1440x900');
await open('/?view=about&theme=light');
await full('about-light-1440x900');

await browser.close();
if (errors.length) throw new Error(`Renderer errors:\n${errors.join('\n')}`);
process.stdout.write(
  `Captured ${themes.length} themes × ${widths.length} required widths plus semantic close-ups in ${output}.\n`,
);
