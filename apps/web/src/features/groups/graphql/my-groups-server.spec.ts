import { describe, expect, it, vi } from 'vitest';
import { loadMyGroups } from './my-groups-server';

const list = { items: [{ groupId: 'synthetic-group', lifecycle: 'ACTIVE', myRole: 'OWNER', activeParticipantCount: 1, createdAt: '2026-11-20T01:02:03.004Z', joinedAt: '2026-11-20T01:02:03.004Z', deleteEligibleAt: null }], hasMore: false };
const ok = () => vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { myGroups: list } }));

describe('自分のGroup一覧のServer間Query', () => {
  it('Session Cookie 1つだけ・X-Kakei-Request・JSONを付け、Originを付けずno-storeで固定loopbackへ送る', async () => {
    const fetcher = ok();

    const result = await loadMyGroups('g_state={"i_l":0}; kakei_dev_auth_session=synthetic-session; theme=dark', { mode: 'development', fetcher });

    expect(result).toEqual({ status: 'ok', value: list });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [target, init] = fetcher.mock.calls[0];
    expect(target).toBe('http://127.0.0.1:3001/graphql');
    expect(init?.method).toBe('POST');
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('manual');
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual(['content-type', 'cookie', 'x-kakei-request']);
    expect(headers.get('cookie')).toBe('kakei_dev_auth_session=synthetic-session');
    expect(headers.get('x-kakei-request')).toBe('1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ query: expect.stringContaining('query MyGroups'), operationName: 'MyGroups' });
  });

  it.each([[null], [''], ['theme=dark'], ['kakei_dev_auth_session_old=x'], ['__Host-kakei-auth-session=x']])('開発Session Cookieがない（%s）なら送らず未認証にする', async (cookie) => {
    const fetcher = ok();
    expect(await loadMyGroups(cookie, { mode: 'development', fetcher })).toEqual({ status: 'authentication-required' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['重複', 'kakei_dev_auth_session=a; kakei_dev_auth_session=b'],
    ['空値', 'kakei_dev_auth_session='],
    ['区切り文字を含む値', 'kakei_dev_auth_session="a,b"'],
    ['上限超過', 'kakei_dev_auth_session=' + 'a'.repeat(4097)],
  ])('Session Cookieの%sは送らず取得不能にする', async (_, cookie) => {
    const fetcher = ok();
    expect(await loadMyGroups(cookie, { mode: 'development', fetcher })).toEqual({ status: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['production', 'test', undefined])('%sではAPIへ接続しない', async (mode) => {
    const fetcher = ok();
    expect(await loadMyGroups('kakei_dev_auth_session=synthetic-session', { mode, fetcher })).toEqual({ status: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('AUTHENTICATION_REQUIREDを未認証として返す', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ errors: [{ message: 'ログインが必要です。', extensions: { code: 'AUTHENTICATION_REQUIRED', requestId: '00000000-0000-4000-8000-000000000001' } }], data: null }));
    expect(await loadMyGroups('kakei_dev_auth_session=synthetic-session', { mode: 'development', fetcher })).toEqual({ status: 'authentication-required' });
  });

  it('接続障害を診断なしの取得不能にする', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED synthetic-session'));
    expect(await loadMyGroups('kakei_dev_auth_session=synthetic-session', { mode: 'development', fetcher })).toEqual({ status: 'unavailable' });
  });

  it('契約外の応答を取得不能にする', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { myGroups: { items: 'x', hasMore: false } } }));
    expect(await loadMyGroups('kakei_dev_auth_session=synthetic-session', { mode: 'development', fetcher })).toEqual({ status: 'unavailable' });
  });
});
