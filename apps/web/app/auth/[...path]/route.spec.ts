import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST, OPTIONS } from './route';
afterEach(() => {vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('同一Origin認証の開発転送',()=>{
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
