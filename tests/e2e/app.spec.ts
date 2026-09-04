import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('workspace opening composition stays optically centered', async ({ page }) => {
  await page.goto('/?opening=1&openingScene=0');
  const card = page.locator('.workspace-opening__card');
  await expect(card).toBeVisible();
  const geometry = await card.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      cardCenterX: rect.left + rect.width / 2,
      cardCenterY: rect.top + rect.height / 2,
      hostCenterX: (() => {
        const host = document.querySelector('.app-content')?.getBoundingClientRect();
        return host ? host.left + host.width / 2 : window.innerWidth / 2;
      })(),
      hostCenterY: (() => {
        const host = document.querySelector('.app-content')?.getBoundingClientRect();
        return host ? host.top + host.height / 2 : window.innerHeight / 2;
      })(),
    };
  });
  expect(Math.abs(geometry.cardCenterX - geometry.hostCenterX)).toBeLessThanOrEqual(8);
  expect(Math.abs(geometry.cardCenterY - geometry.hostCenterY)).toBeLessThanOrEqual(8);
  await expect(page.locator('html')).toHaveAttribute('data-opening-scene', '0');
  const shelfBackground = await page
    .locator('.shelf')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const titlebarBackground = await page
    .locator('.cupcake-titlebar')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(shelfBackground).not.toBe('rgb(246, 242, 235)');
  expect(titlebarBackground).not.toBe('rgb(246, 242, 235)');
  const seam = await page.evaluate(() => {
    const opening = document.querySelector('.workspace-opening')?.getBoundingClientRect();
    const image = document.querySelector('.workspace-dreamscape')?.getBoundingClientRect();
    const content = document.querySelector<HTMLElement>('.app-content');
    const search = document.querySelector<HTMLElement>('.cupcake-titlebar__search');
    if (!opening || !image || !content || !search) throw new Error('Opening composition missing');
    const contentStyle = getComputedStyle(content);
    return {
      imageCoversLeft: image.left <= opening.left,
      imageCoversTop: image.top <= opening.top,
      imageCoversRight: image.right >= opening.right,
      imageCoversBottom: image.bottom >= opening.bottom,
      leftRadius: contentStyle.borderTopLeftRadius,
      leftShadow: contentStyle.boxShadow,
      searchShadow: getComputedStyle(search).boxShadow,
    };
  });
  expect(seam).toMatchObject({
    imageCoversLeft: true,
    imageCoversTop: true,
    imageCoversRight: true,
    imageCoversBottom: true,
    leftRadius: '0px',
    leftShadow: 'none',
    searchShadow: 'none',
  });
});

