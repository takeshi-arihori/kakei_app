import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import type { GroupManagementGraphQLUseCases } from './group-management/presentation/graphql/group-management-resolvers.js';
import {
  PUBLIC_ROOT_FIELDS,
  createGraphQLEntry,
} from './presentation/graphql/graphql-entry.js';
import type { GraphQLAuthenticationCapability } from './presentation/graphql/graphql-request-identity.js';
import { createGraphQLSchema } from './presentation/graphql/schema.js';

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
  /**
   * 業務GraphQLの本人性能力。未指定なら認証付きOperationをSERVICE_UNAVAILABLEで封鎖し、
   * 照合先がないためOrigin付きRequestを拒否する。
   */
  readonly graphql?: GraphQLAuthenticationCapability;
  /**
   * GraphQLで公開するGroup ManagementのUse Case。未指定なら`createGroup`・`myGroups`を
   * 認証leaseを開かずに`SERVICE_UNAVAILABLE`で封鎖する。
   */
  readonly groupManagement?: GroupManagementGraphQLUseCases;
}

/**
 * 公開Transportを構成する。認証能力は通常mainで自動生成しない。
 * @param options 検証済みCompositionだけが与える能力。
 * @returns health/GraphQLと封鎖可能な認証経路を持つHono Application。
 */
export const createApp = (options: CreateAppOptions = {}) => {
  const app = new Hono<{ Bindings: ApiBindings }>();
  // POST＋JSONの単一Operationだけを上限内で実行し、違反は実行前に拒否する（#293）。
  // 本人性・Origin・CSRF・公開Errorも同じ入口で扱う（#304）。
  const graphql = createGraphQLEntry({
    schema: createGraphQLSchema({ groupManagement: options.groupManagement }),
    publicRootFields: PUBLIC_ROOT_FIELDS,
    capability: options.graphql,
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
  app.all('/graphql', (context) => graphql(context.req.raw));

  return app;
};

/** Compositionで固定した公開Hono Applicationの型。 */
export type ApiApp = ReturnType<typeof createApp>;
