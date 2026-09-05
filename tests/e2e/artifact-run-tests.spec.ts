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
  await expect(approval).toContainText('finished in the isolated local Python environment');

  await approval.getByRole('button', { name: 'Open task' }).click();
  await expect(
    page.getByRole('heading', { name: 'Run tests · test_provider_routes.py' }),
  ).toBeVisible();
  await expect(page.getByText('Complete', { exact: true })).toBeVisible();
  await expect(page.getByText('Local Python sandbox', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Python test results' })).toContainText(
    '3 tests passed',
  );
  await expect(page.getByRole('button', { name: 'Cancel safely' })).toHaveCount(0);
  const followup = page.getByRole('button', { name: 'Queue follow-up' });
  await expect(followup).toBeVisible();
  const followupLayout = await followup.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  expect(followupLayout.width).toBeGreaterThan(90);
  expect(followupLayout.height).toBeLessThan(40);
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

test('a completed failing suite reports test counts instead of an infrastructure failure', async ({
  page,
}) => {
  await page.goto('/?view=artifacts&artifactTestOutcome=failure');
  await page.getByRole('button', { name: /test_provider_routes\.py/ }).click();
  await page.getByRole('button', { name: 'Run tests' }).click();
  const result = page.getByRole('region', { name: 'Python test run' });
  await result.getByRole('button', { name: 'Allow once' }).click();

  await expect(result.getByText('7 of 8 tests passed')).toBeVisible();
  await expect(result).toContainText('finished with 1 error');
  await expect(result).not.toContainText('did not complete');

  await result.getByRole('button', { name: 'Open task' }).click();
  const taskResult = page.getByRole('region', { name: 'Python test results' });
  await expect(taskResult.getByText('7 of 8 tests passed')).toBeVisible();
  await expect(page.getByText('Complete · tests need attention')).toBeVisible();
  await expect(page.getByText('Local Python sandbox', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'All tasks' }).click();
  const taskRow = page.getByRole('button', { name: /Run tests · test_provider_routes\.py/ });
  await expect(taskRow).toContainText('Tests failed');
  await expect(taskRow).toContainText('Tests finished · issues found');
  await expect(taskRow.locator('.task-state-icon')).toHaveClass(/is-failed/);
});
