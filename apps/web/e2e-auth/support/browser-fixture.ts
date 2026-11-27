// 認証とGroupのBrowser E2Eが共有する、Test所有API（実PostgreSQL・実SDK署名検証）とGoogle Script代替。
import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
export { expect };
const requireApi=createRequire(resolve(process.cwd(),'../api/package.json'));
export const test=base.extend<{control:string}>({control:async({},provide)=>{
 const child=spawn(process.execPath,['--import',requireApi.resolve('tsx'),resolve(process.cwd(),'../api/test/support/authentication-browser-server.ts')],{env:{...process.env,NODE_ENV:'test',KAKEI_BROWSER_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
 const closed=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 let ready=false;
 try{
  const control=await new Promise<string>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('認証Test専用APIの起動期限')),25_000);let text='';
   child.once('error',()=>{clearTimeout(timer);reject(new Error('認証Test専用APIを起動できません'));});
   child.once('exit',()=>{clearTimeout(timer);if(!ready)reject(new Error('認証Test専用APIが起動前に終了しました'));});
   child.stdout.on('data',chunk=>{text+=String(chunk);for(const line of text.split('\n')){if(!line.startsWith('{'))continue;try{const value:unknown=JSON.parse(line);if(typeof value==='object'&&value!==null&&'fixtureReady' in value&&'controlPort' in value&&typeof value.controlPort==='number'){ready=true;clearTimeout(timer);resolve('http://127.0.0.1:'+value.controlPort);}}catch{ /* 完全な開始行を待つ。 */ }}});
  });await provide(control);
 }finally{child.kill('SIGTERM');await closed;}
}});
export const gisScript=`let configuration;window.google={accounts:{id:{initialize(c){configuration=c;},renderButton(element,options){const button=document.createElement('button');button.textContent='Googleでログイン';button.type='button';button.style.width=options.width+'px';button.style.minHeight='40px';button.style.height='40px';button.style.padding='0';button.style.margin='0';button.addEventListener('click',()=>{options.click_listener();window.syntheticCredential(configuration.nonce).then(credential=>configuration.callback({credential}));});element.append(button);},disableAutoSelect(){}}}};window.addEventListener('synthetic-late-credential',()=>window.syntheticCredential(configuration.nonce).then(credential=>configuration.callback({credential})));`;
export const prepare=async(page:Page,control:string,mode='valid')=>{
 await page.exposeFunction('syntheticCredential',async(nonce:string)=>{
  const r=await page.request.post(control+'/credential',{data:{nonce,mode}});if(r.status()!==200)throw new Error('Test署名の準備失敗');const body:unknown=await r.json();if(typeof body!=='object'||body===null||!('credential'in body)||typeof body.credential!=='string')throw new Error('Test署名の構造不正');return body.credential;
 });
 await page.route('https://accounts.google.com/gsi/client?hl=ja',route=>route.fulfill({contentType:'application/javascript',body:gisScript }));
 const loaded=await page.goto('/login');expect(loaded?.headers()['cross-origin-opener-policy']).toBe('same-origin-allow-popups');expect(loaded?.headers()['referrer-policy']).toBe('no-referrer-when-downgrade');await expect(page.getByRole('button',{name:'Googleログインを準備',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Googleログインを準備',exact:true}).click();await expect(page.getByRole('button',{name:'Googleでログイン',exact:true})).toBeVisible();
};
export const login=async(page:Page)=>{await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();await expect(page.getByRole('status')).toHaveText('ログイン中です。');};
