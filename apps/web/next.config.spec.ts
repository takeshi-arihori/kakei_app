import { afterEach, describe, expect, it, vi } from 'vitest';
import config from './next.config';
afterEach(()=>vi.unstubAllEnvs());
describe('Google popupの開発限定Header',()=>{
 it('開発ログインだけReferrer/COOPを設定する',async()=>{vi.stubEnv('NODE_ENV','development');expect(await config.headers?.()).toEqual([{source:'/login',headers:[{key:'Referrer-Policy',value:'no-referrer-when-downgrade'},{key:'Cross-Origin-Opener-Policy',value:'same-origin-allow-popups'}]}]);});
 it.each(['production','test'])('%sへ開発例外を広げない',async mode=>{vi.stubEnv('NODE_ENV',mode);expect(await config.headers?.()).toEqual([]);});
});