test('fresh Windows profile opens directly without enabling workspace security', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const target = window as typeof window & {
      __quickSetupCalled?: boolean;
      __securityEnabled?: boolean;
      __securityDisabled?: boolean;
      cupcake?: unknown;
    };
    target.__quickSetupCalled = false;
    target.__securityEnabled = false;
    target.__securityDisabled = false;
    target.cupcake = {
      apiVersion: 1,
      platform: 'win32',
      app: {
        getInfo: () =>
          Promise.resolve({
            apiVersion: 1,
            appVersion: 'test',
            platform: 'win32',
            packaged: false,
            runtime: 'ready',
          }),
        openExternal: () => Promise.resolve(),
      },
      workspace: {
        status: () => Promise.resolve({ state: 'needs_setup', failedAttempts: 0, retryAfterMs: 0 }),
        setup: () => {
          target.__securityEnabled = true;
          return Promise.resolve({
            state: 'unlocked',
            unlockMode: 'password',
            failedAttempts: 0,
            retryAfterMs: 0,
          });
        },
        setupWithoutPassword: () => {
          target.__quickSetupCalled = true;
          return Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 });
        },
        unlock: () => Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 }),
        onStatus: () => () => undefined,
        changePassword: () =>
          Promise.resolve({
            state: 'unlocked',
            unlockMode: 'password',
            failedAttempts: 0,
            retryAfterMs: 0,
          }),
        disableProtection: () => {
          target.__securityDisabled = true;
          return Promise.resolve({ state: 'unlocked', failedAttempts: 0, retryAfterMs: 0 });
        },
      },
      window: {
        isMaximized: () => Promise.resolve(false),
        minimize: () => Promise.resolve(),
        toggleMaximize: () => Promise.resolve(false),
        close: () => Promise.resolve(),
        onCloseRequested: () => () => undefined,
      },
      dialog: {
        openFiles: () => Promise.resolve([]),
        openDirectory: () => Promise.resolve(null),
        chooseSaveTarget: () => Promise.resolve(null),
        releaseHandle: () => Promise.resolve(),
      },
      commands: { execute: () => Promise.resolve(), onCommand: () => () => undefined },
      runtime: {
        status: () => Promise.resolve({ state: 'ready', mode: 'broker', restartCount: 0 }),
        cancel: () => Promise.resolve(true),
        onEvent: () => () => undefined,
        onStatus: () => () => undefined,
        request: ({ method }: { method: string }) => {
          const results: Record<string, unknown> = {
            'app.bootstrap': {
              selectedModelId: null,
              projects: [],
              conversations: [],
              models: [],
              tools: [],
              hardware: {},
              localRuntimes: [],
              suggestionsEnabled: false,
            },
            'tasks.list': [],
            'memory.list': [],
            'providers.status': { providers: [] },
            'settings.list': {},
            'migration.detect': { state: 'not_found', available: false },
            'local_models.cupcake.status': {
              activeModelId: null,
              availableModels: [],
              models: [],
              recommendations: [],
              downloads: [],
              availableRuntimes: [],
              runtimes: [],
              runtimeRecommendations: [],
              hardware: {},
            },
            'artifacts.list': [],
            'developer.events': [],
          };
          return Promise.resolve({ ok: true, result: results[method] });
        },
      },
    };
  });
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as typeof window & { __quickSetupCalled?: boolean }).__quickSetupCalled),
  );
  await expect(page.getByRole('heading', { name: 'Make this CupcakeAI yours' })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Startup security' })).toHaveCount(0);
  await expect(page.locator('.home-hero')).toBeVisible();

  await page.goto('/?view=settings');
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
  await expect(page.getByText('Workspace lock is off')).toBeVisible();
  await page.getByLabel('Create password').fill('correct horse battery staple');
  await page.getByLabel('Confirm new password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Enable workspace lock' }).click();
  await page.waitForFunction(() =>
    Boolean((window as typeof window & { __securityEnabled?: boolean }).__securityEnabled),
  );
  await expect(page.getByText('Workspace lock is on')).toBeVisible();
  await page.getByLabel('Current password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Turn off workspace lock' }).click();
  await page.waitForFunction(() =>
    Boolean((window as typeof window & { __securityDisabled?: boolean }).__securityDisabled),
  );
  await expect(page.getByText('Workspace lock is off')).toBeVisible();
});

test('first-run tour is complete, replayable, centered, and keeps search in the titlebar', async ({
  page,
}) => {
  await page.goto('/?onboarding=1');
  const tour = page.locator('.onboarding-card');
  await expect(tour).toBeVisible();
  const art = page.locator('.onboarding-story-art');
  const artBox = await art.boundingBox();
  expect(artBox).not.toBeNull();
  expect(Math.abs((artBox?.width ?? 0) - (artBox?.height ?? 0))).toBeLessThanOrEqual(3);
  await tour.getByRole('button', { name: 'Continue' }).click();
  const targetedBox = await tour.boundingBox();
  expect(targetedBox).not.toBeNull();
  expect(
    Math.abs(
      (targetedBox?.y ?? 0) +
        (targetedBox?.height ?? 0) / 2 -
        (44 + ((page.viewportSize()?.height ?? 900) - 44) / 2),
    ),
  ).toBeLessThanOrEqual(12);
  for (let step = 1; step < 7; step += 1) {
    await tour.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Make CupcakeAI feel like yours' })).toBeVisible();
  await page.getByRole('button', { name: 'Finish tour' }).click();
  await expect(tour).toBeHidden();
  await expect(page.getByRole('button', { name: /Search CupcakeAI/ })).toBeVisible();

  const openNavigation = page.getByRole('button', { name: 'Open navigation' });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'General' }).click();
  await page.getByRole('button', { name: /Replay onboarding/ }).click();
  await expect(page.getByRole('dialog', { name: 'One calm place for serious work' })).toBeVisible();
});

test('model discovery starts curated and only searches the Hub on request', async ({ page }) => {
  await page.goto('/?view=models');
  const state = page.locator('.model-catalog-summary');
  await expect(state).toContainText(/carefully selected matches/i);
  await expect(state).not.toContainText(/community results/i);
  await page.getByRole('button', { name: /Refine results/i }).click();
  await page.getByLabel(/Search Hugging Face too/i).check();
  await page.getByLabel('Find a model').fill('qwen');
  await expect(state).toContainText(/optional community results/i);
  await expect(page.getByRole('button', { name: /Show more community models/i })).toHaveCount(0);
});

