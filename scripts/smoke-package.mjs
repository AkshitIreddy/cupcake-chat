#!/usr/bin/env node
import { basename, join, relative } from 'node:path';
import {
  exists,
  fileSize,
  parseArgValue,
  readJson,
  repoRoot,
  sha256File,
  walkFiles,
} from './lib/process.mjs';

const args = process.argv.slice(2);
const targetPlatform = parseArgValue(args, '--platform', process.platform);
const targetArch = parseArgValue(args, '--arch', process.arch);
const mode = parseArgValue(args, '--mode', 'build');
const targetTriple = 'x86_64-pc-windows-msvc';
const tauriRoot = join(repoRoot, 'apps', 'desktop', 'src-tauri');
const releaseRoot = join(tauriRoot, 'target', 'release');
const resourceRoot = join(tauriRoot, 'resources', 'sidecars');
const binaryRoot = join(tauriRoot, 'binaries');
const descriptor = await readJson(join(repoRoot, 'packaging', 'sidecars.json'));

if (!['build', 'bundle'].includes(mode)) throw new Error('--mode must be build or bundle');
if (targetPlatform !== 'win32' || targetArch !== 'x64') {
  throw new Error(
    `CupcakeAI 2.0 package smoke supports Windows x64 only (received ${targetPlatform}-${targetArch}).`,
  );
}

const launcher = join(releaseRoot, 'CupcakeAI.exe');
if (!(await exists(launcher)) || (await fileSize(launcher)) === 0) {
  throw new Error(`Tauri release executable is missing or empty: ${relative(repoRoot, launcher)}`);
}

const manifestPath = join(resourceRoot, 'sidecars.manifest.json');
if (!(await exists(manifestPath))) {
  throw new Error('Tauri resources/sidecars/sidecars.manifest.json is missing');
}
const manifest = await readJson(manifestPath);
if (
  manifest.schemaVersion !== descriptor.schemaVersion ||
  manifest.protocolVersion !== descriptor.protocolVersion ||
  manifest.platform !== targetPlatform ||
  manifest.architecture !== targetArch
) {
  throw new Error('Tauri sidecar manifest target or protocol version is invalid');
}
if (!Array.isArray(manifest.binaries) || manifest.binaries.length !== descriptor.sidecars.length) {
  throw new Error('Tauri sidecar manifest does not contain the exact declared sidecar set');
}

const seen = new Set();
for (const binary of manifest.binaries) {
  const expected = descriptor.sidecars.find((item) => item.id === binary.id);
  if (!expected || seen.has(binary.id)) throw new Error(`Unexpected sidecar id: ${binary.id}`);
  seen.add(binary.id);
  const packagedName = `${expected.baseName}.exe`;
  const externalBinName = `${expected.baseName}-${targetTriple}.exe`;
  if (binary.file !== packagedName || binary.file !== basename(binary.file)) {
    throw new Error(`Unsafe or unexpected packaged sidecar filename: ${binary.file}`);
  }
  if (
    binary.transport !== expected.transport ||
    !Number.isSafeInteger(binary.bytes) ||
    binary.bytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(binary.sha256)
  ) {
    throw new Error(`Invalid sidecar metadata: ${binary.id}`);
  }
  for (const path of [join(resourceRoot, packagedName), join(binaryRoot, externalBinName)]) {
    if (!(await exists(path))) {
      throw new Error(`Tauri sidecar input is missing: ${relative(repoRoot, path)}`);
    }
    if ((await fileSize(path)) !== binary.bytes || (await sha256File(path)) !== binary.sha256) {
      throw new Error(
        `Tauri sidecar input failed integrity verification: ${relative(repoRoot, path)}`,
      );
    }
  }
}

if (!Array.isArray(manifest.resources) || manifest.resources.length !== 1) {
  throw new Error('Tauri sidecar manifest must contain the Cupcake Local CPU baseline');
}
const resource = manifest.resources[0];
if (
  resource.id !== 'cupcake-local-cpu-baseline' ||
  resource.directory !== 'cupcake-local' ||
  resource.manifest !== 'cupcake-local/cupcake-local.manifest.json' ||
  !/^[a-f0-9]{64}$/.test(resource.sha256)
) {
  throw new Error('Cupcake Local resource metadata is invalid');
}
const localManifestPath = join(resourceRoot, resource.manifest);
if (
  !(await exists(localManifestPath)) ||
  (await sha256File(localManifestPath)) !== resource.sha256
) {
  throw new Error('Cupcake Local resource manifest is missing or corrupt');
}
const localManifest = await readJson(localManifestPath);
if (
  localManifest.environment !== 'local-release-candidate' ||
  localManifest.productionSigning !== false ||
  localManifest.modelWeightsBundled !== false ||
  !Number.isSafeInteger(localManifest.runtimeFileCount) ||
  localManifest.runtimeFileCount <= 0
) {
  throw new Error('Cupcake Local resource manifest has invalid local-candidate provenance');
}
const runtimeCatalogPath = join(resourceRoot, resource.directory, 'cupcake-local-runtime-v1.json');
const modelCatalogPath = join(resourceRoot, resource.directory, 'cupcake-local-models-v1.json');
const publicKeysPath = join(resourceRoot, resource.directory, 'cupcake-local-public-keys.json');
if (
  !(await exists(runtimeCatalogPath)) ||
  localManifest.catalogSha256 !== (await sha256File(runtimeCatalogPath)) ||
  !(await exists(modelCatalogPath)) ||
  localManifest.modelCatalogSha256 !== (await sha256File(modelCatalogPath)) ||
  !(await exists(publicKeysPath)) ||
  localManifest.publicKeysSha256 !== (await sha256File(publicKeysPath)) ||
  !Number.isSafeInteger(localManifest.modelCount) ||
  localManifest.modelCount <= 0
) {
  throw new Error('Verified Cupcake Local catalogs or public keys are missing or corrupt');
}
const localFiles = await walkFiles(join(resourceRoot, resource.directory));
if (localFiles.some((file) => /\.gguf$/i.test(file))) {
  throw new Error('Tauri package inputs must not contain model weights');
}

if (mode === 'bundle') {
  const nsisRoot = join(releaseRoot, 'bundle', 'nsis');
  const installers = (await walkFiles(nsisRoot)).filter((file) => /-setup\.exe$/i.test(file));
  if (installers.length !== 1 || (await fileSize(installers[0])) === 0) {
    throw new Error('Tauri NSIS build must produce exactly one nonempty *-setup.exe installer');
  }
  process.stdout.write(`Unsigned NSIS installer: ${relative(repoRoot, installers[0])}\n`);
}

const releaseFiles = await walkFiles(releaseRoot);
const forbidden = releaseFiles.filter((file) =>
  /(?:electron|squirrel|\.nupkg$|(?:^|[\\/])RELEASES$)/i.test(relative(releaseRoot, file)),
);
if (forbidden.length) {
  throw new Error(`Tauri output contains rejected desktop artifacts: ${forbidden.join(', ')}`);
}

process.stdout.write(
  `Tauri package smoke passed: ${relative(repoRoot, launcher)}, ${manifest.binaries.length} sidecars, Cupcake Local CPU baseline, mode=${mode}.\n`,
);
