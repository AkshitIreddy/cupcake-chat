#!/usr/bin/env node
/**
 * Record the real packaged Cupcake Chat WebView2 UI through gifsmith.
 *
 * The coordinating operator launches a disposable owner-profile clone off-screen with CDP.
 * This helper attaches to it; it never launches the app or reads credentials.
 * Render mode performs one real Madara chat send and therefore requires an
 * explicit execution token. The ODM artifact/task and group chat must already
 * exist as real persisted work.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/* global window, document */

const MADARA_PROMPT =
  'Why didn’t Madara just have Nagato revive him with the Rinnegan much earlier? Is that a Naruto plot hole, or am I missing part of the plan? Spoilers are fine. Separate what the story actually tells us from fan theories, and keep it to the useful bits.';
const GROQ_MODEL_ID = 'openai-compatible:groq/openai/gpt-oss-120b';
const COHERE_MODEL_ID = 'cohere:command-a-plus-05-2026';
const defaults = {
  everydayProject: 'Life, Admin, Done',
  landlordChat: 'help me text my landlord about this leak',
  project: 'Anime rabbit holes',
  odmChat: 'can we make ODM gear into a tiny physics toy?',
  odmArtifact: 'ODM toy physics.py',
  odmTask: 'Test ODM toy physics',
  groupProject: 'Neighborhood Repair Cafe',
  groupChat: 'Thirty-six broken things, one Saturday',
};
const themeLabels = {
  'cupcake-light': 'Cupcake Light',
  light: 'Cupcake Light',
  'cupcake-dark': 'Cupcake Dark',
  dark: 'Cupcake Dark',
  minimal: 'Minimal',
  classic: 'Classic',
};
const wallpaperLabels = {
  none: 'Quiet paper',
  'moonlit-archive': 'Moonlit archive',
  'pistachio-atelier': 'Pistachio atelier',
  'blueberry-observatory': 'Blueberry observatory',
  'copper-workshop': 'Copper workshop',
  'aquamarine-tidepool-library': 'Tidepool library',
  'ink-snow-garden': 'Ink snow garden',
  'raspberry-circuit-conservatory': 'Circuit conservatory',
  'saffron-paper-city': 'Saffron paper city',
  'lavender-cloud-parlour': 'Lavender cloud parlour',
  'ember-rain-cafe': 'Ember rain café',
  'citrus-solar-studio': 'Citrus solar studio',
  'rosewood-reading-room': 'Rosewood reading room',
  'cherry-lacquer-atelier': 'Cherry lacquer atelier',
  'burgundy-cinema-lounge': 'Burgundy cinema lounge',
  'peach-blossom-loft': 'Peach blossom loft',
  'jade-paper-conservatory': 'Jade paper conservatory',
  'cobalt-night-train': 'Cobalt night train',
  'amethyst-mineral-gallery': 'Amethyst mineral gallery',
  'amber-desert-observatory': 'Amber desert observatory',
  'ice-blue-nordic-atrium': 'Ice blue Nordic atrium',
  'obsidian-aurora-workshop': 'Obsidian aurora workshop',
};

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};
const phase = option('--phase', 'plan');
if (!['plan', 'dry-run', 'render'].includes(phase)) {
  throw new Error('--phase must be plan, dry-run, or render');
}
if (phase === 'render' && option('--execute') !== 'ACTUAL_PACKAGED_APP_RECORDING') {
  throw new Error('Render requires --execute ACTUAL_PACKAGED_APP_RECORDING');
}
const port = Number(option('--port', '10131'));
assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, 'Invalid CDP port');
const output = resolve(option('--output', 'E:/temp/cupcake-chat-gifsmith-demo'));
assertChildOfETemp(output);
const install = resolve(option('--gifsmith-install', 'E:/temp/cupcake-gifsmith'));
const gifsmithRoot = join(install, 'node_modules', 'gifsmith');
const selections = {
  everydayProject: option('--everyday-project', defaults.everydayProject),
  landlordChat: option('--landlord-chat', defaults.landlordChat),
  project: option('--project', defaults.project),
  odmChat: option('--odm-chat', defaults.odmChat),
  odmArtifact: option('--odm-artifact', defaults.odmArtifact),
  odmTask: option('--odm-task', defaults.odmTask),
  groupProject: option('--group-project', defaults.groupProject),
  groupChat: option('--group-chat', defaults.groupChat),
};

