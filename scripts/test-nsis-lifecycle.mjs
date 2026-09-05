#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const installer = resolve(
  option(
    '--installer',
    join(
      'apps',
      'desktop',
      'src-tauri',
      'target',
      'release',
      'bundle',
      'nsis',
      'CupcakeAI 2_2.0.0-rc.1_x64-setup.exe',
    ),
  ),
);
const productName = option('--product-name', 'CupcakeAI 2');
const portableExecutable = resolve(
  option(
    '--portable-executable',
    join('apps', 'desktop', 'src-tauri', 'target', 'release', 'CupcakeAI.exe'),
  ),
);
if (!process.env.LOCALAPPDATA)
  throw new Error('LOCALAPPDATA is required for NSIS lifecycle testing');
const installDirectory = normalize(join(process.env.LOCALAPPDATA, productName));
const profile = resolve(
  option('--profile', join('out', 'tauri-test-profiles', 'nsis-lifecycle-retained')),
);
const resultPath = resolve(
  option('--result', join('out', 'nsis-lifecycle', 'lifecycle-result.json')),
);
const port = Number(option('--port', '10041'));

function installedRecords(displayName = productName) {
  const root = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  const result = spawnSync('reg.exe', ['query', root, '/s'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 && !/unable to find/iu.test(result.stderr)) {
    throw new Error(`Could not inspect current-user uninstall records: ${result.stderr.trim()}`);
  }
  const value = (block, name) =>
    block.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, 'imu'))?.[1]?.trim() ?? null;
  return result.stdout
    .split(/\r?\n(?=HKEY_)/u)
    .filter(
      (block) =>
        /^HKEY_/u.test(block) &&
        value(block, 'DisplayName')?.localeCompare(displayName, undefined, {
          sensitivity: 'accent',
        }) === 0,
    )
    .map((block) => ({
      key: block.split(/\r?\n/u)[0].trim(),
      installLocation: value(block, 'InstallLocation'),
      uninstallString: value(block, 'UninstallString'),
      quietUninstallString: value(block, 'QuietUninstallString'),
    }));
}

if (args.includes('--inspect-registry')) {
  process.stdout.write(`${JSON.stringify(installedRecords(), null, 2)}\n`);
  process.exit(0);
}

await access(installer);
await access(portableExecutable);
const existingRecords = installedRecords();
if (existingRecords.length) {
  throw new Error(
    `${productName} is already registered for this user; refusing to overwrite it: ${JSON.stringify(existingRecords)}`,
  );
}
const localAppData = normalize(process.env.LOCALAPPDATA);
const relativeInstall = relative(localAppData, installDirectory);
if (
  !relativeInstall ||
  relativeInstall.startsWith('..') ||
  resolve(localAppData) === installDirectory ||
  installDirectory === normalize(join(localAppData, 'CUPCAKEAGI'))
) {
  throw new Error('Resolved install directory is not a safe, isolated 2.0 current-user path');
}
try {
  await access(installDirectory);
  throw new Error(`Disposable install directory already exists: ${installDirectory}`);
} catch (error) {
  if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error;
}
await mkdir(dirname(installDirectory), { recursive: true });
await mkdir(profile, { recursive: true });
await mkdir(dirname(resultPath), { recursive: true });

