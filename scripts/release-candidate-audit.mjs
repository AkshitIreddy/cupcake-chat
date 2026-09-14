#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  ensureDir,
  exists,
  fileSize,
  parseArgValue,
  readJson,
  repoRoot,
  run,
  sha256File,
  walkFiles,
} from './lib/process.mjs';

const args = process.argv.slice(2);
const requireArtifacts = args.includes('--require-artifacts');
const requireUpdaterArtifacts = args.includes('--require-updater-artifacts');
const requireAuthenticode = args.includes('--require-authenticode');
const jsonOutput = parseArgValue(args, '--json', null);
const checks = [];
const targetTriple = 'x86_64-pc-windows-msvc';

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function assertReleaseVersion(label, version) {
  record(`${label} version`, version === '1.8.0', String(version ?? 'missing'));
}

async function auditVersions() {
  for (const path of [
    'package.json',
    'apps/desktop/package.json',
    'packages/contracts/package.json',
  ]) {
    const manifest = await readJson(join(repoRoot, path));
    assertReleaseVersion(path, manifest.version);
    record(
      `${path} private`,
      manifest.private === true,
      manifest.private === true ? 'private' : 'must remain private',
    );
  }
  for (const path of ['apps/desktop/src-tauri/Cargo.toml', 'crates/tool-broker/Cargo.toml']) {
    const cargo = await readFile(join(repoRoot, path), 'utf8');
    assertReleaseVersion(path, cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]);
  }
  const pyproject = await readFile(join(repoRoot, 'services/runtime/pyproject.toml'), 'utf8');
  const pythonVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  record(
    'services/runtime/pyproject.toml version',
    pythonVersion === '1.8.0',
    String(pythonVersion ?? 'missing'),
  );
  const runtimeInit = await readFile(
    join(repoRoot, 'services/runtime/src/cupcake_runtime/__init__.py'),
    'utf8',
  );
  assertReleaseVersion(
    'services/runtime/src/cupcake_runtime/__init__.py',
    runtimeInit.match(/^__version__\s*=\s*"([^"]+)"/m)?.[1],
  );
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
  for (const lockfile of [
    'pnpm-lock.yaml',
    'apps/desktop/src-tauri/Cargo.lock',
    'crates/tool-broker/Cargo.lock',
  ]) {
    record(`${lockfile} present`, await exists(join(repoRoot, lockfile)), lockfile);
  }
}

