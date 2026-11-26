import { expect, test } from '@playwright/test';

test('Productionの/groupsはAPIへ接続せず、取得できない案内を出す', async ({ page }) => {
  await page.goto('/groups');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('グループを表示できません');
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '再読み込み', exact: true })).toHaveAttribute('href', '/groups');
});

test('Productionの/graphqlは転送せず、no-storeの503と固定の公開Errorを返す', async ({ request }) => {
  const response = await request.post('/graphql', { headers: { 'Content-Type': 'application/json', 'X-Kakei-Request': '1' }, data: { query: 'query MyGroups { myGroups { hasMore } }' } });
  expect(response.status()).toBe(503);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['set-cookie']).toBeUndefined();
  expect(await response.json()).toEqual({ errors: [{ message: '現在処理できません。', extensions: { code: 'SERVICE_UNAVAILABLE', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } }] });
  expect((await request.get('/graphql')).status()).toBe(405);
});
