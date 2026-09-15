#!/usr/bin/env node
/** Shorten the real sandbox wait; publish only a GIF and keep MP4 for owner review. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] ?? 'E:/temp/cupcake-chat-smooth-demo-1.8/final');
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const evidence = await read(join(root, 'evidence.json'));
assert.equal(evidence.outcome, 'completed');
// Gifsmith's review beats describe detected motion, not complete timeline steps.
// Use boundaries inspected in the finished video so no action or output is cut.
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? NaN : Number(process.argv[index + 1]);
};
const cutStart = option('--cut-start'),
  cutEnd = option('--cut-end');
assert(
  Number.isFinite(cutStart) && Number.isFinite(cutEnd),
  'Provide visually verified --cut-start and --cut-end seconds',
);
assert(cutStart >= 0 && cutEnd > cutStart && cutEnd < evidence.result.durationSeconds);
const source = join(root, 'cupcake-chat-demo.mp4');
const outputIndex = process.argv.indexOf('--review-output');
const mp4 =
  outputIndex < 0 ? 'E:/temp/cupcake-chat-review-1.8.mp4' : resolve(process.argv[outputIndex + 1]);
const gif = resolve('docs/media/cupcake-chat-demo-preview.gif');
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => {
      error += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(Error(error))));
  });
const filter =
  cutEnd > cutStart
    ? `[0:v]split[a][b];[a]trim=end=${cutStart},setpts=PTS-STARTPTS[x];[b]trim=start=${cutEnd},setpts=PTS-STARTPTS[y];[x][y]concat=n=2:v=1:a=0[v]`
    : '[0:v]setpts=PTS-STARTPTS[v]';
await run('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-i',
  source,
  '-filter_complex',
  filter,
  '-map',
  '[v]',
  '-an',
  '-c:v',
  'libx264',
  '-preset',
  'fast',
  '-crf',
  '18',
  '-r',
  '30',
  '-movflags',
  '+faststart',
  mp4,
]);
await mkdir(resolve('docs/media'), { recursive: true });
await run('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-i',
  mp4,
  '-filter_complex',
  'fps=10,scale=840:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
  '-loop',
  '0',
  gif,
]);
await writeFile(
  join(root, 'edit.json'),
  JSON.stringify(
    {
      source,
      mp4,
      gif,
      cutStart,
      cutEnd,
      removedSeconds: Math.max(0, cutEnd - cutStart),
      reason:
        'Shortened actual Python waiting time; original click, computation, and results retained.',
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ mp4, gif, removedSeconds: Math.max(0, cutEnd - cutStart) }));
