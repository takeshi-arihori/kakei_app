import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

describe('Hono API', () => {
  const app = createApp();

  it('GET /healthでLivenessを返す', async () => {
    const response = await app.request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('POST /graphqlでAPI疎通状態を返す', async () => {
    const response = await app.request('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query ApiStatus { apiStatus { status } }',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { apiStatus: { status: 'ok' } },
    });
  });

  describe('/graphqlのCORS（同一Origin方針）', () => {
    const otherOrigin = 'https://evil.example';
    const corsResponseHeaders = [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-methods',
      'access-control-allow-headers',
    ];

    it('他Originからのpreflightを許可せずCORS Headerを返さない', async () => {
      const response = await app.request('/graphql', {
        method: 'OPTIONS',
        headers: {
          origin: otherOrigin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });

      expect(response.status).toBe(405);
      for (const name of corsResponseHeaders)
        expect(response.headers.has(name), name).toBe(false);
    });

    it('他OriginのOrigin付きPOSTへCORS Headerを返さない', async () => {
      const response = await app.request('/graphql', {
        method: 'POST',
        headers: { origin: otherOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'query ApiStatus { apiStatus { status } }',
        }),
      });

      for (const name of corsResponseHeaders)
        expect(response.headers.has(name), name).toBe(false);
    });

    it('同一Origin転送のOrigin付きPOSTは成功しCORS Headerを返さない', async () => {
      const response = await app.request('/graphql', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: 'query ApiStatus { apiStatus { status } }',
        }),
      });

      expect(response.status).toBe(200);
      for (const name of corsResponseHeaders)
        expect(response.headers.has(name), name).toBe(false);
      await expect(response.json()).resolves.toEqual({
        data: { apiStatus: { status: 'ok' } },
      });
    });
  });

  it.each([
    ['POST', '/auth/google/attempt'],
    ['POST', '/auth/google/login'],
    ['GET', '/auth/session'],
    ['POST', '/auth/logout'],
  ])(
    'Capability未設定の%s %sは認証を有効にせず503を返す',
    async (method, path) => {
      const response = await app.request(path, { method });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({
        error: {
          code: 'AUTHENTICATION_UNAVAILABLE',
          requestId: expect.any(String) as unknown,
        },
      });
    },
  );
});
