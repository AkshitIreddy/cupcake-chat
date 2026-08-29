import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { contractSchemas } from '../dist/registry.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(packageRoot, 'schema', 'v1');
const checkOnly = process.argv.includes('--check');

const generated = Object.entries(contractSchemas)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, schema]) => {
    const document = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema };
    const contents = `${JSON.stringify(document, null, 2)}\n`;
    return {
      name,
      file: `${name}.schema.json`,
      contents,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  });

const manifest = `${JSON.stringify(
  {
    contractVersion: 1,
    dialect: 'https://json-schema.org/draft/2020-12/schema',
    schemas: generated.map(({ name, file, sha256 }) => ({ name, file, sha256 })),
  },
  null,
  2,
)}\n`;

if (checkOnly) {
  const mismatches = [];
  for (const entry of generated) {
    if ((await readExisting(resolve(outputRoot, entry.file))) !== entry.contents)
      mismatches.push(entry.file);
  }
  if ((await readExisting(resolve(outputRoot, 'manifest.json'))) !== manifest)
    mismatches.push('manifest.json');
  if (mismatches.length > 0) {
    throw new Error(`Generated schemas are stale: ${mismatches.join(', ')}`);
  }
} else {
  await mkdir(outputRoot, { recursive: true });
  await Promise.all(
    generated.map((entry) => writeFile(resolve(outputRoot, entry.file), entry.contents)),
  );
  await writeFile(resolve(outputRoot, 'manifest.json'), manifest);
}

const languageGenerator = resolve(packageRoot, 'scripts', 'generate-language-bindings.mjs');
const languageResult = spawnSync(
  process.execPath,
  [languageGenerator, ...(checkOnly ? ['--check'] : [])],
  { stdio: 'inherit' },
);
if (languageResult.status !== 0) {
  throw new Error(
    `Cross-language contract generation failed with exit code ${languageResult.status}`,
  );
}

async function readExisting(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
