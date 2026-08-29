#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  ensureDir,
  exists,
  parseArgValue,
  readJson,
  repoRoot,
  run,
  sha256File,
  walkFiles,
} from './lib/process.mjs';

const args = process.argv.slice(2);
const requireArtifacts = args.includes('--require-artifacts');
const jsonOutput = parseArgValue(args, '--json', null);
const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function assertRcVersion(label, version) {
  record(
    `${label} version`,
    typeof version === 'string' && /^2\.0\.0-rc\.\d+$/.test(version),
    String(version ?? 'missing'),
  );
}

async function auditVersions() {
  for (const path of [
    'package.json',
    'apps/desktop/package.json',
    'packages/contracts/package.json',
  ]) {
    const manifest = await readJson(join(repoRoot, path));
    assertRcVersion(path, manifest.version);
    record(
      `${path} private`,
      manifest.private === true,
      manifest.private === true ? 'private' : 'must remain private',
    );
  }

  const cargoPath = join(repoRoot, 'crates', 'tool-broker', 'Cargo.toml');
  const cargo = await readFile(cargoPath, 'utf8');
  assertRcVersion('crates/tool-broker/Cargo.toml', cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]);

  const pyprojectPath = join(repoRoot, 'services', 'runtime', 'pyproject.toml');
  if (await exists(pyprojectPath)) {
    const pyproject = await readFile(pyprojectPath, 'utf8');
    const version = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    record(
      'services/runtime/pyproject.toml version',
      typeof version === 'string' && /^2\.0\.0rc\d+$/.test(version),
      String(version ?? 'missing'),
    );
  } else {
    record('Python runtime manifest', false, 'services/runtime/pyproject.toml is missing');
  }
}

async function auditTrackedState() {
  const result = run('git', ['ls-files', '-z'], { capture: true });
  const tracked = result.stdout.split('\0').filter(Boolean);
  const forbidden = [];
  for (const path of tracked) {
    if (!(await exists(join(repoRoot, path)))) continue;
    const normalized = path.replaceAll('\\', '/');
    if (
      /(^|\/)\.env(?:\.|$)/.test(normalized) ||
      /(^|\/)(__pycache__|node_modules|target)(\/|$)/.test(normalized) ||
      /\.(?:py[co]|db|db-shm|db-wal|sqlite|sqlite3)$/i.test(normalized)
    ) {
      forbidden.push(path);
    }
  }
  record(
    'No tracked secrets/generated state',
    forbidden.length === 0,
    forbidden.length ? forbidden.join(', ') : 'clean',
  );

  for (const lockfile of ['pnpm-lock.yaml', 'crates/tool-broker/Cargo.lock']) {
    record(`${lockfile} present`, await exists(join(repoRoot, lockfile)), lockfile);
  }
}

async function auditAutomationPolicy() {
  const scanRoots = ['.github/workflows', 'scripts', 'packaging', 'apps/desktop'];
  const extensions = new Set(['.yml', '.yaml', '.json', '.ts', '.js', '.mjs', '.py', '.toml']);
  const forbiddenPatterns = [
    { label: 'write-enabled GitHub contents permission', pattern: /contents\s*:\s*write/i },
    {
      label: 'release publishing command',
      pattern:
        /\b(?:npm\s+publish|gh\s+release\s+create|electron-forge\s+publish|mkdocs\s+gh-deploy)\b/i,
    },
    { label: 'Electron Forge publisher configuration', pattern: /\bpublishers\s*:/i },
    {
      label: 'live updater feed endpoint',
      pattern: /\b(?:setFeedURL|updateConfigPath|RELEASES\.json)\b/i,
    },
  ];
  const violations = [];
  for (const root of scanRoots) {
    for (const file of await walkFiles(join(repoRoot, root))) {
      if (file === join(repoRoot, 'scripts', 'release-candidate-audit.mjs')) continue;
      if (!extensions.has(extname(file))) continue;
      const source = await readFile(file, 'utf8');
      for (const rule of forbiddenPatterns) {
        if (rule.pattern.test(source))
          violations.push(`${relative(repoRoot, file)}: ${rule.label}`);
      }
    }
  }
  record(
    'No publish/updater configuration',
    violations.length === 0,
    violations.length ? violations.join('; ') : 'clean',
  );
}

async function auditContracts() {
  const sidecars = await readJson(join(repoRoot, 'packaging', 'sidecars.json'));
  record(
    'Sidecar descriptor schema',
    sidecars.schemaVersion === 1 && sidecars.protocolVersion === 1,
    'schema/protocol v1',
  );
  record(
    'Sidecar descriptor completeness',
    sidecars.sidecars
      ?.map((entry) => entry.id)
      .sort()
      .join(',') === 'runtime,tool-broker',
    sidecars.sidecars?.map((entry) => entry.id).join(', ') ?? 'missing',
  );
}

