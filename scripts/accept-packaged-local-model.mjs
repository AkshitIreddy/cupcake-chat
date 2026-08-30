#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const executable = resolve(
  option(
    '--executable',
    join('apps', 'desktop', 'src-tauri', 'target', 'release', 'CUPCAKEAGI.exe'),
  ),
);
const profile = resolve(option('--profile', join('out', 'tauri-test-profiles', 'packaged-local')));
const output = resolve(option('--output', join('artifacts', 'screenshots', 'packaged-local')));
const markerPath = option('--gpu-marker');
const port = Number(option('--port', '10031'));
if (!markerPath) throw new Error('--gpu-marker is required');
if ((await readFile(resolve(markerPath), 'utf8')).trim().toLowerCase() !== 'yes') {
  throw new Error('GPU marker must already be yes before packaged local-model acceptance starts');
}
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('--port must be an unprivileged TCP port');
}

await mkdir(profile, { recursive: true });
await mkdir(output, { recursive: true });

let app;
let browser;
let page;
const evidence = {
  executable,
  profile,
  startedAt: new Date().toISOString(),
  startupMs: [],
  hardware: '',
  runtime: '',
  userAgent: '',
  benchmark: '',
  processMemory: [],
  downloadRecovery: false,
  chatCompleted: false,
  modelRemoved: false,
};

async function waitForDevtools(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // The WebView2 debugging endpoint is not listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error('Packaged WebView2 debugging endpoint did not become ready');
}

