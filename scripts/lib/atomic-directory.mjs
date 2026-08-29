import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { exists } from './process.mjs';

export async function promoteDirectory(
  stagingDirectory,
  finalDirectory,
  {
    pathExists = exists,
    renameDirectory = rename,
    removeDirectory = (path) => rm(path, { recursive: true, force: true }),
  } = {},
) {
  const previousDirectory = join(
    dirname(finalDirectory),
    `.${basename(finalDirectory)}.previous-${String(process.pid)}`,
  );
  await removeDirectory(previousDirectory);
  const hadPrevious = await pathExists(finalDirectory);
  if (hadPrevious) await renameDirectory(finalDirectory, previousDirectory);
  try {
    await renameDirectory(stagingDirectory, finalDirectory);
  } catch (error) {
    if (hadPrevious && !(await pathExists(finalDirectory))) {
      await renameDirectory(previousDirectory, finalDirectory);
    }
    throw error;
  }
  await removeDirectory(previousDirectory);
}