async function auditAutomationPolicy() {
  const workflows = await walkFiles(join(repoRoot, '.github/workflows'));
  const releasePath = join(repoRoot, '.github/workflows/release-windows.yml');
  const release = await readFile(releasePath, 'utf8');
  const unsafeWorkflows = [];
  for (const file of workflows) {
    if (file === releasePath) continue;
    const source = await readFile(file, 'utf8');
    if (/contents\s*:\s*write/i.test(source)) {
      unsafeWorkflows.push(`${relative(repoRoot, file)} grants contents: write`);
    }
  }
  const releaseIsGated =
    /^\s*workflow_dispatch\s*:/m.test(release) &&
    !/^\s*(?:push|pull_request|schedule)\s*:/m.test(release) &&
    /^\s*environment\s*:\s*release\s*$/m.test(release) &&
    /^\s*contents\s*:\s*write\s*$/m.test(release) &&
    /^\s*releaseDraft\s*:\s*true\s*$/m.test(release) &&
    /^\s*uploadUpdaterJson\s*:\s*true\s*$/m.test(release) &&
    /^\s*updaterJsonPreferNsis\s*:\s*true\s*$/m.test(release) &&
    /tauri-apps\/tauri-action@944946e3e4cac6603d1fe8f514171e9ecd3c78aa/.test(release) &&
    /TAURI_UPDATER_PUBLIC_KEY/.test(release) &&
    /TAURI_SIGNING_PRIVATE_KEY/.test(release) &&
    /WINDOWS_CERTIFICATE/.test(release) &&
    /AUTHENTICODE_ENABLED=false/.test(release);
  record(
    'Release automation is manual, environment-gated, updater-signed, and draft-only',
    releaseIsGated && unsafeWorkflows.length === 0,
    releaseIsGated && unsafeWorkflows.length === 0
      ? 'workflow_dispatch -> protected release environment -> GitHub draft'
      : ['release workflow policy drift', ...unsafeWorkflows].join('; '),
  );

  const mainConfig = await readJson(join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json'));
  const testConfig = await readJson(
    join(repoRoot, 'apps/desktop/src-tauri/tauri.updater-test.conf.json'),
  );
  const updaterSource = await readFile(
    join(repoRoot, 'apps/desktop/src-tauri/src/app_updates.rs'),
    'utf8',
  );
  const updaterPolicy =
    typeof mainConfig.plugins?.updater?.pubkey === 'string' &&
    mainConfig.bundle?.createUpdaterArtifacts !== true &&
    mainConfig.plugins?.updater?.dangerousInsecureTransportProtocol !== true &&
    testConfig.plugins?.updater?.dangerousInsecureTransportProtocol === true &&
    updaterSource.includes('option_env!("CUPCAKE_UPDATER_PUBLIC_KEY")') &&
    updaterSource.includes('releases/latest/download/latest.json') &&
    updaterSource.includes('CUPCAKE_TEST_DATA_DIR') &&
    updaterSource.includes('127.0.0.1') &&
    updaterSource.includes('localhost');
  record(
    'Signed updater configuration is explicit and test transport is isolated',
    updaterPolicy,
    updaterPolicy
      ? 'production HTTPS feed with compile-time verification key; HTTP limited to test config and loopback profile'
      : 'updater configuration policy drift',
  );
}

async function auditRemovedIntegrations() {
  const roots = [
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'apps/desktop/package.json',
    'apps/desktop/src',
    'apps/desktop/src-tauri',
    'services/runtime/src',
    'crates/tool-broker/src',
    'packages/contracts/src',
    'packages/contracts/schema',
    'README.md',
    'docs/development.md',
    'docs/local-testing.md',
    'docs/known-issues.md',
    'docs/free-tier-guide.md',
    'docs/user-guide.md',
    'docs/architecture',
    'packaging/README.md',
    'packages/contracts/README.md',
  ];
  const violations = [];
  for (const root of roots) {
    const absolute = join(repoRoot, root);
    const files =
      (await exists(absolute)) && extname(absolute) ? [absolute] : await walkFiles(absolute);
    for (const file of files) {
      if (/[/\\](?:PAUSED_HANDOFF|RESEARCH_LEDGER|REPOSITORY_AUDIT)\.md$/i.test(file)) continue;
      const extension = extname(file).toLowerCase();
      if (
        !new Set([
          '.md',
          '.json',
          '.yaml',
          '.yml',
          '.toml',
          '.ts',
          '.tsx',
          '.js',
          '.mjs',
          '.py',
          '.rs',
        ]).has(extension)
      ) {
        continue;
      }
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!/(?:electron|squirrel|lm[ _-]?studio|ollama)/i.test(line)) continue;
        const negativeRemovalTest =
          /ensure_runtime_method_allowed/.test(line) && /\.is_err\(\)/.test(line);
        const explicitHistorical =
          /histor(?:y|ic|ical)|rejected baseline|removed migration|intentionally excludes/i.test(
            line,
          );
        if (!negativeRemovalTest && !explicitHistorical) {
          violations.push(`${relative(repoRoot, file)}:${index + 1}`);
        }
      }
    }
  }
  record(
    'No active rejected desktop/local-runtime references',
    violations.length === 0,
    violations.length ? violations.join(', ') : 'clean',
  );
}

async function auditContracts() {
  const sidecars = await readJson(join(repoRoot, 'packaging', 'sidecars.json'));
  const ids = sidecars.sidecars
    ?.map((entry) => entry.id)
    .sort()
    .join(',');
  record(
    'Sidecar descriptor',
    sidecars.schemaVersion === 1 && sidecars.protocolVersion === 1 && ids === 'runtime,tool-broker',
    `schema=${String(sidecars.schemaVersion)} protocol=${String(sidecars.protocolVersion)} ids=${ids ?? 'missing'}`,
  );
}

