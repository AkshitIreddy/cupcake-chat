#!/usr/bin/env node
/* global window */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { pnpmCommand, repoRoot, run } from './lib/process.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const allowedTempRoot = resolve('E:/temp');
const workspaceRoot = resolve(option('--workspace-root', 'E:/temp/cupcake-chat-updater-tests'));
const targetDirectory = resolve(option('--target-dir', 'E:/temp/cupcake-chat-updater-cargo-cache'));
const reusedKeyDirectory = option('--key-directory', null);
const configuredKeyDirectory = reusedKeyDirectory ? resolve(reusedKeyDirectory) : null;
for (const [label, path] of [
  ['workspace root', workspaceRoot],
  ['Cargo target directory', targetDirectory],
  ...(configuredKeyDirectory ? [['key directory', configuredKeyDirectory]] : []),
]) {
  const fromAllowedRoot = relative(allowedTempRoot, path);
  if (!fromAllowedRoot || fromAllowedRoot.startsWith('..') || isAbsolute(fromAllowedRoot)) {
    throw new Error(`${label} must be a child of E:/temp`);
  }
}
const workspace = join(workspaceRoot, `run-${Date.now()}-${process.pid}`);
const port = Number(option('--port', '43121'));
const debugPort = Number(option('--debug-port', '43122'));
if (
  ![port, debugPort].every(
    (value) => Number.isSafeInteger(value) && value >= 1024 && value <= 65535,
  )
) {
  throw new Error('Updater and debug ports must be non-privileged TCP ports');
}

const keysDirectory = configuredKeyDirectory ?? join(workspace, 'keys');
const feedDirectory = join(workspace, 'feed');
const profileDirectory = join(workspace, 'profile');
const webviewDirectory = join(workspace, 'webview2');
const privateKey = join(keysDirectory, 'updater-test.key');
const publicKey = `${privateKey}.pub`;
const payloadPath = join(feedDirectory, 'cupcake-chat-1.8.1-test-updater.exe');
const signaturePath = `${payloadPath}.sig`;
const evidencePath = join(workspace, 'evidence.json');
const testConfig = 'src-tauri/tauri.updater-test.conf.json';
const disposablePassphrase = 'cupcake-local-test-only';

await Promise.all([
  mkdir(keysDirectory, { recursive: true }),
  mkdir(feedDirectory, { recursive: true }),
  mkdir(profileDirectory, { recursive: true }),
  mkdir(webviewDirectory, { recursive: true }),
]);

const pnpm = pnpmCommand();
if (!configuredKeyDirectory) {
  run(pnpm.command, [
    ...pnpm.prefix,
    '--filter',
    '@cupcakeagi/desktop',
    'tauri',
    'signer',
    'generate',
    '--ci',
    '--force',
    '--password',
    disposablePassphrase,
    '--write-keys',
    privateKey,
  ]);
}

const originalPayload = Buffer.from(
  'Cupcake Chat disposable updater signature-verification fixture\n',
  'utf8',
);
await writeFile(payloadPath, originalPayload);
run(pnpm.command, [
  ...pnpm.prefix,
  '--filter',
  '@cupcakeagi/desktop',
  'tauri',
  'signer',
  'sign',
  '--private-key-path',
  privateKey,
  '--password',
  disposablePassphrase,
  payloadPath,
]);

const [updaterPublicKey, signature] = await Promise.all([
  readFile(publicKey, 'utf8').then((value) => value.trim()),
  readFile(signaturePath, 'utf8').then((value) => value.trim()),
]);
const manifest = {
  version: '1.8.1',
  notes: 'Disposable loopback update used to verify the native updater bridge.',
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      url: `http://127.0.0.1:${port}/${encodeURIComponent(payloadPath.split(/[\\/]/u).at(-1))}`,
      signature,
    },
  },
};

run(
  pnpm.command,
  [
    ...pnpm.prefix,
    '--filter',
    '@cupcakeagi/desktop',
    'tauri',
    'build',
    '--no-bundle',
    '--config',
    testConfig,
  ],
  {
    env: {
      CI: 'true',
      CARGO_TARGET_DIR: targetDirectory,
      CUPCAKE_UPDATER_PUBLIC_KEY: updaterPublicKey,
    },
  },
);

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/latest.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(manifest));
      return;
    }
    if (request.url === `/${encodeURIComponent(payloadPath.split(/[\\/]/u).at(-1))}`) {
      const payload = await readFile(payloadPath);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(404);
    response.end();
  } catch {
    response.writeHead(500);
    response.end();
  }
});
await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(port, '127.0.0.1', resolveListen);
});

const executable = join(targetDirectory, 'release', 'CupcakeAI.exe');
const child = spawn(executable, [], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CUPCAKE_TEST_DATA_DIR: profileDirectory,
    CUPCAKE_TEST_HEADLESS: '1',
    CUPCAKE_UPDATER_TEST_ENDPOINT: `http://127.0.0.1:${port}/latest.json`,
    WEBVIEW2_USER_DATA_FOLDER: webviewDirectory,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-16_384);
  });
}

let browser;
const evidence = {
  candidate: executable,
  profile: profileDirectory,
  feed: `http://127.0.0.1:${port}/latest.json`,
  validSignature: null,
  tamperedPayloadRejected: false,
};
try {
  await waitForDevtools(debugPort, child, 120_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const page = await waitForPage(browser, 30_000);
  await page.waitForFunction(() => Boolean(window.cupcake?.app.updates), undefined, {
    timeout: 180_000,
  });

  const status = await page.evaluate(() => window.cupcake.app.updates.status());
  if (!status.configured || status.currentVersion !== '1.8.0') {
    throw new Error(`Unexpected updater status: ${JSON.stringify(status)}`);
  }
  const checked = await page.evaluate(() => window.cupcake.app.updates.check());
  if (!checked.available || checked.update?.version !== '1.8.1') {
    throw new Error(`Loopback update was not discovered: ${JSON.stringify(checked)}`);
  }
  const downloaded = await page.evaluate(() => window.cupcake.app.updates.download());
  if (!downloaded.downloaded || downloaded.version !== '1.8.1') {
    throw new Error(`Signed updater payload was not verified: ${JSON.stringify(downloaded)}`);
  }
  evidence.validSignature = { status, checked, downloaded };

  await page.evaluate(() => window.cupcake.app.updates.check());
  await writeFile(payloadPath, Buffer.concat([originalPayload, Buffer.from('tampered\n')]));
  const tamperResult = await page.evaluate(async () => {
    try {
      await window.cupcake.app.updates.download();
      return { accepted: true };
    } catch (error) {
      return { accepted: false, error };
    }
  });
  evidence.tamperedPayloadRejected =
    !tamperResult.accepted && tamperResult.error?.code === 'UPDATE_FAILED';
  evidence.tamperResult = tamperResult;
  if (!evidence.tamperedPayloadRejected) {
    throw new Error('The updater accepted a payload that changed after signing');
  }

  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath }, null, 2)}\n`);
} catch (error) {
  evidence.failure = String(error instanceof Error ? (error.stack ?? error.message) : error);
  evidence.diagnostics = diagnostics;
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null) child.kill();
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function waitForDevtools(activePort, processHandle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Cupcake Chat exited before WebView2 opened: ${diagnostics}`);
    }
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${activePort}/json/version`);
      if (response.ok) return;
    } catch {
      // WebView2 is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('Cupcake Chat did not expose its hidden WebView2 debugging endpoint');
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
  throw new Error('Cupcake Chat did not expose its production renderer');
}
