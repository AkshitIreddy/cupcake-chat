import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileHandleRegistry } from './file-handles';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('main-owned file handles', () => {
  it('keeps native paths private while resolving an active attachment internally', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cupcake-handles-'));
    cleanup.push(directory);
    const path = join(directory, 'notes.txt');
    await writeFile(path, 'cupcake');
    const registry = new FileHandleRegistry();

    const publicHandle = await registry.registerExisting(path);
    const [internal] = registry.resolveActiveAttachments([publicHandle.id]);

    expect(publicHandle).not.toHaveProperty('absolutePath');
    expect(internal?.absolutePath).toBe(path);
    expect(registry.release(publicHandle.id)).toBe(true);
    expect(() => registry.resolveActiveAttachments([publicHandle.id])).toThrow(
      'Attachment handle is unavailable',
    );
  });

  it('rejects directory and writable capabilities as chat attachments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cupcake-handles-'));
    cleanup.push(directory);
    const registry = new FileHandleRegistry();
    const publicHandle = await registry.registerExisting(directory);

    expect(() => registry.resolveActiveAttachments([publicHandle.id])).toThrow(
      'Attachment handle is unavailable',
    );
  });
});
