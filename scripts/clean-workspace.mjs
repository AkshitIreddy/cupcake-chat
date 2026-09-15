#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  acquireWorkspaceLock,
  assertLocalWorkPath,
  removeWorkDirectory,
  workPath,
} from './lib/workspace.mjs';

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--apply', '--profiles'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
}
// Keep compiled targets, pinned downloads, sidecars, tools, dependencies, source,
// release media, and all installed-app data. Only disposable developer output goes.
const targets = ['qa', 'demo', 'tmp', 'pyinstaller'];
if (args.has('--profiles')) targets.push('profiles');
if (args.has('--apply') && args.has('--profiles') && process.platform === 'win32') {
  const probe = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'if (Get-Process CupcakeAI,cupcake-runtime,cupcake-tool-broker -ErrorAction SilentlyContinue) { exit 2 }',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  if (probe.error || probe.status !== 0)
    throw new Error('Close Cupcake Chat before resetting development profiles.');
}
for (const target of targets) await assertLocalWorkPath(workPath(target));
if (!args.has('--apply')) {
  console.log('Cleanup preview (use --apply to delete):');
  for (const target of targets) console.log(workPath(target));
} else {
  const release = await acquireWorkspaceLock('maintenance');
  try {
    for (const target of targets) {
      await removeWorkDirectory(workPath(target));
      console.log(`Cleaned ${workPath(target)}`);
    }
  } finally {
    release();
  }
}
