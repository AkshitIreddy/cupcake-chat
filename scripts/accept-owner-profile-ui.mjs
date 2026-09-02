#!/usr/bin/env node
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
  option('--profile', join(process.env.APPDATA ?? '', 'com.cupcakeagi.desktop', 'runtime')),
);
const output = resolve(
  option('--output', join('artifacts', 'screenshots', 'owner-profile-acceptance')),
);
const webviewData = resolve(
  option('--webview-data', 'E:/temp/CupcakeAI/qa/owner-profile-webview2'),
);
const port = Number(option('--port', '10051'));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('--port must be a non-privileged TCP port');
}

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
let diagnostics = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-32_768);
  });
}

let browser;
const browserErrors = [];
const result = {
  unlocked: false,
  workspaceReady: false,
  runtimeStatus: null,
  visibleError: null,
  settingsIcon: null,
  browserErrors,
};
try {
  await waitForDevtools(port, child, 90_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitForPage(browser, 30_000);
  page.on('pageerror', (error) => browserErrors.push(sanitize(error.message)));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(sanitize(message.text()));
  });
  await page.screenshot({ path: join(output, 'owner-profile-before-unlock.png') });
  const passwordInputs = page.locator('input[type="password"]');
  const passwordInput = passwordInputs.first();
  try {
    await passwordInput.waitFor({ timeout: 30_000 });
  } catch (error) {
    const snapshot = {
      url: page.url(),
      title: await page.title().catch(() => ''),
      body: sanitize(
        await page
          .locator('body')
          .innerText()
          .catch(() => ''),
      ),
    };
    throw new Error(`Password field did not appear: ${JSON.stringify(snapshot)}; ${error}`, {
      cause: error,
    });
  }
  await passwordInput.fill(password.toString('utf8'));
  if ((await passwordInputs.count()) > 1) {
    await passwordInputs.nth(1).fill(password.toString('utf8'));
  }
  password.fill(0);
  await page.getByRole('button', { name: /Unlock workspace|Create password and open/ }).click();

  const ready = page.locator('.home-hero').filter({ hasText: 'Your workbench is ready' });
  const failure = page.locator('[role="alert"]').first();
  await Promise.race([
    ready.waitFor({ timeout: 240_000 }),
    failure.waitFor({ timeout: 240_000 }),
  ]).catch(() => undefined);
  const lockState = await page
    .evaluate(() => globalThis.window.cupcake?.workspace.status())
    .catch(() => null);
  result.unlocked = lockState?.state === 'unlocked';
  result.workspaceReady = await ready.isVisible().catch(() => false);
  result.visibleError = await failure
    .innerText()
    .then(sanitize)
    .catch(() => null);
  result.runtimeStatus = await page
    .evaluate(() => globalThis.window.cupcake?.runtime.status())
    .catch((error) => ({ probeError: sanitize(String(error)) }));
  await page.screenshot({ path: join(output, 'owner-profile-after-unlock.png') });

  if (result.workspaceReady) {
    const button = page.getByRole('button', { name: 'Settings', exact: true });
    const svg = button.locator('svg');
    if ((await svg.count()) > 0) {
      await svg.screenshot({ path: join(output, 'settings-icon.png') });
      result.settingsIcon = {
        box: await svg.boundingBox(),
        viewBox: await svg.getAttribute('viewBox'),
        paths: await svg
          .locator('path')
          .evaluateAll((items) => items.map((item) => item.getAttribute('d'))),
      };
    }
  }
} finally {
  password.fill(0);
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10_000)),
  ]);
}

if (!result.workspaceReady) {
  const safeDiagnostics = sanitize(diagnostics);
  throw new Error(
    `Owner-profile UI did not reach the workbench: ${JSON.stringify(result)}; diagnostics=${safeDiagnostics || 'empty'}`,
  );
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function waitForDevtools(debugPort, processHandle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`CupcakeAI exited before WebView2 was ready (${processHandle.exitCode})`);
    }
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) return;
    } catch {
      // The hidden WebView2 endpoint is not ready yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('CupcakeAI did not expose its hidden WebView2 debugging endpoint');
}

async function waitForPage(connectedBrowser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = connectedBrowser.contexts().flatMap((context) => context.pages());
    const page =
      pages.find((candidate) => /tauri\.localhost|https?:\/\/localhost/iu.test(candidate.url())) ??
      pages.find((candidate) => candidate.url() !== 'about:blank');
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
