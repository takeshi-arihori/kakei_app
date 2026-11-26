import type { Page } from '@playwright/test';
import { expect, login, prepare, test } from './support/browser-fixture';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const groups = (page: Page) => page.getByRole('region', { name: '参加しているグループ' }).getByRole('listitem');
const createButton = (page: Page) => page.getByRole('button', { name: 'グループを作成', exact: true });
const openGroups = async (page: Page) => {
  await page.getByRole('link', { name: '自分のグループを見る', exact: true }).click();
  await expect(page).toHaveURL('/groups');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('自分のグループ');
};
type CreateRequest = Readonly<{ operationId: unknown; csrf: string | undefined; origin: string | undefined }>;
const recordCreates = (page: Page): CreateRequest[] => {
  const seen: CreateRequest[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/graphql') return;
    const body: unknown = request.postDataJSON();
    const variables = typeof body === 'object' && body !== null && 'variables' in body ? body.variables : undefined;
    const input = typeof variables === 'object' && variables !== null && 'input' in variables ? variables.input : undefined;
    const operationId = typeof input === 'object' && input !== null && 'operationId' in input ? input.operationId : undefined;
    seen.push({ operationId, csrf: request.headers()['x-csrf-token'], origin: request.headers()['origin'] });
  });
  return seen;
};

test('未ログインの/groupsは戻り先URLなしでログイン画面へ移る', async ({ page }) => {
  await page.goto('/groups');
  await expect(page).toHaveURL('/login');
  expect(new URL(page.url()).search).toBe('');
});

test('ログインした本人が空の一覧からグループを作成し、再読込後も一覧で確認できる', async ({ page, control, context }) => {
  const creates = recordCreates(page);
  const browserRequests: string[] = [];
  page.on('request', (request) => browserRequests.push(new URL(request.url()).origin));
  await prepare(page, control);
  await login(page);
  await openGroups(page);
  await expect(page.getByText('まだ参加しているグループはありません。')).toBeVisible();
  await expect(groups(page)).toHaveCount(0);

  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/graphql');
  await createButton(page).click();
  const created = await response;
  await expect(page.locator('#create-group-heading ~ [role="status"]')).toHaveText('グループを作成しました。');
  await expect(groups(page)).toHaveCount(1);
  await expect(groups(page).first()).toContainText('利用中');
  await expect(groups(page).first()).toContainText('オーナー');
  await expect(groups(page).first()).toContainText('1人');
  await expect(groups(page).first().getByRole('link')).toHaveCount(0);

  expect(created.status()).toBe(200);
  expect(created.headers()['cache-control']).toBe('no-store');
  expect(created.headers()['set-cookie']).toBeUndefined();
  expect(creates).toHaveLength(1);
  expect(creates[0].operationId).toMatch(uuidV4);
  expect(creates[0].csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(creates[0].origin).toBe('http://localhost:3000');
  // 一覧QueryはServer間だけで送り、BrowserはAPIのloopbackへ直接接続しない。
  expect(browserRequests.filter((origin) => origin !== 'http://localhost:3000' && origin !== 'https://accounts.google.com')).toEqual([]);

  await page.reload();
  await expect(groups(page)).toHaveCount(1);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  expect(storage).not.toContain(String(creates[0].operationId));
  expect(storage).not.toContain(String(creates[0].csrf));
  expect((await context.cookies()).filter((c) => c.name.startsWith('kakei_dev_auth')).map((c) => c.name)).toEqual(['kakei_dev_auth_session']);

  await createButton(page).click();
  await expect(groups(page)).toHaveCount(2);
  expect(creates[1].operationId).toMatch(uuidV4);
  expect(creates[1].operationId).not.toBe(creates[0].operationId);
});

test('作成の応答が結果不明でも、同じ操作IDの再試行で1件のグループに収束する', async ({ page, control }) => {
  const creates = recordCreates(page);
  await prepare(page, control);
  await login(page);
  await openGroups(page);
  let intercepted = 0;
  await page.route('**/graphql', async (route) => {
    intercepted++;
    if (intercepted > 1) {
      await route.continue();
      return;
    }
    // APIではcommit済みだが、Browserへは結果不明として届くことを再現する。
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ status: 200, json: { errors: [{ message: '現在処理できません。', extensions: { code: 'SERVICE_UNAVAILABLE', requestId: '00000000-0000-4000-8000-000000000001' } }], data: null } });
  });

  await createButton(page).click();
  await expect(page.getByRole('region', { name: 'グループを作成' }).getByRole('alert')).toContainText('作成できたか確認できませんでした');
  await expect(groups(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'もう一度試す', exact: true }).click();
  await expect(page.locator('#create-group-heading ~ [role="status"]')).toHaveText('グループを作成しました。');

  await expect(groups(page)).toHaveCount(1);
  expect(creates.map((c) => c.operationId)).toEqual([creates[0].operationId, creates[0].operationId]);
  await page.reload();
  await expect(groups(page)).toHaveCount(1);
});

test('作成時にSessionが失効していればログイン画面へ移り、グループを作らない', async ({ page, control, context }) => {
  await prepare(page, control);
  await login(page);
  await openGroups(page);
  const other = await context.newPage();
  await other.goto('/login');
  await other.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(other.getByRole('status')).toHaveText('ログアウトしました。');
  await other.close();

  await createButton(page).click();
  await expect(page).toHaveURL('/login');
  expect(new URL(page.url()).search).toBe('');
});

test('Keyboardだけで作成でき、320px幅と200%拡大ではみ出さず、44pxの操作対象を保つ', async ({ page, control }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await prepare(page, control);
  await login(page);
  await openGroups(page);
  const button = createButton(page);
  for (let n = 0; n < 12 && !(await button.evaluate((e) => e === document.activeElement)); n++) await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await expect(button).toHaveCSS('outline-style', 'solid');
  expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter');
  await expect(groups(page)).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('groups-320.png'), fullPage: true });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  await page.setViewportSize({ width: 640, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.evaluate(() => { document.body.style.zoom = '1'; });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: test.info().outputPath('groups-desktop.png'), fullPage: true });
});
