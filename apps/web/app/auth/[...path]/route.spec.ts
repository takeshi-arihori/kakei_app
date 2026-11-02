import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST, OPTIONS } from './route';
afterEach(() => {vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('同一Origin認証の開発転送',()=>{
  it.each([
    ['/auth/google/attempt', 'POST', '{}', 201, '{"nonce":"synthetic-nonce","csrfToken":"synthetic-csrf","expiresAt":1}'],
    ['/auth/google/login', 'POST', '{"credential":"synthetic-credential"}', 204, null],
    ['/auth/session', 'GET', null, 200, '{"authenticated":true,"csrfToken":"synthetic-csrf","expiresAt":1}'],
    ['/auth/logout', 'POST', '{}', 204, null],
  ] as const)('%sの%sを固定loopbackへ転送し応答を維持する', async (path, method, body, status, responseBody) => {
    vi.stubEnv('NODE_ENV', 'development');
    const upstream = new Response(responseBody, {status, headers:{'Content-Type':'application/json','Set-Cookie':'kakei_dev_auth_session=synthetic; HttpOnly'}});
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(upstream);vi.stubGlobal('fetch',fetcher);
    const request = new Request('http://localhost:3000'+path,{method,headers:{Origin:'http://localhost:3000','X-Kakei-Request':'1','X-CSRF-Token':'synthetic-csrf',Cookie:'kakei_dev_auth_session=synthetic',...(body === null ? {} : {'Content-Type':'application/json'})},body});
    const response = await (method === 'GET' ? GET : POST)(request);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [target, init] = fetcher.mock.calls[0];
    expect(target).toBe('http://127.0.0.1:3001'+path);
    expect(init?.method).toBe(method);
    expect(init?.redirect).toBe('manual');
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get('origin')).toBe('http://localhost:3000');
    expect(forwarded.get('x-kakei-request')).toBe('1');
    expect(forwarded.get('x-csrf-token')).toBe('synthetic-csrf');
    expect(forwarded.get('cookie')).toBe('kakei_dev_auth_session=synthetic');
    if (body === null) expect(init?.body).toBeNull();
    else expect(await new Response(init?.body).text()).toBe(body);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(responseBody ?? '');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.getSetCookie()).toEqual(['kakei_dev_auth_session=synthetic; HttpOnly']);
  });
  it.each(['http://localhost:3000','https://other.example.test',null])('Originを補わずCookieの複数行を維持する: %s',async origin=>{
    vi.stubEnv('NODE_ENV','development');
    const upstream=new Response(null,{status:204,headers:[['Set-Cookie','kakei_dev_auth_session=synthetic; HttpOnly'],['Set-Cookie','kakei_dev_auth_attempt=; Max-Age=0']]});
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(upstream);vi.stubGlobal('fetch',fetcher);
    const response=await POST(new Request('http://localhost:3000/auth/google/login',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:'{}'}));
    expect(response.status).toBe(204);expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:3001/auth/google/login');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('origin')).toBe(origin);
  });
  it.each(['production','test'])('%sではloopback認証を有効にしない',async mode=>{
    vi.stubEnv('NODE_ENV',mode);const fetcher=vi.fn<typeof fetch>();vi.stubGlobal('fetch',fetcher);
    const response=await GET(new Request('http://localhost:3000/auth/session'));expect(response.status).toBe(503);expect(fetcher).not.toHaveBeenCalled();
  });
  it('接続障害の診断を出さず、no-storeの503だけを返す',async()=>{
    vi.stubEnv('NODE_ENV','development');vi.stubGlobal('fetch',vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic-private-cookie')));
    const response=await GET(new Request('http://localhost:3000/auth/session'));expect(response.status).toBe(503);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.text()).not.toMatch(/synthetic|private|cookie/);
  });
  it('preflightを転送せず405を返す',async()=>{
    vi.stubEnv('NODE_ENV','development');const fetcher=vi.fn<typeof fetch>();vi.stubGlobal('fetch',fetcher);
    const response=await OPTIONS(new Request('http://localhost:3000/auth/session',{method:'OPTIONS'}));expect(response.status).toBe(405);expect(response.headers.get('allow')).toBe('GET');expect(fetcher).not.toHaveBeenCalled();
  });
});
