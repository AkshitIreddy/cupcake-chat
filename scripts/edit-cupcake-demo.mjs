#!/usr/bin/env node
/** Shorten the real sandbox wait; publish an animation and keep MP4 for owner review. */
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
const gifIndex = process.argv.includes('--preview-output')
  ? process.argv.indexOf('--preview-output')
  : process.argv.indexOf('--gif-output');
const gif = resolve(
  gifIndex < 0 ? 'docs/media/cupcake-chat-demo-preview.webp' : process.argv[gifIndex + 1],
);
const forwardLoop = process.argv.includes('--forward-loop');
const playbackSpeed = Number.isFinite(option('--speed')) ? option('--speed') : 1;
assert(playbackSpeed >= 1 && playbackSpeed <= 2, 'Playback speed must be between 1 and 2');
const zoomIndex = process.argv.indexOf('--zooms');
const zooms = zoomIndex < 0 ? [] : await read(resolve(process.argv[zoomIndex + 1]));
for (const shot of zooms) {
  assert(shot.start >= 0 && shot.end > shot.start && shot.scale >= 1 && shot.scale <= 2);
  assert(shot.x >= 0 && shot.x <= 1 && shot.y >= 0 && shot.y <= 1);
}
// Reframe the encoded picture, not the application's layout. Smoothstep eases
// both ends; supersampling avoids one-pixel crop jitter during slow camera moves.
const ramp = (value) => `(min(1,max(0,${value})))`;
const ease = (value) => `(${value}*${value}*(3-2*${value}))`;
const weights = zooms.map(
  (shot) => `${ease(ramp(`(on/30-${shot.start})/0.75`))}*${ease(ramp(`(${shot.end}-on/30)/0.75`))}`,
);
const zoom = ['1', ...zooms.map((shot, i) => `${shot.scale - 1}*${weights[i]}`)].join('+');
const position = (axis) =>
  ['0.5', ...zooms.map((shot, i) => `${shot[axis] - 0.5}*${weights[i]}`)].join('+');
const cameraFilter = zooms.length
  ? `fps=30,scale=2880:1840:flags=lanczos,zoompan=z='${zoom}':x='(iw-iw/zoom)*(${position('x')})':y='(ih-ih/zoom)*(${position('y')})':d=1:s=1440x920:fps=30`
  : 'null';
const editedDuration = (evidence.result.durationSeconds - (cutEnd - cutStart)) / playbackSpeed;
const seamSeconds = 0.3;
const outputDuration = editedDuration + (forwardLoop ? 0.1 : 0);
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
const cutFilter = `[0:v]split[a][b];[a]trim=end=${cutStart},setpts=PTS-STARTPTS[x];[b]trim=start=${cutEnd},setpts=PTS-STARTPTS[y];[x][y]concat=n=2:v=1:a=0,setpts=PTS/${playbackSpeed},${cameraFilter}[cut]`;
// Keep every scene in chronological order. Only the final Home hold dissolves
// into the opening still; no reverse playback or half-cycle scene blending.
const filter = forwardLoop
  ? `${cutFilter};[cut]fps=30,format=yuv420p,split[body][head];[head]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${seamSeconds + 0.1}[anchor];[body][anchor]xfade=transition=fade:duration=${seamSeconds}:offset=${(editedDuration - seamSeconds).toFixed(6)},trim=duration=${outputDuration.toFixed(6)}[v]`
  : `${cutFilter};[cut]null[v]`;
if (!process.argv.includes('--preview-only'))
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
    '-pix_fmt',
    'yuv420p',
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
await run(
  'ffmpeg',
  /\.webp$/iu.test(gif)
    ? [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        mp4,
        '-vf',
        'fps=20,scale=960:-2:flags=lanczos',
        '-c:v',
        'libwebp_anim',
        '-quality',
        '78',
        '-compression_level',
        '4',
        '-loop',
        '0',
        '-an',
        gif,
      ]
    : [
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
      ],
);
await writeFile(
  join(root, 'edit.json'),
  JSON.stringify(
    {
      source,
      mp4,
      gif,
      cutStart,
      cutEnd,
      forwardLoop,
      playbackSpeed,
      zooms,
      outputDuration,
      seamSeconds: forwardLoop ? seamSeconds : 0,
      removedSeconds: Math.max(0, cutEnd - cutStart),
      reason:
        'Shortened actual Python waiting time; original click, computation, and results retained.',
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ mp4, gif, removedSeconds: Math.max(0, cutEnd - cutStart) }));
