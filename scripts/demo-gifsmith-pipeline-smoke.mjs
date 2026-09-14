#!/usr/bin/env node
/**
 * Exercise gifsmith's capture -> H.264 MP4 path without touching the app.
 * The source images are labelled historical stills; this is not a product demo.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};

const output = resolve(option('--output', 'E:/temp/cupcake-gifsmith/pipeline-smoke'));
const gifsmithRoot = resolve(
  option('--gifsmith-root', 'E:/temp/cupcake-gifsmith/node_modules/gifsmith'),
);
assertChildOfETemp(output);
await mkdir(output, { recursive: true });

const stills = [
  resolve('E:/temp/cupcake-video-showcase-20260914/final-package-9f5a571/owner-home.png'),
  resolve('E:/temp/cupcake-video-showcase-20260914/visual-gallery.png'),
  resolve('E:/temp/cupcake-video-showcase-20260914/visual-chat-repair-cafe-group.png'),
];
for (const path of stills) assert((await readFile(path)).length > 1000, `Missing still: ${path}`);

const htmlPath = join(output, 'pipeline-smoke.html');
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#180f14}
  body{font:600 16px/1.4 system-ui;color:#fff} .frame{position:absolute;inset:0;opacity:0;transition:opacity .55s ease}
  .frame.is-active{opacity:1}.frame img{width:100%;height:100%;object-fit:cover}
  .label{position:absolute;left:28px;bottom:24px;padding:10px 14px;border-radius:999px;background:#1b1115e8;box-shadow:0 8px 30px #0008}
  button{position:absolute;right:28px;bottom:24px;padding:11px 18px;border:0;border-radius:999px;background:#ffd3df;color:#3a1420;font:inherit}
</style></head><body>
  ${stills
    .map(
      (path, index) =>
        `<section class="frame${index === 0 ? ' is-active' : ''}" data-index="${index}"><img src="${pathToFileURL(path).href}" alt=""><div class="label">PIPELINE TEST · historical still ${index + 1}/3</div></section>`,
    )
    .join('')}
  <button id="next">Next still</button>
  <script>let i=0;document.querySelector('#next').onclick=()=>{document.querySelector('[data-index="'+i+'"]').classList.remove('is-active');i=(i+1)%3;document.querySelector('[data-index="'+i+'"]').classList.add('is-active')}</script>
</body></html>`;
await writeFile(htmlPath, html, 'utf8');

const gifsmith = await import(pathToFileURL(join(gifsmithRoot, 'dist/index.js')).href);
const tl = gifsmith.timeline((t) => {
  t.waitFor('#next');
  t.hold(0.8);
  t.loopAnchor();
  t.click('#next', { via: 'direct' });
  t.hold(1.1);
  t.click('#next', { via: 'direct' });
  t.hold(1.1);
  t.click('#next', { via: 'direct' });
  t.hold(0.8);
});
const result = await gifsmith.render({
  target: gifsmith.web(pathToFileURL(htmlPath).href),
  out: join(output, 'pipeline-smoke.mp4'),
  viewport: { width: 1440, height: 920, deviceScaleFactor: 1 },
  timeline: tl,
  capture: { mode: 'screencast', format: 'png' },
  encode: { width: 960, fps: 12, speed: 1, mp4Crf: 18 },
  loop: { strategy: 'anchor', minCycleSeconds: 3 },
  review: { dir: join(output, 'review'), maxFindings: 6, controls: 2 },
  workDir: join(output, 'work'),
  logLevel: 'info',
});
await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function assertChildOfETemp(path) {
  if (!isAbsolute(path)) throw new Error('Output must be absolute');
  const root = resolve('E:/temp');
  const rel = relative(root, resolve(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Output must be a child of ${root}`);
  }
}
