#!/usr/bin/env node
/* global document, getComputedStyle, HTMLElement, innerHeight, innerWidth, requestAnimationFrame */
import AxeBuilder from '@axe-core/playwright';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:42620';
const output = resolve(process.argv[3] ?? 'E:/temp/cupcake-overhaul-20260905/integrated-ui');
const variants = [
  {
    name: 'narrow-light-ink-snow',
    width: 390,
    height: 844,
    theme: 'light',
    wallpaper: 'Ink snow garden',
  },
  {
    name: 'compact-dark-blueberry',
    width: 768,
    height: 900,
    theme: 'dark',
    wallpaper: 'Blueberry observatory',
  },
  {
    name: 'desktop-light-raspberry',
    width: 1440,
    height: 900,
    theme: 'light',
    wallpaper: 'Circuit conservatory',
  },
  {
    name: 'ultrawide-dark-moonlit',
    width: 2160,
    height: 1080,
    theme: 'dark',
    wallpaper: 'Moonlit archive',
  },
];
const views = ['Home', 'Chats', 'Projects', 'Tasks', 'Artifacts', 'Memory', 'Models', 'Tools'];

await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const report = {
  kind: 'browser fixture evidence',
  note: 'This validates the renderer fixture only. Packaged Windows evidence is separate.',
  baseURL,
  capturedAt: new Date().toISOString(),
  variants: [],
  keyboard: [],
  navigation: [],
  highContrast: [],
  browserErrors: [],
  accessibility: [],
};

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/(^-|-$)/gu, '');
}

async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

async function waitForRenderer(page, path = '/') {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await page.goto(`${baseURL}${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      if (!response?.ok()) throw new Error(`HTTP ${response?.status() ?? 'unknown'}`);
      await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 8_000 });
      await settle(page);
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(750);
    }
  }
  throw lastError;
}

async function clickNavigation(page, label) {
  const accessibleName = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\s|$)`);
  let target = page.getByRole('button', { name: accessibleName }).first();
  const viewport = page.viewportSize();
  const targetBox = await target.boundingBox().catch(() => null);
  const targetIsOnscreen =
    targetBox &&
    viewport &&
    targetBox.right > 0 &&
    targetBox.x < viewport.width &&
    targetBox.y + targetBox.height > 0 &&
    targetBox.y < viewport.height;
  if (!(await target.isVisible().catch(() => false)) || !targetIsOnscreen) {
    const menu = page.getByRole('button', { name: 'Open navigation' });
    if (await menu.isVisible().catch(() => false)) await menu.click();
    target = page.getByRole('button', { name: accessibleName }).first();
  }
  // At Windows-like narrow heights the fixed shelf keeps bottom actions in its
  // own scroll region. DOM activation matches keyboard/button semantics while
  // avoiding Playwright's viewport-only actionability gate for that region.
  await target.evaluate((element) => element.click());
  await page.waitForFunction(
    (name) => {
      const active = [...document.querySelectorAll('.nav-item.is-active')];
      return active.some((item) => item.textContent?.includes(name));
    },
    label === 'Developer mode' ? 'Developer mode' : label,
  );
  await settle(page);
}

async function setAppearance(page, theme, wallpaper) {
  await clickNavigation(page, 'Settings');
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const themeName = theme === 'dark' ? 'Cupcake Dark' : 'Cupcake Light';
  await page.getByRole('button', { name: new RegExp(`^${themeName}`) }).click();
  await page.getByRole('button', { name: new RegExp(`^${wallpaper}`) }).click();
  await page.locator('.app-shell--wallpaper').waitFor({ state: 'visible' });
  await settle(page);
}

async function metrics(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const clippedControls = [...document.querySelectorAll('button, input, textarea, select, a')]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const intersectsViewport =
          rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
        const outside =
          rect.right > innerWidth + 1 ||
          rect.left < -1 ||
          rect.bottom > innerHeight + 1 ||
          rect.top < -1;
        if (!outside || !intersectsViewport) return null;
        return {
          tag: element.tagName.toLowerCase(),
          label:
            element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 80) ?? '',
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .filter(Boolean);
    const active = document.activeElement;
    const activeStyle = active instanceof HTMLElement ? getComputedStyle(active) : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      },
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      clippedControls,
      focus: active
        ? {
            tag: active.tagName.toLowerCase(),
            label:
              active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 80) ?? '',
            outline: activeStyle?.outline,
            boxShadow: activeStyle?.boxShadow,
          }
        : null,
      wallpaper: document.querySelector('.app-shell')?.getAttribute('data-wallpaper') ?? null,
      theme: document.documentElement.dataset.theme ?? null,
      appContentScrollTop: document.querySelector('.app-content')?.scrollTop ?? null,
    };
  });
}

