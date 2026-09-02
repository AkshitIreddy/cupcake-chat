#!/usr/bin/env node
import { copyFile, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promoteDirectory } from './lib/atomic-directory.mjs';
import {
  commandExists,
  ensureDir,
  exists,
  fileSize,
  isWindows,
  parseArgValue,
  readJson,
  repoRoot,
  run,
  sha256File,
} from './lib/process.mjs';

const args = process.argv.slice(2);
const targetPlatform = parseArgValue(args, '--platform', process.platform);
const targetArch = parseArgValue(args, '--arch', process.arch);
const verifyOnly = args.includes('--verify-only');
const clean = !args.includes('--no-clean');
const skipRuntime = args.includes('--skip-runtime');
const skipBroker = args.includes('--skip-broker');
const skipCupcakeLocal = args.includes('--skip-cupcake-local');
const reuseNative = args.includes('--reuse-native');
const reuseRuntime = args.includes('--reuse-runtime');

if (targetPlatform !== 'win32' || targetArch !== 'x64') {
  throw new Error(
    `CupcakeAI 2.0 sidecars support Windows x64 only (received ${targetPlatform}-${targetArch}).`,
  );
}
if (!verifyOnly && (targetPlatform !== process.platform || targetArch !== process.arch)) {
  throw new Error(
    `Sidecars are native builds. Run this script on ${targetPlatform}/${targetArch}; the current host is ${process.platform}/${process.arch}.`,
  );
}

const descriptorPath = join(repoRoot, 'packaging', 'sidecars.json');
const finalOutputDir = resolve(
  parseArgValue(
    args,
    '--out-dir',
    join(repoRoot, 'out', 'sidecars', `${targetPlatform}-${targetArch}`, 'sidecars'),
  ),
);
const relativeFinalOutput = relative(join(repoRoot, 'out'), finalOutputDir);
if (
  !relativeFinalOutput ||
  relativeFinalOutput.startsWith('..') ||
  isAbsolute(relativeFinalOutput)
) {
  throw new Error('Sidecar output must be a child of the repository out/ directory.');
}
const stagingOutputDir = join(
  dirname(finalOutputDir),
  `.${basename(finalOutputDir)}.staging-${String(process.pid)}`,
);
const outputDir = verifyOnly ? finalOutputDir : stagingOutputDir;
const manifestPath = join(outputDir, 'sidecars.manifest.json');
const binarySuffix = '.exe';
const targetTriple = 'x86_64-pc-windows-msvc';
const descriptor = await readJson(descriptorPath);
const tauriRoot = join(repoRoot, 'apps', 'desktop', 'src-tauri');
const tauriBinaryDir = join(tauriRoot, 'binaries');
const tauriResourceDir = join(tauriRoot, 'resources', 'sidecars');

async function cleanStaleStagingDirectories() {
  const parent = dirname(finalOutputDir);
  const resolvedParent = resolve(parent);
  const prefix = `.${basename(finalOutputDir)}.staging-`;
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const candidate = resolve(parent, entry.name);
    if (dirname(candidate) !== resolvedParent || !basename(candidate).startsWith(prefix)) {
      throw new Error(`Refusing to clean unsafe sidecar staging path: ${candidate}`);
    }
    const details = await stat(candidate);
    if (Date.now() - details.mtimeMs < 6 * 60 * 60 * 1000) continue;
    await rm(candidate, { recursive: true, force: true });
    process.stdout.write(
      `Removed stale sidecar staging directory ${relative(repoRoot, candidate)}.\n`,
    );
  }
}

async function pythonCommand() {
  const localVenv = join(repoRoot, 'services', 'runtime', '.venv', 'Scripts', 'python.exe');
  if (isWindows && (await exists(localVenv))) return localVenv;
  const python = isWindows ? 'python' : commandExists('python3') ? 'python3' : 'python';
  if (!commandExists(python))
    throw new Error('Python 3.12 or newer is required to package the runtime.');
  return python;
}

function outputName(id) {
  const item = descriptor.sidecars.find((sidecar) => sidecar.id === id);
  if (!item) throw new Error(`Missing ${id} in ${relative(repoRoot, descriptorPath)}`);
  return `${item.baseName}${binarySuffix}`;
}

