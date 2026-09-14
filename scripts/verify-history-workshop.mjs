import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const native = process.argv.includes('--native');
const output = 'E:/temp/cupcake-release-1.8-20260915/history-ui';
await mkdir(output, { recursive: true });
const browser = native
  ? await chromium.connectOverCDP('http://127.0.0.1:10131')
  : await chromium.launch({ headless: true });
const page = native
  ? browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'))
  : await browser.newPage({ viewport: { width: 1440, height: 920 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const receipt = { native, eras: [], screens: [] };
try {
  if (!native) await page.goto('http://127.0.0.1:42619');
  await page.locator('.shelf').getByRole('button', { name: 'Tools', exact: true }).click();
  const launch = page.getByRole('button', { name: /History workshop/ });
  if ((await launch.getAttribute('aria-expanded')) !== 'true') await launch.click();
  await page.locator('.history-map__land path').first().waitFor();
  for (const name of [
    'Egypt',
    'Greece',
    'Rome',
    'Viking Age',
    'Mongol Empire',
    'Medieval Europe',
  ]) {
    await page.locator('.history-era-tabs').getByRole('button', { name, exact: true }).click();
    await page.getByRole('combobox', { name: 'Map destination' }).selectOption('2');
    const original = await page.locator('.history-result').innerText();
    const slider = page.getByRole('slider', { name: 'Travel pace', exact: true });
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    assert.notEqual(
      await page.locator('.history-result').innerText(),
      original,
      'Pace changes result',
    );
    await page.locator('.history-heading').scrollIntoViewIfNeeded();
    const images = await page
      .locator('.history-lab img')
      .evaluateAll((es) => es.every((e) => e.complete && e.naturalWidth > 0));
    assert(images, 'Bundled portraits load');
    assert.equal(await page.locator('.history-map__land path').count(), 125);
    const file = name.replaceAll(' ', '-') + '.png';
    await page.screenshot({ path: output + '/' + file, animations: 'disabled' });
    receipt.eras.push({ name, result: await page.locator('.history-result').innerText(), images });
    receipt.screens.push(file);
  }
  await page.getByRole('tab', { name: 'Siege supplies', exact: true }).click();
  assert.match(await page.locator('.history-result').innerText(), /31.7/);
  await page.getByRole('slider', { name: 'People arriving', exact: true }).focus();
  await page.keyboard.press('Home');
  assert.match(await page.locator('.history-result').innerText(), /36/);
  await page.screenshot({ path: output + '/stores.png', animations: 'disabled' });
  await page.getByRole('tab', { name: 'Horses & forage', exact: true }).click();
  const before = await page.locator('.history-result').innerText();
  await page.getByRole('slider', { name: 'Available from grazing', exact: true }).focus();
  await page.keyboard.press('End');
  assert.match(await page.locator('.history-result').innerText(), /^0 kg/);
  assert.notEqual(before, await page.locator('.history-result').innerText());
  await page.keyboard.press('Home');
  await page.screenshot({ path: output + '/horses.png', animations: 'disabled' });
  if (native) {
    await page.getByRole('button', { name: 'Save result to project', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Saved in this project' }).waitFor();
    receipt.artifactSaved = true;
  }
  receipt.errors = errors;
  assert.deepEqual(errors, []);
  receipt.outcome = 'passed';
} finally {
  await writeFile(
    output + '/receipt-' + (native ? 'native' : 'preview') + '.json',
    JSON.stringify(receipt, null, 2),
  );
  await browser.close();
}
