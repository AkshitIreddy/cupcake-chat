#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const repo = resolve(import.meta.dirname, '..');
const desktop = join(repo, 'apps', 'desktop');
const cssPath = join(desktop, 'src', 'renderer', 'styles-living-motion.css');
const vitePath = join(repo, 'node_modules', 'vite', 'bin', 'vite.js');
const output = resolve(
  process.argv.includes('--output')
    ? process.argv[process.argv.indexOf('--output') + 1]
    : 'E:/temp/cupcake-chat-rebrand-20260915/living-motion-fixture',
);
const port = Number(
  process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '42629',
);
const url = `http://127.0.0.1:${port}/?theme=light`;

if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('--port must be a non-privileged TCP port');
}

await mkdir(output, { recursive: true });
const receipt = {
  generatedAt: new Date().toISOString(),
  fixtureUrl: url,
  cssPath,
  viewport: { width: 1440, height: 920 },
  checks: [],
  failures: [],
  screenshots: [],
};

const server = spawn(
  process.execPath,
  [vitePath, '--config', 'vite.renderer.config.ts', '--host', '127.0.0.1', '--port', String(port)],
  {
    cwd: desktop,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverLog = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    serverLog = `${serverLog}${chunk}`.slice(-16_384);
  });
}

let browser;
try {
  await waitForServer(url, server, 60_000);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: receipt.viewport,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.locator('.app-shell').waitFor();
  await page.addStyleTag({ path: cssPath });

  const initial = await motionStyle(
    page.locator('.app-content > main, .app-content > .chat-layout').first(),
  );
  check(
    'view-arrival-is-integrated',
    initial.animationNames.includes('living-view-arrive'),
    initial,
  );

  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const projectsMain = page.locator('.app-content > main').first();
  const viewFrames = await sampleStyles(projectsMain, [0, 90, 320]);
  check(
    'view-arrival-settles-once',
    viewFrames[0].animationNames.includes('living-view-arrive') &&
      viewFrames.at(-1).opacity >= 0.99 &&
      nearIdentity(viewFrames.at(-1).transform),
    viewFrames,
  );
  await capture(page, '01-project-view-settled.png');

  const projectCard = page.locator('.project-card--workbench').first();
  const cardBefore = await motionStyle(projectCard);
  await projectCard.hover();
  await page.waitForTimeout(110);
  const cardHover = await motionStyle(projectCard);
  check(
    'card-hover-is-subtle-and-responsive',
    cardBefore.transform !== cardHover.transform && cardHover.transitionDurationMs <= 200,
    { before: cardBefore, hover: cardHover },
  );
  await capture(page, '02-project-card-hover.png');

  await page.getByRole('button', { name: 'Open command palette', exact: true }).click();
  const palette = page.locator('.command-palette');
  const backdrop = page.locator('.command-layer');
  const dialogFrames = await sampleStyles(palette, [0, 90, 290]);
  const backdropStyle = await motionStyle(backdrop);
  check(
    'dialog-and-backdrop-enter-together',
    dialogFrames[0].animationNames.includes('living-sheet-in') &&
      backdropStyle.animationNames.includes('living-backdrop-in') &&
      nearIdentity(dialogFrames.at(-1).transform),
    { dialogFrames, backdropStyle },
  );
  await capture(page, '03-command-palette-settled.png');
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'detached' });

  await page.locator('.new-chat').click();
  const fixtureConversation = page.locator(
    '.conversation[aria-label="Deterministic fixture conversation"]',
  );
  await fixtureConversation.evaluate((conversation) => {
    conversation.classList.add('live-conversation');
    const source = conversation.querySelector('#turn-answer');
    if (!(source instanceof globalThis.HTMLElement)) {
      throw new Error('Fixture answer was unavailable for the arrival probe.');
    }
    const next = source.cloneNode(true);
    if (!(next instanceof globalThis.HTMLElement)) return;
    next.id = 'turn-motion-probe';
    const response = next.querySelector('.rich-response');
    if (response instanceof globalThis.HTMLElement) {
      const text = globalThis.document.createElement('p');
      text.textContent = 'A calm next step, arriving without stealing focus.';
      response.replaceChildren(text);
    }
    next.querySelector('.message-footer')?.remove();
    conversation.append(next);
  });
  const latestTurn = page.locator('.live-conversation #turn-motion-probe');
  await latestTurn.waitFor();
  const turnFrames = await sampleStyles(latestTurn, [0, 90, 360]);
  check(
    'latest-message-arrives-once-and-settles',
    turnFrames[0].animationNames.includes('living-turn-arrive') &&
      turnFrames.at(-1).opacity >= 0.99 &&
      nearIdentity(turnFrames.at(-1).transform),
    turnFrames,
  );
  await latestTurn.scrollIntoViewIfNeeded();
  await setAnimationTime(latestTurn, 'living-turn-arrive', 0);
  await capture(page, '04a-message-arrival-start.png');
  await setAnimationTime(latestTurn, 'living-turn-arrive', 90);
  await capture(page, '04b-message-arrival-mid.png');
  await setAnimationTime(latestTurn, 'living-turn-arrive', 320);
  await capture(page, '04c-message-arrival-settled.png');

  await latestTurn
    .locator('.rich-response')
    .evaluate((node) => node.classList.add('streaming-message'));
  const activity = await latestTurn.locator('.thread-node').evaluate((node) => {
    const ring = globalThis.getComputedStyle(node, '::after');
    const portrait = node.querySelector('.cupcake-portrait');
    return {
      ringAnimation: ring.animationName,
      ringDuration: ring.animationDuration,
      portraitAnimation: portrait ? globalThis.getComputedStyle(portrait).animationName : null,
    };
  });
  check(
    'cupcake-activity-only-while-streaming',
    activity.ringAnimation.includes('living-cupcake-thinking') &&
      activity.portraitAnimation?.includes('living-cupcake-nod'),
    activity,
  );
  await capture(page, '05-cupcake-streaming-activity.png');
  await latestTurn
    .locator('.rich-response')
    .evaluate((node) => node.classList.remove('streaming-message'));
  const inactiveRing = await latestTurn
    .locator('.thread-node')
    .evaluate((node) => globalThis.getComputedStyle(node, '::after').animationName);
  check('cupcake-activity-stops-with-stream', inactiveRing === 'none', { inactiveRing });

  await page.getByRole('button', { name: 'Add Cupcake', exact: true }).click();
  const cupcakeDialog = page.getByTestId('add-cupcake-dialog');
  const cupcakeDialogFrames = await sampleStyles(cupcakeDialog, [0, 90, 290]);
  check(
    'cupcake-dialog-uses-shared-settle',
    cupcakeDialogFrames[0].animationNames.includes('living-sheet-in') &&
      nearIdentity(cupcakeDialogFrames.at(-1).transform),
    cupcakeDialogFrames,
  );
  await capture(page, '06-add-cupcake-dialog.png');
  await page.getByRole('button', { name: 'Close Add Cupcake', exact: true }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const darkTheme = page.locator('.theme-card--dark');
  await darkTheme.click();
  const themeSample = await motionStyle(darkTheme.locator('.theme-sample'));
  check(
    'theme-selection-acknowledges-once',
    themeSample.animationNames.includes('living-choice-settle') &&
      themeSample.animationIterations === 1,
    themeSample,
  );
  await page.waitForTimeout(180);
  await capture(page, '07-theme-selection.png');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const reducedSystem = await motionStyle(page.locator('.app-content > main').first());
  check(
    'system-reduced-motion-disables-arrivals',
    reducedSystem.animationNames.every((name) => name === 'none') ||
      reducedSystem.animationDurationMs <= 0.001,
    reducedSystem,
  );

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    globalThis.document.documentElement.dataset.reducedMotion = 'true';
  });
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  const reducedSetting = await motionStyle(page.locator('.app-content > main').first());
  check(
    'app-reduced-motion-setting-disables-arrivals',
    reducedSetting.animationNames.every((name) => name === 'none') ||
      reducedSetting.animationDurationMs <= 0.001,
    reducedSetting,
  );
  await capture(page, '08-reduced-motion-still.png');
} catch (error) {
  receipt.failures.push({
    name: 'probe-error',
    message: sanitize(error instanceof Error ? error.stack || error.message : error),
  });
} finally {
  receipt.passed = receipt.failures.length === 0;
  receipt.serverLog = sanitize(serverLog);
  await writeFile(
    resolve(output, 'living-motion-verification.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  await browser?.close().catch(() => undefined);
  if (server.exitCode === null) server.kill();
  await Promise.race([
    new Promise((resolveExit) => server.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000)),
  ]);
}

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!receipt.passed) process.exitCode = 1;

