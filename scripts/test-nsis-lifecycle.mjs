#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const repoRoot = resolve('.');
const outRoot = join(repoRoot, 'out');
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
      'CUPCAKEAGI 2_2.0.0-rc.1_x64-setup.exe',
    ),
  ),
);
const productName = option('--product-name', 'CUPCAKEAGI 2');
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
  installDirectory,
  profile,
  silentInstall: false,
  firstRun: false,
  silentUninstall: false,
  profileRetained: false,
};
let app;
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
  const executable = join(installDirectory, 'CUPCAKEAGI.exe');
  await access(executable);
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
  evidence.firstRun = true;
  app.kill();
  await Promise.race([
    new Promise((resolveExit) => app.once('exit', resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 15_000)),
  ]);
  app = undefined;

  const uninstallers = (await readdir(installDirectory)).filter((name) =>
    /uninstall.*\.exe$/iu.test(name),
  );
  if (uninstallers.length !== 1) {
    throw new Error(`Expected one uninstaller, found: ${uninstallers.join(', ') || 'none'}`);
  }
  await run(join(installDirectory, uninstallers[0]), ['/S']);
  evidence.silentUninstall = true;
  const profileFiles = await readdir(profile);
  evidence.profileRetained = profileFiles.length > 0;
} finally {
  if (app && app.exitCode === null) app.kill();
  // This path was validated above as a non-root child of repo/out and was
  // created solely for this lifecycle test. The retained disposable profile
  // is intentionally not removed so its data-retention evidence can be read.
  await rm(installDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

if (
  !evidence.silentInstall ||
  !evidence.firstRun ||
  !evidence.silentUninstall ||
  !evidence.profileRetained
) {
  throw new Error(`NSIS lifecycle acceptance was incomplete: ${JSON.stringify(evidence)}`);
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
