#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(option('--port', '10131'));
const output = resolve(option('--output', 'E:/temp/cupcake-chat-rebrand-20260914/native'));
const cdp = option('--cdp', `http://127.0.0.1:${port}`);

const plannedChecks = [
  'packaged Windows bridge and standard, unzoomed viewport',
  'repeated New chat drafts do not persist',
  'opening and cancelling Add Cupcake does not persist a conversation',
  'Recent > All chats toggles every active conversation inside the sidebar without navigating',
  'the top of a project card selects that project',
  'normal and rapid artifact project switches never show a blank or mixed-project frame',
  'Models typography minimums and uncluttered header geometry',
  'the custom title bar contains no app icon or app-name label',
  'all seventeen wallpapers after Copper workshop activate and persist',
  'user and assistant turns use distinct colors with matching avatar/name geometry',
];

if (!execute) {
  process.stdout.write(
    `${JSON.stringify(
      {
        execute: false,
        message:
          'Dry run only. Start the newly packaged app with remote debugging, then add --execute.',
        example: `node scripts/verify-cupcake-chat-refresh.mjs --execute --port ${port}`,
        cdp,
        output,
        plannedChecks,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('--port must be a non-privileged TCP port');
}

await mkdir(output, { recursive: true });

const receipt = {
  generatedAt: new Date().toISOString(),
  cdp,
  output,
  packaged: false,
  appInfo: null,
  viewport: null,
  checks: [],
  failures: [],
  screenshots: [],
  originalSettings: null,
  restoredSettings: null,
};

let browser;
let page;
let originalSettings;

try {
  browser = await chromium.connectOverCDP(cdp);
  page = await findTauriPage(browser, 30_000);
  page.setDefaultTimeout(30_000);

  const appInfo = await page.evaluate(() => globalThis.window.cupcake?.app.getInfo());
  receipt.appInfo = appInfo ?? null;
  receipt.packaged = appInfo?.packaged === true;
  requireCheck('native-packaged-app', receipt.packaged, { appInfo });
  requireCheck('native-platform', appInfo?.platform === 'win32', { platform: appInfo?.platform });

  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 120_000 });
  await page.locator('.new-chat').waitFor();
  const viewport = await page.evaluate(() => ({
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    devicePixelRatio: globalThis.devicePixelRatio,
    visualScale: globalThis.visualViewport?.scale ?? 1,
  }));
  receipt.viewport = viewport;
  requireCheck(
    'standard-window-no-zoom',
    viewport.innerWidth >= 1200 &&
      viewport.innerHeight >= 760 &&
      Math.abs(viewport.visualScale - 1) < 0.01,
    viewport,
  );

  originalSettings = await runtime('settings.list');
  receipt.originalSettings = selectAppearanceSettings(originalSettings);

  await checkTitlebar();
  await checkEmptyDrafts();
  const chatFixture = await checkAllChatsAndCrossProjectNavigation();
  await checkTurnGeometry(chatFixture);
  await checkProjectCardTopSelection();
  await checkArtifactSwitching();
  await checkModels();
  await checkWallpapers();
} catch (error) {
  receipt.failures.push({
    name: 'harness-error',
    message: sanitize(error instanceof Error ? error.stack || error.message : error),
  });
} finally {
  if (page && originalSettings) {
    try {
      await restoreAppearanceSettings(originalSettings);
      receipt.restoredSettings = {
        ...selectAppearanceSettings(await runtime('settings.list')),
        renderedTheme: await page.locator('html').getAttribute('data-theme'),
        renderedWallpaper:
          (await page.locator('.app-shell').getAttribute('data-wallpaper')) ?? 'none',
      };
      const original = receipt.originalSettings;
      const restored = receipt.restoredSettings;
      const expectedRenderedTheme =
        original.theme === 'cupcake-dark'
          ? 'dark'
          : original.theme === 'cupcake-light'
            ? 'light'
            : original.theme;
      requireCheck(
        'appearance-settings-restored',
        original.theme === restored.theme &&
          original.wallpaper === restored.wallpaper &&
          expectedRenderedTheme === restored.renderedTheme &&
          (original.wallpaper ?? 'none') === restored.renderedWallpaper,
        { original, restored },
      );
    } catch (error) {
      receipt.failures.push({
        name: 'appearance-settings-restored',
        message: sanitize(error),
      });
    }
  }
  await browser?.close().catch(() => undefined);
  receipt.passed = receipt.failures.length === 0;
  await writeFile(
    resolve(output, 'cupcake-chat-refresh-verification.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  );
}

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!receipt.passed) process.exitCode = 1;

async function checkTitlebar() {
  const titlebar = page.locator('.cupcake-titlebar');
  await titlebar.waitFor();
  const identity = titlebar.locator('.cupcake-titlebar__identity');
  const evidence = {
    identityText: (await identity.innerText()).trim(),
    identityImages: await identity.locator('img, svg').count(),
    searchVisible: await titlebar.getByRole('button', { name: 'Search Cupcake Chat' }).isVisible(),
    windowControls: await titlebar.locator('.window-control').count(),
  };
  requireCheck(
    'titlebar-brand-is-absent',
    evidence.identityText === '' && evidence.identityImages === 0 && evidence.windowControls === 3,
    evidence,
  );
  await screenshot('01-titlebar-and-home.png');
}

async function checkEmptyDrafts() {
  const before = await activeConversationInventory();
  for (let index = 0; index < 4; index += 1) {
    await page.locator('.new-chat').click();
    await page.locator('.chat-main').waitFor();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.locator('.project-library').waitFor();
  }
  const afterDrafts = await activeConversationInventory();
  requireCheck('empty-new-chat-drafts-not-persisted', sameIds(before, afterDrafts), {
    before: before.length,
    after: afterDrafts.length,
  });

  await page.locator('.new-chat').click();
  await page.locator('.chat-main').waitFor();
  await page.getByRole('button', { name: 'Add Cupcake', exact: true }).click();
  const dialog = page.getByTestId('add-cupcake-dialog');
  await dialog.waitFor();
  await page.getByRole('button', { name: 'Close Add Cupcake', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const afterDialog = await activeConversationInventory();
  requireCheck('cancelled-add-cupcake-does-not-persist', sameIds(before, afterDialog), {
    before: before.length,
    after: afterDialog.length,
  });
  await screenshot('02-empty-chat-and-cancelled-cupcake.png');
}

async function checkAllChatsAndCrossProjectNavigation() {
  const [projects, conversations] = await Promise.all([
    runtime('projects.list', { includeArchived: false }),
    activeConversationInventory(),
  ]);
  const projectById = new Map(projects.map((project) => [project.id, project.name]));
  const usable = conversations.filter(
    (conversation) => conversation.project_id && projectById.has(conversation.project_id),
  );
  const projectIds = [...new Set(usable.map((conversation) => conversation.project_id))];
  requireCheck('cross-project-fixture-available', projectIds.length >= 2, {
    activeConversations: conversations.length,
    projectsWithChats: projectIds.length,
  });
  if (projectIds.length < 2) throw new Error('Need active chats in at least two projects');

  const mainBeforeToggle = await page.locator('.app-content').innerText();
  const sidebarToggle = page.getByRole('button', {
    name: 'Show all chats in sidebar',
    exact: true,
  });
  await sidebarToggle.click();
  requireCheck(
    'sidebar-toggle-does-not-navigate',
    (await page.locator('.app-content').innerText()) === mainBeforeToggle &&
      (await sidebarToggle.getAttribute('aria-pressed')) === 'true',
  );
  const rows = page.locator('.shelf__recent-list > button');
  await expectCount(rows, conversations.length, 30_000);
  requireCheck('all-chats-count-matches-runtime', (await rows.count()) === conversations.length, {
    runtimeCount: conversations.length,
    renderedCount: await rows.count(),
  });
  await screenshot('03-all-chats-across-projects.png');

  const targets = projectIds
    .slice(0, 2)
    .map((projectId) => usable.find((conversation) => conversation.project_id === projectId));
  for (const target of targets) {
    const projectName = projectById.get(target.project_id);
    const row = rows.filter({ hasText: target.title }).first();
    await row.click();
    await page.locator('.chat-header h1').filter({ hasText: target.title }).waitFor();
    const evidence = {
      expectedTitle: target.title,
      renderedTitle: (await page.locator('.chat-header h1').innerText()).trim(),
      expectedProject: projectName,
      renderedProject: (await page.locator('.chat-project').innerText()).trim(),
    };
    requireCheck(
      `cross-project-chat-${target.id}`,
      evidence.renderedTitle === target.title && evidence.renderedProject.includes(projectName),
      evidence,
    );
  }
  await sidebarToggle.click();
  requireCheck(
    'sidebar-toggle-returns-to-recent',
    (await rows.count()) <= 3 && (await sidebarToggle.getAttribute('aria-pressed')) === 'false',
  );
  return { conversation: targets.at(-1), projectName: projectById.get(targets.at(-1).project_id) };
}

async function checkTurnGeometry(chatFixture) {
  await page.locator('.turn--user').first().waitFor();
  await page.locator('.turn--assistant').first().waitFor();
  const evidence = await page.evaluate(() => {
    const measure = (selector) => {
      const turn = globalThis.document.querySelector(selector);
      const node = turn?.querySelector('.thread-node')?.getBoundingClientRect();
      const message = turn?.querySelector('.message')?.getBoundingClientRect();
      const meta = turn?.querySelector('.message-meta')?.getBoundingClientRect();
      const messageStyle = turn?.querySelector('.message')
        ? globalThis.getComputedStyle(turn.querySelector('.message'))
        : null;
      return node && message && meta && messageStyle
        ? {
            nodeX: node.x,
            nodeWidth: node.width,
            messageX: message.x,
            messageWidth: message.width,
            metaX: meta.x,
            nodeToMetaY: meta.y - node.y,
            background: messageStyle.backgroundColor,
            borderLeft: messageStyle.borderLeftColor,
          }
        : null;
    };
    return { user: measure('.turn--user'), assistant: measure('.turn--assistant') };
  });
  const { user, assistant } = evidence;
  const aligned =
    user &&
    assistant &&
    Math.abs(user.nodeX - assistant.nodeX) <= 2 &&
    Math.abs(user.nodeWidth - assistant.nodeWidth) <= 2 &&
    Math.abs(user.messageX - assistant.messageX) <= 2 &&
    Math.abs(user.metaX - assistant.metaX) <= 2 &&
    Math.abs(user.nodeToMetaY - assistant.nodeToMetaY) <= 3;
  requireCheck('user-assistant-avatar-name-geometry', Boolean(aligned), evidence);
  requireCheck(
    'user-assistant-bubbles-have-distinct-color',
    Boolean(user && assistant && user.background !== assistant.background),
    evidence,
  );
  requireCheck(
    'human-bubble-compact-width',
    Boolean(user && assistant && user.messageWidth < assistant.messageWidth * 0.85),
    evidence,
  );
  const attach = page.getByRole('button', { name: 'Attach file', exact: true });
  await page.mouse.move(0, 0);
  const started = Date.now();
  await attach.hover();
  await page.getByRole('tooltip').waitFor();
  const elapsedMs = Date.now() - started;
  requireCheck('tooltip-appears-promptly', elapsedMs < 500, {
    elapsedMs,
    text: await page.getByRole('tooltip').innerText(),
  });
  await page.keyboard.press('Escape');
  await page.getByRole('tooltip').waitFor({ state: 'detached' });
  await attach.focus();
  await page.getByRole('tooltip').waitFor();
  requireCheck(
    'tooltip-keyboard-description',
    (await attach.getAttribute('aria-describedby'))?.includes('cupcake-tooltip'),
  );
  await page.keyboard.press('Escape');
  await screenshot('04-chat-turn-geometry.png');
  return chatFixture;
}

async function checkProjectCardTopSelection() {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const library = page.locator('.project-library');
  await library.waitFor();
  const cards = library.locator('.project-card--workbench');
  const count = await cards.count();
  let target;
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    if (!(await card.evaluate((element) => element.classList.contains('is-active')))) {
      target = card;
      break;
    }
  }
  if (!target) throw new Error('Need a non-active project card for top-hit testing');
  const projectName = (await target.locator('.project-card__select strong').innerText()).trim();
  const header = target.locator('header');
  const box = await header.boundingBox();
  if (!box) throw new Error(`Project card header for ${projectName} has no hit box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitFor(
    async () => target.evaluate((element) => element.classList.contains('is-active')),
    30_000,
    `top of ${projectName} project card to activate`,
  );
  requireCheck('project-card-top-selects-project', true, { projectName, click: box });
  await screenshot('05-project-card-top-selected.png');
}

async function checkArtifactSwitching() {
  const projects = await runtime('projects.list', { includeArchived: false });
  const candidates = [];
  for (const project of projects) {
    const artifacts = await runtime('artifacts.list', { projectId: project.id });
    if (!artifacts.length) continue;
    const first = artifacts[0];
    const snapshot = await runtime('artifacts.get', {
      artifactId: first.id,
      projectId: project.id,
      revisionId: first.head_revision_id,
    });
    candidates.push({
      project,
      artifact: first,
      contentHash: sha256(snapshot.content ?? ''),
    });
    if (candidates.length === 2) break;
  }
  if (candidates.length < 2) throw new Error('Need artifacts in two projects for switch testing');
  const [left, right] = candidates;

  await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
  await switchArtifactProject(left.project.name);
  const leftSettled = await artifactFrame();
  const normalFrames = await captureArtifactTransition(right.project.name, '06-artifact-normal');
  validateArtifactFrames(normalFrames, left, right, leftSettled);

  await switchArtifactProject(left.project.name);
  const rapidCapture = monitorArtifactFrames(1800);
  const rightChip = artifactProjectChip(right.project.name);
  const leftChip = artifactProjectChip(left.project.name);
  await rightChip.click();
  await leftChip.click();
  await rightChip.click();
  const rapidFrames = await rapidCapture;
  await waitFor(
    async () => (await artifactFrame()).project === right.project.name,
    30_000,
    `rapid artifact switch to ${right.project.name}`,
  );
  rapidFrames.push(await artifactFrame());
  validateArtifactFrames(rapidFrames, left, right, leftSettled);
  await screenshot('07-artifact-rapid-final.png');
}

async function checkModels() {
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.locator('.model-atlas-hero').waitFor();
  const evidence = await page.evaluate(() => {
    const box = (selector) => {
      const node = globalThis.document.querySelector(selector);
      const rect = node?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    };
    const fontSizes = (selector) =>
      [...globalThis.document.querySelectorAll(selector)]
        .filter((node) => node instanceof globalThis.HTMLElement && node.offsetParent !== null)
        .map((node) => ({
          text: node.textContent?.trim().slice(0, 80),
          px: parseFloat(globalThis.getComputedStyle(node).fontSize),
        }));
    return {
      hero: box('.model-atlas-hero'),
      copy: box('.model-atlas-hero__copy'),
      current: box('.model-atlas-current'),
      actions: box('.model-atlas-hero__actions'),
      heading: fontSizes('.model-atlas-hero__copy h2'),
      primaryCopy: fontSizes(
        '.model-atlas-hero__copy > p:last-of-type, .model-atlas-current strong',
      ),
      supportingCopy: fontSizes(
        '.model-atlas-current small, .model-atlas-current > p, .model-card > p, .model-card dt, .model-card dd',
      ),
    };
  });
  const noOverlap =
    evidence.copy &&
    evidence.current &&
    evidence.actions &&
    !overlaps(evidence.copy, evidence.actions) &&
    !overlaps(evidence.current, evidence.actions);
  const min = (items) => Math.min(...items.map((item) => item.px));
  requireCheck('models-header-uncluttered', Boolean(noOverlap), evidence);
  requireCheck(
    'models-readable-type',
    min(evidence.heading) >= 30 &&
      min(evidence.primaryCopy) >= 15 &&
      min(evidence.supportingCopy) >= 12,
    evidence,
  );
  await screenshot('08-models-header-and-type.png');
}

async function checkWallpapers() {
  const wallpapers = [
    ['aquamarine-tidepool-library', 'Tidepool library'],
    ['ink-snow-garden', 'Ink snow garden'],
    ['raspberry-circuit-conservatory', 'Circuit conservatory'],
    ['saffron-paper-city', 'Saffron paper city'],
    ['lavender-cloud-parlour', 'Lavender cloud parlour'],
    ['ember-rain-cafe', 'Ember rain café'],
    ['citrus-solar-studio', 'Citrus solar studio'],
    ['rosewood-reading-room', 'Rosewood reading room'],
    ['cherry-lacquer-atelier', 'Cherry lacquer atelier'],
    ['burgundy-cinema-lounge', 'Burgundy cinema lounge'],
    ['peach-blossom-loft', 'Peach blossom loft'],
    ['jade-paper-conservatory', 'Jade paper conservatory'],
    ['cobalt-night-train', 'Cobalt night train'],
    ['amethyst-mineral-gallery', 'Amethyst mineral gallery'],
    ['amber-desert-observatory', 'Amber desert observatory'],
    ['ice-blue-nordic-atrium', 'Ice blue Nordic atrium'],
    ['obsidian-aurora-workshop', 'Obsidian aurora workshop'],
  ];
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('heading', { name: 'Workspace wallpaper', exact: true }).waitFor();
  for (const [id, label] of wallpapers) {
    const button = page.locator('.wallpaper-grid button').filter({ hasText: label });
    await button.click();
    await waitFor(
      async () =>
        page
          .locator('.app-shell')
          .getAttribute('data-wallpaper')
          .then((value) => value === id),
      15_000,
      `${label} wallpaper to render`,
    );
    const settings = await runtime('settings.list');
    requireCheck(`wallpaper-${id}`, settings['appearance.wallpaper'] === id, {
      rendered: await page.locator('.app-shell').getAttribute('data-wallpaper'),
      persisted: settings['appearance.wallpaper'],
    });
    if (id === 'lavender-cloud-parlour' || id === 'citrus-solar-studio') {
      await screenshot(`09-theme-${id}.png`);
    }
  }
}

async function switchArtifactProject(projectName) {
  const chip = artifactProjectChip(projectName);
  if (!(await chip.evaluate((element) => element.classList.contains('is-active')))) {
    await chip.click();
  }
  await waitFor(
    async () => (await artifactFrame()).project === projectName,
    30_000,
    `artifact project ${projectName}`,
  );
  await page.locator('.artifact-stage').waitFor();
}

function artifactProjectChip(projectName) {
  return page.getByRole('button', { name: `Show artifacts from ${projectName}`, exact: true });
}

async function captureArtifactTransition(projectName, screenshotPrefix) {
  const capture = monitorArtifactFrames(1200);
  await artifactProjectChip(projectName).click();
  const frames = await capture;
  await waitFor(
    async () => (await artifactFrame()).project === projectName,
    30_000,
    `artifact project ${projectName}`,
  );
  frames.push(await artifactFrame());
  await screenshot(`${screenshotPrefix}-final.png`);
  return frames;
}

async function artifactFrame() {
  return (await monitorArtifactFrames(0))[0];
}

async function monitorArtifactFrames(durationMs) {
  return page.evaluate(async (duration) => {
    const frames = [];
    const deadline = globalThis.performance.now() + duration;
    do {
      frames.push(readFrame());
      if (duration > 0)
        await new Promise((resolveFrame) => globalThis.requestAnimationFrame(resolveFrame));
    } while (globalThis.performance.now() < deadline);
    return frames;

    function readFrame() {
      const project =
        globalThis.document.querySelector('.artifact-scope > strong')?.textContent?.trim() ?? null;
      const title =
        globalThis.document.querySelector('.artifact-stage__header h1')?.textContent?.trim() ??
        null;
      const preview =
        globalThis.document.querySelector('.document-preview')?.textContent?.trim() ?? '';
      return {
        project,
        title,
        previewHash: preview ? hashText(preview) : null,
        previewLength: preview.length,
        loading: Boolean(globalThis.document.querySelector('.artifact-loading')),
        blank:
          !globalThis.document.querySelector('.artifact-workspace') ||
          !globalThis.document.querySelector('.artifact-stage'),
        error:
          globalThis.document.querySelector('.artifact-inline-error')?.textContent?.trim() ?? null,
      };
    }

    function hashText(value) {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    }
  }, durationMs);
}

function validateArtifactFrames(frames, left, right, leftSettled) {
  const known = new Map([
    [left.project.name, left.artifact.title],
    [right.project.name, right.artifact.title],
  ]);
  const mixed = frames.filter((frame) => {
    const expectedTitle = known.get(frame.project);
    return (
      frame.blank ||
      frame.loading ||
      Boolean(frame.error) ||
      !expectedTitle ||
      frame.title !== expectedTitle ||
      (frame.project === right.project.name &&
        leftSettled.previewHash &&
        frame.previewHash === leftSettled.previewHash)
    );
  });
  requireCheck(`artifact-transition-${receipt.checks.length}`, mixed.length === 0, {
    from: {
      project: left.project.name,
      artifact: left.artifact.title,
      contentHash: left.contentHash,
    },
    to: {
      project: right.project.name,
      artifact: right.artifact.title,
      contentHash: right.contentHash,
    },
    frames,
    mixed,
  });
}

async function activeConversationInventory() {
  return runtime('conversations.list', { includeArchived: false, limit: 2000 });
}

async function runtime(method, params = {}) {
  const response = await page.evaluate(
    async ({ method: runtimeMethod, params: runtimeParams }) =>
      globalThis.window.cupcake?.runtime.request({
        method: runtimeMethod,
        params: runtimeParams,
        timeoutMs: 120_000,
      }),
    { method, params },
  );
  if (!response?.ok) {
    throw new Error(
      `${method}: ${response?.error?.code ?? 'NO_RESPONSE'} ${response?.error?.message ?? ''}`,
    );
  }
  return response.result;
}

async function restoreAppearanceSettings(settings) {
  const entries = [
    ['appearance.theme', settings['appearance.theme']],
    ['appearance.wallpaper', settings['appearance.wallpaper']],
  ];
  for (const [key, value] of entries) {
    if (value !== undefined) await runtime('settings.set', { key, value });
  }
  await page.evaluate((appearance) => {
    const key = 'cupcake-workspace-settings';
    try {
      const current = JSON.parse(globalThis.localStorage.getItem(key) || '{}');
      if (appearance.theme !== undefined) {
        current.theme =
          appearance.theme === 'cupcake-dark'
            ? 'dark'
            : appearance.theme === 'cupcake-light'
              ? 'light'
              : appearance.theme;
      }
      if (appearance.wallpaper !== undefined) current.wallpaper = appearance.wallpaper;
      globalThis.localStorage.setItem(key, JSON.stringify(current));
    } catch {
      // Runtime settings remain authoritative on the next launch.
    }
  }, selectAppearanceSettings(settings));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 120_000 });
  await page.locator('.new-chat').waitFor();
}

