import type { GraphQLError } from 'graphql';
import { createGraphQLError } from 'graphql-yoga';

/** 業務GraphQLが公開する唯一のcode一覧。追加はADRの変更として扱う。 */
export const PUBLIC_GRAPHQL_ERROR_CODES = [
  'INVALID_REQUEST',
  'REQUEST_REJECTED',
  'AUTHENTICATION_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'OPERATION_MISMATCH',
  'INVALID_INPUT',
  'SERVICE_UNAVAILABLE',
] as const;

/** 許可Listに含まれる公開Error code。 */
export type PublicGraphQLErrorCode =
  (typeof PUBLIC_GRAPHQL_ERROR_CODES)[number];

/** 入力値・ID・原因を含めない、codeごとの固定文。 */
export const PUBLIC_GRAPHQL_ERROR_MESSAGES: Readonly<
  Record<PublicGraphQLErrorCode, string>
> = Object.freeze({
  INVALID_REQUEST: 'Requestを処理できません。',
  REQUEST_REJECTED: 'Requestを受け付けられません。',
  AUTHENTICATION_REQUIRED: 'ログインが必要です。',
  NOT_FOUND: '対象が見つかりません。',
  CONFLICT: '対象がほかの操作で変更されました。',
  OPERATION_MISMATCH: '同じ操作IDで異なる内容が送られました。',
  INVALID_INPUT: '入力内容を確認してください。',
  SERVICE_UNAVAILABLE: '現在処理できません。',
});
const messages = PUBLIC_GRAPHQL_ERROR_MESSAGES;

/** 公開Errorの応答形。`locations`・`path`・入力値を持たない。 */
export interface PublicGraphQLErrorBody {
  /** 公開Error。実行前の拒否では1件だけで、`data`を伴わない。 */
  readonly errors: readonly {
    /** codeごとの固定文。 */
    readonly message: string;
    /** Clientが判断に使う最小の情報。 */
    readonly extensions: {
      /** 許可Listのcode。 */
      readonly code: PublicGraphQLErrorCode;
      /** Serverが発行するUUIDv4。Client値を使わない。 */
      readonly requestId: string;
    };
  }[];
}

/**
 * Context PresentationとGraphQL境界が意図して公開するError。
 * 原因例外・入力値を保持しない。
 */
export class PublicGraphQLError extends Error {
  /** 許可Listのcode。 */
  readonly code: PublicGraphQLErrorCode;

  /**
   * @param code 許可Listのcode。
   * @throws 許可List外のcode。
   */
  constructor(code: PublicGraphQLErrorCode) {
    if (!Object.hasOwn(messages, code))
      throw new Error('公開Error codeが許可Listにありません');
    super(messages[code]);
    this.name = 'PublicGraphQLError';
    this.code = code;
  }
}

/** Yoga自身がHTTP層で拒否した（解析・Method等）4xxだけをINVALID_REQUESTとして残す。 */
const protocolRejection = (
  error: unknown,
): { status: number; allow: string | undefined } | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const { extensions, originalError } = error as {
    extensions?: { http?: { status?: unknown; headers?: unknown } };
    originalError?: unknown;
  };
  const status = extensions?.http?.status;
  if (
    originalError !== undefined ||
    typeof status !== 'number' ||
    ![400, 405, 413, 415].includes(status)
  )
    return undefined;
  const headers = extensions?.http?.headers;
  const allow =
    typeof headers === 'object' && headers !== null && 'Allow' in headers
      ? headers.Allow
      : undefined;
  return { status, allow: typeof allow === 'string' ? allow : undefined };
};

/**
 * Yogaのmask関数。公開ErrorとYogaのHTTP層4xxだけをcodeと固定文で通し、それ以外を
 * SERVICE_UNAVAILABLEへ写像する。NODE_ENVに関係なく原因を残さない。
 * @param error Resolver・Plugin・Yogaから届いた未検証のError。
 * @returns locations・path・originalErrorを持たない公開GraphQLError。
 */
export const maskPublicGraphQLError = (error: unknown): GraphQLError => {
  // YogaとこのModuleのgraphql実体が異なりうるので、GraphQLErrorはinstanceofで判定しない。
  const candidate: unknown =
    error instanceof PublicGraphQLError
      ? error
      : typeof error === 'object' && error !== null && 'originalError' in error
        ? error.originalError
        : undefined;
  const protocol =
    candidate instanceof PublicGraphQLError
      ? undefined
      : protocolRejection(error);
  if (protocol)
    return createGraphQLError(messages.INVALID_REQUEST, {
      extensions: {
        code: 'INVALID_REQUEST',
        http: {
          status: protocol.status,
          ...(protocol.allow === undefined
            ? {}
            : { headers: { Allow: protocol.allow } }),
        },
      },
    });
  const publicError =
    candidate instanceof PublicGraphQLError
      ? candidate
      : new PublicGraphQLError('SERVICE_UNAVAILABLE');
  return createGraphQLError(publicError.message, {
    extensions: { code: publicError.code },
  });
};

/**
 * Yogaへ渡す前に拒否したRequestの応答。dataを含めない。
 * @param code 許可Listのcode。
 * @param status 拒否のHTTP status。
 * @param requestId Server発行の相関ID。
 * @returns no-store・nosniffを付けたGraphQL形式のResponse。405には`Allow: POST`を付ける。
 */
export const publicGraphQLErrorResponse = (
  code: PublicGraphQLErrorCode,
  status: number,
  requestId: string,
): Response => {
  const body: PublicGraphQLErrorBody = {
    errors: [{ message: messages[code], extensions: { code, requestId } }],
  };
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/json',
  });
  if (status === 405) headers.set('Allow', 'POST');
  return new Response(JSON.stringify(body), { status, headers });
};
