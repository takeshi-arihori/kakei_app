import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ContentState } from './content-state';
import Loading from '../loading';
import NotFound from '../not-found';

describe('Route内容の状態表示', () => {
  it('Loadingを支援技術へ通知し、業務完了を表示しない', () => {
    const html = renderToStaticMarkup(createElement(Loading));
    expect(html).toContain('role="status"');
    expect(html).toContain('読み込んでいます');
    expect(html).not.toContain('完了');
  });

  it('空集合が確定した呼出し元の説明を表示し、Error扱いしない', () => {
    const html = renderToStaticMarkup(createElement(ContentState, {
      kind: 'empty',
      title: '表示する内容はありません',
      description: '条件を変更して確認してください。',
    }));
    expect(html).toContain('<h1>表示する内容はありません</h1>');
    expect(html).toContain('条件を変更して確認してください。');
    expect(html).not.toMatch(/role="(?:alert|status)"/);
  });

  it('不明なRouteでは情報を推測せず、ホームへの復帰先を示す', () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain('このページを表示できません');
    expect(html).toContain('href="/"');
    expect(html).toContain('ホームへ戻る');
    expect(html).not.toMatch(/role="alert"|<main/);
  });
});