async function launch() {
  const started = Date.now();
  app = spawn(executable, [], {
    env: {
      ...process.env,
      CUPCAKE_TEST_DATA_DIR: profile,
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    windowsHide: true,
    stdio: 'ignore',
  });
  await waitForDevtools();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    page = browser.contexts().flatMap((context) => context.pages())[0];
    if (page) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  if (!page) throw new Error('Packaged Tauri WebView2 page was not exposed over CDP');
  await page.getByRole('button', { name: 'Models', exact: true }).waitFor({ timeout: 180_000 });
  evidence.startupMs.push(Date.now() - started);
  evidence.userAgent = await page.evaluate(() => globalThis.navigator.userAgent);
}

async function stop() {
  if (app && app.exitCode === null) app.kill();
  if (app) {
    await Promise.race([
      new Promise((resolveExit) => app.once('exit', resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 15_000)),
    ]);
  }
  if (browser) await browser.close().catch(() => undefined);
  app = undefined;
  browser = undefined;
  page = undefined;
}

function processMemory() {
  const result = spawnSync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const processNames = new Set([
    'cupcakeagi.exe',
    'cupcake-tool-broker.exe',
    'cupcake-runtime.exe',
    'llama-server.exe',
  ]);
  const processes = result.stdout
    .split(/\r?\n/u)
    .map((row) => row.match(/"(?:[^"]|"")*"/g) ?? [])
    .filter((fields) => processNames.has((fields[0] ?? '').replaceAll('"', '').toLowerCase()))
    .map((fields) => ({
      name: (fields[0] ?? '').replaceAll('"', ''),
      pid: Number((fields[1] ?? '').replaceAll(/[^0-9]/g, '')),
      workingSetBytes: Number((fields[4] ?? '').replaceAll(/[^0-9]/g, '')) * 1024,
    }));
  return {
    totalWorkingSetBytes: processes.reduce((total, item) => total + item.workingSetBytes, 0),
    processes,
  };
}

async function openModels() {
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('heading', { name: 'Models', exact: true }).last().waitFor();
  await page.getByText('Device profile detected').waitFor({ timeout: 180_000 });
}

async function waitForProgress(card, minimum = 1) {
  const progress = card.getByRole('progressbar');
  await progress.waitFor({ timeout: 600_000 });
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const value = Number(await progress.getAttribute('aria-valuenow'));
    if (value >= minimum) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Model download did not reach ${minimum}%`);
}

try {
  await launch();
  evidence.processMemory.push({ stage: 'steady-no-model', ...processMemory() });
  await openModels();
  evidence.hardware = (await page.locator('.hardware-card').innerText()).replaceAll(/\s+/g, ' ');
  if (!/NVIDIA/i.test(evidence.hardware) || !/CUDA/i.test(evidence.hardware)) {
    throw new Error(`Packaged hardware discovery did not prove NVIDIA CUDA: ${evidence.hardware}`);
  }
  const cudaCards = page.locator('article.runtime-pack').filter({ hasText: /CUDA/i });
  await cudaCards.first().waitFor({ timeout: 180_000 });
  const cudaCardTexts = await cudaCards.allInnerTexts();
  const recommendedIndex = cudaCardTexts.findIndex((text) => /Active runtime/i.test(text));
  const rankedIndex = cudaCardTexts.findIndex((text) => /Recommended for this device/i.test(text));
  const cuda13Index = cudaCardTexts.findIndex((text) => /CUDA-13 acceleration/i.test(text));
  const selectedIndex =
    recommendedIndex >= 0 ? recommendedIndex : rankedIndex >= 0 ? rankedIndex : cuda13Index;
  if (selectedIndex < 0) {
    throw new Error(`No compatible CUDA runtime card was exposed: ${cudaCardTexts.join(' | ')}`);
  }
  const recommendedCuda = cudaCards.nth(selectedIndex);
  evidence.runtime = (await recommendedCuda.innerText()).replaceAll(/\s+/g, ' ');
  const reviewRuntime = recommendedCuda.getByRole('button', { name: 'Review pack' });
  if (await reviewRuntime.isVisible()) {
    await reviewRuntime.click();
    const runtimeDialog = page.getByRole('dialog', { name: /Install .*CUDA/i });
    await runtimeDialog.getByRole('checkbox').check();
    await runtimeDialog.getByRole('button', { name: 'Download and verify' }).click();
  }
  const activateRuntime = recommendedCuda.getByRole('button', { name: 'Activate', exact: true });
  if (await activateRuntime.isVisible()) await activateRuntime.click();
  await recommendedCuda.getByText('Active runtime', { exact: true }).waitFor({ timeout: 1_800_000 });
  await page.screenshot({ path: join(output, '01-cuda-runtime-installed.png') });

  await page.getByPlaceholder('Find a model').fill('Qwen3 8B');
  let modelCard = page
    .locator('article.model-card')
    .filter({ hasText: /Qwen3 8B/ })
    .first();
  const reviewInstall = modelCard.getByRole('button', { name: 'Review install' });
  if (await reviewInstall.isVisible()) {
    await reviewInstall.click();
    const modelDialog = page.getByRole('dialog', { name: /Review Qwen3 8B/ });
    await modelDialog.getByRole('checkbox').check();
    await modelDialog.getByRole('button', { name: 'Start verified download' }).click();
    await waitForProgress(modelCard, 1);
    await page.screenshot({ path: join(output, '02-model-download-before-restart.png') });
    await stop();
    await launch();
    await openModels();
    await page.getByPlaceholder('Find a model').fill('Qwen3 8B');
    modelCard = page
      .locator('article.model-card')
      .filter({ hasText: /Qwen3 8B/ })
      .first();
  }
  const installedModel = modelCard.getByText('Installed', { exact: true });
  const retryDownload = modelCard.getByRole('button', { name: 'Retry download', exact: true });
  if (await installedModel.isVisible()) {
    evidence.downloadRecovery = true;
  } else if (await retryDownload.isVisible()) {
    evidence.downloadRecovery = true;
    await page.screenshot({ path: join(output, '02-model-download-recovered.png') });
    await retryDownload.click();
  } else {
    await modelCard.getByText('Paused', { exact: true }).waitFor({ timeout: 180_000 });
    evidence.downloadRecovery = true;
    await page.screenshot({ path: join(output, '02-model-download-recovered.png') });
    await modelCard.getByRole('button', { name: 'Resume download', exact: true }).click();
  }
  await installedModel.waitFor({ timeout: 3_600_000 });
  await modelCard.getByRole('button', { name: 'Load model' }).click();
  await modelCard.getByText('Loaded', { exact: true }).waitFor({ timeout: 900_000 });
  evidence.processMemory.push({ stage: 'model-loaded', ...processMemory() });

  await page.getByRole('button', { name: /Benchmark Qwen3 8B/ }).click();
  const benchmark = modelCard.locator('.benchmark-result');
  await benchmark.waitFor({ timeout: 900_000 });
  evidence.benchmark = (await benchmark.innerText()).replaceAll(/\s+/g, ' ');
  const makeDefault = modelCard.getByRole('button', { name: 'Make default' });
  if (await makeDefault.isVisible()) await makeDefault.click();
  await modelCard.getByText('Default model').waitFor({ timeout: 120_000 });
  await page.screenshot({ path: join(output, '03-model-loaded-benchmarked.png') });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  const offline = page.getByRole('switch', { name: 'Offline mode' });
  if ((await offline.getAttribute('aria-checked')) !== 'true') await offline.click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page
    .getByRole('button', { name: /New chat/i })
    .first()
    .click();
  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('Reply with exactly: CUPCAKE LOCAL CUDA ACCEPTED');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page
    .getByText(/CUPCAKE LOCAL CUDA ACCEPTED/i)
    .last()
    .waitFor({ timeout: 900_000 });
  await page.getByRole('button', { name: 'Send message' }).waitFor({ state: 'visible' });
  evidence.chatCompleted = true;
  await page.screenshot({ path: join(output, '04-offline-local-chat.png') });

  await openModels();
  await page.getByPlaceholder('Find a model').fill('Qwen3 8B');
  modelCard = page
    .locator('article.model-card')
    .filter({ hasText: /Qwen3 8B/ })
    .first();
  await modelCard.getByRole('button', { name: 'Unload' }).click();
  await modelCard.getByRole('button', { name: 'Load model' }).waitFor({ timeout: 300_000 });
  await modelCard.getByRole('button', { name: /Remove Qwen3 8B/ }).click();
  await page
    .getByRole('alertdialog', { name: /Remove Qwen3 8B/ })
    .getByRole('button', { name: 'Remove local files' })
    .click();
  await modelCard.getByRole('button', { name: 'Review install' }).waitFor({ timeout: 300_000 });
  evidence.modelRemoved = true;
  await page.screenshot({ path: join(output, '05-model-removed.png') });
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(
    join(output, 'acceptance.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );
  await stop();
}

if (!evidence.downloadRecovery || !evidence.chatCompleted || !evidence.modelRemoved) {
  throw new Error(`Packaged local-model acceptance was incomplete: ${JSON.stringify(evidence)}`);
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
