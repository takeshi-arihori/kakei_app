import { describe, expect, it, vi } from 'vitest';
import type { GoogleAuthenticationService } from '../../../shared/application/authentication/google-authentication-service.js';
import { createAuthenticationTransactionScopes } from '../../../shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import { createAuthenticationHttpSecurity } from '../../../shared/infrastructure/authentication/authentication-http-security.js';
import type { AuthenticationHttpRate } from '../../../shared/application/authentication/authentication-http-ports.js';
import type { AuthenticationHttpService } from './authentication-http.js';
import { createAuthenticationHttp } from './authentication-http.js';
const secret = (n: number) => Buffer.alloc(32, n).toString('base64url');
const setup = (production = false) => {
  const begin = vi
    .fn<GoogleAuthenticationService['beginGoogleLogin']>()
    .mockResolvedValue({
      status: 'started',
      attemptSecret: secret(1),
      nonce: secret(2),
      csrf: secret(3),
      expiresAt: 301000,
    });
  const complete = vi
    .fn<GoogleAuthenticationService['completeGoogleLogin']>()
    .mockResolvedValue({
      status: 'authenticated',
      sessionSecret: secret(4),
      absoluteExpiresAt: 604801000,
    });
  const logout = vi
    .fn<GoogleAuthenticationService['logoutCurrentSession']>()
    .mockResolvedValue({ status: 'logged-out' });
  const inspect: GoogleAuthenticationService['withAuthenticatedActor'] = async (
    _secret,
    usage,
    callback,
  ) => {
    expect(usage).toBe('inspect');
    const lease = createAuthenticationTransactionScopes().open({
      query: () =>
        Promise.resolve({
          rows: [],
          rowCount: 0,
          command: 'SELECT',
          oid: 0,
          fields: [],
        }),
    });
    try {
      const value = await callback(
        {
          actorSubject: '00000000-0000-4000-8000-000000000218',
          csrf: secret(5),
          absoluteExpiresAt: 604801000,
        },
        lease.scope,
      );
      lease.seal();
      lease.assertResult(value);
      lease.assertCommittable();
      return { status: 'authenticated', value };
    } finally {
      lease.close();
    }
  };
  const rate = {
    reserve: vi.fn<AuthenticationHttpRate['reserve']>(() =>
      Promise.resolve({ status: 'allowed' }),
    ),
  };
  const origin = production
    ? 'https://app.example.test'
    : 'http://localhost:3000';
  const service: AuthenticationHttpService = {
    beginGoogleLogin: begin,
    completeGoogleLogin: complete,
    logoutCurrentSession: logout,
    withAuthenticatedActor: inspect,
  };
  const handler = createAuthenticationHttp({
    service,
    rate,
    security: createAuthenticationHttpSecurity(),
    origin,
    profile: production ? 'production' : 'local-development',
    clock: { now: () => 1000 },
  });
  const send = (
    path: string,
    body?: string,
    extra: Record<string, string> = {},
  ) =>
    handler(
      new Request(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: origin,
          'X-Kakei-Request': '1',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extra,
        },
        body,
      }),
      '127.0.0.1',
    );
  return { send, begin, complete, logout, rate, service };
};
describe('認証HTTPのService境界', () => {
  it.each([0, 1, 999, 1000, 1001])(
    'Cookie残寿命%dmsを秒へ変換し、正のMax-Ageがなければ成功を返さない',
    async (remaining) => {
      const s = setup();
      s.begin.mockResolvedValueOnce({
        status: 'started',
        attemptSecret: secret(1),
        nonce: secret(2),
        csrf: secret(3),
        expiresAt: 1000 + remaining,
      });
      s.complete.mockResolvedValueOnce({
        status: 'authenticated',
        sessionSecret: secret(4),
        absoluteExpiresAt: 1000 + remaining,
      });
      const attempt = await s.send('/auth/google/attempt', '{}');
      const login = await s.send(
        '/auth/google/login',
        '{"credential":"synthetic-token"}',
        { 'X-CSRF-Token': secret(3) },
      );
      if (remaining < 1000) {
        for (const response of [attempt, login]) {
          expect(response.status).toBe(503);
          expect(response.headers.has('set-cookie')).toBe(false);
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(await response.json()).toMatchObject({
            error: { code: 'AUTHENTICATION_UNAVAILABLE' },
          });
        }
      } else {
        expect(attempt.status).toBe(201);
        expect(attempt.headers.get('set-cookie')).toContain('Max-Age=1;');
        expect(login.status).toBe(204);
        expect(login.headers.getSetCookie()[0]).toContain('Max-Age=1;');
        expect(login.headers.getSetCookie()).toHaveLength(2);
      }
    },
  );
  it('beginは秘密Cookieと公開nonce/CSRFを分け、no-storeで返す', async () => {
    const s = setup();
    const response = await s.send('/auth/google/attempt', '{}');
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      nonce: secret(2),
      csrfToken: secret(3),
      expiresAt: 301000,
    });
    expect(response.headers.get('set-cookie')).toContain(
      `kakei_dev_auth_attempt=${secret(1)}`,
    );
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('Production契約のCookieをSecure/__Host/Domainなしに固定する', async () => {
    const response = await setup(true).send('/auth/google/attempt', '{}');
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('__Host-kakei-auth-attempt=');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('Domain=');
  });
  it('login成功後だけ新Session CookieとAttempt削除を返す', async () => {
    const s = setup();
    const r = await s.send(
      '/auth/google/login',
      '{"credential":"synthetic-token"}',
      {
        Cookie: `kakei_dev_auth_attempt=${secret(1)}`,
        'X-CSRF-Token': secret(3),
      },
    );
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect(r.headers.getSetCookie()).toHaveLength(2);
    expect(
      r.headers
        .getSetCookie()
        .some(
          (c) =>
            c.includes('kakei_dev_auth_attempt=;') && c.includes('Max-Age=0'),
        ),
    ).toBe(true);
    expect(s.complete).toHaveBeenCalledWith({
      credential: 'synthetic-token',
      attemptSecret: secret(1),
      csrf: secret(3),
      currentSessionSecret: undefined,
    });
  });
  it('inspectはlease内で確定した本文だけを返しActorを公開しない', async () => {
    const r = await setup().send('/auth/session', undefined, {
      Cookie: `kakei_dev_auth_session=${secret(4)}`,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      authenticated: true,
      csrfToken: secret(5),
      expiresAt: 604801000,
    });
  });
  it('logoutのCSRF不一致ではCookieも現在Sessionも変更しない', async () => {
    const s = setup();
    const r = await s.send('/auth/logout', '{}', {
      Cookie: `kakei_dev_auth_session=${secret(4)}`,
      'X-CSRF-Token': secret(6),
    });
    expect(r.status).toBe(403);
    expect(r.headers.has('set-cookie')).toBe(false);
    expect(s.logout).not.toHaveBeenCalled();
  });
  it('logoutは同じCookieを失効した後だけ消す', async () => {
    const s = setup();
    const r = await s.send('/auth/logout', '{}', {
      Cookie: `kakei_dev_auth_session=${secret(4)}`,
      'X-CSRF-Token': secret(5),
    });
    expect(r.status).toBe(204);
    expect(s.logout).toHaveBeenCalledWith(secret(4));
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('Rate/Store障害で成功やCookie削除を返さず秘密を漏らさない', async () => {
    const s = setup();
    s.complete.mockRejectedValueOnce(
      new Error('synthetic-token/private-diagnostic'),
    );
    const r = await s.send(
      '/auth/google/login',
      '{"credential":"synthetic-token"}',
      {
        Cookie: `kakei_dev_auth_attempt=${secret(1)}`,
        'X-CSRF-Token': secret(3),
      },
    );
    expect(r.status).toBe(503);
    expect(r.headers.has('set-cookie')).toBe(false);
    expect(await r.text()).not.toMatch(/synthetic|private/);
  });
  it('別OriginではServiceとRateに届かない', async () => {
    const s = setup();
    const r = await s.send('/auth/google/attempt', '{}', { Origin: 'null' });
    expect(r.status).toBe(403);
    expect(s.begin).not.toHaveBeenCalled();
    expect(s.rate.reserve).not.toHaveBeenCalled();
  });
  it('予算拒否と障害はServiceに到達せずCookieを変更しない', async () => {
    const s = setup();
    s.rate.reserve.mockResolvedValueOnce({
      status: 'limited',
      retryAfterSeconds: 1,
    });
    const limited = await s.send('/auth/google/attempt', '{}');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(limited.headers.has('set-cookie')).toBe(false);
    expect(s.begin).not.toHaveBeenCalled();
    s.rate.reserve.mockResolvedValueOnce({ status: 'unavailable' });
    const unavailable = await s.send('/auth/google/attempt', '{}');
    expect(unavailable.status).toBe(503);
    expect(s.begin).not.toHaveBeenCalled();
    expect(unavailable.headers.has('set-cookie')).toBe(false);
  });
  it('Session無効の401だけでCookieを消し、inspect障害では残す', async () => {
    const s = setup();
    s.service.withAuthenticatedActor = () =>
      Promise.resolve({ status: 'unauthenticated' });
    const invalid = await s.send('/auth/session');
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('set-cookie')).toContain('Max-Age=0');
    s.service.withAuthenticatedActor = () =>
      Promise.resolve({ status: 'unavailable' });
    const failed = await s.send('/auth/session');
    expect(failed.status).toBe(503);
    expect(failed.headers.has('set-cookie')).toBe(false);
  });
  it('logoutは不在/失効Sessionで冪等、inspectとrevoke障害ではCookieを消さない', async () => {
    const s = setup();
    s.service.withAuthenticatedActor = () =>
      Promise.resolve({ status: 'unauthenticated' });
    const absent = await s.send('/auth/logout', '{}');
    expect(absent.status).toBe(204);
    expect(s.logout).not.toHaveBeenCalled();
    s.service.withAuthenticatedActor = () =>
      Promise.resolve({ status: 'unavailable' });
    const failed = await s.send('/auth/logout', '{}');
    expect(failed.status).toBe(503);
    expect(failed.headers.has('set-cookie')).toBe(false);
    const other = setup();
    other.logout.mockResolvedValueOnce({ status: 'unavailable' });
    const unknown = await other.send('/auth/logout', '{}', {
      Cookie: 'kakei_dev_auth_session=' + secret(4),
      'X-CSRF-Token': secret(5),
    });
    expect(unknown.status).toBe(503);
    expect(unknown.headers.has('set-cookie')).toBe(false);
  });
  it('期限等値や不正な成功値をCookieに変換せず、失敗詳細を出さない', async () => {
    const s = setup();
    s.begin.mockResolvedValueOnce({
      status: 'started',
      attemptSecret: secret(1),
      nonce: secret(2),
      csrf: secret(3),
      expiresAt: 1000,
    });
    const expired = await s.send('/auth/google/attempt', '{}');
    expect(expired.status).toBe(503);
    expect(expired.headers.has('set-cookie')).toBe(false);
    const body: unknown = await expired.json();
    expect(body).toEqual({
      error: {
        code: 'AUTHENTICATION_UNAVAILABLE',
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ) as unknown,
      },
    });
  });
  it('内部restart-requiredを409へ写像しAttemptだけを削除する', async () => {
    const s = setup();
    s.complete.mockResolvedValueOnce({ status: 'restart-required' });
    const r = await s.send(
      '/auth/google/login',
      '{"credential":"synthetic-token"}',
      {
        Cookie:
          'kakei_dev_auth_attempt=' +
          secret(1) +
          '; kakei_dev_auth_session=' +
          secret(4),
        'X-CSRF-Token': secret(6),
      },
    );
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      error: {
        code: 'LOGIN_RESTART_REQUIRED',
        requestId: expect.any(String) as unknown,
      },
    });
    expect(r.headers.getSetCookie()).toHaveLength(1);
    expect(r.headers.get('set-cookie')).toContain(
      'kakei_dev_auth_attempt=; Max-Age=0',
    );
    expect(r.headers.get('set-cookie')).not.toContain(
      'kakei_dev_auth_session=',
    );
  });
  it.each(['', 'not-canonical'])(
    'LoginのCSRF欠落/形式不正は403でRecordへ到達しない: %s',
    async (csrf) => {
      const s = setup();
      const r = await s.send(
        '/auth/google/login',
        '{"credential":"synthetic-token"}',
        {
          Cookie: 'kakei_dev_auth_attempt=' + secret(1),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
      );
      expect(r.status).toBe(403);
      expect(r.headers.has('set-cookie')).toBe(false);
      expect(s.complete).not.toHaveBeenCalled();
    },
  );
  it('有効Session競合409とCredential拒否401ではCookieを削除しない', async () => {
    const s = setup();
    for (const [status, expected] of [
      ['already-authenticated', 409],
      ['invalid-credential', 401],
    ] as const) {
      s.complete.mockResolvedValueOnce({ status });
      const r = await s.send(
        '/auth/google/login',
        '{"credential":"synthetic-token"}',
        {
          Cookie: 'kakei_dev_auth_attempt=' + secret(1),
          'X-CSRF-Token': secret(3),
        },
      );
      expect(r.status).toBe(expected);
      expect(r.headers.has('set-cookie')).toBe(false);
    }
  });
});