async function capture(page, name) {
  const path = join(output, `${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  return path;
}

async function captureCloseups(page, prefix) {
  const viewport = page.viewportSize();
  if (!viewport) return [];
  const overlap = 72;
  const tileWidth = Math.min(viewport.width, Math.ceil(viewport.width / 2) + overlap);
  const tileHeight = Math.min(viewport.height, Math.ceil(viewport.height / 2) + overlap);
  const positions = [
    ['top-left', 0, 0],
    ['top-right', Math.max(0, viewport.width - tileWidth), 0],
    ['bottom-left', 0, Math.max(0, viewport.height - tileHeight)],
    [
      'bottom-right',
      Math.max(0, viewport.width - tileWidth),
      Math.max(0, viewport.height - tileHeight),
    ],
  ];
  const files = [];
  for (const [label, x, y] of positions) {
    const path = join(output, `${prefix}-closeup-${label}.png`);
    await page.screenshot({ path, clip: { x, y, width: tileWidth, height: tileHeight } });
    files.push(path);
  }
  return files;
}

for (const variant of variants) {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    reducedMotion: 'reduce',
    colorScheme: variant.theme,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) =>
    report.browserErrors.push({ variant: variant.name, type: 'pageerror', message: error.message }),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      report.browserErrors.push({
        variant: variant.name,
        type: 'console',
        message: message.text(),
      });
  });
  await waitForRenderer(page, `/?view=home&theme=${variant.theme}`);
  await setAppearance(page, variant.theme, variant.wallpaper);
  const variantResult = { ...variant, screens: [] };
  variantResult.screens.push({
    view: 'Settings / Appearance',
    file: await capture(page, `${variant.name}-settings-appearance`),
    metrics: await metrics(page),
  });

  for (const view of views) {
    await clickNavigation(page, view);
    const file = await capture(page, `${variant.name}-${slug(view)}`);
    const screenMetrics = await metrics(page);
    variantResult.screens.push({ view, file, metrics: screenMetrics });
  }

  await page.keyboard.press('Control+F');
  await page
    .getByRole('heading', { name: /Search/ })
    .first()
    .waitFor({ state: 'visible' });
  variantResult.screens.push({
    view: 'Search',
    file: await capture(page, `${variant.name}-search`),
    metrics: await metrics(page),
  });

  await clickNavigation(page, 'Home');
  await page.keyboard.press('Control+N');
  await page.locator('.chat-main').waitFor({ state: 'visible' });
  variantResult.screens.push({
    view: 'Active chat',
    file: await capture(page, `${variant.name}-active-chat`),
    metrics: await metrics(page),
  });

  const axeResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  report.accessibility.push({
    variant: variant.name,
    view: 'Active chat',
    seriousOrCritical: axeResults.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.length,
      })),
  });

  // Developer mode can be disabled by saved fixture settings, so capture the
  // route directly rather than manufacturing a visible navigation item.
  await waitForRenderer(page, `/?view=developer&theme=${variant.theme}`);
  variantResult.screens.push({
    view: 'Developer mode',
    file: await capture(page, `${variant.name}-developer-mode`),
    metrics: await metrics(page),
  });

  report.variants.push(variantResult);
  await context.close();
}

const keyboardContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const keyboardPage = await keyboardContext.newPage();
await waitForRenderer(keyboardPage, '/?view=home&theme=light');
await keyboardPage.keyboard.press('Tab');
report.keyboard.push({ action: 'Tab from load', result: await metrics(keyboardPage) });
await capture(keyboardPage, 'keyboard-first-focus');
await keyboardPage.keyboard.press('Control+K');
await keyboardPage.getByRole('dialog', { name: 'Command palette' }).waitFor();
await capture(keyboardPage, 'keyboard-command-palette');
await keyboardPage.keyboard.press('ArrowDown');
await keyboardPage.keyboard.press('Escape');
report.keyboard.push({
  action: 'Ctrl+K, ArrowDown, Escape',
  paletteClosed: !(await keyboardPage
    .getByRole('dialog', { name: 'Command palette' })
    .isVisible()
    .catch(() => false)),
});
await keyboardPage.keyboard.press('Control+M');
await keyboardPage.locator('.model-picker').waitFor({ state: 'visible' });
await capture(keyboardPage, 'keyboard-model-picker');
await keyboardPage.keyboard.press('Escape');
await keyboardPage.keyboard.press('Control+N');
await keyboardPage.locator('.chat-main').waitFor({ state: 'visible' });
await keyboardPage.keyboard.press('/');
report.keyboard.push({
  action: 'Ctrl+N then /',
  composerFocused: await keyboardPage
    .locator('.composer textarea')
    .evaluate((element) => element === document.activeElement),
});
await keyboardContext.close();

const navigationContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const navigationPage = await navigationContext.newPage();
await waitForRenderer(navigationPage, '/?view=settings&theme=light');
await navigationPage.getByRole('button', { name: 'Appearance', exact: true }).click();
await navigationPage.getByRole('button', { name: /^Ink snow garden/ }).click();
const settingsScrollTop = await navigationPage
  .locator('.app-content')
  .evaluate((element) => element.scrollTop);
await clickNavigation(navigationPage, 'Home');
const navigationMetrics = await metrics(navigationPage);
const heroBounds = await navigationPage.locator('.home-hero').boundingBox();
report.navigation.push({
  action: 'Navigate from scrolled Settings / Appearance to Home',
  settingsScrollTop,
  homeScrollTop: navigationMetrics.appContentScrollTop,
  heroBounds,
  passed:
    settingsScrollTop > 0 &&
    navigationMetrics.appContentScrollTop === 0 &&
    Boolean(heroBounds && heroBounds.y >= 0),
});
await capture(navigationPage, 'navigation-settings-to-home-reset');
await navigationContext.close();

const highContrastContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  forcedColors: 'active',
  reducedMotion: 'reduce',
});
const highContrastPage = await highContrastContext.newPage();
for (const view of ['home', 'chat', 'models', 'settings']) {
  await waitForRenderer(highContrastPage, `/?view=${view}&theme=dark`);
  const file = await capture(highContrastPage, `high-contrast-${view}`);
  report.highContrast.push({ view, file, metrics: await metrics(highContrastPage) });
}
await highContrastContext.close();

const detailContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
});
const detailPage = await detailContext.newPage();
await waitForRenderer(detailPage, '/?view=home&theme=light');
await setAppearance(detailPage, 'light', 'Circuit conservatory');
for (const view of ['Home', 'Artifacts', 'Models', 'Settings']) {
  await clickNavigation(detailPage, view);
  await captureCloseups(detailPage, `detail-${slug(view)}`);
}
await clickNavigation(detailPage, 'Home');
await detailPage.keyboard.press('Control+N');
await detailPage.locator('.chat-main').waitFor({ state: 'visible' });
await captureCloseups(detailPage, 'detail-active-chat');
await waitForRenderer(detailPage, '/?onboarding=1&theme=light');
await detailPage.getByRole('dialog').waitFor({ state: 'visible' });
await capture(detailPage, 'detail-onboarding-full');
await captureCloseups(detailPage, 'detail-onboarding');
await detailContext.close();

const standaloneContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const standalonePage = await standaloneContext.newPage();
for (const [name, path] of [
  ['about', '/?view=about&theme=light'],
  ['opening', '/?opening=1&openingScene=0&theme=dark'],
]) {
  await waitForRenderer(standalonePage, path);
  await capture(standalonePage, `standalone-${name}`);
}
await standaloneContext.close();

await browser.close();
await writeFile(join(output, 'visual-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const failures = report.variants.flatMap((variant) =>
  variant.screens.flatMap((screen) => {
    const failures = [];
    if (screen.metrics.horizontalOverflow)
      failures.push(`${variant.name}/${screen.view}: horizontal overflow`);
    return failures;
  }),
);
if (report.browserErrors.length) failures.push(`${report.browserErrors.length} renderer errors`);
for (const probe of report.navigation) {
  if (!probe.passed) failures.push(`${probe.action}: scroll/focus target was not reset`);
}
if (failures.length) {
  throw new Error(`Integrated browser fixture verification failed:\n${failures.join('\n')}`);
}
process.stdout.write(
  `Fixture UI evidence captured in ${output}; ${report.variants.length} viewport variants, ` +
    `${report.highContrast.length} forced-color screens, and ${report.keyboard.length} keyboard probes.\n`,
);
