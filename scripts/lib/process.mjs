import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const isWindows = process.platform === 'win32';

export function executable(name) {
  return isWindows && !name.endsWith('.exe') ? `${name}.cmd` : name;
}

export function run(command, args = [], options = {}) {
  const printable = [command, ...args].map((part) => JSON.stringify(String(part))).join(' ');
  process.stdout.write(`\n> ${printable}\n`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CI: process.env.CI ?? '1', ...options.env },
    maxBuffer: options.capture ? 16 * 1024 * 1024 : undefined,
    shell: isWindows && /\.(?:cmd|bat)$/i.test(command),
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Could not start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    throw new Error(`${printable} exited with status ${String(result.status)}`);
  }
  return result;
}

export function commandExists(command) {
  const probe = spawnSync(
    isWindows ? 'where.exe' : 'sh',
    isWindows ? [command] : ['-c', `command -v "$1"`, '--', command],
    {
      encoding: 'utf8',
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  return probe.status === 0;
}

export function pnpmCommand() {
  if (commandExists('pnpm')) return { command: executable('pnpm'), prefix: [] };
  if (commandExists('corepack')) return { command: executable('corepack'), prefix: ['pnpm'] };
  throw new Error('pnpm is required. Install it or enable Corepack for this repository.');
}

export async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function sha256File(path) {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

export async function walkFiles(root) {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export async function fileSize(path) {
  return (await stat(path)).size;
}

export function parseArgValue(args, name, fallback) {
  const exactIndex = args.indexOf(name);
  if (exactIndex >= 0) {
    if (!args[exactIndex + 1] || args[exactIndex + 1].startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    return args[exactIndex + 1];
  }
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}
