#!/usr/bin/env node
/**
 * Gifsmith tour of a real packaged profile. Only the typing/response chapter is
 * a controlled replay, using exact saved provider text. It never sends a model
 * request. All navigation, avatar, wallpaper, and model changes use the app UI.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/* global window, document, HTMLTextAreaElement, Event, requestAnimationFrame, cancelAnimationFrame, performance */
const args = process.argv.slice(2);
const option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
const execute = args.includes('--execute');
const output = resolve(option('--output', 'E:/temp/cupcake-chat-smooth-demo-1.8'));
assert(output.toLowerCase().startsWith('e:\\temp\\'), 'Large recording files belong under E:/temp');
const install = 'E:/temp/cupcake-gifsmith';
const require = createRequire(pathToFileURL(join(install, 'package.json')));
const puppeteer = require('puppeteer-core');
const spawn = childProcess.spawn;
childProcess.spawn = (command, argv, options = {}) => {
  // Intermediate PNGs are disposable lossless frames; lighter compression saves
  // encoding time without changing pixels or the final MP4 settings.
  const fastFrames = /ffmpeg(?:\.exe)?$/iu.test(command) && /%05d\.png$/u.test(argv?.at(-1) ?? '');
  const argumentsWithCompression = fastFrames
    ? [...argv.slice(0, -1), '-compression_level', '1', argv.at(-1)]
    : argv;
  return spawn(command, argumentsWithCompression, { ...options, windowsHide: true });
};
syncBuiltinESMExports();
const gifsmith = await import(pathToFileURL(join(install, 'node_modules/gifsmith/dist/index.js')));
const props = await import(
  pathToFileURL(join(install, 'node_modules/gifsmith/dist/props/index.js'))
);
const ids = {
  analysis: '01a0a20e-7101-7b4c-b188-2b24e95cb120',
  group: '01a0a210-ea18-738d-af5b-3304acb25676',
  code: '01a0a3a1-5f81-7e0d-a2a6-d763d0d91bb0',
};
let prepared;
let exchanges;
const preparedTypingSeconds = 2.3;
const timeline = gifsmith.timeline((t) => {
  t.call(
    async (page) => {
      await page.evaluate(await readFile(join(output, 'renderer/renderer.js'), 'utf8'));
      assert(
        await page.evaluate(() => Boolean(window.CupcakeDemoMarkdown)),
        'Replay renderer did not initialize',
      );
      await page.evaluate(() => {
        window.__cupcakeReplayReceipts = [];
      });
    },
    { name: 'initialize production Markdown renderer', seconds: 0.1 },
  );
  nav(t, 'Home');
  t.hold(0.65);
  nav(t, 'Projects');
  clickText(t, '.project-card__select', 'Rome beyond the battlefield');
  nav(t, 'Chats');
  t.call(hideReplayHistory, { name: 'hide old turns before opening replay', seconds: 0.01 });
  clickText(t, '.chat-list__main', 'How did Rome keep an army fed?');
  t.call(prepareReplay, { name: 'prepare saved provider exchange', seconds: 0.2 });
  t.call(
    async (page) => {
      await page.type('textarea[aria-label="Message Cupcake"]', prepared.user.content, {
        delay: 37,
      });
    },
    { name: 'type the real question', seconds: preparedTypingSeconds },
  );
  t.hold(0.15);
  t.click('button[aria-label="Send message"]', { via: 'cursor', glideSeconds: 0.28 });
  t.call(playResponse, { name: 'replay exact saved response', seconds: 7 });
  t.hold(0.65);
  t.scroll('.conversation-scroll', 350, 0.8, 'easeInOut');
  t.hold(0.65);
  t.call(restoreReplay, { name: 'restore original saved conversation', seconds: 0.2 });
  if (args.includes('--stream-only')) return;
  nav(t, 'Memory');
  t.hold(0.65);
  t.click('button[aria-label="Search Cupcake Chat"]', { via: 'cursor', glideSeconds: 0.28 });
  t.waitFor('input[aria-label="Search workspace"]');
  t.type('input[aria-label="Search workspace"]', 'supply', { delayMs: 55 });
  t.hold(0.65);
  nav(t, 'Models');
  t.hold(0.65);
  t.scroll('.app-content', 380, 0.8, 'easeInOut');
  t.hold(0.65);
  t.click('button[aria-label="New chat"]', { via: 'cursor', glideSeconds: 0.28 });
  for (const route of ['Cohere', 'Groq']) {
    t.click('button.model-chip:not(.group-model-chip)', { via: 'cursor', glideSeconds: 0.28 });
    t.call(
      async (page) => {
        await page.focus('.model-picker input[placeholder*="Search model"]');
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
      },
      { name: 'clear model search', seconds: 0.1 },
    );
    t.type('.model-picker input[placeholder*="Search model"]', route, { delayMs: 55 });
    t.hold(0.65);
    t.call((page) => mark(page, '.model-picker__list button', prepared.modelNames[route]), {
      name: `choose ${route}`,
      seconds: 0.1,
    });
    t.click('[data-demo-target]', { via: 'cursor', glideSeconds: 0.3 });
    t.call((page) => page.waitForSelector('.model-picker', { hidden: true }), {
      name: 'model selected',
      seconds: 0.1,
    });
    t.hold(0.25);
  }
  t.click('button[aria-label="Show all chats in sidebar"]', { via: 'cursor', glideSeconds: 0.28 });
  t.hold(0.65);
  t.click('button[aria-label="Show all chats in sidebar"]', { via: 'cursor', glideSeconds: 0.28 });
  nav(t, 'Projects');
  clickText(t, '.project-card__select', 'Rome beyond the battlefield');
  nav(t, 'Chats');
  t.call(
    async (page) => {
      prepared = exchanges.code;
      await hideReplayHistory(page);
    },
    { name: 'prepare real code exchange', seconds: 0.1 },
  );
  clickText(t, '.chat-list__main', 'When would a Roman fort run out of grain?');
  t.call(prepareReplay, { name: 'prepare saved code response', seconds: 0.2 });
  t.call(
    (page) =>
      page.type('textarea[aria-label="Message Cupcake"]', prepared.user.content, { delay: 28 }),
    { name: 'ask about the grain calculation', seconds: 1.8 },
  );
  t.click('button[aria-label="Send message"]', { via: 'cursor', glideSeconds: 0.28 });
  t.call(playResponse, { name: 'show AI generated Python in chat', seconds: 6 });
  t.call((page) => restoreReplay(page, true), {
    name: 'restore saved code for real execution',
    seconds: 0.1,
  });
  t.call(
    (page) =>
      page.evaluate(() => {
        const pane = document.querySelector('.conversation-scroll');
        const code = document.querySelector('.markdown-code-block');
        pane.scrollTop += code.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20;
      }),
    { name: 'show code actions', seconds: 0.2 },
  );
  clickText(t, '.markdown-code-block figcaption button', 'Run tests', true);
  t.call(
    (page) =>
      page.waitForFunction(
        () =>
          [...document.querySelectorAll('.markdown-code-result')].some((n) =>
            n.textContent.includes('8 tests passed'),
          ),
        { timeout: 60000 },
      ),
    { name: 'wait for actual Python test results', seconds: 1 },
  );
  t.call(
    (page) =>
      page.evaluate(() => {
        const pane = document.querySelector('.conversation-scroll');
        const result = document.querySelector('.markdown-code-result');
        pane.scrollTop +=
          result.getBoundingClientRect().top - pane.getBoundingClientRect().top - 30;
      }),
    { name: 'show actual local Python output', seconds: 0.2 },
  );
  t.hold(0.65);
  nav(t, 'Artifacts');
  t.call(clearReplayVisibility, { name: 'restore offscreen saved history', seconds: 0.01 });
  // The newest saved artifact is first; prior failed work remains in the audit history.
  t.click('.artifact-list__item:first-child', { via: 'cursor', glideSeconds: 0.28 });
  t.hold(0.65);
  t.scroll('.document-preview', 590, 0.9, 'easeInOut');
  t.hold(0.65);
  nav(t, 'Tasks');
  t.hold(0.65);
  nav(t, 'Projects');
  clickText(t, '.project-card__select', 'Rome beyond the battlefield');
  nav(t, 'Chats');
  clickText(t, '.chat-list__main', 'Winning battles, losing the war');
  t.hold(0.65);
  t.scroll('.conversation-scroll', -760, 0.9, 'easeInOut');
  t.hold(0.65);
  t.click('button.participant-add', { via: 'cursor', glideSeconds: 0.28 });
  t.waitFor('button[aria-label="Close Add Cupcake"]');
  t.click('select[aria-label="Advisor era"]', { via: 'cursor', glideSeconds: 0.28 });
  t.call(
    async (page) => {
      await page.keyboard.press('r');
      await page.keyboard.press('Enter');
    },
    { name: 'choose Roman companions from the open selector', seconds: 0.2 },
  );
  t.hold(0.65);
  t.click('button[aria-label="Close Add Cupcake"]', { via: 'cursor', glideSeconds: 0.28 });
  nav(t, 'Settings');
  clickText(t, '.settings-layout aside button', 'Profile', true);
  t.call(
    (page) =>
      page.evaluate(() =>
        document
          .querySelector(
            '.avatar-picker:not(.avatar-picker--assistant) button[data-tooltip^="Flavia"]',
          )
          .scrollIntoView({ behavior: 'smooth', block: 'center' }),
      ),
    { name: 'show profile portraits', seconds: 1 },
  );
  t.hold(0.25);
  t.click('.avatar-picker:not(.avatar-picker--assistant) button[data-tooltip^="Flavia"]', {
    via: 'cursor',
    glideSeconds: 0.3,
  });
  t.call(
    (page) =>
      page.waitForSelector(
        '.avatar-picker:not(.avatar-picker--assistant) button.is-active[data-tooltip^="Flavia"]',
      ),
    { name: 'verify saved profile portrait', seconds: 0.2 },
  );
  t.hold(0.65);
  t.call(
    (page) =>
      page.evaluate(() =>
        document
          .querySelector('.avatar-picker--assistant button[data-tooltip^="Milo"]')
          .scrollIntoView({ behavior: 'smooth', block: 'center' }),
      ),
    { name: 'show assistant portraits', seconds: 1 },
  );
  t.hold(0.25);
  t.click('.avatar-picker--assistant button[data-tooltip^="Milo"]', {
    via: 'cursor',
    glideSeconds: 0.3,
  });
  t.call(
    (page) =>
      page.waitForSelector('.avatar-picker--assistant button.is-active[data-tooltip^="Milo"]'),
    { name: 'verify saved assistant portrait', seconds: 0.2 },
  );
  t.hold(0.65);
  clickText(t, '.settings-layout aside button', 'Appearance', true);
  clickText(t, '.theme-grid button', 'Cupcake Dark');
  clickText(t, '.wallpaper-grid button', 'Rose castle garden');
  t.hold(0.65);
  nav(t, 'Home');
  t.hold(0.65);
  nav(t, 'Settings');
  clickText(t, '.settings-layout aside button', 'Appearance', true);
  clickText(t, '.settings-layout aside button', 'General', true);
  t.call((page) => page.evaluate(() => window.sessionStorage.removeItem('cupcake.setup.step')), {
    name: 'start setup tour at welcome',
    seconds: 0.1,
  });
  clickText(t, '.settings-layout button', 'Replay onboarding', true);
  t.hold(0.65);
  clickText(t, '.onboarding-layer nav button', 'Cloud providers');
  t.hold(0.65);
  clickText(t, '.onboarding-provider-guide button', 'Groq');
  t.hold(0.65);
  t.click('button[aria-label="Close provider setup"]', { via: 'cursor', glideSeconds: 0.4 });
  clickText(t, '.onboarding-layer nav button', 'Optional · run models on this PC');
  t.hold(0.65);
  clickText(t, '.onboarding-layer button', 'Set up local models and runtimes');
  t.hold(0.65);
  clickText(t, 'button', 'Continue setup', true);
  t.click('button[aria-label="Skip onboarding"]', { via: 'cursor', glideSeconds: 0.28 });
  t.hold(0.25);
  nav(t, 'Home');
  t.hold(0.65);
});
const scene = {
  target: gifsmith.tauri({ port: 10131 }),
  out: join(output, 'cupcake-chat-demo.mp4'),
  viewport: { width: 1440, height: 920, deviceScaleFactor: 1.5 },
  props: [props.cursor({ start: { x: 1160, y: 118 } })],
  timeline,
  capture: { mode: 'screencast', format: 'jpeg', quality: 96 },
  encode: { width: 1440, fps: 30, speed: 1, mp4Crf: 18, targetMB: 100 },
  loop: 'none',
  review: { dir: join(output, 'review'), maxFindings: 12, controls: 3 },
  workDir: join(output, 'work'),
  keepFrames: true,
  logLevel: 'info',
};
if (!execute) {
  process.stdout.write(
    JSON.stringify(
      {
        seconds: gifsmith.estimateSeconds(timeline.steps),
        output: scene.out,
        replay: 'exact saved provider text; no inference during filming',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
await mkdir(output, { recursive: true });
const { build } = await import('vite');
await build({
  configFile: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: {
    alias: {
      'react-dom': resolve('apps/desktop/node_modules/react-dom'),
      react: resolve('apps/desktop/node_modules/react'),
    },
  },
  build: {
    outDir: join(output, 'renderer'),
    emptyOutDir: false,
    lib: {
      entry: resolve('scripts/demo-markdown-entry.mjs'),
      name: 'CupcakeDemoMarkdown',
      formats: ['iife'],
      fileName: () => 'renderer.js',
    },
  },
});
const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:10131',
  defaultViewport: null,
});
const page = (await browser.pages()).find((item) => /tauri\.localhost/u.test(item.url()));
assert(page, 'Launch the packaged demo profile first');
const receipt = { startedAt: new Date().toISOString(), outcome: 'failed' };
try {
  const info = await page.evaluate(() => window.cupcake.app.getInfo());
  assert(info.packaged && info.appVersion === '1.8.0', 'Packaged 1.8 app required');
  assert.equal(await page.$('.fixture-banner'), null, 'No fixture mode in release media');
  const conversation = await request(page, 'conversations.get', { conversationId: ids.analysis });
  const history = await request(page, 'chat.history', { branchId: conversation.activeBranchId });
  const userIndex = history.findIndex((item) => item.role === 'user');
  const user = history[userIndex];
  const assistant = history.slice(userIndex + 1).find((item) => item.role === 'assistant');
  assert(user && assistant?.state === 'complete' && assistant.provider_id && assistant.model_id);
  assert(['stop', 'end_turn'].includes(assistant.canonical_metadata?.finishReason));
  const models = await request(page, 'models.list');
  const modelNames = Object.fromEntries(
    [
      ['Cohere', 'cohere:command-a-plus-05-2026'],
      ['Groq', 'openai-compatible:groq/openai/gpt-oss-120b'],
    ].map(([name, id]) => {
      const model = models.find((item) => item.id === id);
      assert(model, `Missing ${name}`);
      return [name, model.display_name];
    }),
  );
  prepared = {
    user,
    assistant,
    modelNames,
    branchId: conversation.activeBranchId,
    historyDigest: digest(history),
  };
  const codeConversation = await request(page, 'conversations.get', { conversationId: ids.code });
  const codeHistory = await request(page, 'chat.history', {
    branchId: codeConversation.activeBranchId,
  });
  const codeAssistant = codeHistory.find((item) => item.role === 'assistant');
  assert(
    codeAssistant?.canonical_metadata?.finishReason === 'stop' &&
      codeAssistant.content.includes('```python'),
  );
  exchanges = {
    analysis: prepared,
    code: {
      user: codeHistory.find((item) => item.role === 'user'),
      assistant: codeAssistant,
      modelNames,
      branchId: codeConversation.activeBranchId,
      historyDigest: digest(codeHistory),
    },
  };
  receipt.provenance = {
    conversationId: ids.analysis,
    branchId: prepared.branchId,
    userId: user.id,
    assistantId: assistant.id,
    provider: assistant.provider_id,
    model: assistant.model_id,
    textSha256: digest(assistant.content),
    historySha256: prepared.historyDigest,
  };
  await writeFile(
    join(output, 'replayed-exchange.json'),
    JSON.stringify({ user, assistant }, null, 2),
  );
  receipt.result = await gifsmith.render(scene);
  for (const exchange of Object.values(exchanges)) {
    const after = await request(page, 'chat.history', { branchId: exchange.branchId });
    assert.equal(
      digest(after),
      exchange.historyDigest,
      'Recording must not change saved exchanges',
    );
  }
  receipt.replays = await page.evaluate(() => window.__cupcakeReplayReceipts);
  assert.equal(receipt.replays.length, args.includes('--stream-only') ? 1 : 2);
  for (const replay of receipt.replays)
    assert.equal(replay.interceptedSends, 1, 'Exactly one controlled Send per replay expected');
  receipt.outcome = 'completed';
} catch (error) {
  receipt.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await restoreReplay(page).catch(() => {});
  await clearReplayVisibility(page).catch(() => {});
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'evidence.json'), JSON.stringify(receipt, null, 2));
  await browser.disconnect();
}
process.stdout.write(JSON.stringify(receipt, null, 2));

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function request(page, method, params = {}) {
  const result = await page.evaluate(
    ({ method, params }) => window.cupcake.runtime.request({ method, params, timeoutMs: 120000 }),
    { method, params },
  );
  assert(result.ok, `${method}: ${result.error?.message}`);
  return result.result;
}
function nav(t, name) {
  clickText(t, '.shelf button', name, true);
}
function clickText(t, selector, text, exact = false) {
  t.call((page) => mark(page, selector, text, exact), { name: `find ${text}`, seconds: 0.1 });
  t.click('[data-demo-target]', { via: 'cursor', glideSeconds: 0.28 });
  t.hold(0.25);
}
async function mark(page, selector, text, exact = false) {
  await page.waitForFunction(
    ({ selector, text, exact }) =>
      [...document.querySelectorAll(selector)].some((item) =>
        exact ? item.textContent.trim() === text : item.textContent.includes(text),
      ),
    { timeout: 20000 },
    { selector, text, exact },
  );
  const count = await page.evaluate(
    ({ selector, text, exact }) => {
      document
        .querySelectorAll('[data-demo-target]')
        .forEach((item) => item.removeAttribute('data-demo-target'));
      const matches = [...document.querySelectorAll(selector)].filter((item) =>
        exact ? item.textContent.trim() === text : item.textContent.includes(text),
      );
      if (matches.length === 1) matches[0].setAttribute('data-demo-target', 'true');
      return matches.length;
    },
    { selector, text, exact },
  );
  assert.equal(count, 1, `Ambiguous ${text}`);
  await page.evaluate(() => {
    const target = document.querySelector('[data-demo-target]');
    const box = target.getBoundingClientRect();
    if (box.top < 110 || box.bottom > window.innerHeight - 55) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  });
}
async function hideReplayHistory(page) {
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'demo-replay-visibility';
    style.textContent = '.turn:not([data-demo-revealed]) { display:none !important; }';
    document.head.append(style);
    window.__cupcakeReplayReceipt = {
      interceptedSends: 0,
      preSendUserFrames: 0,
      emptyListFrames: 0,
      frames: [],
      sentAt: null,
    };
  });
}
async function prepareReplay(page) {
  await page.waitForSelector(`#message-${prepared.assistant.id} .rich-response`, {
    visible: false,
  });
  await page.evaluate(
    ({ userId, assistantId }) => {
      const user = document.getElementById(`message-${userId}`);
      const assistant = document.getElementById(`message-${assistantId}`);
      if (!user || !assistant) throw Error('Replay rows missing');
      const original = assistant.querySelector('.rich-response');
      original.style.display = 'none';
      const response = document.createElement('div');
      response.className = 'rich-response';
      response.dataset.demoResponse = 'true';
      original.after(response);
      window.CupcakeDemoMarkdown.mount(response);
      const send = document.querySelector('button[aria-label="Send message"]');
      const receipt = window.__cupcakeReplayReceipt;
      const intercept = (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        receipt.interceptedSends += 1;
        receipt.sentAt = performance.now();
        user.dataset.demoRevealed = 'true';
        const input = document.querySelector('textarea[aria-label="Message Cupcake"]');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      send.addEventListener('click', intercept, true);
      const replay = { user, assistant, original, response, send, intercept, frame: 0 };
      window.__cupcakeReplay = replay;
      const sample = () => {
        if (
          receipt.sentAt === null &&
          [...document.querySelectorAll('.turn--user')].some(
            (n) => n.getBoundingClientRect().height > 0,
          )
        )
          receipt.preSendUserFrames++;
        if ([...response.querySelectorAll('li')].some((n) => !n.textContent.trim()))
          receipt.emptyListFrames++;
        receipt.frames.push({
          at: performance.now(),
          characters: response.innerText.length,
          items: response.querySelectorAll('li').length,
        });
        replay.frame = requestAnimationFrame(sample);
      };
      replay.frame = requestAnimationFrame(sample);
      document.querySelector('.conversation-scroll').scrollTop = 0;
    },
    { userId: prepared.user.id, assistantId: prepared.assistant.id },
  );
}
async function playResponse(page, ctx) {
  await page.evaluate(() => {
    if (window.__cupcakeReplayReceipt.interceptedSends !== 1)
      throw Error('Send must occur before response');
    window.__cupcakeReplay.assistant.dataset.demoRevealed = 'true';
  });
  // Feed genuine Markdown prefixes through the same React component as live chat.
  // The app's presentation buffer smooths these deliberately uneven transport chunks.
  const text = prepared.assistant.content;
  const step = Math.ceil(text.length / 72);
  for (let visible = step; visible < text.length + step; visible += step) {
    await page.evaluate(
      (text) => window.CupcakeDemoMarkdown.render(text, true),
      text.slice(0, visible),
    );
    if (prepared === exchanges.code)
      await page.evaluate(() => {
        const pane = document.querySelector('.conversation-scroll');
        pane.scrollTop = pane.scrollHeight;
        const code = window.__cupcakeReplay.response.querySelector('.markdown-code-block > pre');
        if (code) code.scrollTop = code.scrollHeight;
      });
    await ctx.advance(70);
  }
  await page.evaluate((text) => window.CupcakeDemoMarkdown.render(text, false), text);
  await ctx.advance(200);
  await page.evaluate(() => {
    const receipt = window.__cupcakeReplayReceipt;
    if (receipt.preSendUserFrames || receipt.emptyListFrames)
      throw Error('Replay showed a premature message or empty list');
  });
}
async function restoreReplay(page, keepHistoryHidden = false) {
  await page.evaluate((keepHistoryHidden) => {
    const replay = window.__cupcakeReplay;
    if (!replay) return;
    cancelAnimationFrame(replay.frame);
    window.__cupcakeReplayReceipts.push(window.__cupcakeReplayReceipt);
    window.CupcakeDemoMarkdown.unmount();
    replay.response.remove();
    replay.original.style.display = '';
    if (!keepHistoryHidden) {
      document.getElementById('demo-replay-visibility')?.remove();
      document
        .querySelectorAll('[data-demo-revealed]')
        .forEach((n) => n.removeAttribute('data-demo-revealed'));
    }
    replay.send.removeEventListener('click', replay.intercept, true);
    delete window.__cupcakeReplay;
  }, keepHistoryHidden === true);
}
async function clearReplayVisibility(page) {
  await page.evaluate(() => {
    document.getElementById('demo-replay-visibility')?.remove();
    document
      .querySelectorAll('[data-demo-revealed]')
      .forEach((n) => n.removeAttribute('data-demo-revealed'));
  });
}
