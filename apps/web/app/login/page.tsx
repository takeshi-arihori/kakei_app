import Link from 'next/link';
import { AuthenticationPanel } from '../../src/features/authentication/authentication-panel';
/**
 * 本人性の正本をAPIに保ち、公開設定だけを認証画面へ渡す。
 * @returns 日本語のログイン/状態/ログアウト画面。本番認証は有効化しない。
 */
export default function LoginPage() {
  const clientId=process.env.NODE_ENV==='development'?process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID:undefined;
  return <><p className="eyebrow">共有割り勘を、はじめる前に。</p><h1 className="auth-title">ログイン</h1><p className="auth-intro">Googleアカウントでログインし、現在のログイン状態を確認できます。</p><AuthenticationPanel clientId={clientId}/><Link className="home-link" href="/">ホームへ戻る</Link></>;
}
