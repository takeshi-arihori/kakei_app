import { randomUUID } from 'node:crypto';

const methods: Readonly<Record<string,string>> = { '/auth/google/attempt':'POST','/auth/google/login':'POST','/auth/session':'GET','/auth/logout':'POST' };
const failure = (status:number,code:string,allow?:string) => Response.json({ error:{ code,requestId:randomUUID() } },{ status,headers:{ 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(allow?{Allow:allow}:{}) } });
const proxy = async (request:Request):Promise<Response> => {
  const path=new URL(request.url).pathname;
  const method=methods[path];
  if (!method) return failure(404,'INVALID_REQUEST');
  if (request.method!==method) return failure(405,'INVALID_REQUEST',method);
  if (process.env.NODE_ENV!=='development') return failure(503,'AUTHENTICATION_UNAVAILABLE');
  try {
    const headers=new Headers(request.headers);
    for (const name of ['host','connection','keep-alive','transfer-encoding','te','trailer','upgrade','proxy-authorization','proxy-authenticate']) headers.delete(name);
    // Originは不在/不一致もそのまま渡し、APIの固定Origin照合に任せる。
    const init:RequestInit & {duplex:'half'}={ method,headers,body:method==='POST'?request.body:null,duplex:'half',redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(30_000) };
    const upstream=await fetch('http://127.0.0.1:3001'+path,init);
    const responseHeaders=new Headers({ 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff' });
    for (const name of ['content-type','allow','retry-after']) { const value=upstream.headers.get(name);if(value!==null) responseHeaders.set(name,value); }
    for (const value of upstream.headers.getSetCookie()) responseHeaders.append('Set-Cookie',value);
    return new Response(upstream.body,{status:upstream.status,headers:responseHeaders});
  } catch {
    // Framework既定proxyのURL/例外Logを避け、接続障害も固定Envelopeで返す。
    return failure(503,'AUTHENTICATION_UNAVAILABLE');
  }
};

/**
 * 開発時だけ固定loopback APIへ転送する。Productionでは能力未接続の503。
 * @param request Cookie/Originを含む未検証Request。値をLogへ出さない。
 * @returns APIのResponse、または診断を含まない固定Error。
 */
export const GET = proxy;
/**
 * POSTも同じ固定経路で転送し、Origin/Body/CSRFはAPIで検査する。
 * @param request Methodを検証する未検証Request。
 * @returns 定義外Methodは405、能力未接続は503、またはAPI Response。
 */
export const POST = proxy;
/**
 * 認証preflightを許可せず、定義MethodだけをAllowに示す。
 * @param request Methodを検証する未検証Request。
 * @returns 定義外Methodは405、能力未接続は503、またはAPI Response。
 */
export const OPTIONS = proxy;
/**
 * GETの暗黙HEAD成功を避け、認証契約外Methodとして拒否する。
 * @param request Methodを検証する未検証Request。
 * @returns 定義外Methodは405、能力未接続は503、またはAPI Response。
 */
export const HEAD = proxy;
/**
 * 認証契約外Methodを転送しない。
 * @param request Methodを検証する未検証Request。
 * @returns 定義外Methodは405、能力未接続は503、またはAPI Response。
 */
export const PUT = proxy;
/**
 * 認証契約外Methodを転送しない。
 * @param request Methodを検証する未検証Request。
 * @returns 定義外Methodは405、能力未接続は503、またはAPI Response。
 */
export const PATCH = proxy;
/**
 * 認証契約外Methodを転送しない。
 * @param request Methodを検証する未検証Request。
 * @returns 定義外Methodは405、能力未接続は503、またはAPI Response。
 */
export const DELETE = proxy;
