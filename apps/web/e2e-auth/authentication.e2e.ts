import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireApi=createRequire(resolve(process.cwd(),'../api/package.json'));
const test=base.extend<{control:string}>({control:async({},provide)=>{
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
const gisScript=`let configuration;window.google={accounts:{id:{initialize(c){configuration=c;},renderButton(element,options){const button=document.createElement('button');button.textContent='Googleでログイン';button.type='button';button.style.width=options.width+'px';button.style.minHeight='40px';button.style.height='40px';button.style.padding='0';button.style.margin='0';button.addEventListener('click',()=>{options.click_listener();window.syntheticCredential(configuration.nonce).then(credential=>configuration.callback({credential}));});element.append(button);},disableAutoSelect(){}}}};window.addEventListener('synthetic-late-credential',()=>window.syntheticCredential(configuration.nonce).then(credential=>configuration.callback({credential})));`;
const prepare=async(page:Page,control:string,mode='valid')=>{
 await page.exposeFunction('syntheticCredential',async(nonce:string)=>{
  const r=await page.request.post(control+'/credential',{data:{nonce,mode}});if(r.status()!==200)throw new Error('Test署名の準備失敗');const body:unknown=await r.json();if(typeof body!=='object'||body===null||!('credential'in body)||typeof body.credential!=='string')throw new Error('Test署名の構造不正');return body.credential;
 });
 await page.route('https://accounts.google.com/gsi/client?hl=ja',route=>route.fulfill({contentType:'application/javascript',body:gisScript }));
 const loaded=await page.goto('/login');expect(loaded?.headers()['cross-origin-opener-policy']).toBe('same-origin-allow-popups');expect(loaded?.headers()['referrer-policy']).toBe('no-referrer-when-downgrade');await expect(page.getByRole('button',{name:'Googleログインを準備',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Googleログインを準備',exact:true}).click();await expect(page.getByRole('button',{name:'Googleでログイン',exact:true})).toBeVisible();
};
const login=async(page:Page)=>{await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();await expect(page.getByRole('status')).toHaveText('ログイン中です。');};
test('実SDK署名とAPI/PG/Cookieでlogin→再読込→logout',async({page,control,context})=>{
 const secrets:string[]=[];
 page.on('request',request=>{if(request.url().endsWith('/auth/google/login')){const body:unknown=request.postDataJSON();if(typeof body==='object'&&body!==null&&'credential'in body&&typeof body.credential==='string'){secrets.push(body.credential);const payload:unknown=JSON.parse(Buffer.from(body.credential.split('.')[1],'base64url').toString());if(typeof payload==='object'&&payload!==null&&'nonce'in payload&&typeof payload.nonce==='string')secrets.push(payload.nonce);}const csrf=request.headers()['x-csrf-token'];if(csrf)secrets.push(csrf);}});
 await prepare(page,control);await login(page);await page.reload();await expect(page.getByRole('status')).toHaveText('ログイン中です。');
 expect((await context.cookies()).filter(c=>c.name.startsWith('kakei_dev_auth')).map(c=>({name:c.name,httpOnly:c.httpOnly}))).toEqual([{name:'kakei_dev_auth_session',httpOnly:true}]);
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(secrets.length).toBe(3);expect(secrets.some(secret=>storage.includes(secret))).toBe(false);expect(await page.evaluate(()=>document.cookie)).toBe('');
 await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page.getByRole('status')).toHaveText('ログアウトしました。');
 const state=await (await page.request.get(control+'/state')).json();expect(state).toEqual({actors:1,sessions:[{state:'revoked',count:1}]});expect(new URL(page.url()).search).toBe('');
});
test('SDK状態Cookie共存時もpopup復帰inspectからloginとlogoutを完了する',async({page,control,context})=>{
 await prepare(page,control);
 await context.addCookies([{name:'g_state',value:'{"i_l":0}',url:'http://localhost:3000',sameSite:'Lax'}]);
 const inspected=page.waitForResponse(r=>new URL(r.url()).pathname==='/auth/session');
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 expect((await inspected).status()).toBe(401);
 await expect(page.getByRole('button',{name:'Googleでログイン',exact:true})).toBeVisible();
 await login(page);await page.reload();await expect(page.getByRole('status')).toHaveText('ログイン中です。');
 await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page.getByRole('status')).toHaveText('ログアウトしました。');
 expect((await context.cookies()).some(c=>c.name==='g_state')).toBe(true);
 expect((await context.cookies()).some(c=>c.name==='kakei_dev_auth_session')).toBe(false);
});
for(const mode of ['bad-signature','bad-nonce'])test(mode+'は実SDKが拒否しActorを作らない',async({page,control})=>{
 await prepare(page,control,mode);await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();await expect(page.locator('.auth-card [role="alert"]')).toBeVisible();expect(await(await page.request.get(control+'/state')).json()).toEqual({actors:0,sessions:[]});
});
test('取消後の遅いGoogle callbackでログインしない',async({page,control})=>{
 await prepare(page,control);await page.getByRole('button',{name:'ログインを中止',exact:true}).click();await page.evaluate(()=>window.dispatchEvent(new Event('synthetic-late-credential')));await expect(page.getByRole('status')).toHaveText('ログインを中止しました。');expect(await(await page.request.get(control+'/state')).json()).toEqual({actors:0,sessions:[]});
});
test('試行5分期限等値の409を新しい開始へ案内する',async({page,control})=>{
 await prepare(page,control);await page.request.post(control+'/advance',{data:{milliseconds:300_000}});await page.getByRole('button',{name:'Googleでログイン',exact:true}).click();await expect(page.getByRole('button',{name:'ログインをやり直す',exact:true})).toBeVisible();expect(await(await page.request.get(control+'/state')).json()).toEqual({actors:0,sessions:[]});
});
test('Session無操作24hの401を表示復帰で反映する',async({page,control})=>{
 await prepare(page,control);await login(page);await page.request.post(control+'/advance',{data:{milliseconds:86_400_000}});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByRole('status')).toHaveText(/ログイン状態が変わりました/);
});
test('別Tabのlogoutを同じBrowserの復帰で反映する',async({page,control,context})=>{
 await prepare(page,control);await login(page);const other=await context.newPage();await other.goto('/login');await expect(other.getByRole('status')).toHaveText('ログイン中です。');await other.getByRole('button',{name:'ログアウト',exact:true}).click();await page.bringToFront();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByRole('button',{name:'ログインをやり直す',exact:true})).toBeVisible();await other.close();
});
test('login応答503でもcommit済Cookieのinspectを正本にする',async({page,control})=>{
 await prepare(page,control);await page.route('**/auth/google/login',async route=>{const response=await route.fetch();expect(response.status()).toBe(204);await route.fulfill({response,status:503,json:{error:{code:'AUTHENTICATION_UNAVAILABLE',requestId:'00000000-0000-4000-8000-000000000001'}}});});await login(page);
});
test('Rate待機と狭幅/Keyboard/拡大の認証画面を検証する',async({page,control})=>{
 await page.setViewportSize({width:320,height:850});await prepare(page,control);await page.keyboard.press('Tab');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);expect(await page.locator('.google-button').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
 await page.screenshot({path:test.info().outputPath('authentication-320.png'),fullPage:true});
 await page.evaluate(()=>{document.body.style.zoom='2';});await page.setViewportSize({width:640,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
 await page.getByRole('button',{name:'ログインを中止',exact:true}).click();await page.route('**/auth/session',route=>route.fulfill({status:429,contentType:'application/json',headers:{'retry-after':'30'},body:JSON.stringify({error:{code:'RATE_LIMITED',requestId:'00000000-0000-4000-8000-000000000001'}})}));await page.getByRole('button',{name:'ログインをやり直す',exact:true}).click();await expect(page.locator('.auth-card [role="alert"]')).toHaveText(/操作が集中/);await expect(page.getByRole('button',{name:'状態を確認する',exact:true})).toBeDisabled();
});

test('KeyboardでGoogleとlogoutを操作しFocusと44pxを保つ',async({page,control})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await prepare(page,control);const google=page.getByRole('button',{name:'Googleでログイン',exact:true});for(let n=0;n<12&&!(await google.evaluate(e=>e===document.activeElement));n++)await page.keyboard.press('Tab');await expect(google).toBeFocused();await expect(google).toHaveCSS('outline-style','solid');expect((await google.boundingBox())?.height).toBeGreaterThanOrEqual(44);await page.keyboard.press('Enter');await expect(page.getByRole('status')).toHaveText('ログイン中です。');await page.screenshot({path:test.info().outputPath('authentication-desktop.png'),fullPage:true});const logout=page.getByRole('button',{name:'ログアウト',exact:true});for(let n=0;n<12&&!(await logout.evaluate(e=>e===document.activeElement));n++)await page.keyboard.press('Tab');await expect(logout).toBeFocused();await page.keyboard.press('Enter');await expect(page.getByRole('status')).toHaveText('ログアウトしました。');
});
test('logoutの未実行503とcommit後503をinspectで区別して再試行する',async({page,control})=>{
 await prepare(page,control);await login(page);let requests=0;await page.route('**/auth/logout',async route=>{requests++;const error={error:{code:'AUTHENTICATION_UNAVAILABLE',requestId:'00000000-0000-4000-8000-000000000001'}};if(requests===1)await route.fulfill({status:503,json:error});else{const response=await route.fetch();expect(response.status()).toBe(204);await route.fulfill({response,status:503,json:error});}});await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page.getByRole('status')).toHaveText(/ログアウトは完了していません/);await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page.getByRole('status')).toHaveText('ログアウトしました。');expect(await(await page.request.get(control+'/state')).json()).toEqual({actors:1,sessions:[{state:'revoked',count:1}]});
});

for(const failure of ['error','timeout'] as const)test('GIS '+failure+'から固定案内で新しいログインを準備できる',async({page,control})=>{
 let requests=0;let seen:()=>void=()=>{};let release:(()=>Promise<void>)|undefined;
 const firstScript=new Promise<void>(resolve=>{seen=resolve;});
 if(failure==='timeout'){
  const now=Date.now();await page.clock.install({time:new Date(now)});await page.clock.pauseAt(new Date(now+1000));
 }
 await page.route('https://accounts.google.com/gsi/client?hl=ja',async route=>{
  requests++;
  if(requests>1){await route.fulfill({contentType:'application/javascript',body:gisScript});return;}
  if(failure==='error'){seen();await route.abort('failed');return;}
  await new Promise<void>(resolve=>{release=async()=>{await route.abort('failed');resolve();};seen();});
 });
 try{
  await page.goto('/login');await page.getByRole('button',{name:'Googleログインを準備',exact:true}).click();await firstScript;
  if(failure==='timeout'){
   await page.clock.fastForward(14_999);await expect(page.locator('.auth-card [role="alert"]')).toHaveCount(0);
   await page.clock.fastForward(1);
  }
  await expect(page.locator('.auth-card [role="alert"]')).toHaveText('操作を完了できませんでした。状態を確認するか、ログインをやり直してください。');
  await expect(page.getByRole('button',{name:'ログインをやり直す',exact:true})).toBeEnabled();
  if(release){await release();release=undefined;}
  await page.getByRole('button',{name:'ログインをやり直す',exact:true}).click();
  await page.getByRole('button',{name:'Googleログインを準備',exact:true}).click();
  await expect(page.getByRole('button',{name:'Googleでログイン',exact:true})).toBeVisible();
  await expect(page.locator('.auth-card [role="alert"]')).toHaveCount(0);expect(requests).toBe(2);
  expect(await(await page.request.get(control+'/state')).json()).toEqual({actors:0,sessions:[]});
 }finally{if(release)await release();}
});