async function auditWindowsOnlyPackaging() {
  const forge = await readFile(join(repoRoot, 'apps', 'desktop', 'forge.config.ts'), 'utf8');
  const sidecarScript = await readFile(join(repoRoot, 'scripts', 'package-sidecars.mjs'), 'utf8');
  const workflow = await readFile(
    join(repoRoot, '.github', 'workflows', 'desktop-builds.yml'),
    'utf8',
  );
  const valid =
    forge.includes("packagePlatform !== 'win32' || packageArch !== 'x64'") &&
    !/@electron-forge\/maker-(?:deb|dmg|rpm)/.test(forge) &&
    sidecarScript.includes("targetPlatform !== 'win32' || targetArch !== 'x64'") &&
    /runs-on:\s*windows-latest/.test(workflow) &&
    !/runs-on:\s*(?:ubuntu|macos)-latest/.test(workflow);
  record(
    'Windows x64-only packaging policy',
    valid,
    valid ? 'Forge, sidecars, and installer CI reject non-Windows-x64 targets' : 'policy drift',
  );
}

async function auditArtifacts() {
  const stage = join(
    repoRoot,
    'out',
    'sidecars',
    `${process.platform}-${process.arch}`,
    'sidecars',
  );
  const manifestPath = join(stage, 'sidecars.manifest.json');
  if (!(await exists(manifestPath))) {
    record(
      'Staged sidecars',
      !requireArtifacts,
      requireArtifacts ? 'missing' : 'not required for this audit',
    );
  } else {
    const manifest = await readJson(manifestPath);
    const descriptor = await readJson(join(repoRoot, 'packaging', 'sidecars.json'));
    let valid =
      manifest.schemaVersion === descriptor.schemaVersion &&
      manifest.protocolVersion === descriptor.protocolVersion &&
      manifest.platform === process.platform &&
      manifest.architecture === process.arch &&
      manifest.binaries?.length === descriptor.sidecars.length;
    const seen = new Set();
    for (const binary of manifest.binaries ?? []) {
      const expected = descriptor.sidecars.find((item) => item.id === binary.id);
      const suffix = process.platform === 'win32' ? '.exe' : '';
      valid &&=
        Boolean(expected) &&
        !seen.has(binary.id) &&
        binary.file === `${expected?.baseName}${suffix}` &&
        binary.file === basename(binary.file) &&
        binary.transport === expected?.transport &&
        Number.isSafeInteger(binary.bytes) &&
        binary.bytes > 0 &&
        /^[a-f0-9]{64}$/.test(binary.sha256);
      seen.add(binary.id);
      const file = join(stage, basename(binary.file));
      valid &&= (await exists(file)) && (await sha256File(file)) === binary.sha256;
    }
    const resource = manifest.resources?.[0];
    valid &&=
      manifest.resources?.length === 1 &&
      resource?.id === 'cupcake-local-cpu-baseline' &&
      resource?.directory === 'cupcake-local' &&
      resource?.manifest === 'cupcake-local/cupcake-local.manifest.json' &&
      /^[a-f0-9]{64}$/.test(resource?.sha256 ?? '');
    const localManifestPath = join(stage, resource?.manifest ?? 'missing');
    valid &&=
      (await exists(localManifestPath)) &&
      (await sha256File(localManifestPath)) === resource?.sha256;
    if (await exists(localManifestPath)) {
      const localManifest = await readJson(localManifestPath);
      const localFiles = await walkFiles(join(stage, 'cupcake-local'));
      valid &&=
        localManifest.environment === 'local-release-candidate' &&
        localManifest.productionSigning === false &&
        localManifest.modelWeightsBundled === false &&
        localManifest.runtimeFileCount === 51 &&
        !localFiles.some((file) => /\.gguf$/i.test(file));
    }
    record(
      'Staged sidecars',
      valid,
      valid
        ? 'two checksummed binaries plus verified no-weights Cupcake Local CPU baseline'
        : 'manifest, resource, or digest mismatch',
    );
  }

  const desktopOut = join(repoRoot, 'apps', 'desktop', 'out');
  record(
    'Packaged desktop output',
    !requireArtifacts || (await exists(desktopOut)),
    requireArtifacts ? desktopOut : 'not required',
  );
}

await auditVersions();
await auditTrackedState();
await auditAutomationPolicy();
await auditContracts();
await auditWindowsOnlyPackaging();
await auditArtifacts();

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
}

if (jsonOutput) {
  const path = resolve(repoRoot, jsonOutput);
  const relativeOutput = relative(join(repoRoot, 'out'), path);
  if (!relativeOutput || relativeOutput.startsWith('..') || isAbsolute(relativeOutput)) {
    throw new Error('Audit JSON output must be a child of the repository out/ directory.');
  }
  await ensureDir(dirname(path));
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, auditedAt: new Date().toISOString(), passed: failed.length === 0, checks }, null, 2)}\n`,
    'utf8',
  );
}

if (failed.length) {
  process.exitCode = 1;
  process.stderr.write(`\nRelease-candidate audit failed ${failed.length} check(s).\n`);
} else {
  process.stdout.write('\nRelease-candidate audit passed. No publish action was performed.\n');
}
