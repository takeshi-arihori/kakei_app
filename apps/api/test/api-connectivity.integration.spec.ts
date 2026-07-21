import { describe, expect, it } from 'vitest';

import { executeApiStatus } from '../../web/src/shared/graphql/client.js';
import { createApp } from '../src/app.js';

describe('Next.js client → Hono GraphQL API', () => {
  it('生成型を利用するWeb clientから実際のHono appへ疎通できる', async () => {
    const app = createApp();
    const inMemoryFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      return app.request(request);
    };

    await expect(
      executeApiStatus('http://api.test/graphql', inMemoryFetch),
    ).resolves.toEqual({ status: 'ok' });
  });
});
