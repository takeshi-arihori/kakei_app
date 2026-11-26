import { randomUUID } from 'node:crypto';

// API（public-graphql-error.ts）と同じcode・固定文。入力値・原因・転送先を含めない。
const failures = {
  INVALID_REQUEST: { status: 405, message: 'Requestを処理できません。' },
  SERVICE_UNAVAILABLE: { status: 503, message: '現在処理できません。' },
} as const;
const hopByHop = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate'];

const failure = (code: keyof typeof failures) =>
  Response.json(
    { errors: [{ message: failures[code].message, extensions: { code, requestId: randomUUID() } }] },
    {
      status: failures[code].status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(code === 'INVALID_REQUEST' ? { Allow: 'POST' } : {}),
      },
    },
  );

const proxy = async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return failure('INVALID_REQUEST');
  if (process.env.NODE_ENV !== 'development') return failure('SERVICE_UNAVAILABLE');
  try {
    const headers = new Headers(request.headers);
    for (const name of hopByHop) headers.delete(name);
    // Origin・X-Kakei-Request・X-CSRF-Token・Cookieは補わず改変せず、APIの照合に任せる。
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers,
      body: request.body,
      duplex: 'half',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    };
    const upstream = await fetch('http://127.0.0.1:3001/graphql', init);
    // GraphQLはCookieを発行・削除しない（#304 §5）。Set-Cookieを含め、許可外Headerは返さない。
    const responseHeaders = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const contentType = upstream.headers.get('content-type');
    if (contentType !== null) responseHeaders.set('Content-Type', contentType);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    // Framework既定proxyのURL/例外Logを避け、接続障害も固定の公開Errorで返す。
    return failure('SERVICE_UNAVAILABLE');
  }
};

/**
 * 業務GraphQLを開発時だけ固定loopback APIへ転送する。Production・Testでは能力未接続の503。
 * @param request Browserが送った未検証Request。Cookie・CSRF・Bodyの値をLogへ出さない。
 * @returns APIのResponse（status・Body・Content-Typeを維持）、または診断を含まない固定の公開Error。
 */
export const POST = proxy;
/**
 * GET実行を許可しない（#293）。転送せず拒否する。
 * @param request Methodを検証する未検証Request。
 * @returns 405とAllow: POSTの固定公開Error。
 */
export const GET = proxy;
/**
 * GETの暗黙HEAD成功を避け、契約外Methodとして拒否する。
 * @param request Methodを検証する未検証Request。
 * @returns 405とAllow: POSTの固定公開Error。
 */
export const HEAD = proxy;
/**
 * CORS preflightを許可せず、POSTだけをAllowに示す。
 * @param request Methodを検証する未検証Request。
 * @returns 405とAllow: POSTの固定公開Error。
 */
export const OPTIONS = proxy;
/**
 * 契約外Methodを転送しない。
 * @param request Methodを検証する未検証Request。
 * @returns 405とAllow: POSTの固定公開Error。
 */
export const PUT = proxy;
/**
 * 契約外Methodを転送しない。
 * @param request Methodを検証する未検証Request。
 * @returns 405とAllow: POSTの固定公開Error。
 */
export const PATCH = proxy;
/**
 * 契約外Methodを転送しない。
 * @param request Methodを検証する未検証Request。
 * @returns 405とAllow: POSTの固定公開Error。
 */
export const DELETE = proxy;
