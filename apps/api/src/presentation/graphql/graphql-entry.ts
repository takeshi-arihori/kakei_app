import { randomUUID } from 'node:crypto';

import type { GraphQLSchema } from 'graphql';
import { createYoga, maskError } from 'graphql-yoga';

import {
  checkGraphQLDocument,
  type GraphQLDocumentPolicy,
} from './graphql-document-limits.js';
import {
  GraphQLEntryRejection,
  readGraphQLRequestBody,
} from './graphql-request-body.js';

/** `INVALID_REQUEST`の固定message。入力値・原因・Rule名を含めない。 */
export const INVALID_REQUEST_MESSAGE = 'Requestを処理できません。';

/** 実行前拒否の公開形。`data`・`locations`・`path`を持たない。 */
export interface PublicGraphQLErrorBody {
  /** 固定の拒否1件だけ。検証Errorを列挙しない。 */
  readonly errors: readonly [
    {
      /** 固定文。入力値・原因・Rule名を含めない。 */
      readonly message: string;
      /** Clientが判断に使う最小の情報。 */
      readonly extensions: {
        /** 実行前拒否は常に`INVALID_REQUEST`。 */
        readonly code: 'INVALID_REQUEST';
        /** Serverが発行するUUIDv4。Client値を使わない。 */
        readonly requestId: string;
      };
    },
  ];
}

/**
 * 未認証で公開するroot field。ここにないroot fieldは認証付きとして数える。
 * 業務fieldを未認証で公開するときだけ、ADRに従って追加する。
 */
export const PUBLIC_ROOT_FIELDS: ReadonlySet<string> = new Set([
  'Query.apiStatus',
]);

const harden = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * 実行前拒否の固定Responseを作る。
 * @param status 拒否の固定HTTP status。
 * @returns no-store／nosniff付きの`INVALID_REQUEST`。405には`Allow: POST`を付ける。
 */
export const invalidRequestResponse = (
  status: GraphQLEntryRejection['status'],
): Response => {
  const body: PublicGraphQLErrorBody = {
    errors: [
      {
        message: INVALID_REQUEST_MESSAGE,
        extensions: { code: 'INVALID_REQUEST', requestId: randomUUID() },
      },
    ],
  };
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (status === 405) headers.set('Allow', 'POST');
  return harden(new Response(JSON.stringify(body), { status, headers }));
};

/** `/graphql`入口の構成。 */
export interface GraphQLEntryOptions extends GraphQLDocumentPolicy {
  /** 実行するSchema。 */
  readonly schema: GraphQLSchema;
}

/**
 * `/graphql`の入口を組み立てる。POST＋JSONの単一Operationを上限内でだけ実行し、
 * 違反はResolver（以後の認証leaseを含む）を呼ぶ前に固定形で拒否する。
 * 全Compositionで同じ挙動にし、`NODE_ENV`で応答を変えない。
 * @param options Schemaと認証付きfieldの判定方針。
 * @returns 未検証RequestからResponseを返す関数。
 */
export const createGraphQLEntry = (
  options: GraphQLEntryOptions,
): ((request: Request) => Promise<Response>) => {
  const yoga = createYoga({
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
    maskedErrors: {
      isDev: false,
      maskError: (error, message) => maskError(error, message, false),
    },
  });
  const policy: GraphQLDocumentPolicy = {
    publicRootFields: options.publicRootFields,
  };

  return async (request) => {
    try {
      if (request.method !== 'POST') throw new GraphQLEntryRejection(405);
      const body = await readGraphQLRequestBody(request);
      checkGraphQLDocument(options.schema, body, policy);
      const headers = new Headers(request.headers);
      for (const name of [
        'content-length',
        'content-encoding',
        'transfer-encoding',
      ])
        headers.delete(name);
      headers.set('Content-Type', 'application/json');
      // SSE／incremental deliveryを選ばせず、応答をJSONだけにする。
      headers.set('Accept', 'application/json');
      return harden(
        await yoga.fetch(
          new Request(request.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
        ),
      );
    } catch (error) {
      if (error instanceof GraphQLEntryRejection)
        return invalidRequestResponse(error.status);
      throw error;
    }
  };
};
