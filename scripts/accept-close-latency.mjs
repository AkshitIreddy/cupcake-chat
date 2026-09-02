#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
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
const profile = resolve(option('--profile', join('out', 'tauri-test-profiles', 'close-latency')));
const webviewData = resolve(
  option('--webview-data', 'E:/temp/CupcakeAI/qa/close-latency-webview2'),
);
const port = Number(option('--port', '10071'));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('--port must be a non-privileged TCP port');
}

const input = createInterface({ input: process.stdin, terminal: false });
const passwordLine = await input.question('');
input.close();
const password = Buffer.from(passwordLine, 'utf8');
if (!password.length) throw new Error('Read the workspace password from stdin');

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
  stdio: 'ignore',
});

let browser;
try {
  await waitForDevtools(port, child, 90_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitForPage(browser, 30_000);
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ timeout: 30_000 });
  await passwordInput.fill(password.toString('utf8'));
  password.fill(0);
  await page.getByRole('button', { name: 'Unlock workspace' }).click();
  await page.getByRole('button', { name: 'Close window' }).waitFor({ timeout: 180_000 });
  const closePromptsBefore = await page.getByText(/What should closing do|Close CupcakeAI/).count();
  const exitPromise = new Promise((resolveExit) => child.once('exit', () => resolveExit(true)));
  const started = performance.now();
  await page.getByRole('button', { name: 'Close window' }).click();
  const exited = await Promise.race([
    exitPromise,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  const closeMs = Math.round(performance.now() - started);
  if (!exited) throw new Error(`CupcakeAI did not exit within 5 seconds (${closeMs} ms)`);
  if (closePromptsBefore !== 0) throw new Error('A close-confirmation prompt was already visible');
  process.stdout.write(`${JSON.stringify({ closeMs, exited, closePrompt: false }, null, 2)}\n`);
} finally {
  password.fill(0);
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null) child.kill();
}

async function waitForDevtools(debugPort, processHandle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error('CupcakeAI exited before WebView2 opened');
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) return;
    } catch {
      // Hidden WebView2 is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('CupcakeAI did not expose its hidden WebView2 debugging endpoint');
}

async function waitForPage(connectedBrowser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = connectedBrowser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() !== 'about:blank');
    if (page) return page;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('CupcakeAI did not expose its production renderer');
}
