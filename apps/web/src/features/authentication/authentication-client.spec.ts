import { describe, expect, it, vi } from 'vitest';
import { createAuthenticationClient } from './authentication-client';
const secret = 'A'.repeat(43);
const expiry = Date.now() + 300_000;
const error = (status: number, code: string, extra: Record<string,string> = {}) => Response.json({error:{code,requestId:'00000000-0000-4000-8000-000000000001'}},{status,headers:extra});
describe('A5同一Origin認証Client',()=>{
  it('Sessionの妥当な本文と必須Header/非Cacheを維持する',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({authenticated:true,csrfToken:secret,expiresAt:expiry}));
    expect(await createAuthenticationClient(fetcher).inspect()).toEqual({status:'ok',value:{csrfToken:secret,expiresAt:expiry}});
    const [path,init]=fetcher.mock.calls[0];expect(path).toBe('/auth/session');expect(init?.credentials).toBe('same-origin');expect(init?.cache).toBe('no-store');expect(new Headers(init?.headers).get('x-kakei-request')).toBe('1');expect(new Headers(init?.headers).has('origin')).toBe(false);
  });
  it('beginのServer値を検査しlogin/logoutをJSONとCSRFで送る',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({nonce:secret,csrfToken:secret,expiresAt:expiry},{status:201})).mockResolvedValueOnce(new Response(null,{status:204})).mockResolvedValueOnce(new Response(null,{status:204}));
    const client=createAuthenticationClient(fetcher);
    expect(await client.begin()).toEqual({status:'ok',value:{nonce:secret,csrfToken:secret,expiresAt:expiry}});
    expect(await client.login('synthetic-credential',secret)).toEqual({status:'ok',value:null});expect(await client.logout(secret)).toEqual({status:'ok',value:null});
    expect(fetcher.mock.calls.map(c=>c[0])).toEqual(['/auth/google/attempt','/auth/google/login','/auth/logout']);
    expect(fetcher.mock.calls[1][1]?.body).toBe('{"credential":"synthetic-credential"}');expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('x-csrf-token')).toBe(secret);
  });
  it.each([{}, {authenticated:false}, {authenticated:true,csrfToken:'bad',expiresAt:expiry}, {authenticated:true,csrfToken:secret,expiresAt:'later'}, {authenticated:true,csrfToken:secret,expiresAt:expiry,actor:'private'}])('不正なSession本文は状態を確定せず破棄する: %#',async body=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));expect(await createAuthenticationClient(fetcher).inspect()).toEqual({status:'unavailable'});
  });
  it.each([[401,'AUTHENTICATION_REQUIRED','required'],[409,'LOGIN_RESTART_REQUIRED','restart'],[403,'REQUEST_REJECTED','rejected'],[503,'AUTHENTICATION_UNAVAILABLE','unavailable']] as const)('%i/%sを固定結果へ写像する',async(status,code,result)=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(error(status,code));expect(await createAuthenticationClient(fetcher).inspect()).toEqual({status:result});
  });
  it('429は待機期限を返し、診断や例外を伝播しない',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(error(429,'RATE_LIMITED',{'Retry-After':'30'})).mockRejectedValueOnce(new Error('private-diagnostic'));
    const client=createAuthenticationClient(fetcher);expect(await client.begin()).toMatchObject({status:'limited',retryAt:expect.any(Number)});expect(await client.begin()).toEqual({status:'unavailable'});
  });
  it('不正な401本文を未認証成功へ変換しない',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response('private-html',{status:401}));expect(await createAuthenticationClient(fetcher).inspect()).toEqual({status:'unavailable'});
  });
});
