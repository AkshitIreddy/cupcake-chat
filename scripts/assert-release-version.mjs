#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, repoRoot } from './lib/process.mjs';

const requestedVersion = process.argv[2];
if (!requestedVersion || !/^\d+\.\d+\.\d+$/u.test(requestedVersion)) {
  throw new Error('Pass the stable release version as X.Y.Z');
}

const versions = new Map();
for (const path of [
  'package.json',
  'apps/desktop/package.json',
  'packages/contracts/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
]) {
  versions.set(path, (await readJson(join(repoRoot, path))).version);
}

for (const path of ['apps/desktop/src-tauri/Cargo.toml', 'crates/tool-broker/Cargo.toml']) {
  const source = await readFile(join(repoRoot, path), 'utf8');
  versions.set(path, source.match(/^version\s*=\s*"([^"]+)"/mu)?.[1]);
}

const pyproject = await readFile(join(repoRoot, 'services/runtime/pyproject.toml'), 'utf8');
versions.set('services/runtime/pyproject.toml', pyproject.match(/^version\s*=\s*"([^"]+)"/mu)?.[1]);

const runtimeInit = await readFile(
  join(repoRoot, 'services/runtime/src/cupcake_runtime/__init__.py'),
  'utf8',
);
versions.set(
  'services/runtime/src/cupcake_runtime/__init__.py',
  runtimeInit.match(/^__version__\s*=\s*"([^"]+)"/mu)?.[1],
);

const mismatches = [...versions].filter(([, version]) => version !== requestedVersion);
if (mismatches.length) {
  throw new Error(
    `Release version ${requestedVersion} does not match: ${mismatches
      .map(([path, version]) => `${path}=${String(version ?? 'missing')}`)
      .join(', ')}`,
  );
}

process.stdout.write(
  `${JSON.stringify({ version: requestedVersion, manifests: Object.fromEntries(versions) }, null, 2)}\n`,
);