function tauriExternalBinName(id) {
  const item = descriptor.sidecars.find((sidecar) => sidecar.id === id);
  if (!item) throw new Error(`Missing ${id} in ${relative(repoRoot, descriptorPath)}`);
  return `${item.baseName}-${targetTriple}${binarySuffix}`;
}

async function findRuntimeEntry() {
  const candidates = [
    'services/runtime/src/cupcake_runtime/__main__.py',
    'services/runtime/src/cupcake_runtime/main.py',
    'services/runtime/main.py',
  ];
  for (const candidate of candidates) {
    const absolute = join(repoRoot, candidate);
    if (await exists(absolute)) return absolute;
  }
  throw new Error(`No Python runtime entry point found. Checked: ${candidates.join(', ')}`);
}

async function buildRuntime() {
  const python = await pythonCommand();
  run(python, ['-c', 'import sqlcipher3']);
  const sourceRoot = join(repoRoot, 'services', 'runtime', 'src');
  const sourceEntry = await findRuntimeEntry();
  const buildRoot = join(repoRoot, 'out', 'pyinstaller', `${targetPlatform}-${targetArch}`);
  const distRoot = join(buildRoot, 'dist');
  const snapshotRoot = join(buildRoot, 'source-snapshot');
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
  // PyInstaller analysis can take many minutes. Build from one immutable
  // source snapshot so edits made during that window cannot produce a frozen
  // runtime containing modules from different workspace revisions. Generated
  // bytecode is deliberately excluded; PyInstaller compiles the snapshotted
  // source itself.
  await cp(sourceRoot, snapshotRoot, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/u).includes('__pycache__') && !source.endsWith('.pyc'),
  });
  const entry = join(snapshotRoot, relative(sourceRoot, sourceEntry));
  run(
    python,
    [
      '-m',
      'PyInstaller',
      '--noconfirm',
      '--clean',
      '--onefile',
      '--name',
      'cupcake-runtime',
      '--paths',
      snapshotRoot,
      '--hidden-import',
      'sqlcipher3',
      '--copy-metadata',
      'dbos',
      '--copy-metadata',
      'cohere',
      '--copy-metadata',
      'latex2mathml',
      '--distpath',
      distRoot,
      '--workpath',
      join(buildRoot, 'work'),
      '--specpath',
      join(buildRoot, 'spec'),
      entry,
    ],
    {
      env: {
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: snapshotRoot,
      },
    },
  );
  const built = join(distRoot, outputName('runtime'));
  if (!(await exists(built))) throw new Error(`PyInstaller did not create ${built}`);
  run(built, ['--help']);
  await copyFile(built, join(outputDir, outputName('runtime')));
}

async function reuseFrozenRuntime() {
  const built = join(
    repoRoot,
    'out',
    'pyinstaller',
    `${targetPlatform}-${targetArch}`,
    'dist',
    outputName('runtime'),
  );
  if (!(await exists(built))) {
    throw new Error(`Reusable frozen runtime is missing: ${built}`);
  }
  run(built, ['--help']);
  await copyFile(built, join(outputDir, outputName('runtime')));
}

async function stageCupcakeLocal({ verify = false } = {}) {
  const command = await pythonCommand();
  const localOutput = join(outputDir, 'cupcake-local');
  const localArgs = [join(repoRoot, 'scripts', 'stage-cupcake-local.py'), '--out-dir', localOutput];
  if (verify) localArgs.push('--verify-only');
  run(command, localArgs);
}

async function buildBroker() {
  const userProfile = process.env.USERPROFILE ?? '';
  const standardCargo = join(userProfile, '.cargo', 'bin', 'cargo.exe');
  const cargo = commandExists('cargo')
    ? 'cargo'
    : (await exists(standardCargo))
      ? standardCargo
      : '';
  if (!cargo) throw new Error('The stable Rust toolchain is required to package the broker.');
  const manifest = join(repoRoot, 'crates', 'tool-broker', 'Cargo.toml');
  const targetDir = join(repoRoot, 'out', 'cargo', `${targetPlatform}-${targetArch}`);
  run(cargo, [
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    manifest,
    '--target-dir',
    targetDir,
  ]);
  const built = join(targetDir, 'release', outputName('tool-broker'));
  if (!(await exists(built))) throw new Error(`Cargo did not create ${built}`);
  await copyFile(built, join(outputDir, outputName('tool-broker')));
}

