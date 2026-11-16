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

test('coverage plan: projection, ready queries and links from the map', async ({ page }) => {
  await page.goto(`/plan?run=${RUN_ID}`);
  await expect(page.getByRole('heading', { name: 'План покрытия' })).toBeVisible();
  // The demo suite leaves 11 fields uncovered; the plan closes all of them.
  await expect(page.getByText('Сейчас не покрыто 11 из 72 полей.')).toBeVisible();
  await expect(page.getByRole('img', { name: /до 100%/ })).toBeVisible();
  await expect(page.locator('pre code').first()).toContainText('query CoverVideo');

  // Uncovered field page shows the query that would cover it.
  await page.goto(`/fields/Mutation.follow?run=${RUN_ID}`);
  await expect(page.getByText('Поле не покрыто. Запрос, который его покроет')).toBeVisible();
  await expect(page.locator('pre code').first()).toContainText('follow(userId: $userId)');

  // Map side panel offers the same plan for a partially covered type.
  await page.goto(`/graph?run=${RUN_ID}&sel=Video`);
  await expect(page.getByRole('heading', { name: /Как покрыть/ })).toBeVisible();
});

test('test impact: unique contribution, minimal set and the test footprint on the map', async ({
  page,
}) => {
  await page.goto(`/tests?run=${RUN_ID}`);
  await expect(page.getByRole('heading', { name: 'Вклад тестов' })).toBeVisible();
  await expect(page.getByText(/из 18 тестов дают то же покрытие полей \(61 из 72\)/)).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'post with comments' });
  await expect(row).toContainText('незаменим');
  await row.getByRole('link', { name: 'след на карте' }).click();
  await expect(page).toHaveURL(/\/graph\?.*test=content/);
  await expect(page.getByText(/След теста: затронуто \d+ полей/)).toBeVisible();
});

test('compare preselects a base run and flags regressions', async ({ page }) => {
  await page.goto(`/compare?run=${RUN_ID}`);
  await expect(page).toHaveURL(/base=.*head=/);
  await expect(page.getByRole('status').filter({ hasText: /Покрытие|Регрессия/ })).toBeVisible();
});

test('command palette jumps to a field; risk signals; run-scoped screens open the latest run', async ({
  page,
}) => {
  await page.goto(`/table?run=${RUN_ID}`);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Поиск' }).fill('totalLikes');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/fields\/UserStats\.totalLikes/);

  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Сигналы риска' })).toContainText(
    'мутации без тестов',
  );

  await page.goto('/plan');
  await expect(page).toHaveURL(/run=/);
  await expect(page.getByRole('heading', { name: 'План покрытия' })).toBeVisible();
});

test('connect page shows the proxy URL and stack snippets; HTML report downloads', async ({
  page,
}) => {
  await page.goto('/connect');
  await expect(page.getByRole('heading', { name: 'Подключение тестов' })).toBeVisible();
  await expect(page.getByText(/:4000\/graphql/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Playwright' }).click();
  await expect(page.locator('pre code')).toContainText('extraHTTPHeaders');

  await page.goto(`/table?run=${RUN_ID}`);
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Отчёт HTML' }).click();
  expect((await download).suggestedFilename()).toBe(`coverage-${RUN_ID}.html`);
});
