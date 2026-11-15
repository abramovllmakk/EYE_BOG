import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const RUN_ID = `ui-${Date.now()}`;

test.beforeAll(() => {
  execFileSync('node', [fileURLToPath(new URL('../demo/traffic/src/run.mjs', import.meta.url))], {
    env: {
      ...process.env,
      PROXY_URL: process.env.E2E_PROXY_URL ?? 'http://localhost:4000/graphql',
      RUN_ID,
      BRANCH: 'ui-smoke',
    },
  });
});

test('graph → type → field → operation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Прогоны тестов' })).toBeVisible();

  await page.goto(`/graph?run=${RUN_ID}`);
  // Colouring: covered/partial cards are rendered with their status and percentage.
  const userCard = page
    .locator('.react-flow__node')
    .filter({ hasText: 'User' })
    .filter({ hasText: 'avatarUrl' });
  await expect(userCard).toBeVisible();
  await expect(userCard).toContainText('100%');
  const postCard = page
    .locator('.react-flow__node')
    .filter({ hasText: 'publishedAt' })
    .filter({ hasText: 'comments' });
  await expect(postCard).toContainText('88.9%');
  await expect(page.getByLabel('Легенда цветов')).toBeVisible();

  // Only-uncovered mode hides fully covered types.
  // (state lives in the URL, so we assert the URL instead of the checkbox's instant state)
  await page.getByLabel('Только непокрытое').click();
  await expect(page).toHaveURL(/uncovered=1/);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'avatarUrl' })).toHaveCount(0);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'totalLikes' })).toBeVisible();
  await page.getByLabel('Только непокрытое').click();
  await expect(page).not.toHaveURL(/uncovered=1/);

  // Graph → type (side panel) → type page.
  await page
    .locator('.react-flow__node')
    .filter({ hasText: 'avatarUrl' })
    .locator('text=User')
    .first()
    .click();
  await page.getByRole('link', { name: 'Открыть детализацию типа' }).click();
  await expect(page.getByRole('heading', { name: 'User' })).toBeVisible();

  // Type → field.
  await page.getByRole('link', { name: 'name', exact: true }).first().click();
  await expect(page).toHaveURL(/\/fields\/User\.name/);
  await expect(page.getByText('Пути от корня')).toBeVisible();

  // Field → operation drill-down.
  await page.locator('table a').first().click();
  await expect(page).toHaveURL(/\/operations\/\d+/);
  await expect(page.getByText('Текст запроса')).toBeVisible();
  await expect(page.locator('pre code')).toContainText('name');
});

test('table filters live in the URL', async ({ page }) => {
  await page.goto(`/table?run=${RUN_ID}&view=never`);
  await expect(page.getByRole('cell', { name: 'Mutation.follow' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Query.viewer' })).toHaveCount(0);
});
