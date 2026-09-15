import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './lib/process.mjs';
import { promoteDirectory } from './lib/atomic-directory.mjs';
import {
  acquireWorkspaceLock,
  assertWorkPath,
  removeWorkDirectory,
  resetWorkDirectory,
} from './lib/workspace.mjs';

const suite = join(repoRoot, 'test-results', 'workspace-maintenance');
const root = join(suite, 'out');
await mkdir(root, { recursive: true });
after(() => rm(suite, { recursive: true, force: true }));

test('cleanup rejects the output root, sibling-prefix paths, and traversal', () => {
  for (const path of [root, `${root}-other`, join(root, '..', 'source')]) {
    assert.throws(() => assertWorkPath(path, root), /must be a child/);
  }
  assert.equal(assertWorkPath(join(root, 'qa'), root), join(root, 'qa'));
});

test('reset replaces previous output and leaves retained files alone', async () => {
  const output = join(root, 'demo');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'old-frame.png'), 'old');
  await writeFile(join(root, 'retained-cache'), 'keep');
  await resetWorkDirectory(output, root);
  await assert.rejects(readFile(join(output, 'old-frame.png')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'retained-cache'), 'utf8'), 'keep');
});

test('cleanup refuses linked roots and ancestors and never follows a nested link', async () => {
  const outside = join(suite, 'source');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'keep.txt'), 'keep');
  const link = join(root, 'link');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeWorkDirectory(join(link, 'child'), root), /is a link/);
  await assert.rejects(removeWorkDirectory(join(link, 'child'), link), /is a link/);
  const output = join(root, 'nested');
  await mkdir(output, { recursive: true });
  await symlink(outside, join(output, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await removeWorkDirectory(output, root);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('cleanup and shared-output jobs exclude one another', async () => {
  const release = await acquireWorkspaceLock('recording', root);
  try {
    await assert.rejects(acquireWorkspaceLock('recording', root), /already running/);
    await assert.rejects(acquireWorkspaceLock('maintenance', root), /busy/);
  } finally {
    release();
  }
  const cleanup = await acquireWorkspaceLock('maintenance', root);
  try {
    await assert.rejects(acquireWorkspaceLock('recording', root), /busy/);
  } finally {
    cleanup();
  }
});

test('interrupted directory promotion restores the last complete build on failure', async () => {
  const final = join(root, 'sidecars');
  const previous = join(root, '.sidecars.previous');
  const staging = join(root, '.sidecars.staging');
  await mkdir(previous, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(previous, 'build.txt'), 'last complete');
  await writeFile(join(staging, 'build.txt'), 'new build');
  const { rename } = await import('node:fs/promises');
  await assert.rejects(
    promoteDirectory(staging, final, {
      renameDirectory: (source, destination) => {
        if (source === staging) throw new Error('simulated disk failure');
        return rename(source, destination);
      },
    }),
    /simulated disk failure/,
  );
  assert.equal(await readFile(join(final, 'build.txt'), 'utf8'), 'last complete');
  await promoteDirectory(staging, final);
  assert.equal(await readFile(join(final, 'build.txt'), 'utf8'), 'new build');
  await assert.rejects(readFile(join(previous, 'build.txt')), { code: 'ENOENT' });
});