test('model and provider pickers use loaded company marks', async ({ page }) => {
  await page.goto('/?view=models');
  const openAiMark = page.locator('img[alt="OpenAI logo"]').first();
  await expect(openAiMark).toBeVisible();
  expect(
    await openAiMark.evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0);

  await page.getByLabel('Find a model').fill('qwen');
  const qwenMark = page.locator('img[alt="Qwen logo"]').first();
  await expect(qwenMark).toBeVisible();
  expect(await qwenMark.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(
    0,
  );

  await page.getByRole('button', { name: 'Add provider' }).click();
  const providerMarks = page.locator('.provider-choice-grid .provider-logo img');
  await expect(providerMarks).toHaveCount(7);
  expect(
    await providerMarks.evaluateAll((images) =>
      images.every(
        (image) =>
          (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
      ),
    ),
  ).toBe(true);
});

test('Home uses intentional aligned marks instead of bare status dots', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.shelf__recent button > i')).toHaveCount(0);
  await expect(page.locator('.composer-model-logo')).toBeVisible();
  const alignment = await page.locator('.composer-model-logo').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const parent = element.parentElement?.getBoundingClientRect();
    return parent ? Math.abs(rect.y + rect.height / 2 - (parent.y + parent.height / 2)) : 999;
  });
  expect(alignment).toBeLessThanOrEqual(1);
  const portrait = page.locator('.home-hero__mascot > .cupcake-portrait');
  await expect(portrait).toBeVisible();
  expect(await portrait.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(
    'cupcake-avatar-atlas-v1.webp',
  );
});

test('Appearance offers immersive wallpapers across the complete chat surface', async ({
  page,
}) => {
  await page.goto('/?view=settings');
  await page.getByRole('button', { name: 'Appearance' }).click();
  const wallpaperChoices = page.locator('.wallpaper-grid > button');
  await expect(wallpaperChoices).toHaveCount(9);
  const choice = page.getByRole('button', { name: /Blueberry observatory/ });
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(choice).toHaveClass(/is-active/);
  await expect(page.locator('.app-shell')).not.toHaveClass(/app-shell--wallpaper/);
  const openNavigation = page.getByRole('button', { name: 'Open navigation' });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.locator('.new-chat').click();
  const chatSurface = page.locator('.app-content--chat');
  await expect(chatSurface).toHaveClass(/app-content--wallpaper/);
  const background = await page
    .locator('.app-content--chat')
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(background).toContain('blueberry-observatory.webp');
  expect(background).not.toContain('linear-gradient');

  await expect
    .poll(() =>
      page.locator('.shelf').evaluate((element) => {
        const value = getComputedStyle(element).backgroundColor;
        const modern = value.match(/\/\s*([\d.]+)(%)?\s*\)$/u);
        if (modern) return Number(modern[1]) / (modern[2] ? 100 : 1);
        const legacy = value.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/u);
        return legacy ? Number(legacy[1]) : value === 'transparent' ? 0 : 1;
      }),
    )
    .toBeLessThan(0.92);

  const surfaces = await page.evaluate(() => {
    const rgbaAlpha = (value: string) => {
      if (value === 'transparent') return 0;
      const modern = value.match(/\/\s*([\d.]+)(%)?\s*\)$/u);
      if (modern) return Number(modern[1]) / (modern[2] ? 100 : 1);
      const legacy = value.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/u);
      return legacy ? Number(legacy[1]) : 1;
    };
    const read = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const style = getComputedStyle(element);
      return {
        alpha: rgbaAlpha(style.backgroundColor),
        color: style.color,
      };
    };
    return {
      shellHasTheme: document
        .querySelector('.app-shell')
        ?.classList.contains('app-shell--chat-wallpaper'),
      shelf: read('.shelf'),
      titlebar: read('.cupcake-titlebar'),
      header: read('.chat-header'),
      transcript: read('.chat-main'),
      composer: read('.composer'),
      messageText: getComputedStyle(document.querySelector<HTMLElement>('.rich-response > p'))
        .color,
      composerFade: getComputedStyle(
        document.querySelector<HTMLElement>('.chat-composer-wrap'),
        '::before',
      ).display,
      contentRadius: getComputedStyle(
        document.querySelector<HTMLElement>('.app-content--wallpaper'),
      ).borderTopLeftRadius,
    };
  });
  expect(surfaces.shellHasTheme).toBe(true);
  expect(surfaces.shelf.alpha).toBeLessThan(0.92);
  expect(surfaces.titlebar.alpha).toBeLessThan(0.92);
  expect(surfaces.header.alpha).toBeLessThan(0.92);
  expect(surfaces.transcript.alpha).toBeLessThan(0.92);
  expect(surfaces.composer.alpha).toBeLessThan(0.92);
  expect(surfaces.composerFade).toBe('none');
  expect(surfaces.contentRadius).toBe('0px');
  expect(surfaces.header.color).toBe('rgb(255, 249, 238)');
  expect(surfaces.messageText).toBe('rgb(255, 249, 238)');
});

