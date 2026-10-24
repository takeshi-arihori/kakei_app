import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { createYoga } from 'graphql-yoga';

import { schema } from './presentation/graphql/schema.js';

/** Node接続情報はHeaderではなくAdapterのenvだけから受け取る。 */
interface ApiBindings {
  incoming?: { socket: { remoteAddress?: string } };
}

/** 起動入口だけが具体認証能力を注入する。未指定なら認証経路を封鎖する。 */
export interface CreateAppOptions {
  /**
   * 認証HTTP能力。PeerはNode接続から取得し、Forwarded Headerを使わない。
   * @param request 未検証のBrowser Request。
   * @param peer 接続Peer、不明ならnullで能力側も拒否する。
   * @returns 秘密値を診断へ出さない認証Response。
   */
  readonly authentication?: (
    request: Request,
    peer: string | null,
  ) => Promise<Response>;
}

/**
 * 公開Transportを構成する。認証能力は通常mainで自動生成しない。
 * @param options 検証済みCompositionだけが与える能力。
 * @returns health/GraphQLと封鎖可能な認証経路を持つHono Application。
 */
export const createApp = (options: CreateAppOptions = {}) => {
  const app = new Hono<{ Bindings: ApiBindings }>();
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    maskedErrors: true,
  });

  const authenticationMethods = {
    '/auth/google/attempt': 'POST',
    '/auth/google/login': 'POST',
    '/auth/session': 'GET',
    '/auth/logout': 'POST',
  } as const;
  for (const [path, method] of Object.entries(authenticationMethods)) {
    app.all(path, async (context) => {
      context.header('Cache-Control', 'no-store');
      context.header('X-Content-Type-Options', 'nosniff');
      if (context.req.method !== method) {
        context.header('Allow', method);
        return context.json(
          { error: { code: 'INVALID_REQUEST', requestId: randomUUID() } },
          405,
        );
      }
      try {
        if (options.authentication)
          return await options.authentication(
            context.req.raw,
            context.env?.incoming?.socket.remoteAddress ?? null,
          );
      } catch {
        // 注入能力の例外もCause/Request/SDK診断として出力しない。
      }
      return context.json(
        {
          error: {
            code: 'AUTHENTICATION_UNAVAILABLE',
            requestId: randomUUID(),
          },
        },
        503,
      );
    });
  }

  app.get('/health', (context) => context.json({ status: 'ok' }));
  app.on(['GET', 'POST', 'OPTIONS'], '/graphql', (context) =>
    yoga.fetch(context.req.raw),
  );

  return app;
};

/** Compositionで固定した公開Hono Applicationの型。 */
export type ApiApp = ReturnType<typeof createApp>;
