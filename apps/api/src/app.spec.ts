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
});
