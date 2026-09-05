#!/usr/bin/env node
/* global document, innerHeight, innerWidth */
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const execFileAsync = promisify(execFile);
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
const profile = resolve(option('--profile', 'E:/temp/cupcakeai-owner-test-20260902'));
const output = resolve(option('--output', 'E:/temp/cupcake-overhaul-20260905/baseline'));
const webviewData = resolve(
  option('--webview-data', 'E:/temp/cupcake-overhaul-20260905/baseline-webview2'),
);
const port = Number(option('--port', '10105'));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('--port must be a non-privileged TCP port');
}

await mkdir(output, { recursive: true });
await mkdir(webviewData, { recursive: true });
const startedAt = performance.now();
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
let page;
let closedThroughUi = false;
const evidence = {
  executable,
  profile,
  output,
  pid: child.pid,
  timingsMs: {},
  viewport: null,
  screens: [],
  browserErrors: [],
  processTreeAtReady: [],
  finalOverflow: null,
  close: null,
};

try {
  await waitForDevtools(port, child, 90_000);
  evidence.timingsMs.processToDevtools = Math.round(performance.now() - startedAt);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await waitForPage(browser, 30_000);
  page.on('pageerror', (error) => evidence.browserErrors.push(sanitize(error.message)));
  page.on('console', (message) => {
    if (message.type() === 'error') evidence.browserErrors.push(sanitize(message.text()));
  });
  await page.evaluate(() => document.fonts.ready);
  evidence.viewport = await viewport(page);

  // Capture the first production-rendered frame before waiting for workspace readiness.
  await capture(page, '00-startup-opening', output, evidence, { closeups: true });
  const ready = page.locator('.home-hero');
  await ready.waitFor({ timeout: 240_000 });
  evidence.timingsMs.processToHome = Math.round(performance.now() - startedAt);
  evidence.processTreeAtReady = await processTree(child.pid);

  await dismissOnboarding(page, 2_000);

  await capture(page, '01-home', output, evidence, { closeups: true });
  await navigate(page, 'Chats');
  await capture(page, '02-chats', output, evidence, { closeups: true });

  // Avoid coupling the audit to async sidebar selection. The owner profile's
  // currently selected conversation is available directly through the routed
  // production renderer, without writing a new selection to product state.
  await page.goto('https://tauri.localhost/?view=chat', { waitUntil: 'domcontentloaded' });
  await page.locator('.chat-main').waitFor({ timeout: 180_000 });
  await dismissOnboarding(page, 1_000);
  await capture(page, '03-active-chat', output, evidence, { closeups: true });

  await navigate(page, 'Projects');
  await capture(page, '04-projects', output, evidence, { closeups: true });
  await navigate(page, 'Tasks');
  await capture(page, '05-tasks', output, evidence, { closeups: true });
  const firstTask = page.locator('.task-row').first();
  if (await firstTask.isVisible().catch(() => false)) {
    await firstTask.click();
    await capture(page, '06-task-detail', output, evidence, { closeups: true });
  }

  await navigate(page, 'Artifacts');
  await capture(page, '07-artifacts', output, evidence, { closeups: true });
  const revisions = page.getByRole('button', { name: 'Revisions', exact: true });
  if (await revisions.isVisible().catch(() => false)) {
    await revisions.click();
    await capture(page, '08-artifact-revisions', output, evidence, { closeups: true });
  }

  await navigate(page, 'Memory');
  await capture(page, '09-memory', output, evidence, { closeups: true });
  await navigate(page, 'Models');
  await page.locator('.models-page').waitFor({ timeout: 30_000 });
  await capture(page, '10-models-initial', output, evidence, { closeups: true });
  await page
    .waitForFunction(
      () =>
        !document.body.textContent?.includes('Refreshing…') ||
        document.querySelectorAll('.model-card').length > 0,
      undefined,
      { timeout: 180_000 },
    )
    .catch(() => undefined);
  await capture(page, '10-models-stable', output, evidence, { closeups: true });

  const filters = page.getByRole('button', { name: /Filters/u }).first();
  if (await filters.isVisible().catch(() => false)) {
    await filters.click();
    await capture(page, '11-models-filters', output, evidence, { closeups: true });
    await filters.click();
  }

  await page.keyboard.press('Control+M');
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await picker.waitFor({ timeout: 15_000 });
  await capture(page, '12-model-picker', output, evidence, { closeups: true, modal: picker });
  await page.keyboard.press('Escape');

  const install = page.getByRole('button', { name: 'Install', exact: true }).first();
  if (await install.isVisible().catch(() => false)) {
    await install.click();
    const installDialog = page
      .getByRole('dialog')
      .filter({ hasText: /Install|Model files/u })
      .last();
    if (await installDialog.isVisible().catch(() => false)) {
      await capture(page, '13-model-install-dialog', output, evidence, {
        closeups: true,
        modal: installDialog,
      });
      await page.keyboard.press('Escape');
    }
  }

  await navigate(page, 'Tools');
  await capture(page, '14-tools', output, evidence, { closeups: true });

  await page.getByRole('button', { name: /Search CupcakeAI/u }).click();
  await capture(page, '15-search', output, evidence, { closeups: true });

  await page.keyboard.press('Control+K');
  const commands = page.getByRole('dialog', { name: 'Command palette' });
  await commands.waitFor({ timeout: 15_000 });
  await capture(page, '16-command-palette', output, evidence, { closeups: true, modal: commands });
  await page.keyboard.press('Escape');

  await navigate(page, 'Settings');
  await page.locator('.settings-layout').waitFor({ timeout: 30_000 });
  await capture(page, '17-settings-personality', output, evidence, { closeups: true });
  for (const tab of [
    'General',
    'Profile',
    'Appearance',
    'Window',
    'Local models',
    'Privacy',
    'Providers',
    'Storage',
    'Shortcuts',
  ]) {
    if (
      !(await page
        .locator('.settings-layout')
        .isVisible()
        .catch(() => false))
    ) {
      await navigate(page, 'Settings');
      await page.locator('.settings-layout').waitFor({ timeout: 30_000 });
    }
    const tabButton = page.getByRole('button', { name: tab, exact: true }).first();
    if (await tabButton.isVisible().catch(() => false)) {
      await tabButton.click();
      await capture(page, `18-settings-${slug(tab)}`, output, evidence, { closeups: true });
    }
  }

  if (
    !(await page
      .locator('.settings-layout')
      .isVisible()
      .catch(() => false))
  ) {
    await navigate(page, 'Settings');
    await page.locator('.settings-layout').waitFor({ timeout: 30_000 });
  }
  const providersTab = page.getByRole('button', { name: 'Providers', exact: true }).first();
  await providersTab.click().catch(() => undefined);
  const openAiRow = page.locator('.provider-row').filter({ hasText: 'OpenAI' }).first();
  const manage = openAiRow.getByRole('button', { name: /Connect|Manage/u }).first();
  if (await manage.isVisible().catch(() => false)) {
    await manage.click();
    const providerDialog = page.getByRole('dialog').last();
    if (await providerDialog.isVisible().catch(() => false)) {
      await capture(page, '19-provider-dialog-openai', output, evidence, {
        closeups: true,
        modal: providerDialog,
      });
      await page.keyboard.press('Escape');
    }
  }

  if (
    !(await page
      .locator('.settings-layout')
      .isVisible()
      .catch(() => false))
  ) {
    await navigate(page, 'Settings');
    await page.locator('.settings-layout').waitFor({ timeout: 30_000 });
  }
  const replay = page.getByRole('button', { name: /Replay onboarding/u });
  await page.getByRole('button', { name: 'General', exact: true }).first().click();
  if (await replay.isVisible().catch(() => false)) {
    await replay.click();
    for (let index = 0; index < 8; index += 1) {
      const tour = page.locator('.onboarding-card');
      await tour.waitFor({ timeout: 15_000 });
      await capture(page, `20-onboarding-step-${index + 1}`, output, evidence, {
        closeups: true,
        modal: tour,
      });
      if (index < 7) await page.getByRole('button', { name: 'Continue', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Skip onboarding', exact: true }).click();
  }

  const developer = page.getByRole('button', { name: /Developer mode/u }).first();
  if (await developer.isVisible().catch(() => false)) {
    await developer.click();
    await capture(page, '21-developer', output, evidence, { closeups: true });
  }

  await page.goto('https://tauri.localhost/?view=about', { waitUntil: 'domcontentloaded' });
  await page.locator('.about-page').waitFor({ timeout: 180_000 });
  await capture(page, '22-about', output, evidence, { closeups: true });
  const architecture = page.getByRole('button', { name: /Architecture notes/u });
  if (await architecture.isVisible().catch(() => false)) {
    await architecture.click();
    const aboutDialog = page.getByRole('dialog', { name: 'Architecture notes' });
    await capture(page, '23-about-architecture-dialog', output, evidence, {
      closeups: true,
      modal: aboutDialog,
    });
    await page.keyboard.press('Escape');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://tauri.localhost/?view=models', { waitUntil: 'domcontentloaded' });
  await page.locator('.models-page').waitFor({ timeout: 180_000 });
  await capture(page, '30-models-narrow', output, evidence, { closeups: true });
  await page.keyboard.press('Control+M');
  const narrowPicker = page.getByRole('dialog', { name: 'Choose model' });
  await capture(page, '31-model-picker-narrow', output, evidence, {
    closeups: true,
    modal: narrowPicker,
  });
  await page.keyboard.press('Escape');

  await page.goto('https://tauri.localhost/?view=home&onboarding=1', {
    waitUntil: 'domcontentloaded',
  });
  const narrowTour = page.locator('.onboarding-card');
  await narrowTour.waitFor({ timeout: 180_000 });
  await capture(page, '32-onboarding-step-1-narrow', output, evidence, {
    closeups: true,
    modal: narrowTour,
  });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await capture(page, '33-onboarding-step-2-narrow', output, evidence, {
    closeups: true,
    modal: narrowTour,
  });
  await page.getByRole('button', { name: 'Skip onboarding', exact: true }).click();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await capture(page, '34-mobile-navigation', output, evidence, { closeups: true });
  await page.locator('.shelf__close').click();

  evidence.finalOverflow = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
  }));

  await writeEvidence();
  const closeStarted = performance.now();
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  await page.getByRole('button', { name: 'Close window' }).click();
  const closeCode = await Promise.race([
    exit,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 5_000)),
  ]);
  evidence.close = {
    result: closeCode,
    latencyMs: Math.round(performance.now() - closeStarted),
  };
  closedThroughUi = closeCode !== 'timeout';
  await writeEvidence();
} catch (error) {
  evidence.failure = sanitize(error instanceof Error ? `${error.stack ?? error.message}` : error);
  evidence.diagnostics = sanitize(diagnostics);
  await page?.screenshot({ path: join(output, '99-failure.png') }).catch(() => undefined);
  await writeEvidence();
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (!closedThroughUi && child.exitCode === null) child.kill();
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10_000)),
    ]);
  }
}

