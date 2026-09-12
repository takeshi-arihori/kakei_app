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

  it('dataとGraphQL Errorが併存するときErrorを優先する', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: { apiStatus: { status: 'ok' } },
        errors: [{ message: 'resolver failed' }],
      }),
    );

    await expect(executeApiStatus('/graphql', fetch)).rejects.toEqual(
      new ApiGraphQLError(['resolver failed']),
    );
  });

  it('GraphQL Errorのmessageが文字列でない場合は既定文言を使う', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ errors: [{}, { message: 400 }] }),
    );

    await expect(executeApiStatus('/graphql', fetch)).rejects.toEqual(
      new ApiGraphQLError([
        'Unknown GraphQL error',
        'Unknown GraphQL error',
      ]),
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

  it('HTTP失敗をApiTransportErrorへ変換する', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { data: { apiStatus: { status: 'unavailable' } } },
        { status: 503 },
      ),
    );

    await expect(executeApiStatus('/graphql', fetch)).rejects.toBeInstanceOf(
      ApiTransportError,
    );
  });

  it('不正JSONをApiTransportErrorへ変換する', async () => {
    const fetch = vi.fn(async () => new Response('<html>bad gateway</html>'));

    await expect(executeApiStatus('/graphql', fetch)).rejects.toBeInstanceOf(
      ApiTransportError,
    );
  });

  it('Response bodyの読み取り失敗をApiTransportErrorへ変換する', async () => {
    const response = Response.json({ data: { apiStatus: { status: 'ok' } } });
    await response.text();
    const fetch = vi.fn(async () => response);

    await expect(executeApiStatus('/graphql', fetch)).rejects.toBeInstanceOf(
      ApiTransportError,
    );
  });

  it.each([
    ['null', null],
    ['配列', []],
    ['primitive', 'ok'],
    ['dataがnull', { data: null }],
    ['dataが配列', { data: [] }],
    ['apiStatusがない', { data: {} }],
    ['apiStatusがnull', { data: { apiStatus: null } }],
    ['apiStatusが配列', { data: { apiStatus: [] } }],
    ['statusがない', { data: { apiStatus: {} } }],
    ['statusがnull', { data: { apiStatus: { status: null } } }],
    ['statusが数値', { data: { apiStatus: { status: 123 } } }],
  ])('不正な%s payloadをApiTransportErrorとして拒否する', async (_, payload) => {
    const fetch = vi.fn(async () => Response.json(payload));

    await expect(executeApiStatus('/graphql', fetch)).rejects.toBeInstanceOf(
      ApiTransportError,
    );
  });

  it.each([
    ['null', null],
    ['object', {}],
    ['null要素', [null]],
    ['primitive要素', ['resolver failed']],
    ['配列要素', [[]]],
  ])('不正な%s errorsをApiTransportErrorとして拒否する', async (_, errors) => {
    const fetch = vi.fn(async () =>
      Response.json({ data: { apiStatus: { status: 'ok' } }, errors }),
    );

    await expect(executeApiStatus('/graphql', fetch)).rejects.toBeInstanceOf(
      ApiTransportError,
    );
  });

  it('空errorsと追加Fieldを許容しString statusを返す', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: {
          apiStatus: { status: 'degraded', extension: 'ignored by contract' },
        },
        errors: [],
        extensions: { requestId: 'test-request' },
      }),
    );

    await expect(executeApiStatus('/graphql', fetch)).resolves.toMatchObject({
      status: 'degraded',
    });
  });
});