async function sampleStyles(locator, delays) {
  const frames = [];
  let elapsed = 0;
  for (const delay of delays) {
    await locator.waitFor();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, delay - elapsed)));
    elapsed = delay;
    frames.push({ elapsedMs: delay, ...(await motionStyle(locator)) });
  }
  return frames;
}

async function motionStyle(locator) {
  return locator.evaluate((node) => {
    const style = globalThis.getComputedStyle(node);
    const durations = style.animationDuration
      .split(',')
      .map((value) => seconds(value.trim()) * 1000);
    const transitions = style.transitionDuration
      .split(',')
      .map((value) => seconds(value.trim()) * 1000);
    return {
      animationNames: style.animationName.split(',').map((value) => value.trim()),
      animationDurationMs: Math.max(...durations),
      animationIterations: Number.parseFloat(style.animationIterationCount) || 1,
      transitionDurationMs: Math.max(...transitions),
      opacity: Number.parseFloat(style.opacity),
      transform: style.transform,
    };

    function seconds(value) {
      if (value.endsWith('ms')) return Number.parseFloat(value) / 1000;
      return Number.parseFloat(value) || 0;
    }
  });
}

async function setAnimationTime(locator, animationName, currentTime) {
  await locator.evaluate(
    (node, frame) => {
      const animation = node
        .getAnimations()
        .find((candidate) => candidate.animationName === frame.animationName);
      if (!animation) throw new Error(`Animation ${frame.animationName} was unavailable.`);
      animation.pause();
      animation.currentTime = frame.currentTime;
    },
    { animationName, currentTime },
  );
}

async function capture(page, name) {
  const path = resolve(output, name);
  await page.screenshot({ path });
  receipt.screenshots.push(path);
}

function check(name, passed, evidence) {
  const item = { name, passed: Boolean(passed), evidence };
  receipt.checks.push(item);
  if (!passed) receipt.failures.push(item);
}

function nearIdentity(transform) {
  return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
}

async function waitForServer(target, processHandle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Fixture server exited early (${processHandle.exitCode})`);
    }
    try {
      const response = await globalThis.fetch(target);
      if (response.ok) return;
    } catch {
      // The hidden fixture server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Timed out waiting for the hidden fixture server');
}

function sanitize(value) {
  return String(value)
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, '[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(-3000);
}
