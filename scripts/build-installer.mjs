#!/usr/bin/env node
import { copyFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acquireWorkspaceLock } from './lib/workspace.mjs';
import { pnpmCommand, readJson, repoRoot, run, sha256File } from './lib/process.mjs';

// One stable local installer. Keep the previous complete file until its replacement is ready.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const publishOnly = args.includes('--publish-only');
const buildArgs = args.filter((arg) => arg !== '--publish-only');
const releaseLock = await acquireWorkspaceLock('installer');
const destination = join(repoRoot, 'Cupcake-Chat-setup.exe');
const staging = `${destination}.pending`;
try {
  if (process.platform !== 'win32')
    throw new Error('The Windows installer must be built on Windows.');
  if (!publishOnly) {
    const pnpm = pnpmCommand();
    run(pnpm.command, [
      ...pnpm.prefix,
      '--filter',
      '@cupcakeagi/desktop',
      'exec',
      'tauri',
      'build',
      '--bundles',
      'nsis',
      ...buildArgs,
    ]);
  }
  const config = await readJson(join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json'));
  const targetIndex = buildArgs.indexOf('--target');
  const target = targetIndex >= 0 ? buildArgs[targetIndex + 1] : undefined;
  const targetRoot = resolve(
    repoRoot,
    process.env.CARGO_TARGET_DIR ?? 'apps/desktop/src-tauri/target',
  );
  const bundle = join(targetRoot, ...(target ? [target] : []), 'release/bundle/nsis');
  const installer = join(bundle, `${config.productName}_${config.version}_x64-setup.exe`);
  if ((await stat(installer)).size < 1_000_000) throw new Error('The installer is incomplete.');
  await copyFile(installer, staging);
  const hash = await sha256File(installer);
  if ((await sha256File(staging)) !== hash) throw new Error('Installer copy verification failed.');
  await rename(staging, destination);
  console.log(`Installer ready: ${destination}\nSHA256: ${hash}`);
} finally {
  await rm(staging, { force: true });
  releaseLock();
}