// gifsmith 0.3.5 does not set windowsHide on its FFmpeg children. Keep this
// process's helpers hidden without changing the installed package or the app.
const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options = {}) =>
  originalSpawn(command, args, { ...options, windowsHide: true });
syncBuiltinESMExports();
const gifsmith = await import(pathToFileURL(join(gifsmithRoot, 'dist/index.js')).href);
const props = await import(pathToFileURL(join(gifsmithRoot, 'dist/props/index.js')).href);
const target = gifsmith.tauri({ port });
let initialState = null;
const timeline = buildTimeline();
const scene = {
  target,
  out: join(output, 'cupcake-chat-demo.mp4'),
  viewport: { width: 1440, height: 920, deviceScaleFactor: 1.5 },
  props: [props.cursor({ start: { x: 1160, y: 118 } })],
  timeline,
  capture: { mode: 'screencast', format: 'jpeg', quality: 96 },
  encode: { width: 1440, fps: 30, speed: 1.12, mp4Crf: 18, targetMB: 90 },
  loop: { strategy: 'anchor', minCycleSeconds: 90 },
  review: { dir: join(output, 'review'), maxFindings: 12, controls: 3 },
  workDir: join(output, 'work'),
  keepFrames: false,
  logLevel: 'info',
};

if (phase === 'plan') {
  process.stdout.write(
    `${JSON.stringify(
      {
        phase,
        plannedSeconds: gifsmith.estimateSeconds(timeline.steps),
        prompt: MADARA_PROMPT,
        selections,
        output: scene.out,
        package: 'gifsmith@0.3.5',
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

await mkdir(output, { recursive: true });
initialState = await inspectPreparedApp();
if (phase === 'dry-run') {
  const report = await gifsmith.dryRun(scene);
  await writeFile(join(output, 'dry-run.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

const evidence = {
  schemaVersion: 1,
  package: {
    name: 'gifsmith',
    version: '0.3.5',
    integrity:
      'sha512-5zLN3NA3CubgoN5L5xZED0T2A/4Qub+tdHT9CjopAAYwg1W96pX5kabNEude+BjLjESOOFDfUcIgtr9ERbbL9w==',
  },
  startedAt: new Date().toISOString(),
  viewport: initialState.viewport,
  prepared: initialState.prepared,
  prompt: MADARA_PROMPT,
  result: null,
  persistedReply: null,
  restored: null,
  outcome: 'failed',
  failure: null,
};
try {
  evidence.result = await gifsmith.render(scene);
  assert(
    evidence.result.durationSeconds >= 90 && evidence.result.durationSeconds <= 180,
    `Review copy duration ${evidence.result.durationSeconds}s is outside 90–180s`,
  );
  evidence.persistedReply = await inspectPersistedMadaraReply();
  evidence.outcome = 'completed';
} catch (error) {
  evidence.failure = safeError(error);
  process.exitCode = 1;
} finally {
  evidence.restored = await restoreInitialState().catch((error) => ({
    ok: false,
    error: safeError(error),
  }));
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}
process.stdout.write(
  `${JSON.stringify(
    {
      outcome: evidence.outcome,
      output: evidence.result?.outputs ?? [],
      durationSeconds: evidence.result?.durationSeconds ?? null,
      persistedReply: evidence.persistedReply,
      restored: evidence.restored,
      evidence: join(output, 'evidence.json'),
      failure: evidence.failure,
    },
    null,
    2,
  )}\n`,
);

function buildTimeline() {
  return gifsmith.timeline((t) => {
    t.waitFor('#root', { timeoutMs: 180_000 });
    markAndClick(t, '.shelf__nav button', 'Home', 'nav-home', false);
    t.hold(2);
    t.loopAnchor();

    markAndClick(t, '.shelf__nav button', 'Projects', 'nav-projects-life', false);
    markAndClick(t, '.project-card__select', selections.everydayProject, 'project-life', false);
    markAndClick(t, '.shelf__nav button', 'Chats', 'nav-chats-life', false);
    markAndClick(t, '.chat-list__main', selections.landlordChat, 'chat-landlord', false);
    t.hold(3.5);
    t.scroll('.conversation-scroll', -620, 3.5, 'easeInOut');
    t.hold(2);

    markAndClick(t, '.shelf__nav button', 'Memory', 'nav-memory', false);
    t.hold(3.5);
    t.scroll('.app-content', 380, 2.5, 'easeInOut');
    t.hold(1.5);

    markAndClick(t, '.shelf__nav button', 'Tools', 'nav-tools', false);
    t.hold(4);

    markAndClick(t, '.shelf__nav button', 'Models', 'nav-models', false);
    t.hold(4);
    t.scroll('.app-content', 470, 3, 'easeInOut');
    t.hold(2);

    markAndClick(t, '.shelf__nav button', 'Projects', 'nav-projects-anime', false);
    markAndClick(t, '.project-card__select', selections.project, 'project-anime', false);
    t.click('button[aria-label="New chat"]', { via: 'cursor', glideSeconds: 0.55 });
    t.hold(1.8);
    t.click('button.model-chip:not(.group-model-chip)', {
      via: 'cursor',
      glideSeconds: 0.45,
    });
    t.hold(1.5);
    t.call(clearModelSearch, { name: 'clear model search', seconds: 0.2 });
    t.type('.model-picker input[placeholder*="Search model"]', 'Cohere', { delayMs: 85 });
    t.hold(1.2);
    t.call(
      (page) =>
        markText(page, '.model-picker__list button', initialState.cohereModelName, 'cohere', false),
      { name: 'mark Cohere model', seconds: 0.1 },
    );
    t.click('[data-demo-target="cohere"]', { via: 'cursor', glideSeconds: 0.5 });
    t.call(waitForModelPickerClose, { name: 'wait for Cohere selection', seconds: 0.1 });
    t.hold(1.4);
    t.click('button.model-chip:not(.group-model-chip)', {
      via: 'cursor',
      glideSeconds: 0.45,
    });
    t.hold(1.1);
    t.call(clearModelSearch, { name: 'clear model search', seconds: 0.2 });
    t.type('.model-picker input[placeholder*="Search model"]', 'Groq', { delayMs: 85 });
    t.hold(1.2);
    t.call(
      (page) =>
        markText(page, '.model-picker__list button', initialState.demoModelName, 'groq', false),
      { name: 'mark Groq model', seconds: 0.1 },
    );
    t.click('[data-demo-target="groq"]', { via: 'cursor', glideSeconds: 0.5 });
    t.call(waitForModelPickerClose, { name: 'wait for Groq selection', seconds: 0.1 });
    t.hold(1.2);
    t.call(
      async (page) => {
        const bootstrap = await runtimeRequest(page, 'app.bootstrap');
        assert.equal(
          bootstrap.selectedModelId,
          GROQ_MODEL_ID,
          'The visible provider switch did not select Groq',
        );
      },
      { name: 'verify selected Groq route', seconds: 0.1 },
    );
    t.call(
      (page) =>
        page.evaluate(() => {
          window.__cupcakeDemoAssistantCount = document.querySelectorAll('.turn--assistant').length;
        }),
      { name: 'remember response count', seconds: 0.1 },
    );
    t.type('textarea[aria-label="Message Cupcake"]', MADARA_PROMPT, { delayMs: 24 });
    t.hold(1.3);
    t.call(addLiveGenerationCaption, {
      name: 'show honest live-generation caption',
      seconds: 0.1,
    });
    t.click('button[aria-label="Send message"]', { via: 'cursor', glideSeconds: 0.35 });
    t.call(waitForRealMadaraReply, { name: 'wait for real Madara reply', seconds: 35 });
    t.call(removeLiveGenerationCaption, {
      name: 'remove live-generation caption',
      seconds: 0.1,
    });
    t.hold(4.5);
    t.scroll('.conversation-scroll', -520, 3, 'easeInOut');
    t.hold(2);

    markAndClick(t, '.shelf__nav button', 'Artifacts', 'nav-artifacts', false);
    t.call(
      (page) =>
        markText(page, '.artifact-list__item', selections.odmArtifact, 'odm-artifact', false),
      { name: 'mark ODM artifact', seconds: 0.1 },
    );
    t.click('[data-demo-target="odm-artifact"]', { via: 'cursor', glideSeconds: 0.5 });
    t.hold(4);
    t.scroll('.document-preview', 650, 4, 'easeInOut');
    t.hold(2);

    markAndClick(t, '.shelf__nav button', 'Tasks', 'nav-tasks', false);
    t.call((page) => markText(page, '.task-row', selections.odmTask, 'odm-task', false), {
      name: 'mark ODM task',
      seconds: 0.1,
    });
    t.click('[data-demo-target="odm-task"]', { via: 'cursor', glideSeconds: 0.5 });
    t.hold(5);

    markAndClick(t, '.shelf__nav button', 'Projects', 'nav-projects-group', false);
    markAndClick(t, '.project-card__select', selections.groupProject, 'project-group', false);
    markAndClick(t, '.shelf__nav button', 'Chats', 'nav-chats-group', false);
    t.call(
      (page) => markText(page, '.chat-list__main', selections.groupChat, 'group-chat', false),
      {
        name: 'mark group chat',
        seconds: 0.1,
      },
    );
    t.click('[data-demo-target="group-chat"]', { via: 'cursor', glideSeconds: 0.5 });
    t.hold(4);
    t.scroll('.conversation-scroll', -760, 4, 'easeInOut');
    t.hold(2);

    markAndClick(t, '.shelf__nav button', 'Settings', 'nav-settings', false);
    markAndClick(t, '.settings-layout aside button', 'Appearance', 'settings-appearance');
    markAndClick(t, '.theme-grid button', 'Cupcake Dark', 'theme-dark', false);
    markAndClick(
      t,
      '.wallpaper-grid button',
      'Burgundy cinema lounge',
      'wallpaper-burgundy',
      false,
    );
    t.hold(3.5);
    markAndClick(t, '.theme-grid button', 'Minimal', 'theme-minimal', false);
    markAndClick(t, '.wallpaper-grid button', 'Cherry lacquer atelier', 'wallpaper-cherry', false);
    t.hold(3.5);
    t.call(
      (page) =>
        markText(page, '.theme-grid button', initialState.originalThemeLabel, 'theme-original'),
      { name: 'mark original theme', seconds: 0.1 },
    );
    t.click('[data-demo-target="theme-original"]', { via: 'cursor', glideSeconds: 0.45 });
    t.call(
      (page) =>
        markText(
          page,
          '.wallpaper-grid button',
          initialState.originalWallpaperLabel,
          'wallpaper-original',
          false,
        ),
      { name: 'mark original wallpaper', seconds: 0.1 },
    );
    t.click('[data-demo-target="wallpaper-original"]', {
      via: 'cursor',
      glideSeconds: 0.45,
    });
    t.hold(2.5);
    t.call(
      (page) =>
        runtimeRequest(page, 'models.select', {
          modelId: initialState.selectedModelId,
        }),
      { name: 'restore original model', seconds: 0.1 },
    );
    markAndClick(t, '.shelf__nav button', 'Home', 'nav-home-final', false);
    t.hold(3);
  });
}

async function clearModelSearch(page) {
  await page.focus('.model-picker input[placeholder*="Search model"]');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
}

async function waitForModelPickerClose(page) {
  await page.waitForSelector('.model-picker', { hidden: true, timeout: 30000 });
}

function markAndClick(t, selector, text, key, exact = true) {
  t.call((page) => markText(page, selector, text, key, exact), {
    name: `mark ${key}`,
    seconds: 0.1,
  });
  t.click(`[data-demo-target="${key}"]`, { via: 'cursor', glideSeconds: 0.45 });
  if (selector === '.project-card__select') {
    t.call(
      (page) =>
        page.waitForFunction(
          (key) =>
            globalThis.document
              .querySelector(`[data-demo-target="${key}"]`)
              ?.closest('.project-card')
              ?.classList.contains('is-active'),
          { timeout: 30000 },
          key,
        ),
      { name: `wait for ${key}`, seconds: 0.1 },
    );
  }
  t.hold(0.8);
}

async function markText(page, selector, text, key, exact = true) {
  const found = await page.evaluate(
    ({ selector, text, key, exact }) => {
      document
        .querySelectorAll('[data-demo-target]')
        .forEach((item) => item.removeAttribute('data-demo-target'));
      const normalized = (value) =>
        String(value ?? '')
          .replace(/\s+/gu, ' ')
          .trim();
      const wanted = normalized(text);
      const matches = [...document.querySelectorAll(selector)].filter((item) => {
        const value = normalized(item.textContent);
        return exact ? value === wanted : value.includes(wanted);
      });
      if (matches.length !== 1) return { count: matches.length };
      matches[0].setAttribute('data-demo-target', key);
      return { count: 1 };
    },
    { selector, text, key, exact },
  );
  assert.equal(found.count, 1, `Expected one ${selector} containing ${text}`);
}

async function waitForRealMadaraReply(page) {
  const popup = await page.evaluate(() =>
    document.body.textContent?.toLowerCase().includes('send this context'),
  );
  assert.equal(popup, false, 'A redundant outbound confirmation appeared');
  const handle = await page.waitForFunction(
    (prompt) => {
      const turns = [...document.querySelectorAll('.turn')];
      const userIndex = turns.findIndex(
        (turn) => turn.matches('.turn--user') && turn.textContent?.includes(prompt),
      );
      if (userIndex < 0) return false;
      return turns
        .slice(userIndex + 1)
        .some(
          (turn) =>
            turn.matches('.turn--assistant') &&
            !turn.querySelector('.streaming-caret') &&
            (turn.querySelector('.rich-response')?.textContent?.trim().length ?? 0) > 80,
        );
    },
    { timeout: 180_000, polling: 250 },
    MADARA_PROMPT,
  );
  await handle.dispose();
}

async function addLiveGenerationCaption(page) {
  await page.evaluate(() => {
    document.querySelector('[data-cupcake-demo-caption]')?.remove();
    const caption = document.createElement('div');
    caption.setAttribute('data-cupcake-demo-caption', 'true');
    caption.textContent = 'Real Groq response · playback 1.12×';
    Object.assign(caption.style, {
      position: 'fixed',
      right: '28px',
      bottom: '26px',
      zIndex: '2147483647',
      padding: '10px 15px',
      border: '1px solid rgba(255,255,255,.34)',
      borderRadius: '999px',
      background: 'rgba(24,16,22,.88)',
      boxShadow: '0 10px 32px rgba(0,0,0,.28)',
      color: '#fff7fa',
      font: '600 14px/1.2 system-ui, sans-serif',
      letterSpacing: '.01em',
      pointerEvents: 'none',
    });
    document.body.append(caption);
  });
}

async function removeLiveGenerationCaption(page) {
  await page.evaluate(() => document.querySelector('[data-cupcake-demo-caption]')?.remove());
}

async function inspectPreparedApp() {
  return withAttachedPage(async (page) => {
    const identity = await page.evaluate(async () => ({
      tauri: '__TAURI_INTERNALS__' in window,
      app: await window.cupcake?.app?.getInfo?.(),
      runtime: await window.cupcake?.runtime?.status?.(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      },
    }));
    assert(identity.tauri && identity.app?.packaged === true, 'Packaged Tauri app required');
    assert.equal(identity.runtime?.state, 'ready');
    assert.deepEqual(identity.viewport, { width: 1440, height: 920, dpr: 1.5 });
    const bootstrap = await runtimeRequest(page, 'app.bootstrap');
    const selectedModelId = bootstrap.selectedModelId;
    assert(selectedModelId, 'Current model is missing');
    const models = modelArray(await runtimeRequest(page, 'models.list'));
    const selectedModel = models.find((model) => model.id === selectedModelId);
    assert(modelReady(selectedModel), 'Current NVIDIA NIM model is not ready');
    assert.equal(
      normalizeProvider(selectedModel.provider ?? selectedModel.providerId),
      'nvidia-nim',
      'Recording must start on hosted NVIDIA NIM; local routes are forbidden',
    );
    const demoModel = models.find((model) => model.id === GROQ_MODEL_ID);
    assert(modelReady(demoModel), 'Groq GPT-OSS 120B is not ready');
    const cohereModel = models.find((model) => model.id === COHERE_MODEL_ID);
    assert(modelReady(cohereModel), 'Cohere Command A+ is not ready');
    const appearanceTheme = settingValue(
      await runtimeRequest(page, 'settings.get', { key: 'appearance.theme' }),
    );
    const wallpaper = settingValue(
      await runtimeRequest(page, 'settings.get', { key: 'appearance.wallpaper' }),
    );
    assert(themeLabels[appearanceTheme], `Unknown theme: ${appearanceTheme}`);
    assert(wallpaperLabels[wallpaper], `Unknown wallpaper: ${wallpaper}`);
    const projects = await runtimeRequest(page, 'projects.list', { includeArchived: false });
    const everydayProject = exactBy(projects, 'name', selections.everydayProject);
    const animeProject = exactBy(projects, 'name', selections.project);
    const groupProject = exactBy(projects, 'name', selections.groupProject);
    const everydayChats = await runtimeRequest(page, 'conversations.list', {
      projectId: everydayProject.id,
      includeArchived: false,
      limit: 500,
    });
    const landlordChat = exactBy(everydayChats, 'title', selections.landlordChat);
    const animeChats = await runtimeRequest(page, 'conversations.list', {
      projectId: animeProject.id,
      includeArchived: false,
      limit: 500,
    });
    const odmChat = exactBy(animeChats, 'title', selections.odmChat);
    const groupChats = await runtimeRequest(page, 'conversations.list', {
      projectId: groupProject.id,
      includeArchived: false,
      limit: 500,
    });
    const groupChat = exactBy(groupChats, 'title', selections.groupChat);
    const artifacts = await runtimeRequest(page, 'artifacts.list', { projectId: animeProject.id });
    const odmArtifact = exactBy(artifacts, 'title', selections.odmArtifact);
    const tasks = taskArray(await runtimeRequest(page, 'tasks.list', { limit: 500 }));
    const odmTask = exactTask(tasks, selections.odmTask);
    const [landlordProof, odmProof, groupProof, taskProof] = await Promise.all([
      inspectRealConversation(page, landlordChat.id, 1),
      inspectRealConversation(page, odmChat.id, 1),
      inspectRealConversation(page, groupChat.id, 2),
      inspectRealCodeTask(page, odmTask, animeProject.id, odmArtifact),
    ]);
    const existing = await findPromptReply(page, animeProject.id, MADARA_PROMPT);
    assert.equal(existing, null, 'Madara prompt already exists; use a fresh prepared demo profile');
    return {
      viewport: identity.viewport,
      selectedModelId,
      originalTheme: appearanceTheme,
      originalThemeLabel: themeLabels[appearanceTheme],
      originalWallpaper: wallpaper,
      originalWallpaperLabel: wallpaperLabels[wallpaper],
      demoModelName: demoModel.display_name ?? demoModel.name,
      cohereModelName: cohereModel.display_name ?? cohereModel.name,
      prepared: {
        everydayProjectId: everydayProject.id,
        landlordConversationId: landlordChat.id,
        projectId: animeProject.id,
        odmConversationId: odmChat.id,
        odmArtifactId: odmArtifact.id,
        odmTaskId: odmTask.run_id ?? odmTask.runId,
        groupProjectId: groupProject.id,
        groupConversationId: groupChat.id,
        proofs: { landlord: landlordProof, odm: odmProof, group: groupProof, task: taskProof },
      },
    };
  });
}

async function inspectPersistedMadaraReply() {
  return withAttachedPage(async (page) => {
    const projects = await runtimeRequest(page, 'projects.list', { includeArchived: false });
    const project = exactBy(projects, 'name', selections.project);
    const match = await findPromptReply(page, project.id, MADARA_PROMPT);
    assert(match, 'The recorded Madara send was not persisted');
    assert.equal(match.assistant.state, 'complete');
    assert(
      ['stop', 'end_turn'].includes(match.assistant.canonical_metadata?.finishReason),
      'The recorded response is incomplete',
    );
    assert(
      match.assistant.provider_id && match.assistant.model_id,
      'Real route provenance missing',
    );
    assert.equal(normalizeProvider(match.assistant.provider_id), 'openai-compatible');
    assert.match(match.assistant.model_id, /gpt-oss-120b$/u);
    return {
      projectId: project.id,
      conversationId: match.conversation.id,
      branchId: match.branchId,
      userMessageId: match.user.id,
      assistantMessageId: match.assistant.id,
      provider: match.assistant.provider_id,
      model: match.assistant.model_id,
      characters: match.assistant.content.length,
    };
  });
}

async function inspectRealConversation(page, conversationId, minimumAssistantReplies) {
  const state = await runtimeRequest(page, 'conversations.get', { conversationId });
  const branchId = state.activeBranchId ?? state.branches?.[0]?.id;
  assert(branchId, `Conversation ${conversationId} has no branch`);
  const history = await runtimeRequest(page, 'chat.history', { branchId });
  const assistants = history.filter(
    (message) =>
      message.role === 'assistant' &&
      message.state === 'complete' &&
      ['stop', 'end_turn'].includes(message.canonical_metadata?.finishReason) &&
      message.provider_id &&
      message.model_id &&
      message.content?.trim().length > 80,
  );
  assert(
    assistants.length >= minimumAssistantReplies,
    `Conversation ${conversationId} lacks real complete assistant replies`,
  );
  const providers = [...new Set(assistants.map((message) => message.provider_id))];
  if (minimumAssistantReplies > 1) {
    assert(providers.length >= 2, `Group conversation ${conversationId} lacks provider diversity`);
  }
  return {
    conversationId,
    branchId,
    assistantReplies: assistants.length,
    providers,
    models: [...new Set(assistants.map((message) => message.model_id))],
  };
}

async function inspectRealCodeTask(page, task, projectId, artifact) {
  const runId = task.run_id ?? task.runId;
  assert(runId, 'ODM task has no durable run ID');
  const saved = await runtimeRequest(page, 'tasks.get', { runId });
  const spec = saved.spec ?? {};
  assert.equal(saved.status, 'succeeded', 'ODM task did not succeed');
  assert.equal(
    spec.project_id ?? spec.projectId,
    projectId,
    'ODM task is bound to another project',
  );
  assert.equal(spec.work_kind ?? spec.workKind, 'code_execution', 'ODM task is not code execution');
  const inputs = (spec.steps ?? []).flatMap(
    (step) => step.arguments?.artifactInputs ?? step.arguments?.artifact_inputs ?? [],
  );
  assert(
    inputs.some(
      (input) => input.artifactId === artifact.id && input.revisionId === artifact.head_revision_id,
    ),
    'ODM task is not bound to the current saved artifact revision',
  );
  const proof = saved.tool_evidence;
  assert.equal(proof?.status, 'succeeded', 'ODM task has no successful tool evidence');
  assert.equal(proof?.exitStatus, 0, 'ODM task exited unsuccessfully');
  assert.equal(proof?.tool, 'python.run', 'ODM task did not use the Python tool');
  assert.equal(proof?.nativeTool, 'native.sandbox.python', 'ODM task did not use native Python');
  assert.equal(proof?.artifactId, artifact.id, 'ODM task evidence names another artifact');
  assert.equal(
    proof?.revisionId,
    artifact.head_revision_id,
    'ODM task evidence names another revision',
  );
  assert.equal(proof?.testSummary?.successful, true, 'ODM task tests were not successful');
  assert(
    Number.isSafeInteger(proof?.testSummary?.run) && proof.testSummary.run >= 1,
    'ODM task evidence contains no executed tests',
  );
  assert(
    Array.isArray(proof?.provenance) && proof.provenance.length > 0,
    'ODM task has no execution provenance',
  );
  return {
    runId,
    artifactId: proof.artifactId,
    revisionId: proof.revisionId,
    exitStatus: proof.exitStatus,
    tests: proof.testSummary ?? null,
  };
}

async function restoreInitialState() {
  if (!initialState) return { ok: true, changed: false };
  return withAttachedPage(async (page) => {
    await removeLiveGenerationCaption(page);
    await runtimeRequest(page, 'settings.set', {
      key: 'appearance.theme',
      value: initialState.originalTheme,
    });
    await runtimeRequest(page, 'settings.set', {
      key: 'appearance.wallpaper',
      value: initialState.originalWallpaper,
    });
    await runtimeRequest(page, 'models.select', {
      modelId: initialState.selectedModelId,
    });
    return {
      ok: true,
      theme: initialState.originalTheme,
      wallpaper: initialState.originalWallpaper,
      selectedModelId: initialState.selectedModelId,
    };
  });
}

async function findPromptReply(page, projectId, prompt) {
  const conversations = await runtimeRequest(page, 'conversations.list', {
    projectId,
    includeArchived: false,
    limit: 500,
  });
  const matches = [];
  for (const conversation of conversations) {
    const state = await runtimeRequest(page, 'conversations.get', {
      conversationId: conversation.id,
    });
    const branches =
      state.branches ??
      (await runtimeRequest(page, 'conversations.branches', { conversationId: conversation.id }));
    for (const branch of branches) {
      const history = await runtimeRequest(page, 'chat.history', { branchId: branch.id });
      const userIndex = history.findIndex(
        (message) => message.role === 'user' && message.content === prompt,
      );
      if (userIndex < 0) continue;
      const assistant = history
        .slice(userIndex + 1)
        .find((message) => message.role === 'assistant');
      if (assistant)
        matches.push({ conversation, branchId: branch.id, user: history[userIndex], assistant });
    }
  }
  assert(matches.length <= 1, 'Madara prompt appears more than once');
  return matches[0] ?? null;
}

async function withAttachedPage(fn) {
  const requireFromInstall = createRequire(pathToFileURL(join(install, 'package.json')));
  const puppeteerPath = requireFromInstall.resolve('puppeteer-core');
  const puppeteerModule = await import(pathToFileURL(puppeteerPath).href);
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null,
  });
  try {
    const pages = await browser.pages();
    const page = pages.find((item) => /tauri\.localhost/iu.test(item.url()));
    assert(page, 'Cupcake Chat WebView2 page is missing');
    return await fn(page);
  } finally {
    await browser.disconnect();
  }
}

async function runtimeRequest(page, method, params = {}, timeoutMs = 180_000) {
  const response = await page.evaluate(
    async ({ method, params, timeoutMs }) =>
      window.cupcake.runtime.request({ method, params, timeoutMs }),
    { method, params, timeoutMs },
  );
  if (!response?.ok) {
    throw new Error(
      `${method}: ${response?.error?.code ?? 'FAILED'}: ${safeText(response?.error?.message)}`,
    );
  }
  return response.result;
}

function exactBy(items, key, value) {
  const matches = items.filter((item) => item[key] === value);
  assert.equal(matches.length, 1, `Expected one ${key}=${value}`);
  return matches[0];
}

function modelArray(value) {
  return Array.isArray(value) ? value : (value?.models ?? []);
}

function modelReady(model) {
  if (!model || model.available === false || model.enabled === false) return false;
  const status = String(model.availability?.status ?? model.status ?? '').toLowerCase();
  return !['unavailable', 'not_configured', 'not_loaded', 'offline_blocked', 'error'].includes(
    status,
  );
}

function normalizeProvider(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/gu, '-');
}

function taskArray(value) {
  return Array.isArray(value) ? value : (value?.tasks ?? []);
}

function exactTask(tasks, title) {
  const matches = tasks.filter((task) => (task?.spec?.title ?? task?.title) === title);
  assert.equal(matches.length, 1, `Expected one task title=${title}`);
  return matches[0];
}

function settingValue(value) {
  return typeof value === 'object' && value !== null && 'value' in value ? value.value : value;
}

function assertChildOfETemp(path) {
  if (!isAbsolute(path)) throw new Error('Output must be absolute');
  const root = resolve('E:/temp');
  const rel = relative(root, resolve(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Output must be a child of ${root}`);
  }
}

function safeError(error) {
  return { name: safeText(error?.name ?? 'Error'), message: safeText(error?.message ?? error) };
}

function safeText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|AIza|key|token)[-_A-Za-z0-9+/=.]{12,}\b/gu, '[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 1200);
}
