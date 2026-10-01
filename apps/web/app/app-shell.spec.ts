import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import RootLayout, { metadata } from './layout';
import Home from './page';

describe('共有割り勘の入口と共通外枠', () => {
  it('利用目的と流れを説明し、利用開始前であることを伝える', () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(html.replace(/<[^>]*>/g, '')).toContain('支出から精算まで、グループで。');
    expect(html).toContain('支出を記録');
    expect(html).toContain('みんなで確認');
    expect(html).toContain('受け取りまで確認');
    expect(html).toContain('アプリ内で送金は行いません');
    expect(html).toContain('利用開始の準備を進めています');
    expect(html).not.toMatch(/<button|<input|href=/);
  });

  it('日本語の外枠がRoute内容を単一の本文へ配置する', () => {
    const html = renderToStaticMarkup(createElement(RootLayout, null,
      createElement('p', null, 'Routeの内容')));
    expect(html).toContain('lang="ja"');
    expect(html).toContain('href="#main"');
    expect(html).toContain('本文へ移動');
    expect(html).toMatch(/<main[^>]+id="main"[^>]*><p>Routeの内容<\/p><\/main>/);
    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html).toContain('共有割り勘 ホーム');
  });

  it('共有割り勘の目的をページ情報へ反映する', () => {
    expect(metadata.title).toContain('共有割り勘');
    expect(metadata.description).toContain('グループ');
    expect(metadata.description).toContain('精算');
  });
});