if (evidence.browserErrors.length) {
  throw new Error(`Production renderer errors: ${JSON.stringify(evidence.browserErrors)}`);
}
if (!closedThroughUi) throw new Error('Packaged app did not close through its own Close control');
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function navigate(activePage, label) {
  await dismissOnboarding(activePage);
  const button = activePage.locator('.shelf__nav, .shelf__bottom').getByRole('button', {
    name: label,
    exact: true,
  });
  await button.first().click();
  await activePage.waitForTimeout(250);
}

async function dismissOnboarding(activePage, waitMs = 0) {
  const button = activePage.getByRole('button', { name: 'Skip onboarding', exact: true });
  if (waitMs > 0) {
    await button.waitFor({ state: 'visible', timeout: waitMs }).catch(() => undefined);
  }
  if (await button.isVisible().catch(() => false)) await button.click();
}

async function capture(activePage, name, directory, result, options = {}) {
  await activePage.evaluate(() => document.fonts.ready);
  await activePage.waitForTimeout(180);
  const size = await viewport(activePage);
  const full = join(directory, `${name}.png`);
  await activePage.screenshot({ path: full, animations: 'disabled' });
  const item = {
    name,
    full,
    viewport: size,
    title: sanitize(
      await activePage
        .locator('h1, h2')
        .first()
        .innerText()
        .catch(() => ''),
    ),
    scroll: await activePage.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight,
    })),
    closeups: [],
  };
  if (options.modal) {
    item.modalBox = await options.modal.boundingBox();
  }
  if (options.closeups) {
    const regions = [
      ['masthead', 0, 0, size.width, Math.min(size.height, Math.max(220, size.height * 0.31))],
      [
        'upper',
        0,
        Math.max(0, size.height * 0.19),
        size.width,
        Math.min(size.height * 0.46, size.height),
      ],
      [
        'middle',
        0,
        Math.max(0, size.height * 0.43),
        size.width,
        Math.min(size.height * 0.41, size.height),
      ],
      [
        'lower',
        0,
        Math.max(0, size.height * 0.68),
        size.width,
        Math.min(size.height * 0.32, size.height),
      ],
    ];
    for (const [regionName, x, y, width, requestedHeight] of regions) {
      const height = Math.min(requestedHeight, size.height - y);
      if (width < 1 || height < 1) continue;
      const regionPath = join(directory, `${name}--${regionName}.png`);
      await activePage.screenshot({
        path: regionPath,
        animations: 'disabled',
        clip: { x, y, width, height },
      });
      item.closeups.push(regionPath);
    }
  }
  if (options.modal) {
    const modalPath = join(directory, `${name}--dialog.png`);
    await options.modal.screenshot({ path: modalPath, animations: 'disabled' });
    item.closeups.push(modalPath);
  }
  result.screens.push(item);
}

async function viewport(activePage) {
  return activePage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

async function waitForDevtools(debugPort, processHandle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error('CupcakeAI exited before WebView2 opened');
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) return;
    } catch {
      // WebView2 is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('CupcakeAI did not expose its hidden WebView2 debugging endpoint');
}

async function waitForPage(connectedBrowser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = connectedBrowser.contexts().flatMap((context) => context.pages());
    const candidate = pages.find((item) => item.url() !== 'about:blank');
    if (candidate) return candidate;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('CupcakeAI did not expose its production renderer');
}

async function processTree(parentPid) {
  const script = [
    `$rootPid=${Number(parentPid)}`,
    '$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath',
    '$ids=[System.Collections.Generic.HashSet[uint32]]::new()',
    '[void]$ids.Add([uint32]$rootPid)',
    'do {',
    '  $before=$ids.Count',
    '  foreach($process in $all){ if($ids.Contains([uint32]$process.ParentProcessId)){ [void]$ids.Add([uint32]$process.ProcessId) } }',
    '} while($ids.Count -gt $before)',
    '$all | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | ConvertTo-Json -Compress',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function writeEvidence() {
  await writeFile(join(output, 'audit.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
}

function sanitize(value) {
  return String(value)
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, '[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(-2000);
}