test('selected user and assistant portraits propagate into chat', async ({ page }) => {
  await page.goto('/?view=settings');
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  const userChoice = page.locator(
    '.avatar-picker:not(.avatar-picker--assistant) button[title="Pixel explorer"]',
  );
  const assistantChoice = page.locator('.avatar-picker--assistant button[title="Synthwave DJ"]');
  await userChoice.click();
  await assistantChoice.click();
  const expected = await Promise.all(
    [userChoice, assistantChoice].map((choice) =>
      choice.locator('.cupcake-portrait').evaluate((element) => {
        const style = getComputedStyle(element);
        return { image: style.backgroundImage, position: style.backgroundPosition };
      }),
    ),
  );
  const openNavigation = page.getByRole('button', { name: 'Open navigation' });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.locator('.new-chat').click();
  const actual = await Promise.all(
    [
      page.locator('.turn--user .thread-node--user .cupcake-portrait').first(),
      page.locator('.turn--assistant .thread-node--assistant .cupcake-portrait').first(),
    ].map((portrait) =>
      portrait.evaluate((element) => {
        const style = getComputedStyle(element);
        return { image: style.backgroundImage, position: style.backgroundPosition };
      }),
    ),
  );
  expect(actual).toEqual(expected);
});

test('profile, scrollbar, and RAM fallback controls update the local UI', async ({ page }) => {
  await page.goto('/?view=settings');
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.getByLabel('Display name').fill('Cupcake Tester');
  await expect(page.getByRole('button', { name: /Cupcake Tester/ })).toBeVisible();

  await page.getByRole('button', { name: 'Appearance' }).click();
  await page
    .getByLabel('Scrollbar visibility')
    .getByRole('button', { name: 'Minimal', exact: true })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-scrollbars', 'minimal');

  await page.getByRole('button', { name: 'Local models' }).click();
  await page.getByRole('switch', { name: 'Allow system RAM fallback' }).click();
  await expect(page.getByText('VRAM-only loading')).toBeVisible();
});

test('home, navigation, command palette and explicit model picker work', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: /Good (morning|afternoon|evening), Akshit/ }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 640) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'Models' }).click();
  await expect(page.getByRole('heading', { name: 'Models', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: /Refine results/ })).toBeVisible();
  await expect(page.locator('.community-model-intro')).toHaveCount(0);

  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByPlaceholder('What would you like to do?').fill('Change model');
  await page.getByRole('button', { name: /Change model/ }).click();
  await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeVisible();
  await expect(page.getByText('There is no Auto mode.')).toHaveCount(0);
  await expect(page.getByText('Show unavailable')).toBeVisible();
  await expect(page.locator('.model-picker__group').first()).toBeVisible();
});

test('chat accepts multiline input and labels deterministic fixture mode', async ({ page }) => {
  await page.goto('/?view=chat');
  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('First line');
  await composer.press('Shift+Enter');
  await composer.type('Second line');
  await expect(composer).toHaveValue('First line\nSecond line');
  await composer.press('Enter');
  await expect(page.getByText('First line\nSecond line')).toBeVisible();
  await expect(page.getByText(/Deterministic fixture response/)).toBeVisible();
  await expect(
    page.getByText(/desktop bridge absent; no provider, file, or tool call can leave/i),
  ).toBeVisible();
});

