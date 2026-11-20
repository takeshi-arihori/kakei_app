import { createSchema } from 'graphql-yoga';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedActor } from '../../shared/application/authentication/authentication-ports.js';
import { createAuthenticationTransactionScopes } from '../../shared/infrastructure/authentication/postgres/authentication-transaction-scopes.js';
import type {
  GraphQLAuthenticationService,
  GraphQLContext,
} from './authenticated-operation.js';
import { createGraphQLEntry } from './graphql-entry.js';
import { PublicGraphQLError } from './public-graphql-error.js';

const origin = 'http://localhost:3000';
const cookieName = 'kakei_dev_auth_session';
const requestId = '6f1c2f8e-3b1a-4c5d-9e7f-0a1b2c3d4e5f';
const secret = (n: number) => Buffer.alloc(32, n).toString('base64url');
const actor: AuthenticatedActor = {
  actorSubject: '00000000-0000-4000-8000-000000000317',
  absoluteExpiresAt: 604_801_000,
  csrf: secret(5),
};
const publicRootFields: ReadonlySet<string> = new Set(['Query.open']);
const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const message = (code: ConstructorParameters<typeof PublicGraphQLError>[0]) =>
  new PublicGraphQLError(code).message;

/** 業務fieldが未公開でも境界を検証できるTest専用Schema。 */
const business = vi.fn<(actorSubject: string) => Promise<string>>();
const schema = createSchema<GraphQLContext>({
  typeDefs: /* GraphQL */ `
    type Query {
      open: String!
      me: String!
    }
    type Mutation {
      create: String!
    }
  `,
  resolvers: {
    Query: {
      open: () => 'ok',
      me: (_parent, _args, context, info) =>
        context.authenticated.run(info, (current) =>
          business(current.actorSubject),
        ),
    },
    Mutation: {
      create: (_parent, _args, context, info) =>
        context.authenticated.run(info, (current) =>
          business(current.actorSubject),
        ),
    },
  },
});

const setup = (
  options: { capability?: boolean; profile?: 'production' } = {},
) => {
  const withAuthenticatedActor =
    vi.fn<(sessionSecret: unknown, usage: string) => void>();
  const lease: GraphQLAuthenticationService['withAuthenticatedActor'] = async (
    sessionSecret,
    usage,
    callback,
  ) => {
    withAuthenticatedActor(sessionSecret, usage);
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
      const value = await callback(actor, lease.scope);
      lease.seal();
      lease.assertResult(value);
      lease.assertCommittable();
      return { status: 'authenticated', value };
    } catch {
      return { status: 'unavailable' };
    } finally {
      lease.close();
    }
  };
  const handler = createGraphQLEntry({
    schema,
    publicRootFields,
    capability:
      options.capability === false
        ? undefined
        : {
            origin:
              options.profile === 'production'
                ? 'https://kakei.example'
                : origin,
            profile: options.profile ?? 'local-development',
            service: { withAuthenticatedActor: lease },
            security: {
              createRequestId: () => requestId,
              equalSecrets: (left, right) => left === right,
            },
          },
  });
  return { handler, withAuthenticatedActor };
};
const post = (query: string, headers: Record<string, string> = {}): Request =>
  new Request('http://127.0.0.1:3001/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kakei-request': '1',
      ...headers,
    },
    body: JSON.stringify({ query }),
  });
const session = { cookie: `${cookieName}=${secret(9)}` };
const mutationHeaders = { ...session, origin, 'x-csrf-token': secret(5) };
const expectPublic = async (
  response: Response,
  status: number,
  code: ConstructorParameters<typeof PublicGraphQLError>[0],
  data?: unknown,
) => {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.has('set-cookie')).toBe(false);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toEqual({
    errors: [
      {
        message: message(code),
        extensions: {
          code,
          requestId: expect.stringMatching(uuidV4) as unknown,
        },
      },
    ],
    ...(data === undefined ? {} : { data }),
  });
};

afterEach(() => {
  business.mockReset();
  vi.unstubAllEnvs();
});

