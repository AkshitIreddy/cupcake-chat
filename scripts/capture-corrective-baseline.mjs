#!/usr/bin/env node
/* global document, innerHeight, innerWidth */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:42619';
const output = resolve(process.argv[3] ?? 'artifacts/corrective-baseline');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const browserErrors = [];
page.on('pageerror', (error) => browserErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') browserErrors.push(message.text());
});

async function open(path) {
  await page.goto(`${baseURL}${path}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
}

await open('/?view=settings&theme=light');
await page.getByRole('button', { name: 'Providers' }).click();
await page
  .locator('.provider-row')
  .filter({ hasText: 'OpenAI' })
  .getByRole('button', { name: /Connect|Manage/ })
  .click();
await page.locator('.provider-dialog').screenshot({ path: join(output, 'provider-popup.png') });
await page.screenshot({ path: join(output, 'provider-popup-full.png') });

await open('/?view=models&theme=light');
await page.getByRole('button', { name: 'Local', exact: true }).click();
await page.screenshot({ path: join(output, 'local-models.png') });

await page.setViewportSize({ width: 768, height: 520 });
await open('/?view=models&theme=dark');
await page.screenshot({ path: join(output, 'native-scrollbars.png') });

await page.setViewportSize({ width: 1024, height: 720 });
await open('/?view=models&theme=light');
const titlebarOverlap = await page.evaluate(() => {
  const reserved = { left: innerWidth - 150, top: 0, right: innerWidth, bottom: 40 };
  const overlaps = [...document.querySelectorAll('button, a, input, [role="button"]')]
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const intersects =
        rect.right > reserved.left &&
        rect.left < reserved.right &&
        rect.bottom > reserved.top &&
        rect.top < reserved.bottom;
      return intersects
        ? {
            element: element.tagName.toLowerCase(),
            label:
              element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 80) ?? '',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          }
        : null;
    })
    .filter(Boolean);
  return { viewport: { width: innerWidth, height: innerHeight }, reserved, overlaps };
});
await page.evaluate(() => {
  const marker = document.createElement('div');
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText = [
    'position:fixed',
    'z-index:9999',
    'right:0',
    'top:0',
    'width:150px',
    'height:40px',
    'pointer-events:none',
    'background:rgba(182,38,38,.20)',
    'border:2px dashed rgba(152,20,20,.85)',
  ].join(';');
  document.body.append(marker);
});
await page.screenshot({ path: join(output, 'titlebar-overlap-reservation.png') });

await writeFile(
  join(output, 'baseline.json'),
  `${JSON.stringify({ titlebarOverlap, browserErrors }, null, 2)}\n`,
  'utf8',
);
await browser.close();

if (browserErrors.length) {
  throw new Error(`Renderer errors:\n${browserErrors.join('\n')}`);
}
process.stdout.write(`Captured corrective Electron/web baseline in ${output}.\n`);
