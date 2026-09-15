#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { promoteDirectory } from './lib/atomic-directory.mjs';
import { acquireWorkspaceLock, workPath, resetWorkDirectory } from './lib/workspace.mjs';

const releaseWorkspace = await acquireWorkspaceLock('atomic-directory-test');
const root = await resetWorkDirectory(workPath('qa/atomic-directory-test'));
try {
  const finalDirectory = join(root, 'sidecars');
  const stagingDirectory = join(root, '.sidecars.staging');
  await seed(finalDirectory, 'old');
  await seed(stagingDirectory, 'new');
  await promoteDirectory(stagingDirectory, finalDirectory);
  assert.equal(await marker(finalDirectory), 'new');

  await rm(finalDirectory, { recursive: true, force: true });
  await seed(finalDirectory, 'old');
  await seed(stagingDirectory, 'new');
  await assert.rejects(
    promoteDirectory(stagingDirectory, finalDirectory, {
      renameDirectory: async (source, destination) => {
        if (source === stagingDirectory) throw new Error('injected promotion failure');
        await rename(source, destination);
      },
    }),
    /injected promotion failure/,
  );
  assert.equal(await marker(finalDirectory), 'old');
  assert.equal(await marker(stagingDirectory), 'new');
  process.stdout.write('Atomic directory promotion and rollback passed.\n');
} finally {
  await rm(root, { recursive: true, force: true });
  releaseWorkspace();
}

async function seed(directory, value) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'marker.txt'), value, 'utf8');
}

async function marker(directory) {
  return readFile(join(directory, 'marker.txt'), 'utf8');
}
