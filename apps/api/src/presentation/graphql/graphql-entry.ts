import { randomUUID } from 'node:crypto';

import type { ExecutionResult, GraphQLSchema } from 'graphql';
import { createGraphQLError, createYoga, type Plugin } from 'graphql-yoga';

import {
  createAuthenticatedOperation,
  isCanonicalCsrfToken,
  type GraphQLContext,
} from './authenticated-operation.js';
import {
  checkGraphQLDocument,
  type GraphQLDocumentPolicy,
} from './graphql-document-limits.js';
import {
  GraphQLEntryRejection,
  readGraphQLRequestBody,
} from './graphql-request-body.js';
import {
  GraphQLRequestRejection,
  checkGraphQLRequestHeaders,
  selectGraphQLSessionCookie,
  verifyGraphQLCapability,
  type GraphQLAuthenticationCapability,
} from './graphql-request-identity.js';
import {
  PUBLIC_GRAPHQL_ERROR_CODES,
  PUBLIC_GRAPHQL_ERROR_MESSAGES,
  maskPublicGraphQLError,
  publicGraphQLErrorResponse,
  type PublicGraphQLErrorCode,
} from './public-graphql-error.js';

export type { PublicGraphQLErrorBody } from './public-graphql-error.js';

/** `INVALID_REQUEST`の固定message。入力値・原因・Rule名を含めない。 */
export const INVALID_REQUEST_MESSAGE =
  PUBLIC_GRAPHQL_ERROR_MESSAGES.INVALID_REQUEST;

/**
 * 未認証で公開するroot field。ここにないroot fieldは認証付きとして数える。
 * 業務fieldを未認証で公開するときだけ、ADRに従って追加する。
 */
export const PUBLIC_ROOT_FIELDS: ReadonlySet<string> = new Set([
  'Query.apiStatus',
]);

const harden = (response: Response): Response => {
  const headers = new Headers(response.headers);
  // GraphQLはCookieを発行・削除しない。
  headers.delete('Set-Cookie');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const boundary = Symbol('graphql-request-boundary');
/** Resolverへ型として公開しない、Request単位の境界状態。 */
interface ServerContext extends GraphQLContext {
  readonly [boundary]: { readonly requestId: string };
}

const allowedCodes: ReadonlySet<unknown> = new Set(PUBLIC_GRAPHQL_ERROR_CODES);
/** mask済みErrorへServer requestIdを付け、許可外codeを残さない。 */
const publicResult: Plugin<ServerContext> = {
  onResultProcess(payload) {
    const { result, serverContext } = payload;
    if (Array.isArray(result) || !('errors' in result) || !result.errors)
      return;
    const requestId = (serverContext as unknown as ServerContext)[boundary]
      .requestId;
    const errors = result.errors.map((error) => {
      const extensions = error.extensions ?? {};
      // mask前に終わるYoga側の解析・検証Errorは、入口の拒否として扱う。
      const known = allowedCodes.has(extensions.code);
      const code: PublicGraphQLErrorCode = known
        ? (extensions.code as PublicGraphQLErrorCode)
        : 'INVALID_REQUEST';
      return createGraphQLError(PUBLIC_GRAPHQL_ERROR_MESSAGES[code], {
        extensions: {
          code,
          requestId,
          ...(known
            ? extensions.http === undefined
              ? {}
              : { http: extensions.http }
            : { http: { status: 400 } }),
        },
      });
    });
    payload.setResult({ ...(result as ExecutionResult), errors });
  },
};

/** `/graphql`入口の構成。 */
export interface GraphQLEntryOptions extends GraphQLDocumentPolicy {
  /** 実行するSchema。Resolverは`GraphQLContext`だけを参照する。 */
  readonly schema: GraphQLSchema;
  /** 業務GraphQLの本人性能力。未指定なら認証付きfieldを封鎖する。 */
  readonly capability?: GraphQLAuthenticationCapability;
}

/**
 * `/graphql`の入口を組み立てる。POST＋JSONの単一Operationを上限内でだけ実行し、
 * 違反はResolver（以後の認証leaseを含む）を呼ぶ前に固定形で拒否する。
 * 本人性・Origin・CSRF・公開Errorもここで扱い、Resolverへは`AuthenticatedOperation`だけを渡す。
 * 全Compositionで同じ挙動にし、`NODE_ENV`で応答を変えない。
 * @param options Schema、認証付きfieldの判定方針、注入された本人性能力。
 * @returns 未検証RequestからResponseを返す関数。
 * @throws 能力のOrigin/Profileが矛盾する構成は起動時に拒否する。
 */
export const createGraphQLEntry = (
  options: GraphQLEntryOptions,
): ((request: Request) => Promise<Response>) => {
  const { capability } = options;
  const sessionCookie = capability ? verifyGraphQLCapability(capability) : null;
  const yoga = createYoga<ServerContext>({
    schema: options.schema,
    graphqlEndpoint: '/graphql',
    // WebとAPIは同一Originへ集約するため、他OriginへCORS Headerを返さない。
    cors: false,
    graphiql: false,
    landingPage: false,
    multipart: false,
    batching: false,
    // 原因例外・Request内容をLogへ丸ごと出さない。
    logging: false,
    maskedErrors: { maskError: maskPublicGraphQLError },
    plugins: [publicResult],
  });
  const policy: GraphQLDocumentPolicy = {
    publicRootFields: options.publicRootFields,
  };

  return async (request) => {
    let requestId: string = randomUUID();
    try {
      if (capability) requestId = capability.security.createRequestId();
      if (request.method !== 'POST') throw new GraphQLEntryRejection(405);
      const originVerified = checkGraphQLRequestHeaders(
        request,
        capability?.origin ?? null,
      );
      const sessionSecret =
        sessionCookie === null
          ? undefined
          : selectGraphQLSessionCookie(
              request.headers.get('cookie'),
              sessionCookie,
            );
      const body = await readGraphQLRequestBody(request);
      const { operation } = checkGraphQLDocument(options.schema, body, policy);
      const csrfToken = request.headers.get('x-csrf-token');
      // 変更系は一致Originとcanonical形式のCSRFを、認証leaseより前に要求する。
      if (
        operation === 'mutation' &&
        !(originVerified && isCanonicalCsrfToken(csrfToken))
      )
        throw new GraphQLRequestRejection('REQUEST_REJECTED', 403);
      // ResolverはYoga Contextの`request`を読めるので、Cookie・CSRF・Origin等の元Headerを
      // 引き継がず、実行に要るものだけで組み立てる。SSE／incremental deliveryも選ばせない。
      const headers = new Headers({
        'Content-Type': 'application/json',
        Accept: 'application/json',
      });
      const context: ServerContext = {
        authenticated: createAuthenticatedOperation({
          service: capability?.service,
          security: capability?.security,
          sessionSecret,
          csrfToken,
        }),
        [boundary]: { requestId },
      };
      return harden(
        await yoga.fetch(
          new Request(request.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
          context,
        ),
      );
    } catch (error) {
      if (error instanceof GraphQLEntryRejection)
        return publicGraphQLErrorResponse(
          'INVALID_REQUEST',
          error.status,
          requestId,
        );
      if (error instanceof GraphQLRequestRejection)
        return publicGraphQLErrorResponse(error.code, error.status, requestId);
      return publicGraphQLErrorResponse('SERVICE_UNAVAILABLE', 503, requestId);
    }
  };
};
