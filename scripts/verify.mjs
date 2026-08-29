#!/usr/bin/env node
import { join } from 'node:path';
import {
  commandExists,
  exists,
  isWindows,
  parseArgValue,
  pnpmCommand,
  repoRoot,
  run,
} from './lib/process.mjs';

const args = process.argv.slice(2);
const lane = parseArgValue(args, '--lane', 'all');
const skipBuild = args.includes('--skip-build');
const supported = new Set(['all', 'js', 'python', 'rust', 'contracts']);

if (!supported.has(lane)) {
  throw new Error(
    `Unknown lane ${JSON.stringify(lane)}. Expected one of: ${[...supported].join(', ')}`,
  );
}

function requireCommand(command, hint) {
  if (!commandExists(command)) throw new Error(`${command} is required. ${hint}`);
}

async function verifyJavaScript() {
  const pnpm = pnpmCommand();
  run(pnpm.command, [...pnpm.prefix, 'lint']);
  run(pnpm.command, [...pnpm.prefix, 'typecheck']);
  run(pnpm.command, [...pnpm.prefix, 'test']);
  if (!skipBuild) run(pnpm.command, [...pnpm.prefix, 'build']);
}

async function verifyPython() {
  const runtime = join(repoRoot, 'services', 'runtime');
  if (!(await exists(join(runtime, 'pyproject.toml')))) {
    throw new Error('Python runtime manifest not found at services/runtime/pyproject.toml');
  }
  const python = isWindows ? 'python' : commandExists('python3') ? 'python3' : 'python';
  requireCommand(python, 'Install Python 3.12 or newer.');
  run(python, ['-m', 'ruff', 'check', 'services/runtime']);
  run(python, ['-m', 'pyright', 'services/runtime']);
  run(python, ['-m', 'pytest', 'services/runtime']);
}

async function verifyRust() {
  const manifest = join(repoRoot, 'crates', 'tool-broker', 'Cargo.toml');
  if (!(await exists(manifest)))
    throw new Error('Rust broker manifest not found at crates/tool-broker/Cargo.toml');
  requireCommand('cargo', 'Install the stable Rust toolchain with rustfmt and clippy.');
  run('cargo', ['fmt', '--manifest-path', manifest, '--all', '--', '--check']);
  run('cargo', [
    'clippy',
    '--manifest-path',
    manifest,
    '--all-targets',
    '--all-features',
    '--',
    '-D',
    'warnings',
  ]);
  run('cargo', ['test', '--manifest-path', manifest, '--all-features']);
}

async function verifyContracts() {
  const pnpm = pnpmCommand();
  run(pnpm.command, [...pnpm.prefix, '--filter', '@cupcakeagi/contracts', 'check:schemas']);
}

const selected = lane === 'all' ? ['contracts', 'js', 'python', 'rust'] : [lane];
for (const current of selected) {
  process.stdout.write(`\n=== ${current.toUpperCase()} VALIDATION ===\n`);
  if (current === 'js') await verifyJavaScript();
  if (current === 'python') await verifyPython();
  if (current === 'rust') await verifyRust();
  if (current === 'contracts') await verifyContracts();
}

process.stdout.write(`\nAll ${selected.join(', ')} checks passed.\n`);