async function createManifest() {
  const binaries = [];
  for (const sidecar of descriptor.sidecars) {
    if ((sidecar.id === 'runtime' && skipRuntime) || (sidecar.id === 'tool-broker' && skipBroker))
      continue;
    const file = join(outputDir, outputName(sidecar.id));
    if (!(await exists(file))) throw new Error(`Missing packaged sidecar: ${file}`);
    binaries.push({
      id: sidecar.id,
      file: basename(file),
      bytes: await fileSize(file),
      sha256: await sha256File(file),
      transport: sidecar.transport,
    });
  }
  const manifest = {
    schemaVersion: descriptor.schemaVersion,
    protocolVersion: descriptor.protocolVersion,
    platform: targetPlatform,
    architecture: targetArch,
    generatedAt: new Date().toISOString(),
    binaries,
    resources: skipCupcakeLocal
      ? []
      : [
          {
            id: 'cupcake-local-cpu-baseline',
            directory: 'cupcake-local',
            manifest: 'cupcake-local/cupcake-local.manifest.json',
            sha256: await sha256File(
              join(outputDir, 'cupcake-local', 'cupcake-local.manifest.json'),
            ),
          },
        ],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function verifyManifest() {
  if (!(await exists(manifestPath))) throw new Error(`Sidecar manifest not found: ${manifestPath}`);
  const manifest = await readJson(manifestPath);
  if (
    manifest.schemaVersion !== descriptor.schemaVersion ||
    manifest.protocolVersion !== descriptor.protocolVersion
  ) {
    throw new Error('Sidecar manifest version does not match packaging/sidecars.json');
  }
  if (manifest.platform !== targetPlatform || manifest.architecture !== targetArch) {
    throw new Error('Sidecar manifest target does not match the requested platform/architecture');
  }
  const expected = descriptor.sidecars.filter(
    (sidecar) =>
      !((sidecar.id === 'runtime' && skipRuntime) || (sidecar.id === 'tool-broker' && skipBroker)),
  );
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length !== expected.length) {
    throw new Error(`Sidecar manifest must contain exactly ${expected.length} binary record(s)`);
  }
  const seen = new Set();
  for (const binary of manifest.binaries) {
    const sidecar = expected.find((item) => item.id === binary.id);
    if (!sidecar || seen.has(binary.id))
      throw new Error(`Unexpected or duplicate sidecar: ${binary.id}`);
    seen.add(binary.id);
    if (binary.file !== outputName(binary.id) || binary.file !== basename(binary.file)) {
      throw new Error(`Unsafe or unexpected filename for ${binary.id}`);
    }
    if (binary.transport !== sidecar.transport)
      throw new Error(`Transport mismatch for ${binary.id}`);
    if (!Number.isSafeInteger(binary.bytes) || binary.bytes <= 0) {
      throw new Error(`Invalid byte length for ${binary.id}`);
    }
    if (!/^[a-f0-9]{64}$/.test(binary.sha256)) throw new Error(`Invalid SHA-256 for ${binary.id}`);
    const file = join(outputDir, binary.file);
    if (!(await exists(file))) throw new Error(`Manifest references missing file: ${binary.file}`);
    if ((await fileSize(file)) !== binary.bytes)
      throw new Error(`Size mismatch for ${binary.file}`);
    if ((await sha256File(file)) !== binary.sha256)
      throw new Error(`SHA-256 mismatch for ${binary.file}`);
  }
  const expectedResources = skipCupcakeLocal ? 0 : 1;
  if (!Array.isArray(manifest.resources) || manifest.resources.length !== expectedResources) {
    throw new Error(
      `Sidecar manifest must contain exactly ${expectedResources} resource record(s)`,
    );
  }
  if (!skipCupcakeLocal) {
    const resource = manifest.resources[0];
    if (
      resource.id !== 'cupcake-local-cpu-baseline' ||
      resource.directory !== 'cupcake-local' ||
      resource.manifest !== 'cupcake-local/cupcake-local.manifest.json' ||
      !/^[a-f0-9]{64}$/.test(resource.sha256)
    ) {
      throw new Error('Cupcake Local sidecar resource record is invalid');
    }
    const resourceManifest = join(outputDir, resource.manifest);
    if (!(await exists(resourceManifest)))
      throw new Error(`Cupcake Local manifest is missing: ${resourceManifest}`);
    if ((await sha256File(resourceManifest)) !== resource.sha256)
      throw new Error('Cupcake Local resource manifest checksum mismatch');
  }
  process.stdout.write(
    `Verified ${manifest.binaries.length} sidecar(s) in ${relative(repoRoot, outputDir)}.\n`,
  );
}

async function stageTauriBundleInputs() {
  const binaryStaging = join(
    dirname(tauriBinaryDir),
    `.${basename(tauriBinaryDir)}.staging-${String(process.pid)}`,
  );
  const resourceStaging = join(
    dirname(tauriResourceDir),
    `.${basename(tauriResourceDir)}.staging-${String(process.pid)}`,
  );
  await rm(binaryStaging, { recursive: true, force: true });
  await rm(resourceStaging, { recursive: true, force: true });
  await mkdir(binaryStaging, { recursive: true });
  await mkdir(resourceStaging, { recursive: true });

  for (const sidecar of descriptor.sidecars) {
    if ((sidecar.id === 'runtime' && skipRuntime) || (sidecar.id === 'tool-broker' && skipBroker)) {
      continue;
    }
    const source = join(finalOutputDir, outputName(sidecar.id));
    await copyFile(source, join(binaryStaging, tauriExternalBinName(sidecar.id)));
    // Keep a verified, self-contained directory for the Rust host. Tauri's
    // externalBin source names carry the target triple, while the packaged
    // executable names and verified manifest deliberately do not.
    await copyFile(source, join(resourceStaging, outputName(sidecar.id)));
  }
  await copyFile(
    join(finalOutputDir, 'sidecars.manifest.json'),
    join(resourceStaging, 'sidecars.manifest.json'),
  );
  await copyFile(join(finalOutputDir, 'LICENSE.txt'), join(resourceStaging, 'LICENSE.txt'));
  if (!skipCupcakeLocal) {
    await cp(join(finalOutputDir, 'cupcake-local'), join(resourceStaging, 'cupcake-local'), {
      recursive: true,
    });
  }

  await ensureDir(dirname(tauriBinaryDir));
  await ensureDir(dirname(tauriResourceDir));
  await promoteDirectory(binaryStaging, tauriBinaryDir);
  await promoteDirectory(resourceStaging, tauriResourceDir);
  process.stdout.write(
    `Staged Tauri externalBin inputs for ${targetTriple} and verified resources/sidecars.\n`,
  );
}

await cleanStaleStagingDirectories();

if (verifyOnly) {
  if (!skipCupcakeLocal) await stageCupcakeLocal({ verify: true });
  await verifyManifest();
} else {
  await rm(stagingOutputDir, { recursive: true, force: true });
  if ((!clean || reuseNative) && (await exists(finalOutputDir))) {
    await cp(finalOutputDir, stagingOutputDir, { recursive: true });
  }
  await ensureDir(outputDir);
  if (!skipRuntime && !reuseNative) {
    if (reuseRuntime) await reuseFrozenRuntime();
    else await buildRuntime();
  }
  if (!skipBroker && !reuseNative) await buildBroker();
  if (!skipCupcakeLocal) await stageCupcakeLocal();
  await copyFile(join(repoRoot, 'LICENSE'), join(outputDir, 'LICENSE.txt'));
  await createManifest();
  await verifyManifest();
  await promoteDirectory(stagingOutputDir, finalOutputDir);
  await stageTauriBundleInputs();
  process.stdout.write(`Promoted verified sidecars to ${relativeFinalOutput}.\n`);
}