test('chat follows new conversation turns and offers a return control when reading history', async ({
  page,
}) => {
  await page.goto('/?view=chat');
  const scroll = page.locator('.conversation-scroll');
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(80);

  await scroll.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(80);

  const composer = page.getByLabel('Message Cupcake');
  await composer.fill('Keep this turn in view');
  await composer.press('Enter');
  await expect(page.getByText('Keep this turn in view')).toBeVisible();
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(80);
});

test('offline mode hard-blocks cloud sends and never invents a local model', async ({ page }) => {
  await page.goto('/?view=settings');
  await page.getByRole('button', { name: 'General' }).click();
  await page.getByRole('switch', { name: 'Offline mode' }).click();
  await page.goto('/?view=chat');
  await expect(page.getByRole('button', { name: /Choose a local model/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(page.getByText(/Offline mode blocks cloud sends/)).toBeVisible();
});

test('keyboard navigation exposes regions, outline, and shortcut reference', async ({ page }) => {
  await page.goto('/?view=chat');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.getByRole('button', { name: 'Close shortcut reference' }).click();
  await page.keyboard.press('F6');
  await expect(page.locator('.shelf')).toBeFocused();
});

test('memory refuses NVIDIA and generic credential-shaped text', async ({ page }) => {
  await page.goto('/?view=memory');
  const answers = ['Provider key', 'nvapi-SYNTHETIC_TEST_VALUE_123456'];
  page.on('dialog', (dialog) => dialog.accept(answers.shift() ?? ''));
  await page.getByRole('button', { name: 'Add memory' }).click();
  await expect(page.getByText(/Credentials cannot be saved as memory/)).toBeVisible();
});

test('themes, reduced-motion contract and narrow layout avoid horizontal overflow', async ({
  page,
}) => {
  await page.goto('/?view=chat&theme=dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
});

test('primary screens have no serious or critical automated accessibility violations', async ({
  page,
}) => {
  for (const view of ['home', 'chat', 'memory', 'models', 'tools', 'settings']) {
    await page.goto(`/?view=${view}`);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      ({ impact }) => impact === 'critical' || impact === 'serious',
    );
    expect(blocking, `${view}: ${blocking.map(({ id }) => id).join(', ')}`).toEqual([]);
  }
});

test('every shipped theme keeps the chat surface AA-clean', async ({ page }) => {
  for (const theme of ['light', 'dark', 'minimal', 'classic']) {
    await page.goto(`/?view=chat&theme=${theme}`);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      ({ impact }) => impact === 'critical' || impact === 'serious',
    );
    expect(blocking, `${theme}: ${blocking.map(({ id }) => id).join(', ')}`).toEqual([]);
  }
});

test('live workspace windows long history and switches immutable branches', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, { __runtimeCalls: calls });
    const history = (branchId: string) =>
      branchId === 'branch-b'
        ? [
            {
              id: 'branch-b-message',
              branch_id: branchId,
              role: 'assistant',
              content: 'Sibling branch B is intact.',
            },
          ]
        : Array.from({ length: 500 }, (_, index) => ({
            id: `message-${index}`,
            branch_id: branchId,
            role: index % 2 ? 'assistant' : 'user',
            content: `Persisted turn ${index}`,
          }));
    Object.defineProperty(window, 'cupcake', {
      value: {
        apiVersion: 1,
        platform: 'win32',
        app: {
          getInfo: async () => {
            await Promise.resolve();
            return {
              apiVersion: 1,
              appVersion: 'test',
              platform: 'win32',
              packaged: false,
              runtime: 'ready',
            };
          },
        },
        window: {
          minimize: async () => {
            await Promise.resolve();
          },
          toggleMaximize: async () => {
            await Promise.resolve();
            return false;
          },
          close: async () => {
            await Promise.resolve();
          },
          isMaximized: async () => {
            await Promise.resolve();
            return false;
          },
        },
        dialog: {
          openFiles: async () => {
            await Promise.resolve();
            return [];
          },
          openDirectory: async () => {
            await Promise.resolve();
            return null;
          },
          chooseSaveTarget: async () => {
            await Promise.resolve();
            return null;
          },
          releaseHandle: async () => {},
        },
        commands: { execute: async () => {}, onCommand: () => () => {} },
        runtime: {
          status: async () => {
            await Promise.resolve();
            return { state: 'ready', mode: 'broker', restartCount: 0 };
          },
          cancel: async () => {
            await Promise.resolve();
            return true;
          },
          onEvent: () => () => {},
          onStatus: () => () => {},
          request: async ({ method, params }: { method: string; params?: unknown }) => {
            await Promise.resolve();
            calls.push(method);
            const results: Record<string, unknown> = {
              'app.bootstrap': {
                selectedModelId: 'openai-compatible:cupcake-local/qwen3-4b-q4-k-m',
                projects: [
                  {
                    id: 'project-1',
                    name: 'Private project',
                    description: 'Boundary',
                    status: 'active',
                  },
                ],
                conversations: [
                  {
                    id: 'conversation-1',
                    title: 'Long history',
                    project_id: 'project-1',
                    status: 'active',
                  },
                ],
                models: [],
                tools: [],
                hardware: {},
                localRuntimes: [],
                suggestionsEnabled: false,
              },
              'tasks.list': [],
              'memory.list': [],
              'providers.status': { providers: [] },
              'settings.list': {},
              'migration.detect': { state: 'not_found', available: false },
              'local_models.cupcake.status': {
                activeModelId: 'qwen3-4b-q4-k-m',
                availableModels: [
                  {
                    id: 'qwen3-4b-q4-k-m',
                    display_name: 'Qwen3 4B',
                    context_window: 8192,
                    capability_tags: ['text', 'chat'],
                  },
                ],
                models: [{ id: 'qwen3-4b-q4-k-m', integrity_verified: true }],
                recommendations: [],
                downloads: [],
                availableRuntimes: [],
                runtimes: [],
                runtimeRecommendations: [],
                hardware: {},
              },
              'artifacts.list': [],
              'developer.events': [],
              'conversations.get': {
                branches: [
                  { id: 'branch-a', conversation_id: 'conversation-1', name: 'Main' },
                  { id: 'branch-b', conversation_id: 'conversation-1', name: 'Sibling B' },
                ],
                activeBranchId: 'branch-a',
              },
              'conversations.list': [
                {
                  id: 'conversation-1',
                  title: 'Long history',
                  project_id: 'project-1',
                  status: 'active',
                },
              ],
              'chat.edit': {
                conversationId: 'conversation-1',
                branchId: 'branch-b',
                runId: 'edit-run',
              },
              'chat.regenerate': {
                conversationId: 'conversation-1',
                branchId: 'branch-b',
                runId: 'retry-run',
              },
            };
            if (method === 'chat.history')
              return {
                ok: true,
                result: history(
                  (params as { branchId?: string } | undefined)?.branchId ?? 'branch-a',
                ),
              };
            return { ok: true, result: results[method] };
          },
        },
      },
    });
  });
  await page.goto('/?view=chats');
  await page.locator('.chat-list__main').filter({ hasText: 'Long history' }).click();
  await expect(page.locator('.live-conversation')).toHaveAttribute('data-rendered-messages', '80');
  await expect(page.getByText('500 turns')).toBeVisible();

  const assistantTurn = page.locator('article.turn--assistant').filter({
    has: page.getByText('Persisted turn 499', { exact: true }),
  });
  await expect(assistantTurn.getByTitle('Edit')).toHaveCount(0);
  const userTurn = page.locator('article.turn--user').filter({
    has: page.getByText('Persisted turn 498', { exact: true }),
  });
  await expect(userTurn.getByTitle('Edit')).toBeVisible();

  await page.getByRole('button', { name: 'Sibling B' }).click();
  await expect(page.getByText('Sibling branch B is intact.')).toBeVisible();
  await expect(page.locator('article.turn--assistant').getByTitle('Edit')).toHaveCount(0);

  await page.getByRole('button', { name: 'Main' }).click();
  await expect(page.getByText('Persisted turn 498', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept('Edited sibling text'));
  await page
    .locator('article.turn--user')
    .filter({ has: page.getByText('Persisted turn 498', { exact: true }) })
    .getByTitle('Edit')
    .click();
  await expect(page.getByText('Sibling branch B is intact.')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __runtimeCalls: string[] }).__runtimeCalls),
  ).toContain('chat.edit');
});

