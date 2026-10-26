import { describe, expect, it, vi } from 'vitest';
import {
  authenticationJsonObject,
  checkAuthenticationRequest,
  authenticationCookieSecrets,
} from './authentication-http-input.js';

const request = (body: string, headers: Record<string, string> = {}) =>
  new Request('http://localhost:3000/auth/google/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
describe('認証HTTPの未検証入力境界', () => {
  it('唯一のcredential文字列と空Objectだけを復元する', async () => {
    expect(
      await authenticationJsonObject(request('{"credential":"synthetic"}'), [
        'credential',
      ]),
    ).toEqual({ credential: 'synthetic' });
    expect(await authenticationJsonObject(request('{}'), [])).toEqual({});
  });
  it.each([
    '{"credential":"a","credential":"b"}',
    '{"credential":"a","cred\\u0065ntial":"b"}',
    '{"actor":"self"}',
    '{"credential":{}}',
    '[]',
    'null',
    '{"credential":"a",}',
  ])('%sを暗黙に受理しない', async (body) => {
    await expect(
      authenticationJsonObject(request(body), ['credential']),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    'text/plain',
    'application/x-www-form-urlencoded',
    'application/json; charset=shift_jis',
  ])('%sを拒否する', async (type) => {
    await expect(
      authenticationJsonObject(request('{}', { 'content-type': type }), []),
    ).rejects.toMatchObject({ status: 415 });
  });
  it('Content-Lengthを偽装してもstream上限を超えられない', async () => {
    await expect(
      authenticationJsonObject(
        request(' '.repeat(18_433), { 'content-length': '2' }),
        [],
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
  it('届かないBodyを5秒で打ち切る', async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({ start() {} });
      const req = new Request('http://localhost:3000/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit);
      const assertion = expect(
        authenticationJsonObject(req, []),
      ).rejects.toMatchObject({ status: 400 });
      await vi.advanceTimersByTimeAsync(5001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    undefined,
    'null',
    'http://localhost:3001',
    'https://localhost:3000',
    'http://localhost:3000,http://localhost:3000',
  ])('POST Origin %sを拒否する', (origin) => {
    const headers: Record<string, string> = { 'X-Kakei-Request': '1' };
    if (origin !== undefined) headers.Origin = origin;
    expect(() =>
      checkAuthenticationRequest(
        request('{}', headers),
        'http://localhost:3000',
        'POST',
      ),
    ).toThrow();
  });
  it('GETのOrigin省略をcustom Headerと同一Origin Fetch Metadataで許可する', () => {
    const req = new Request('http://localhost:3000/auth/session', {
      headers: { 'X-Kakei-Request': '1', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(() =>
      checkAuthenticationRequest(req, 'http://localhost:3000', 'GET'),
    ).not.toThrow();
  });
  it('偽ForwardedがあってもOrigin欠落を補わない', () => {
    expect(() =>
      checkAuthenticationRequest(
        request('{}', {
          'X-Kakei-Request': '1',
          'X-Forwarded-Host': 'localhost:3000',
          'X-Forwarded-Proto': 'http',
        }),
        'http://localhost:3000',
        'POST',
      ),
    ).toThrow();
  });
  it('選択Cookieの重複を拒否し、別のCookieを本人性に使わない', () => {
    expect(() =>
      authenticationCookieSecrets('a=one; a=two', {
        attempt: 'a',
        session: 's',
      }),
    ).toThrow();
    expect(
      authenticationCookieSecrets('other=value; a=synthetic', {
        attempt: 'a',
        session: 's',
      }),
    ).toEqual({ attemptSecret: 'synthetic', sessionSecret: undefined });
  });
  it('認証に使わないSDK CookieのJSON値から本人性を解釈しない', () => {
    expect(
      authenticationCookieSecrets('g_state={"i_l":0}; a=synthetic', {
        attempt: 'a',
        session: 's',
      }),
    ).toEqual({ attemptSecret: 'synthetic', sessionSecret: undefined });
  });
  it.each([
    'a=synthetic ',
    'a=synthetic ; other=value',
    's=synthetic ',
    'other=value; s=synthetic ; a=other',
    'a= synthetic',
    's="synthetic" ',
  ])('認証Cookie値の空白を暗黙に除去せず拒否する: %s', (cookie) => {
    expect(() =>
      authenticationCookieSecrets(cookie, { attempt: 'a', session: 's' }),
    ).toThrow();
  });
  it.each([
    'g_state={"i_l":0}; a=one; a=two',
    'g_state={"i_l":0}; a={"not":"a-secret"}',
    'g_state=bad\u0001; a=synthetic',
    'other=' + 'x'.repeat(8192),
  ])('SDK Cookieがあっても認証CookieとHeaderの拒否条件を維持する', (cookie) => {
    expect(() =>
      authenticationCookieSecrets(cookie, { attempt: 'a', session: 's' }),
    ).toThrow();
  });
});
