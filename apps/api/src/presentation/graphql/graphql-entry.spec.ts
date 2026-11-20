import { createSchema } from 'graphql-yoga';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INVALID_REQUEST_MESSAGE,
  PUBLIC_ROOT_FIELDS,
  createGraphQLEntry,
} from './graphql-entry.js';
import { PUBLIC_GRAPHQL_ERROR_MESSAGES } from './public-graphql-error.js';

const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const resolvers = {
  apiStatus: vi.fn(() => ({ status: 'ok' })),
  secret: vi.fn(() => ({ status: 'secret' })),
  fail: vi.fn((): never => {
    throw new Error('db password=leaked-value');
  }),
  change: vi.fn(() => ({ status: 'changed' })),
};

const schema = createSchema({
  typeDefs: /* GraphQL */ `
    type Query {
      apiStatus: S!
      secret: S!
      fail: S
    }
    type Mutation {
      change: S!
    }
    type S {
      status: String!
    }
  `,
  resolvers: {
    Query: {
      apiStatus: () => resolvers.apiStatus(),
      secret: () => resolvers.secret(),
      fail: () => resolvers.fail(),
    },
    Mutation: { change: () => resolvers.change() },
  },
});

const entry = () =>
  createGraphQLEntry({ schema, publicRootFields: PUBLIC_ROOT_FIELDS });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://api.test/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kakei-request': '1',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const expectHardenedHeaders = (response: Response) => {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  for (const name of [
    'access-control-allow-origin',
    'access-control-allow-credentials',
  ])
    expect(response.headers.has(name), name).toBe(false);
};

const expectInvalidRequest = async (
  response: Response,
  status: number,
): Promise<void> => {
  expect(response.status).toBe(status);
  expectHardenedHeaders(response);
  expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  const body = (await response.json()) as {
    errors: { extensions: { requestId: string } }[];
  };
  expect(body).toEqual({
    errors: [
      {
        message: INVALID_REQUEST_MESSAGE,
        extensions: {
          code: 'INVALID_REQUEST',
          requestId: expect.stringMatching(uuidV4) as unknown,
        },
      },
    ],
  });
};

const expectNoResolverCalled = () => {
  for (const resolver of Object.values(resolvers))
    expect(resolver).not.toHaveBeenCalled();
};

