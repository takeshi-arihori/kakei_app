import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GroupCreationViewState } from '../group-creation-controller';
import { CreateGroupPanel } from './create-group-panel';

const render = (state: GroupCreationViewState) => renderToStaticMarkup(createElement(CreateGroupPanel, { state, onSubmit: () => {} }));

describe('グループ作成操作の表示', () => {
  it('初期状態で作成ボタンと作成者がオーナーになる説明を示す', () => {
    const html = render({ phase: 'idle', message: '' });
    expect(html).toContain('<h2 id="create-group-heading">グループを作成</h2>');
    expect(html).toContain('オーナー');
    expect(html).toMatch(/<button type="button"[^>]*>グループを作成<\/button>/);
    expect(html).not.toContain('disabled');
    expect(html).toContain('role="status"');
  });

  it('送信中はボタンを無効化してbusyを示す', () => {
    const html = render({ phase: 'submitting', message: 'グループを作成しています。' });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>グループを作成<\/button>/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('グループを作成しています。');
  });

  it('結果不明では同じ操作の再試行を示し、警告として通知する', () => {
    const html = render({ phase: 'retry', message: '作成できたか確認できませんでした。' });
    expect(html).toMatch(/<button type="button"[^>]*>もう一度試す<\/button>/);
    expect(html).toContain('role="alert"');
  });

  it('確定Errorを警告として通知し、新しい作成を押せる', () => {
    const html = render({ phase: 'failed', message: 'グループを作成できませんでした。' });
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button type="button"[^>]*>グループを作成<\/button>/);
  });

  it('ログイン導線へ移動中は操作を受け付けない', () => {
    expect(render({ phase: 'redirecting', message: 'ログインが必要です。' })).toMatch(/<button[^>]*disabled=""/);
  });
});
