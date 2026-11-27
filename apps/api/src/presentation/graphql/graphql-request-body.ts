/** 認証HTTP（H-PRE-3）と同値のBody上限。Content-Lengthの申告を信頼せずstreamで数える。 */
export const GRAPHQL_BODY_LIMIT_BYTES = 18_432;
/** 認証HTTP（H-PRE-3）と同値のBody読取期限。 */
export const GRAPHQL_BODY_READ_TIMEOUT_MS = 5000;

/** `/graphql`の実行前拒否。入力値、原因例外、Rule名を保持しない。 */
export class GraphQLEntryRejection extends Error {
  /** 公開する固定HTTP status。 */
  readonly status: 400 | 405 | 413 | 415;
  /**
   * @param status 実行前拒否の固定status。
   */
  constructor(status: 400 | 405 | 413 | 415) {
    super('GraphQL Requestを拒否しました');
    this.status = status;
  }
}

const reject = (status: 400 | 405 | 413 | 415): never => {
  throw new GraphQLEntryRejection(status);
};

/** 入口の形検査を通過したGraphQL over HTTPのBody。 */
export interface GraphQLRequestBody {
  /** 未parseのGraphQL文書。 */
  readonly query: string;
  /** 実行するOperation名。nullと不在は同じ扱い。 */
  readonly operationName?: string;
  /** 未coerceの変数Object。nullと不在は同じ扱い。 */
  readonly variables?: Readonly<Record<string, unknown>>;
}

const allowedKeys = new Set(['query', 'operationName', 'variables']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readBoundedBytes = async (request: Request): Promise<Uint8Array> => {
  const length = request.headers.get('content-length');
  if (length !== null && !/^(0|[1-9][0-9]*)$/.test(length)) reject(400);
  if (length !== null && Number(length) > GRAPHQL_BODY_LIMIT_BYTES) reject(413);
  if (request.body === null) return reject(400);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, rejectTimeout) => {
    timer = setTimeout(() => {
      rejectTimeout(new GraphQLEntryRejection(400));
      void reader.cancel().catch(() => {});
    }, GRAPHQL_BODY_READ_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > GRAPHQL_BODY_LIMIT_BYTES) reject(413);
      parts.push(part.value);
    }
    if (length !== null && Number(length) !== bytes) reject(400);
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }
    return data;
  } catch (error) {
    if (error instanceof GraphQLEntryRejection) throw error;
    return reject(400);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
};

/**
 * POST BodyをJSONの単一Operationとして読み取る。batch・拡張・未知Keyは受け付けない。
 * 上限・期限・Content-Encodingは認証HTTP（H-PRE-3）と同じ値にする。
 * @param request Methodを検査済みのPOST Request。
 * @returns 型を検査した未parseのBody。
 * @throws Content-Type／Encoding違反415、超過413、期限・不一致・UTF-8・JSON・形の違反400。
 */
export const readGraphQLRequestBody = async (
  request: Request,
): Promise<GraphQLRequestBody> => {
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
      request.headers.get('content-type') ?? '',
    ) ||
    (request.headers.has('content-encoding') &&
      request.headers.get('content-encoding') !== 'identity')
  )
    reject(415);
  const bytes = await readBoundedBytes(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    return reject(400);
  }
  if (!isPlainObject(parsed)) return reject(400);
  for (const key of Object.keys(parsed)) if (!allowedKeys.has(key)) reject(400);
  const { query, operationName, variables } = parsed;
  if (typeof query !== 'string') return reject(400);
  if (
    operationName !== undefined &&
    operationName !== null &&
    typeof operationName !== 'string'
  )
    reject(400);
  if (
    variables !== undefined &&
    variables !== null &&
    !isPlainObject(variables)
  )
    reject(400);
  return {
    query,
    ...(typeof operationName === 'string' ? { operationName } : {}),
    ...(isPlainObject(variables) ? { variables } : {}),
  };
};
