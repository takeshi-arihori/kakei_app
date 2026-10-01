import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

/** 業務データを含めず、日本語の入口の目的をページ情報へ反映する。 */
export const metadata: Metadata = {
  title: '共有割り勘 | グループで支出を記録し、精算する',
  description: 'グループで立て替えた支出を記録し、精算内容の確認から支払い・受け取りの確認までを整理する共有割り勘アプリ。',
};

/**
 * Routeとその状態表示を、同じ本文・ホーム導線で包む共通外枠。
 * @param props Route側で組み立てた内容。業務情報や認可判断を外枠へ渡さない。
 * @returns 日本語の文書と、キーボードで本文へ移動できる外枠。
 */
export default function RootLayout(props: Readonly<{
  /** Page、Loading、NotFound等の内容。本文landmarkは外枠が提供する。 */
  children: ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>
        <a className="skip-link" href="#main">本文へ移動</a>
        <header className="app-header">
          <Link className="brand" href="/" aria-label="共有割り勘 ホーム">
            <span className="brand-mark" aria-hidden="true">分</span>
            <span>共有割り勘</span>
          </Link>
        </header>
        <main id="main" className="app-main" tabIndex={-1}>{props.children}</main>
      </body>
    </html>
  );
}
