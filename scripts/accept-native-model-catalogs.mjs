#!/usr/bin/env node
import { acquireWorkspaceLock, workPath } from './lib/workspace.mjs';
if (!process.argv.includes('--self-test'))
  await acquireWorkspaceLock('accept-native-model-catalogs');

/* global document, fetch */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const executable = resolve(
  option(
    '--executable',
    join('apps', 'desktop', 'src-tauri', 'target', 'release', 'CupcakeAI.exe'),
  ),
);
const profile = resolve(
  option('--profile', join(process.env.APPDATA ?? '', 'com.cupcakeagi.desktop')),
);
const output = resolve(
  option('--output', join('artifacts', 'screenshots', 'native-model-catalogs')),
);
const webviewData = resolve(option('--webview-data', workPath('qa/native-model-catalogs')));
const port = Number(option('--port', '10058'));
const catalogTimeout = Number(option('--catalog-timeout', '120000'));

const input = createInterface({ input: process.stdin, terminal: false });
const passwordLine = await input.question('');
input.close();
const password = Buffer.from(passwordLine, 'utf8');
if (!password.length) throw new Error('Read the workspace password from stdin');

await mkdir(output, { recursive: true });
await mkdir(webviewData, { recursive: true });
const child = spawn(executable, [], {
  env: {
    ...process.env,
    CUPCAKE_TEST_DATA_DIR: profile,
    CUPCAKE_TEST_HEADLESS: '1',
    WEBVIEW2_USER_DATA_FOLDER: webviewData,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const processStartedAt = Date.now();

let browser;
let page;
const errors = [];
try {
  await waitForDevtools(port, child, 90_000);
  const devtoolsReadyAt = Date.now();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await waitForPage(browser, 30_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ timeout: 30_000 });
  await passwordInput.fill(password.toString('utf8'));
  password.fill(0);
  const unlockClickedAt = Date.now();
  await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  const openingCard = page.locator('.workspace-opening__card');
  await openingCard.waitFor({ timeout: 30_000 });
  const openingVisibleAt = Date.now();
  const openingGeometry = await openingCard.evaluate((element) => {
    const card = element.getBoundingClientRect();
    const host = document.querySelector('.app-content')?.getBoundingClientRect();
    return {
      offsetX: host ? card.left + card.width / 2 - (host.left + host.width / 2) : null,
      offsetY: host ? card.top + card.height / 2 - (host.top + host.height / 2) : null,
    };
  });
  if (
    openingGeometry.offsetX === null ||
    openingGeometry.offsetY === null ||
    Math.abs(openingGeometry.offsetX) > 8 ||
    Math.abs(openingGeometry.offsetY) > 8
  ) {
    throw new Error(`Opening card is not centered: ${JSON.stringify(openingGeometry)}`);
  }
  await page.screenshot({ path: join(output, 'native-opening-centered.png') });
  await page.locator('.home-hero').waitFor({ timeout: 240_000 });
  const homeVisibleAt = Date.now();
  const skipOnboarding = page.getByRole('button', { name: 'Skip onboarding', exact: true });
  await skipOnboarding.waitFor({ timeout: 45_000 }).catch(() => undefined);
  if (await skipOnboarding.isVisible().catch(() => false)) await skipOnboarding.click();
  await page.locator('[data-tour="models"]').click();
  await page.locator('.models-page').waitFor({ timeout: 30_000 });

  const catalogSummary = page.locator('.model-catalog-summary');
  await catalogSummary.waitFor({ timeout: catalogTimeout });
  await page.waitForFunction(
    () =>
      /\d+ account-discoverable NIM chat candidates/u.test(
        document.querySelector('.model-catalog-summary')?.textContent ?? '',
      ) &&
      /\d+ Hugging Face GGUF results/u.test(
        document.querySelector('.model-catalog-summary')?.textContent ?? '',
      ),
    undefined,
    { timeout: catalogTimeout },
  );

  const summaryText = (await catalogSummary.innerText()).trim();
  const result = {
    opening: openingGeometry,
    timingsMs: {
      processToDevtools: devtoolsReadyAt - processStartedAt,
      unlockToOpening: openingVisibleAt - unlockClickedAt,
      unlockToInteractive: homeVisibleAt - unlockClickedAt,
    },
    catalogSummary: summaryText,
    modelCards: await page.locator('.model-card').count(),
    errors: errors.map(sanitize),
  };
  await page.screenshot({ path: join(output, 'native-models-nim.png') });
  if (result.errors.length) throw new Error(`Browser errors: ${JSON.stringify(result.errors)}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const diagnostics = page
    ? {
        url: page.url(),
        body: sanitize(
          await page
            .locator('body')
            .innerText()
            .catch(() => ''),
        ),
        providers: await page
          .evaluate(() =>
            globalThis.window.cupcake?.runtime.request({ method: 'providers.status', params: {} }),
          )
          .catch((reason) => ({ probeError: sanitize(reason) })),
        errors: errors.map(sanitize),
      }
    : { errors: errors.map(sanitize) };
  await page
    ?.screenshot({ path: join(output, 'native-models-failure.png') })
    .catch(() => undefined);
  throw new Error(`${error}; diagnostics=${JSON.stringify(diagnostics)}`, { cause: error });
} finally {
  password.fill(0);
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10_000)),
  ]);
}

async function waitForDevtools(debugPort, processHandle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null)
      throw new Error('CupcakeAI exited before WebView2 was ready');
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) return;
    } catch {
      // The hidden WebView2 endpoint is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('CupcakeAI did not expose its hidden WebView2 debugging endpoint');
}

async function waitForPage(connectedBrowser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = connectedBrowser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url() !== 'about:blank');
    if (page) return page;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('CupcakeAI did not expose its production renderer');
}

function sanitize(value) {
  return String(value)
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, '[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(-2000);
}