test('configured NIM catalog enables an explicitly confirmed model', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    Object.assign(window, { __nimRuntimeCalls: calls });
    Object.defineProperty(window, 'cupcake', {
      value: {
        apiVersion: 1,
        platform: 'win32',
        app: {
          getInfo: async () => {
            await Promise.resolve();
            return {
              apiVersion: 1,
              appVersion: 'test',
              platform: 'win32',
              packaged: false,
              runtime: 'ready',
            };
          },
        },
        window: {
          minimize: async () => {
            await Promise.resolve();
          },
          toggleMaximize: async () => {
            await Promise.resolve();
            return false;
          },
          close: async () => {
            await Promise.resolve();
          },
          isMaximized: async () => {
            await Promise.resolve();
            return false;
          },
        },
        dialog: {
          openFiles: async () => {
            await Promise.resolve();
            return [];
          },
          openDirectory: async () => {
            await Promise.resolve();
            return null;
          },
          chooseSaveTarget: async () => {
            await Promise.resolve();
            return null;
          },
          releaseHandle: async () => {
            await Promise.resolve();
          },
        },
        commands: { execute: async () => {}, onCommand: () => () => {} },
        runtime: {
          status: async () => {
            await Promise.resolve();
            return { state: 'ready', mode: 'broker', restartCount: 0 };
          },
          cancel: async () => {
            await Promise.resolve();
            return true;
          },
          onEvent: () => () => {},
          onStatus: () => () => {},
          request: async ({ method, params }: { method: string; params?: unknown }) => {
            await Promise.resolve();
            calls.push({ method, params });
            const result: Record<string, unknown> = {
              'app.bootstrap': {
                selectedModelId: 'nvidia-nim:openai/gpt-oss-20b',
                projects: [],
                conversations: [],
                models: [
                  {
                    id: 'mock:cupcake-deterministic',
                    provider: 'mock',
                    model: 'cupcake-deterministic',
                    display_name: 'Deterministic local',
                    privacy_route: 'local',
                    capabilities: ['chat'],
                  },
                ],
                tools: [],
                hardware: {},
                localRuntimes: [],
                suggestionsEnabled: false,
              },
              'tasks.list': [],
              'memory.list': [],
              'providers.status': {
                providers: [{ provider: 'nvidia-nim', configured: true }],
              },
              'providers.catalog.refresh': {
                models: [
                  {
                    id: 'nvidia-nim:openai/gpt-oss-20b',
                    model: 'openai/gpt-oss-20b',
                    display_name: 'GPT-OSS 20B',
                    privacy_route: 'cloud',
                    capabilities: { streaming: true },
                    metadata: { chat_compatibility: 'unknown' },
                  },
                ],
              },
              'settings.list': {},
              'migration.detect': { state: 'not_found', available: false },
              'models.select': {},
            };
            return { ok: true, result: result[method] };
          },
        },
      },
    });
  });

  await page.goto('/');
  const openNavigation = page.getByRole('button', { name: 'Open navigation' });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await expect(page.locator('.model-catalog-summary')).toContainText(
    '1 curated NVIDIA NIM routes available',
  );
  await page.keyboard.press('Control+M');
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  const nim = picker.getByRole('button', { name: /NVIDIA NIM/ });
  await expect(nim).toBeEnabled();
  await expect(nim).toHaveClass(/is-active/);
  await nim.click();
  await expect(page.getByRole('dialog', { name: 'Choose model' })).toBeHidden();
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __nimRuntimeCalls: Array<{ method: string; params?: unknown }> })
        .__nimRuntimeCalls,
  );
  expect(calls).toContainEqual({
    method: 'models.select',
    params: {
      modelId: 'nvidia-nim:openai/gpt-oss-20b',
      compatibilityConfirmed: true,
    },
  });
  const memoryList = calls.find((item) => item.method === 'memory.list');
  expect(memoryList?.params).not.toMatchObject({ states: expect.arrayContaining(['disabled']) });
});