describe('createGraphQLEntry', () => {
  beforeEach(() => {
    for (const resolver of Object.values(resolvers)) resolver.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('未認証で公開するroot fieldはapiStatusだけ', () => {
    expect([...PUBLIC_ROOT_FIELDS]).toEqual(['Query.apiStatus']);
  });

  it('上限内のPOSTを実行し、no-store／nosniffを付ける', async () => {
    const response = await entry()(post({ query: '{ apiStatus { status } }' }));

    expect(response.status).toBe(200);
    expectHardenedHeaders(response);
    await expect(response.json()).resolves.toEqual({
      data: { apiStatus: { status: 'ok' } },
    });
    expect(resolvers.apiStatus).toHaveBeenCalledOnce();
  });

  it('認証付きfield 1つとMutation 1つは実行する', async () => {
    const query = await entry()(
      post({ query: '{ secret { status } apiStatus { status } }' }),
    );
    expect(query.status).toBe(200);
    // Mutationは一致Originとcanonical形式のCSRFを要求する（#317）。
    const mutation = await createGraphQLEntry({
      schema,
      publicRootFields: PUBLIC_ROOT_FIELDS,
      capability: {
        origin: 'http://localhost:3000',
        profile: 'local-development',
        service: {
          withAuthenticatedActor: () =>
            Promise.resolve({ status: 'unavailable' }),
        },
        security: {
          createRequestId: () => '6f1c2f8e-3b1a-4c5d-9e7f-0a1b2c3d4e5f',
          equalSecrets: () => false,
        },
      },
    })(
      post(
        { query: 'mutation { change { status } }' },
        {
          origin: 'http://localhost:3000',
          'x-csrf-token': Buffer.alloc(32, 5).toString('base64url'),
        },
      ),
    );
    expect(mutation.status).toBe(200);
    await expect(mutation.json()).resolves.toEqual({
      data: { change: { status: 'changed' } },
    });
  });

  it('Acceptでstreamを求めてもJSONで応答する', async () => {
    const response = await entry()(
      post(
        { query: '{ apiStatus { status } }' },
        { accept: 'text/event-stream, multipart/mixed' },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  });

  describe('POST以外は405＋Allow: POST', () => {
    it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'])(
      '%s',
      async (method) => {
        const response = await entry()(
          new Request(
            'http://api.test/graphql?query=%7B%20apiStatus%20%7B%20status%20%7D%20%7D',
            { method },
          ),
        );
        expect(response.headers.get('allow')).toBe('POST');
        if (method === 'HEAD') {
          expect(response.status).toBe(405);
          expectHardenedHeaders(response);
        } else await expectInvalidRequest(response, 405);
        expectNoResolverCalled();
      },
    );

    it('GETのHTML要求にもGraphiQLを返さない', async () => {
      const response = await entry()(
        new Request('http://api.test/graphql', {
          headers: { accept: 'text/html' },
        }),
      );
      await expectInvalidRequest(response, 405);
    });
  });

  describe('違反は実行前に固定形で拒否し、Resolverを呼ばない', () => {
    it.each([
      [
        'form',
        415,
        post('query=%7B%20apiStatus%20%7B%20status%20%7D%20%7D', {
          'content-type': 'application/x-www-form-urlencoded',
        }),
      ],
      [
        'text/plain',
        415,
        post('{"query":"{ apiStatus { status } }"}', {
          'content-type': 'text/plain',
        }),
      ],
      [
        'multipart',
        415,
        post('--x--', { 'content-type': 'multipart/form-data; boundary=x' }),
      ],
      [
        'application/graphql',
        415,
        post('{ apiStatus { status } }', {
          'content-type': 'application/graphql',
        }),
      ],
      [
        'gzip',
        415,
        post(
          { query: '{ apiStatus { status } }' },
          { 'content-encoding': 'gzip' },
        ),
      ],
      [
        'Body超過',
        413,
        post({ query: `{ apiStatus { status } }${' '.repeat(18_432)}` }),
      ],
      ['batch', 400, post([{ query: '{ apiStatus { status } }' }])],
      [
        'extensions',
        400,
        post({
          query: '{ apiStatus { status } }',
          extensions: { persistedQuery: { version: 1, sha256Hash: 'x' } },
        }),
      ],
      ['構文Error', 400, post({ query: '{ apiStatus { status }' })],
      [
        'introspection',
        400,
        post({ query: '{ __schema { types { name } } }' }),
      ],
      [
        '認証付きfield 2',
        400,
        post({ query: '{ secret { status } x: secret { status } }' }),
      ],
      [
        'Mutation field 2',
        400,
        post({ query: 'mutation { change { status } x: change { status } }' }),
      ],
      [
        'alias超過',
        400,
        post({
          query:
            '{ apiStatus { a: status b: status c: status d: status e: status f: status } }',
        }),
      ],
      [
        'Operation選択不能',
        400,
        post({ query: '{ apiStatus { status } }', operationName: 'Missing' }),
      ],
    ])('%s', async (_label, status, request) => {
      await expectInvalidRequest(await entry()(request), status);
      expectNoResolverCalled();
    });
  });

  it('検証Errorにgraphql-jsのmessage・候補・位置を含めない', async () => {
    const response = await entry()(post({ query: '{ apiStatu { status } }' }));
    const text = await response.clone().text();
    expect(text).not.toMatch(/Did you mean|apiStatus|locations|Cannot query/);
    await expectInvalidRequest(response, 400);
  });

  describe('development Compositionでも同じ形', () => {
    beforeEach(() => vi.stubEnv('NODE_ENV', 'development'));

    it('違反は同じ固定形', async () => {
      await expectInvalidRequest(
        await entry()(post({ query: '{ __type(name: "S") { name } }' })),
        400,
      );
    });

    it('実行中の例外はoriginalError・stack・原因messageを出さない', async () => {
      const response = await entry()(post({ query: '{ fail { status } }' }));
      const text = await response.text();
      expect(response.status).toBe(200);
      expectHardenedHeaders(response);
      expect(text).not.toMatch(/originalError|stack|leaked-value|password/);
      expect(JSON.parse(text)).toMatchObject({
        data: { fail: null },
        errors: [
          {
            message: PUBLIC_GRAPHQL_ERROR_MESSAGES.SERVICE_UNAVAILABLE,
            extensions: { code: 'SERVICE_UNAVAILABLE' },
          },
        ],
      });
    });

    it('Yogaのloggerへ原因例外を出さない', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (level) => vi.spyOn(console, level).mockImplementation(() => {}),
      );
      await entry()(post({ query: '{ fail { status } }' }));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
  });
});
