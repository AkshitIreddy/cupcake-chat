import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { repoRoot } from './process.mjs';

/** One checkout owns one reusable output tree. Never write dated siblings in TEMP. */
export const workRoot = join(repoRoot, 'out');
export const workPath = (...parts) => join(workRoot, ...parts);

export function assertWorkPath(path, root = workRoot) {
  const full = resolve(path);
  const rel = relative(resolve(root), full);
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`Working path must be a child of ${root}: ${full}`);
  }
  return full;
}

/** Check every existing ancestor before removing anything; never follow a junction. */
export async function assertLocalWorkPath(path, root = workRoot) {
  const full = assertWorkPath(path, root);
  const rel = relative(resolve(root), full);
  let current = resolve(root);
  for (const part of ['', ...rel.split(/[\\/]/u)]) {
    current = part ? join(current, part) : current;
    const entry = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entry?.isSymbolicLink())
      throw new Error(`Working directory is a link; consolidate it first: ${current}`);
  }
  return full;
}

export async function removeWorkDirectory(path, root = workRoot) {
  const full = await assertLocalWorkPath(path, root);
  // fs.rm unlinks nested symlinks rather than visiting their targets.
  await rm(full, { recursive: true, force: true });
}

export async function resetWorkDirectory(path, root = workRoot) {
  await removeWorkDirectory(path, root);
  await mkdir(path, { recursive: true });
  return path;
}

/** Fixed output names require exclusive ownership, including during cleanup. */
export async function acquireWorkspaceLock(name, root = workRoot) {
  if (!/^[a-z0-9-]+$/u.test(name)) throw new Error('Invalid workspace job name');
  const directory = await assertLocalWorkPath(join(root, '.locks'), root);
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, `${name}.json`);
  function alive(file) {
    try {
      const { pid } = JSON.parse(readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) return true;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code !== 'ESRCH';
      }
    } catch {
      return true;
    }
  }
  if (existsSync(lock)) {
    if (alive(lock)) throw new Error(`Workspace job is already running: ${name}`);
    unlinkSync(lock);
  }
  const fd = openSync(lock, 'wx');
  writeFileSync(fd, JSON.stringify({ pid: process.pid, job: name }));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    closeSync(fd);
    unlinkSync(lock);
    process.off('exit', release);
  };
  process.once('exit', release);
  try {
    for (const entry of readdirSync(directory)) {
      const other = join(directory, entry);
      if (
        other !== lock &&
        (name === 'maintenance' || entry === 'maintenance.json') &&
        alive(other)
      ) {
        throw new Error(`Workspace is busy: ${entry}`);
      }
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}
