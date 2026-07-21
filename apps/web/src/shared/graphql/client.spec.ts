import { describe, expect, it, vi } from 'vitest';

import {
  ApiGraphQLError,
  ApiTransportError,
  executeApiStatus,
} from './client.js';

describe('GraphQL API client', () => {
  it('正常Responseを生成型の結果として返す', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ data: { apiStatus: { status: 'ok' } } }),
    );

    await expect(executeApiStatus('/graphql', fetch)).resolves.toEqual({
      status: 'ok',
    });
  });

  it('GraphQL Errorを規定Errorへ変換する', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ errors: [{ message: 'resolver failed' }] }),
    );

    await expect(executeApiStatus('/graphql', fetch)).rejects.toEqual(
      new ApiGraphQLError(['resolver failed']),
    );
  });

  it('通信失敗を規定Errorへ変換する', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('network unavailable');
    });

    await expect(executeApiStatus('/graphql', fetch)).rejects.toBeInstanceOf(
      ApiTransportError,
    );
  });
});