function selectAppearanceSettings(settings) {
  return {
    theme: settings?.['appearance.theme'],
    wallpaper: settings?.['appearance.wallpaper'],
  };
}

async function screenshot(name) {
  const path = resolve(output, name);
  await page.screenshot({ path });
  receipt.screenshots.push(path);
}

function requireCheck(name, passed, evidence = {}) {
  const item = { name, passed: Boolean(passed), evidence };
  receipt.checks.push(item);
  if (!passed) receipt.failures.push(item);
}

function sameIds(left, right) {
  return (
    left.length === right.length &&
    left
      .map((item) => item.id)
      .sort()
      .every((id, index) => id === right.map((item) => item.id).sort()[index])
  );
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function overlaps(left, right) {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

async function expectCount(locator, expected, timeoutMs) {
  await waitFor(
    async () => (await locator.count()) === expected,
    timeoutMs,
    `locator count ${expected}`,
  );
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${sanitize(lastError)}` : ''}`);
}

async function findTauriPage(connectedBrowser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = connectedBrowser.contexts().flatMap((context) => context.pages());
    const candidate = pages.find((item) => item.url().startsWith('https://tauri.localhost'));
    if (candidate) return candidate;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('The CDP target does not contain a https://tauri.localhost packaged renderer');
}

function sanitize(value) {
  return String(value)
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, '[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(-3000);
}
