"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createAuthenticationClient } from './authentication-client';
import { AuthenticationController } from './authentication-controller';
import { loadGoogleIdentity, mountGoogleButton, requiresGoogleReload, disableGoogleAutoSelect } from './google-identity';
/**
 * Sessionを独自発行/保存せず、Google認証と現在Sessionの操作を表示する。
 * @param props Serverが選んだ公開設定。秘密値は受け取らない。
 * @returns 日本語の認証操作と、結果不明を含む状態案内。
 */
export function AuthenticationPanel(props: Readonly<{
  /** localhost開発だけの公開ID。未設定/Productionではundefined。 */ clientId?: string;
}>) {
  const [controller]=useState(()=>new AuthenticationController(createAuthenticationClient()));
  const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getServerSnapshot);
  const [now,setNow]=useState(0);
  const button=useRef<HTMLDivElement>(null);
  const enabled=typeof props.clientId==='string' && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(props.clientId);
  const showGoogle=snapshot.phase==='google'||snapshot.phase==='waiting';
  const cooling=(snapshot.retryAt??0)>now;
  useEffect(()=>{
    if(!enabled)return;
    void controller.start();
    const refresh=()=>{if(document.visibilityState==='visible')void controller.refresh();};
    window.addEventListener('focus',refresh);window.addEventListener('pageshow',refresh);document.addEventListener('visibilitychange',refresh);
    return ()=>{controller.stop();window.removeEventListener('focus',refresh);window.removeEventListener('pageshow',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[controller,enabled]);
  useEffect(()=>{
    if(!showGoogle && !snapshot.retryAt)return;
    const timer=setInterval(()=>{controller.checkExpiry();setNow(Date.now());},1000);return()=>clearInterval(timer);
  },[controller,showGoogle,snapshot.retryAt]);
  useEffect(()=>{
    const clientId=props.clientId;
    if(!showGoogle || !clientId)return;
    let cancelled=false;let dispose:(()=>void)|undefined;
    void loadGoogleIdentity().then(google=>{
      if(cancelled || !button.current)return;const bindings=controller.googleBindings();if(!bindings)return;
      dispose=mountGoogleButton(google,button.current,clientId,bindings);
    }).catch(()=>{if(!cancelled)controller.googleUnavailable();});
    return()=>{cancelled=true;dispose?.();};
  },[controller,showGoogle,props.clientId]);
  const restart=()=>window.location.assign('/login');
  if(!enabled)return <section className="auth-card" aria-labelledby="auth-heading"><h2 id="auth-heading">ログインは現在準備中です</h2><p role="status">時間をおいて、もう一度お試しください。</p></section>;
  return <section className="auth-card" aria-labelledby="auth-heading" aria-busy={['checking','preparing','completing','logout'].includes(snapshot.phase)}>
    <h2 id="auth-heading">Googleアカウントで利用する</h2>
    <p role={snapshot.phase==='error'?'alert':'status'} aria-live="polite" aria-atomic="true">{snapshot.message}</p>
    {snapshot.phase==='anonymous' && <button type="button" onClick={()=>{if(requiresGoogleReload())restart();else void controller.begin();}}>Googleログインを準備</button>}
    {showGoogle && <div className="google-button" ref={button} aria-label="Googleログイン"/>}
    {['preparing','google','waiting'].includes(snapshot.phase) && <button type="button" className="secondary" onClick={()=>controller.cancel()}>ログインを中止</button>}
    {snapshot.phase==='authenticated' && <button type="button" onClick={()=>void controller.logout().then(()=>{if(controller.getSnapshot().message==='ログアウトしました。')disableGoogleAutoSelect();})}>ログアウト</button>}
    {snapshot.phase==='restart' && <button type="button" onClick={restart}>ログインをやり直す</button>}
    {snapshot.phase==='error' && <div className="auth-actions"><button type="button" disabled={cooling} onClick={()=>void controller.refresh()}>状態を確認する</button><button type="button" className="secondary" disabled={cooling} onClick={restart}>ログインをやり直す</button></div>}
    {cooling && <p>再試行可能になるまでお待ちください。</p>}
    <p className="auth-note">{snapshot.phase==='authenticated'?'このアプリの現在のログインを終了できます。':'ログイン後も、この画面からログアウトできます。'}</p>
  </section>;
}
