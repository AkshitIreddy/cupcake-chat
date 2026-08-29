import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractSchemas } from '../src/registry.js';

interface Manifest {
  contractVersion: number;
  dialect: string;
  schemas: { name: string; file: string; sha256: string }[];
}

const schemaRoot = resolve(import.meta.dirname, '..', 'schema', 'v1');

describe('checked-in cross-language schemas', () => {
  it('publishes every registry entry exactly once with a verified digest', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(schemaRoot, 'manifest.json'), 'utf8'),
    ) as Manifest;
    expect(manifest.contractVersion).toBe(1);
    expect(manifest.dialect).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(manifest.schemas.map(({ name }) => name).sort()).toEqual(
      Object.keys(contractSchemas).sort(),
    );

    for (const entry of manifest.schemas) {
      const contents = await readFile(resolve(schemaRoot, entry.file), 'utf8');
      expect(createHash('sha256').update(contents).digest('hex')).toBe(entry.sha256);
      const schema = JSON.parse(contents) as Record<string, unknown>;
      expect(schema.$schema).toBe(manifest.dialect);
      expect(schema.$id).toBe(contractSchemas[entry.name as keyof typeof contractSchemas].$id);
    }
  });

  it('does not expose credential or raw-path fields in public schema property names', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(schemaRoot, 'manifest.json'), 'utf8'),
    ) as Manifest;
    for (const entry of manifest.schemas) {
      const schemaText = await readFile(resolve(schemaRoot, entry.file), 'utf8');
      expect(schemaText).not.toMatch(/"(?:apiKey|password|secret|rawPath|absolutePath)"\s*:/i);
    }
  });
});
