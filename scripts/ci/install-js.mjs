#!/usr/bin/env node
import { join } from 'node:path';
import { exists, pnpmCommand, repoRoot, run } from '../lib/process.mjs';

const lockfile = join(repoRoot, 'pnpm-lock.yaml');
const args = ['install'];

if (await exists(lockfile)) {
  args.push('--frozen-lockfile');
} else {
  process.stderr.write(
    '::warning::pnpm-lock.yaml is missing; installation is not reproducible yet.\n',
  );
  args.push('--no-frozen-lockfile');
}

const pnpm = pnpmCommand();
run(pnpm.command, [...pnpm.prefix, ...args]);