test('custom titlebar reserves normal flow and exposes semantic window controls', async ({
  page,
}) => {
  await page.goto('/');
  const titlebar = page.locator('.cupcake-titlebar');
  await expect(titlebar).toBeVisible();
  await expect(titlebar.getByRole('button', { name: 'Minimize window' })).toBeVisible();
  await expect(titlebar.getByRole('button', { name: 'Maximize window' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(titlebar.getByRole('button', { name: 'Close window' })).toBeVisible();
  const geometry = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>('.cupcake-titlebar');
    const shelf = document.querySelector<HTMLElement>('.shelf');
    const drag = title?.querySelector<HTMLElement>('.cupcake-titlebar__drag');
    const search = title?.querySelector<HTMLElement>('.cupcake-titlebar__search');
    const controls = title?.querySelector<HTMLElement>('.cupcake-titlebar__controls');
    if (!title || !shelf || !drag || !search || !controls)
      throw new Error('Titlebar geometry is unavailable');
    return {
      titleHeight: title.getBoundingClientRect().height,
      titleBottom: title.getBoundingClientRect().bottom,
      shelfTop: shelf.getBoundingClientRect().top,
      directDrag: drag.parentElement?.classList.contains('cupcake-titlebar__center') ?? false,
      dragChildren: drag.childElementCount,
      dragWidth: drag.getBoundingClientRect().width,
      searchWidth: search.getBoundingClientRect().width,
      controlsWidth: controls.getBoundingClientRect().width,
    };
  });
  expect(geometry.titleHeight).toBe(32);
  expect(geometry.shelfTop).toBeGreaterThanOrEqual(geometry.titleBottom - 1);
  expect(geometry.directDrag).toBe(true);
  expect(geometry.dragChildren).toBe(0);
  expect(geometry.dragWidth).toBeGreaterThan(20);
  expect(geometry.searchWidth).toBeGreaterThan(180);
  expect(geometry.controlsWidth).toBe((page.viewportSize()?.width ?? 1440) <= 420 ? 120 : 126);
});

test('provider setup stays in-app, traps focus, supports Escape, and reviews a masked key', async ({
  page,
}) => {
  await page.goto('/?view=models');
  await page.getByRole('button', { name: 'Add provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a provider' });
  await expect(dialog).toBeVisible();
  await dialog
    .locator('.provider-choice-grid button')
    .filter({
      has: page.getByText('OpenAI', { exact: true }),
    })
    .click();
  await expect(page.getByRole('heading', { name: 'Connect OpenAI' })).toBeVisible();
  const key = page.getByRole('textbox', { name: 'API key', exact: true });
  await key.fill('sk-deterministic-secret-1234');
  await expect(key).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Reveal API key' }).click();
  await expect(key).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide API key' }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('heading', { name: 'Connection verified' })).toBeVisible();
  await expect(page.getByText('••••1234')).toBeVisible();

  const setup = page.locator('.provider-setup');
  const last = setup.getByRole('button', { name: 'Save & connect' });
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(setup.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(setup).toBeHidden();
});

test('all themes style root and nested WebView scrollbars from explicit tokens', async ({
  page,
}) => {
  for (const theme of ['light', 'dark', 'minimal', 'classic']) {
    await page.goto(`/?view=models&theme=${theme}`);
    const scrollbar = await page.evaluate(() => {
      const nested = document.createElement('div');
      nested.style.cssText = 'width:20px;height:20px;overflow:auto';
      nested.innerHTML = '<div style="width:80px;height:80px"></div>';
      document.body.append(nested);
      const root = getComputedStyle(document.documentElement);
      const thumb = getComputedStyle(nested, '::-webkit-scrollbar-thumb');
      const track = getComputedStyle(nested, '::-webkit-scrollbar-track');
      const result = {
        size: root.getPropertyValue('--scrollbar-size').trim(),
        thumbToken: root.getPropertyValue('--scrollbar-thumb').trim(),
        trackToken: root.getPropertyValue('--scrollbar-track').trim(),
        thumb: thumb.backgroundColor,
        track: track.backgroundColor,
      };
      nested.remove();
      return result;
    });
    expect(scrollbar.size).toBe('7px');
    expect(scrollbar.thumbToken).not.toBe('');
    expect(scrollbar.trackToken).not.toBe('');
    expect(scrollbar.thumb).not.toBe('rgba(0, 0, 0, 0)');
    expect(scrollbar.track).not.toBe('rgba(0, 0, 0, 0)');
  }
});

test('managed local catalog stays Cupcake-owned and explains pending hardware detection', async ({
  page,
}) => {
  await page.goto('/?view=models');
  const localCards = page.locator('.model-card').filter({ hasText: 'Cupcake Local' });
  await expect(localCards).toHaveCount(3);
  await page.getByText('Local system & acceleration').click();
  await expect(page.getByRole('heading', { name: 'Scanning device compatibility' })).toBeVisible();
  await expect(page.getByText('RAM pending')).toBeVisible();
  await expect(page.getByText(/LM Studio|Ollama|vLLM/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Install a model to benchmark' })).toBeDisabled();
  const install = localCards.first().getByRole('button', { name: 'Install', exact: true });
  await install.click();
  await expect(page.getByRole('dialog', { name: /Review/ })).toContainText('SHA-256');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Review/ })).toBeHidden();
});
