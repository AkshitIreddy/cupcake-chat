#!/usr/bin/env node
import { basename, dirname, join, relative } from 'node:path';
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
const mode = parseArgValue(args, '--mode', 'package');
const requireSidecars = !args.includes('--allow-missing-sidecars');
const desktopOut = join(repoRoot, 'apps', 'desktop', 'out');
const sidecarDescriptor = await readJson(join(repoRoot, 'packaging', 'sidecars.json'));
const binarySuffix = '.exe';

if (!['package', 'make'].includes(mode)) throw new Error('--mode must be package or make');
if (targetPlatform !== 'win32' || targetArch !== 'x64') {
  throw new Error(
    `CUPCAKEAGI 2.0 package smoke supports Windows x64 only (received ${targetPlatform}-${targetArch}).`,
  );
}
if (!(await exists(desktopOut)))
  throw new Error('Electron Forge output is missing at apps/desktop/out');

const files = await walkFiles(desktopOut);
const executableNames = ['CUPCAKEAGI.exe'];
const launchers = files.filter((file) => {
  if (!executableNames.includes(basename(file))) return false;
  if (file.includes(`${join('resources', 'sidecars')}`)) return false;
  return true;
});
if (launchers.length === 0)
  throw new Error(`No packaged CUPCAKEAGI launcher found for ${targetPlatform}`);

const manifestPaths = files.filter((file) => basename(file) === 'sidecars.manifest.json');
if (requireSidecars && manifestPaths.length === 0) {
  throw new Error('The desktop package does not contain resources/sidecars/sidecars.manifest.json');
}

for (const manifestPath of manifestPaths) {
  const manifest = await readJson(manifestPath);
  if (manifest.platform !== targetPlatform)
    throw new Error(`Wrong sidecar platform in ${manifestPath}`);
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length !== 2) {
    throw new Error(`Expected both native sidecars in ${manifestPath}`);
  }
  const seen = new Set();
  for (const binary of manifest.binaries) {
    const descriptor = sidecarDescriptor.sidecars.find((item) => item.id === binary.id);
    if (!descriptor || seen.has(binary.id)) throw new Error(`Unexpected sidecar id: ${binary.id}`);
    seen.add(binary.id);
    const expectedName = `${descriptor.baseName}${binarySuffix}`;
    if (binary.file !== expectedName || binary.file !== basename(binary.file)) {
      throw new Error(`Unsafe or unexpected bundled sidecar filename: ${binary.file}`);
    }
    if (binary.transport !== descriptor.transport) {
      throw new Error(`Bundled sidecar transport mismatch: ${binary.id}`);
    }
    if (
      !Number.isSafeInteger(binary.bytes) ||
      binary.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(binary.sha256)
    ) {
      throw new Error(`Invalid bundled sidecar integrity metadata: ${binary.id}`);
    }
    const path = join(dirname(manifestPath), binary.file);
    if (!(await exists(path))) throw new Error(`Bundled sidecar is missing: ${binary.file}`);
    if ((await fileSize(path)) !== binary.bytes)
      throw new Error(`Bundled sidecar size mismatch: ${binary.file}`);
    if ((await sha256File(path)) !== binary.sha256)
      throw new Error(`Bundled sidecar digest mismatch: ${binary.file}`);
  }
  if (!Array.isArray(manifest.resources) || manifest.resources.length !== 1) {
    throw new Error(`Expected the Cupcake Local CPU baseline in ${manifestPath}`);
  }
  const resource = manifest.resources[0];
  if (
    resource.id !== 'cupcake-local-cpu-baseline' ||
    resource.directory !== 'cupcake-local' ||
    resource.manifest !== 'cupcake-local/cupcake-local.manifest.json' ||
    !/^[a-f0-9]{64}$/.test(resource.sha256)
  ) {
    throw new Error(`Invalid Cupcake Local resource metadata in ${manifestPath}`);
  }
  const localManifestPath = join(dirname(manifestPath), resource.manifest);
  if (!(await exists(localManifestPath)))
    throw new Error('Bundled Cupcake Local manifest is missing');
  if ((await sha256File(localManifestPath)) !== resource.sha256) {
    throw new Error('Bundled Cupcake Local manifest checksum mismatch');
  }
  const localManifest = await readJson(localManifestPath);
  if (
    localManifest.environment !== 'local-release-candidate' ||
    localManifest.productionSigning !== false ||
    localManifest.modelWeightsBundled !== false ||
    localManifest.runtimeFileCount !== 51
  ) {
    throw new Error('Bundled Cupcake Local manifest has invalid RC provenance');
  }
  const localFiles = await walkFiles(join(dirname(manifestPath), resource.directory));
  if (localFiles.some((file) => /\.gguf$/i.test(file))) {
    throw new Error('Bundled Cupcake Local resource must not contain model weights');
  }
}

if (mode === 'make') {
  const makeFiles = files.filter((file) => file.includes(`${join('out', 'make')}`));
  const installer = makeFiles.find((file) => /Setup\.exe$/i.test(file));
  if (!installer)
    throw new Error(`Electron Forge make did not produce an installer for ${targetPlatform}`);
  if ((await fileSize(installer)) === 0) throw new Error(`Installer is empty: ${installer}`);
  process.stdout.write(`Installer: ${relative(repoRoot, installer)}\n`);
}

process.stdout.write(
  `Package smoke passed: ${launchers.length} launcher(s), ${manifestPaths.length} verified sidecar manifest(s).\n`,
);