async function run(executable, childArgs, environment = process.env) {
  const child = spawn(executable, childArgs, {
    env: environment,
    windowsHide: true,
    stdio: 'ignore',
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (code !== 0) throw new Error(`${executable} exited with status ${String(code)}`);
}

async function waitForDevtools(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // The installed WebView2 app is not ready yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error('Installed Tauri app did not expose its WebView2 debugging endpoint');
}

const evidence = {
  installer,
  portableExecutable,
  installDirectory,
  profile,
  silentInstall: false,
  firstRun: false,
  installedTimingsMs: null,
  firstRunScreenshot: join(dirname(resultPath), 'installed-first-run.png'),
  sentinel: null,
  silentUninstall: false,
  uninstallRecordRemoved: false,
  installDirectoryRemoved: false,
  retainedProfileReopened: false,
  portableTimingsMs: null,
  retainedProfileScreenshot: join(dirname(resultPath), 'portable-retained-profile.png'),
  profileRetained: false,
};
let app;
let browser;
try {
  await run(installer, ['/S']);
  evidence.silentInstall = true;
  const installedRecord = installedRecords();
  if (installedRecord.length !== 1) {
    throw new Error(`Expected one ${productName} uninstall record after install`);
  }
  const recordedLocation = installedRecord[0].installLocation?.replace(/^"|"$/gu, '');
  if (!recordedLocation || normalize(recordedLocation) !== installDirectory) {
    throw new Error(
      `Installer registered an unexpected location: ${recordedLocation ?? 'missing'}`,
    );
  }
  const executable = join(installDirectory, 'CupcakeAI.exe');
  await access(executable);
  let launchedAt = performance.now();
  app = spawn(executable, [], {
    env: {
      ...process.env,
      CUPCAKE_TEST_DATA_DIR: profile,
      CUPCAKE_TEST_HEADLESS: '1',
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    windowsHide: true,
    stdio: 'ignore',
  });
  await waitForDevtools();
  const processToDevtools = Math.round(performance.now() - launchedAt);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = await waitForPage(browser);
  await page.locator('.home-hero').waitFor({ timeout: 240_000 });
  evidence.installedTimingsMs = {
    processToDevtools,
    processToHome: Math.round(performance.now() - launchedAt),
  };
  await page.screenshot({ path: evidence.firstRunScreenshot, fullPage: true });
  const sentinelName = `NSIS lifecycle sentinel ${Date.now()}`;
  const sentinelDescription = 'Disposable project proving installed runtime persistence.';
  const sentinel = await runtimeRequest(page, 'projects.create', {
    name: sentinelName,
    description: sentinelDescription,
  });
  if (!sentinel?.id || sentinel.name !== sentinelName) {
    throw new Error(
      `Installed runtime returned an invalid project sentinel: ${JSON.stringify(sentinel)}`,
    );
  }
  evidence.sentinel = {
    id: sentinel.id,
    name: sentinelName,
    description: sentinelDescription,
  };
  evidence.firstRun = true;
  await closeThroughUi(page, app);
  await browser.close();
  browser = undefined;
  app = undefined;

  const uninstallers = (await readdir(installDirectory)).filter((name) =>
    /uninstall.*\.exe$/iu.test(name),
  );
  if (uninstallers.length !== 1) {
    throw new Error(`Expected one uninstaller, found: ${uninstallers.join(', ') || 'none'}`);
  }
  await run(join(installDirectory, uninstallers[0]), ['/S']);
  evidence.silentUninstall = true;
  await waitForUninstallCompletion();
  evidence.uninstallRecordRemoved = true;
  evidence.installDirectoryRemoved = true;
  const profileFiles = await readdir(profile);
  evidence.profileRetained = profileFiles.length > 0;

  launchedAt = performance.now();
  app = spawn(portableExecutable, [], {
    env: {
      ...process.env,
      CUPCAKE_TEST_DATA_DIR: profile,
      CUPCAKE_TEST_HEADLESS: '1',
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview2-portable-reopen'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    windowsHide: true,
    stdio: 'ignore',
  });
  await waitForDevtools();
  const portableProcessToDevtools = Math.round(performance.now() - launchedAt);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await waitForPage(browser);
  await page.locator('.home-hero').waitFor({ timeout: 240_000 });
  evidence.portableTimingsMs = {
    processToDevtools: portableProcessToDevtools,
    processToHome: Math.round(performance.now() - launchedAt),
  };
  const projects = await runtimeRequest(page, 'projects.list', { includeArchived: true });
  const retained = Array.isArray(projects)
    ? projects.find((project) => project?.id === evidence.sentinel?.id)
    : undefined;
  if (
    !retained ||
    retained.name !== evidence.sentinel?.name ||
    retained.description !== evidence.sentinel?.description
  ) {
    throw new Error('Portable host did not recover the exact installed-runtime project sentinel');
  }
  evidence.retainedProfileReopened = true;
  await page.screenshot({ path: evidence.retainedProfileScreenshot, fullPage: true });
  await closeThroughUi(page, app);
  await browser.close();
  browser = undefined;
  app = undefined;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (app && app.exitCode === null) app.kill();
  // The product uninstaller is the only component allowed to remove the
  // disposable install. If it fails, retain the install for inspection rather
  // than masking the lifecycle defect with harness cleanup. The disposable
  // profile is likewise retained as data-retention evidence.
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

if (
  !evidence.silentInstall ||
  !evidence.firstRun ||
  !evidence.silentUninstall ||
  !evidence.uninstallRecordRemoved ||
  !evidence.installDirectoryRemoved ||
  !evidence.profileRetained ||
  !evidence.retainedProfileReopened
) {
  throw new Error(`NSIS lifecycle acceptance was incomplete: ${JSON.stringify(evidence)}`);
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function waitForPage(activeBrowser, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = activeBrowser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url().startsWith('https://tauri.localhost'));
    if (page) return page;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Installed Tauri WebView page did not become available');
}

async function waitForUninstallCompletion(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recordRemoved = installedRecords().length === 0;
    let directoryRemoved = false;
    try {
      await access(installDirectory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        directoryRemoved = true;
      } else {
        throw error;
      }
    }
    if (recordRemoved && directoryRemoved) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `${productName} uninstall did not remove its registry record and install directory within ${timeoutMs} ms`,
  );
}

async function runtimeRequest(page, method, params) {
  const response = await page.evaluate(
    async ({ requestMethod, requestParams }) => {
      const api = globalThis.window.cupcake?.runtime;
      if (!api) return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE' } };
      return api.request({ method: requestMethod, params: requestParams, timeoutMs: 120_000 });
    },
    { requestMethod: method, requestParams: params },
  );
  if (!response?.ok) {
    throw new Error(
      `${method} failed: ${response?.error?.code ?? 'UNKNOWN'}: ${response?.error?.message ?? ''}`,
    );
  }
  return response.result;
}

async function closeThroughUi(page, child) {
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  await page.getByRole('button', { name: 'Close window' }).click();
  const result = await Promise.race([
    exited.then(() => true),
    new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), 15_000)),
  ]);
  if (!result) throw new Error('Packaged app did not exit through its Close control');
}
