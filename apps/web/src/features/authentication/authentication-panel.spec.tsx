import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthenticationPanel } from './authentication-panel';
describe('認証画面の初期表示',()=>{
 it('未設定ではGoogleScriptやログイン成功を表示しない',()=>{const html=renderToStaticMarkup(createElement(AuthenticationPanel));expect(html).toContain('ログインは現在準備中です');expect(html).not.toMatch(/<script|<button|ログイン中です/);});
 it('設定済みSSRでもSessionを推測せず確認中を表示する',()=>{const html=renderToStaticMarkup(createElement(AuthenticationPanel,{clientId:'synthetic.apps.googleusercontent.com'}));expect(html).toContain('ログイン状態を確認しています');expect(html).not.toContain('synthetic.apps.googleusercontent.com');expect(html).not.toContain('ログイン中です');});
});