describe('業務GraphQL境界: Request前提', () => {
  it.each([
    ['欠落', {}],
    ['値の不一致', { 'x-kakei-request': '0' }],
  ])('X-Kakei-Requestの%sは実行前に403', async (_label, headers) => {
    const { handler } = setup();
    const request = post('{ open }');
    request.headers.delete('x-kakei-request');
    for (const [name, value] of Object.entries(headers))
      request.headers.set(name, value);

    await expectPublic(await handler(request), 403, 'REQUEST_REJECTED');
  });

  it.each(['cross-site', 'same-site', 'none'])(
    'Sec-Fetch-Site: %sは403',
    async (site) => {
      const { handler } = setup();
      await expectPublic(
        await handler(post('{ open }', { 'sec-fetch-site': site })),
        403,
        'REQUEST_REJECTED',
      );
    },
  );

  it.each([
    'null',
    'https://evil.example',
    'http://localhost:3001',
    'https://localhost:3000',
    'http://localhost:3000/',
    `${origin}, ${origin}`,
  ])('Originが設定と完全一致しない(%s)Queryは403', async (value) => {
    const { handler, withAuthenticatedActor } = setup();
    await expectPublic(
      await handler(post('{ me }', { ...session, origin: value })),
      403,
      'REQUEST_REJECTED',
    );
    expect(withAuthenticatedActor).not.toHaveBeenCalled();
  });

  it('Origin欠落のQuery（Server Component経路）は認証付きfieldを実行できる', async () => {
    const { handler, withAuthenticatedActor } = setup();
    business.mockResolvedValue('mine');

    const response = await handler(
      post('{ me }', { ...session, 'sec-fetch-site': 'same-origin' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.json()).resolves.toEqual({ data: { me: 'mine' } });
    expect(business).toHaveBeenCalledWith(actor.actorSubject);
    expect(withAuthenticatedActor).toHaveBeenCalledWith(secret(9), 'activity');
  });

  it('一致Originの未認証QueryはCookieなしで成功する', async () => {
    const { handler, withAuthenticatedActor } = setup();
    const response = await handler(post('{ open }', { origin }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { open: 'ok' } });
    expect(withAuthenticatedActor).not.toHaveBeenCalled();
  });
});

describe('業務GraphQL境界: Mutation', () => {
  it('一致OriginとSession束縛CSRFで業務を実行する', async () => {
    const { handler } = setup();
    business.mockResolvedValue('created');

    const response = await handler(
      post('mutation Create { create }', mutationHeaders),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { create: 'created' },
    });
  });

  it.each([
    ['Origin欠落', { ...session, 'x-csrf-token': secret(5) }],
    ['CSRF欠落', { ...session, origin }],
    ['CSRF形式不正', { ...session, origin, 'x-csrf-token': 'abc' }],
  ])('%sは実行前に403でStoreを呼ばない', async (_label, headers) => {
    const { handler, withAuthenticatedActor } = setup();

    await expectPublic(
      await handler(post('mutation { create }', headers)),
      403,
      'REQUEST_REJECTED',
    );
    expect(withAuthenticatedActor).not.toHaveBeenCalled();
    expect(business).not.toHaveBeenCalled();
  });

  it('operationNameで選んだMutationにも同じ前提を課す', async () => {
    const { handler } = setup();
    const request = new Request('http://127.0.0.1:3001/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kakei-request': '1',
        ...session,
      },
      body: JSON.stringify({
        query: 'query Read { open } mutation Write { create }',
        operationName: 'Write',
      }),
    });

    await expectPublic(await handler(request), 403, 'REQUEST_REJECTED');
    expect(business).not.toHaveBeenCalled();
  });

  it('lease内のCSRF不一致は業務を実行せず200＋REQUEST_REJECTED', async () => {
    const { handler } = setup();

    await expectPublic(
      await handler(
        post('mutation { create }', {
          ...mutationHeaders,
          'x-csrf-token': secret(6),
        }),
      ),
      200,
      'REQUEST_REJECTED',
      null,
    );
    expect(business).not.toHaveBeenCalled();
  });
});

describe('業務GraphQL境界: Session Cookie', () => {
  it('固定名のSession Cookieだけを選び、他のCookieを本人性に使わない', async () => {
    const { handler, withAuthenticatedActor } = setup();
    business.mockResolvedValue('mine');

    await handler(
      post('{ me }', {
        cookie: `other=${secret(1)}; ${cookieName}=${secret(9)}; kakei_dev_auth_attempt=${secret(2)}`,
      }),
    );

    expect(withAuthenticatedActor).toHaveBeenCalledWith(secret(9), 'activity');
  });

  it('productionではHost限定の名前だけを選ぶ', async () => {
    const { handler, withAuthenticatedActor } = setup({
      profile: 'production',
    });
    business.mockResolvedValue('mine');

    await handler(
      post('{ me }', {
        cookie: `${cookieName}=${secret(1)}; __Host-kakei-auth-session=${secret(9)}`,
      }),
    );

    expect(withAuthenticatedActor).toHaveBeenCalledWith(secret(9), 'activity');
  });

  it.each([
    `${cookieName}=${secret(9)}; ${cookieName}=${secret(8)}`,
    `${cookieName}=a b`,
    'novalue',
    `${cookieName}=${secret(9)}\u0001`,
  ])('選択Cookieの重複・構文不正(%#)は400', async (cookie) => {
    const { handler, withAuthenticatedActor } = setup();

    await expectPublic(
      await handler(post('{ me }', { cookie })),
      400,
      'INVALID_REQUEST',
    );
    expect(withAuthenticatedActor).not.toHaveBeenCalled();
  });

  it('Cookieなしは本人性なしとしてAUTHENTICATION_REQUIRED', async () => {
    const withAuthenticatedActor =
      vi.fn<(sessionSecret: unknown, usage: string) => void>();
    const unauthenticated: GraphQLAuthenticationService['withAuthenticatedActor'] =
      (sessionSecret, usage) => {
        withAuthenticatedActor(sessionSecret, usage);
        return Promise.resolve({ status: 'unauthenticated' });
      };
    const endpoint = createGraphQLEntry({
      schema,
      publicRootFields,
      capability: {
        origin,
        profile: 'local-development',
        service: { withAuthenticatedActor: unauthenticated },
        security: {
          createRequestId: () => requestId,
          equalSecrets: () => true,
        },
      },
    });

    await expectPublic(
      await endpoint(post('{ me }')),
      200,
      'AUTHENTICATION_REQUIRED',
      null,
    );
    expect(withAuthenticatedActor).toHaveBeenCalledWith(undefined, 'activity');
  });
});