async function auditWindowsOnlyPackaging() {
  const config = await readJson(join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json'));
  const packageScript = await readFile(join(repoRoot, 'scripts/package-sidecars.mjs'), 'utf8');
  const workflow = await readFile(join(repoRoot, '.github/workflows/desktop-builds.yml'), 'utf8');
  const externalBins = config.bundle?.externalBin ?? [];
  const resources = config.bundle?.resources ?? [];
  const hasSidecarResource = Array.isArray(resources)
    ? resources.includes('resources/sidecars')
    : ['sidecars', 'sidecars/'].includes(
        resources['resources/sidecars'] ?? resources['resources/sidecars/'],
      );
  const valid =
    JSON.stringify(config.bundle?.targets) === JSON.stringify(['nsis']) &&
    externalBins.includes('binaries/cupcake-runtime') &&
    externalBins.includes('binaries/cupcake-tool-broker') &&
    hasSidecarResource &&
    packageScript.includes("targetPlatform !== 'win32' || targetArch !== 'x64'") &&
    packageScript.includes(targetTriple) &&
    packageScript.includes("'--onedir'") &&
    packageScript.includes("'--contents-directory'") &&
    !packageScript.includes("'--onefile'") &&
    /runs-on:\s*windows-latest/.test(workflow) &&
    /bundle:nsis/.test(workflow) &&
    !/runs-on:\s*(?:ubuntu|macos)-latest/.test(workflow);
  record(
    'Windows x64 Tauri NSIS packaging policy',
    valid,
    valid ? 'Tauri NSIS, target-triple sidecars, resources, and Windows-only CI' : 'policy drift',
  );
  const windows = config.app?.windows ?? [];
  record(
    'Native WebView zoom hotkeys',
    windows.length > 0 && windows.every((window) => window.zoomHotkeysEnabled === true),
    windows.length > 0 && windows.every((window) => window.zoomHotkeysEnabled === true)
      ? 'enabled for every packaged window'
      : 'zoomHotkeysEnabled must be true for every packaged window',
  );
}

async function auditArtifacts() {
  const tauriRoot = join(repoRoot, 'apps', 'desktop', 'src-tauri');
  const resourceRoot = join(tauriRoot, 'resources', 'sidecars');
  const binaryRoot = join(tauriRoot, 'binaries');
  const manifestPath = join(resourceRoot, 'sidecars.manifest.json');
  if (!(await exists(manifestPath))) {
    record(
      'Staged Tauri sidecars',
      !requireArtifacts,
      requireArtifacts ? 'missing' : 'not required',
    );
  } else {
    const manifest = await readJson(manifestPath);
    const descriptor = await readJson(join(repoRoot, 'packaging/sidecars.json'));
    let valid =
      manifest.schemaVersion === descriptor.schemaVersion &&
      manifest.protocolVersion === descriptor.protocolVersion &&
      manifest.platform === 'win32' &&
      manifest.architecture === 'x64' &&
      manifest.binaries?.length === descriptor.sidecars.length;
    for (const binary of manifest.binaries ?? []) {
      const expected = descriptor.sidecars.find((item) => item.id === binary.id);
      const packaged = join(resourceRoot, binary.file);
      const external = join(binaryRoot, `${expected?.baseName}-${targetTriple}.exe`);
      valid &&=
        Boolean(expected) &&
        binary.file === `${expected?.baseName}.exe` &&
        binary.file === basename(binary.file) &&
        binary.transport === expected?.transport &&
        Number.isSafeInteger(binary.bytes) &&
        binary.bytes > 0 &&
        /^[a-f0-9]{64}$/.test(binary.sha256) &&
        (await exists(packaged)) &&
        (await exists(external));
      if (valid) {
        valid &&=
          (await fileSize(packaged)) === binary.bytes &&
          (await fileSize(external)) === binary.bytes &&
          (await sha256File(packaged)) === binary.sha256 &&
          (await sha256File(external)) === binary.sha256;
      }
      if (binary.id === 'runtime') {
        const supportRecords = Array.isArray(binary.supportFiles) ? binary.supportFiles : [];
        const actualSupportFiles = (await walkFiles(join(resourceRoot, '_internal')))
          .map((path) => relative(resourceRoot, path).replaceAll('\\', '/'))
          .sort((left, right) => left.localeCompare(right));
        const declaredSupportFiles = supportRecords
          .map((record) => (typeof record?.file === 'string' ? record.file : ''))
          .sort((left, right) => left.localeCompare(right));
        valid &&=
          supportRecords.length > 0 &&
          JSON.stringify(actualSupportFiles) === JSON.stringify(declaredSupportFiles);
        for (const record of supportRecords) {
          if (!record || typeof record !== 'object') {
            valid = false;
            continue;
          }
          const supportRelative = typeof record.file === 'string' ? record.file : 'missing';
          const supportFile = join(resourceRoot, supportRelative);
          valid &&=
            typeof record.file === 'string' &&
            record.file.startsWith('_internal/') &&
            !record.file.includes('\\') &&
            !record.file.split('/').some((part) => !part || part === '.' || part === '..') &&
            Number.isSafeInteger(record.bytes) &&
            record.bytes >= 0 &&
            /^[a-f0-9]{64}$/.test(record.sha256 ?? '') &&
            (await exists(supportFile));
          if (await exists(supportFile)) {
            valid &&=
              (await fileSize(supportFile)) === record.bytes &&
              (await sha256File(supportFile)) === record.sha256;
          }
        }
      } else {
        valid &&= Array.isArray(binary.supportFiles) && binary.supportFiles.length === 0;
      }
    }
    const resource = manifest.resources?.[0];
    const localManifest = join(resourceRoot, resource?.manifest ?? 'missing');
    valid &&=
      manifest.resources?.length === 1 &&
      resource?.id === 'cupcake-local-cpu-baseline' &&
      resource?.directory === 'cupcake-local' &&
      resource?.manifest === 'cupcake-local/cupcake-local.manifest.json' &&
      /^[a-f0-9]{64}$/.test(resource?.sha256 ?? '') &&
      (await exists(localManifest));
    if (await exists(localManifest))
      valid &&= (await sha256File(localManifest)) === resource.sha256;
    if (await exists(localManifest)) {
      const local = await readJson(localManifest);
      const runtimeCatalog = join(resourceRoot, 'cupcake-local/cupcake-local-runtime-v1.json');
      const modelCatalog = join(resourceRoot, 'cupcake-local/cupcake-local-models-v1.json');
      const publicKeys = join(resourceRoot, 'cupcake-local/cupcake-local-public-keys.json');
      valid &&=
        local.modelWeightsBundled === false &&
        Number.isSafeInteger(local.modelCount) &&
        local.modelCount > 0 &&
        (await exists(runtimeCatalog)) &&
        (await exists(modelCatalog)) &&
        (await exists(publicKeys));
      if (
        (await exists(runtimeCatalog)) &&
        (await exists(modelCatalog)) &&
        (await exists(publicKeys))
      ) {
        valid &&=
          (await sha256File(runtimeCatalog)) === local.catalogSha256 &&
          (await sha256File(modelCatalog)) === local.modelCatalogSha256 &&
          (await sha256File(publicKeys)) === local.publicKeysSha256;
      }
    }
    const localFiles = await walkFiles(join(resourceRoot, 'cupcake-local'));
    valid &&= !localFiles.some((file) => /\.gguf$/i.test(file));
    record(
      'Staged Tauri sidecars',
      valid,
      valid ? 'verified externalBin and resource inputs' : 'invalid',
    );
  }

  const releaseRoot = join(tauriRoot, 'target/release');
  const launcher = join(releaseRoot, 'CupcakeAI.exe');
  const installers = (await walkFiles(join(releaseRoot, 'bundle/nsis'))).filter((file) =>
    /-setup\.exe$/i.test(file),
  );
  const packaged =
    (await exists(launcher)) &&
    (await fileSize(launcher)) > 0 &&
    installers.length === 1 &&
    (await fileSize(installers[0])) > 0;
  record(
    'Tauri executable and NSIS installer',
    !requireArtifacts || packaged,
    requireArtifacts ? (packaged ? relative(repoRoot, installers[0]) : 'missing') : 'not required',
  );

  if (requireUpdaterArtifacts || requireAuthenticode) {
    const installer = installers[0];
    const signature = installer ? `${installer}.sig` : '';
    const hasUpdaterSignature =
      Boolean(signature) && (await exists(signature)) && (await fileSize(signature)) > 0;
    record(
      'Release NSIS has a Tauri updater signature',
      hasUpdaterSignature,
      `updaterSignature=${String(hasUpdaterSignature)}`,
    );
    let authenticodeValid = !requireAuthenticode;
    if (requireAuthenticode && process.platform === 'win32' && installer) {
      const status = run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-AuthenticodeSignature -LiteralPath $args[0]).Status.ToString()`,
          installer,
        ],
        { capture: true },
      ).stdout.trim();
      authenticodeValid = status === 'Valid';
    }
    if (requireAuthenticode) {
      record(
        'Release NSIS has a valid optional Authenticode signature',
        authenticodeValid,
        `authenticode=${String(authenticodeValid)}`,
      );
    }
  }
}

await auditVersions();
await auditTrackedState();
await auditAutomationPolicy();
await auditRemovedIntegrations();
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
  process.stderr.write(`\nLocal-candidate audit failed ${failed.length} check(s).\n`);
} else {
  process.stdout.write('\nLocal-candidate audit passed. No publish action was performed.\n');
}
