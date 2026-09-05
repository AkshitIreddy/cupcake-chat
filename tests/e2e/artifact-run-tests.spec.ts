import { expect, test } from '@playwright/test';

test('a saved Python artifact creates, approves, and opens a durable test task', async ({
  page,
}) => {
  await page.goto('/?view=artifacts');

  await page.getByRole('button', { name: /test_provider_routes\.py/ }).click();
  const runTests = page.getByRole('button', { name: 'Run tests' });
  await expect(runTests).toBeEnabled();
  await expect(runTests).toHaveAttribute('title', 'Run saved revision 1');

  await runTests.click();
  const approval = page.getByRole('region', { name: 'Python test run' });
  await expect(approval.getByText('Run tests for this saved version?')).toBeVisible();
  await expect(approval).toContainText('saved revision 1 of test_provider_routes.py');

  await approval.getByRole('button', { name: 'Allow once' }).click();
  await expect(approval.getByText('3 tests passed')).toBeVisible();
  await expect(approval).toContainText('finished in the local Python sandbox');

  await approval.getByRole('button', { name: 'Open task' }).click();
  await expect(
    page.getByRole('heading', { name: 'Run tests · test_provider_routes.py' }),
  ).toBeVisible();
  await expect(page.getByText('Complete', { exact: true })).toBeVisible();
});

test('Run tests stays bound to a saved immutable revision', async ({ page }) => {
  await page.goto('/?view=artifacts');
  await page.getByRole('button', { name: /test_provider_routes\.py/ }).click();
  await page.getByRole('button', { name: 'Edit' }).click();

  const editor = page.getByRole('textbox', { name: 'Edit test_provider_routes.py' });
  await editor.fill(`${await editor.inputValue()}\n# A deliberate fixture edit\n`);
  await expect(page.getByRole('button', { name: 'Run tests' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Run tests' })).toHaveAttribute(
    'title',
    'Save this draft before running tests',
  );

  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('button', { name: 'Run tests' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Run tests' })).toHaveAttribute(
    'title',
    'Run saved revision 2',
  );
});