describe('業務GraphQL境界: 公開Errorとmask', () => {
  it('業務の公開Errorはcode・固定文・requestIdだけを返す', async () => {
    const { handler } = setup();
    business.mockRejectedValue(new PublicGraphQLError('NOT_FOUND'));

    await expectPublic(
      await handler(post('{ me }', session)),
      200,
      'NOT_FOUND',
      null,
    );
  });

  it('予期しない例外はdevelopmentでもSERVICE_UNAVAILABLEへmaskし原因を返さない', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { handler } = setup();
    business.mockRejectedValue(new Error('SELECT secret'));

    const response = await handler(post('{ me }', session));
    const text = await response.clone().text();

    expect(text).not.toMatch(/secret|stack|originalError|locations|path/);
    await expectPublic(response, 200, 'SERVICE_UNAVAILABLE', null);
  });
});

describe('業務GraphQL境界: 入口の拒否', () => {
  it('Server発行のrequestIdを能力のsecurityから使う', async () => {
    const { handler } = setup();
    const response = await handler(
      post('{ open }', { 'x-kakei-request': '0' }),
    );
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ extensions: { requestId } }],
    });
  });

  it.each([
    ['構文Error', '{'],
    ['未定義fieldの検証Error', '{ opn }'],
  ])(
    '%sは400＋INVALID_REQUESTの固定形で、field名や候補を返さない',
    async (_label, query) => {
      const { handler } = setup();
      const response = await handler(post(query, session));
      const text = await response.clone().text();

      expect(text).not.toMatch(/opn|open|Did you mean|Syntax|locations/);
      await expectPublic(response, 400, 'INVALID_REQUEST');
    },
  );

  it('解析できないBodyは400＋INVALID_REQUESTの固定形で、原因を返さない', async () => {
    const { handler } = setup();
    const response = await handler(
      new Request('http://127.0.0.1:3001/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kakei-request': '1' },
        body: '{"query":',
      }),
    );

    await expectPublic(response, 400, 'INVALID_REQUEST');
  });

  it('CORS preflightは405でAllowだけを返しCORS Headerを返さない', async () => {
    const { handler } = setup();
    const response = await handler(
      new Request('http://127.0.0.1:3001/graphql', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
        },
      }),
    );

    expect(response.headers.get('allow')).toBe('POST');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    await expectPublic(response, 405, 'INVALID_REQUEST');
  });
});

describe('業務GraphQL境界: 能力未注入（通常main）', () => {
  it('Origin付きRequestは照合先がないので403', async () => {
    const { handler } = setup({ capability: false });
    await expectPublic(
      await handler(post('{ open }', { origin })),
      403,
      'REQUEST_REJECTED',
    );
  });

  it('未認証Queryは成功し、認証付きfieldはSERVICE_UNAVAILABLE', async () => {
    const { handler } = setup({ capability: false });

    const open = await handler(post('{ open }'));
    expect(open.status).toBe(200);
    await expect(open.json()).resolves.toEqual({ data: { open: 'ok' } });
    await expectPublic(
      await handler(post('{ me }', session)),
      200,
      'SERVICE_UNAVAILABLE',
      null,
    );
    expect(business).not.toHaveBeenCalled();
  });
});

describe('業務GraphQL境界: 能力の構成検査', () => {
  it.each([
    [
      'local-developmentのOrigin違い',
      'http://localhost:3001',
      'local-development',
    ],
    ['productionのhttp', 'http://kakei.example', 'production'],
    ['canonicalでないOrigin', 'https://kakei.example/', 'production'],
  ] as const)('%sは起動時に拒否する', (_label, value, profile) => {
    expect(() =>
      createGraphQLEntry({
        schema,
        publicRootFields,
        capability: {
          origin: value,
          profile,
          service: {
            withAuthenticatedActor: () =>
              Promise.resolve({ status: 'unavailable' }),
          },
          security: {
            createRequestId: () => requestId,
            equalSecrets: () => false,
          },
        },
      }),
    ).toThrow();
  });
});
