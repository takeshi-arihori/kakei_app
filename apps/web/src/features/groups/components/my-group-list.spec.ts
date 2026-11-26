import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MyGroupSummary } from '../graphql/group-graphql-response';
import { MyGroupListView } from './my-group-list';

const active: MyGroupSummary = { groupId: 'synthetic-group-1', lifecycle: 'ACTIVE', myRole: 'OWNER', activeParticipantCount: 1, createdAt: '2026-11-20T01:02:03.004Z', joinedAt: '2026-11-20T01:02:03.004Z', deleteEligibleAt: null };
const render = (items: MyGroupSummary[], hasMore = false) => renderToStaticMarkup(createElement(MyGroupListView, { list: { items, hasMore } }));

describe('自分のグループ一覧の表示', () => {
  it('各行に状態・役割・参加人数・作成日時・参加日時をAsia/Tokyoの文字で示し、Linkにしない', () => {
    const html = render([active, { ...active, groupId: 'synthetic-group-2', myRole: 'PARTICIPANT', lifecycle: 'CLOSING', activeParticipantCount: 3, createdAt: '2026-11-19T15:00:00.000Z', joinedAt: '2026-11-21T00:30:00.000Z' }]);

    expect(html).toContain('aria-labelledby="my-groups-heading"');
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('<dt>状態</dt><dd>利用中</dd>');
    expect(html).toContain('<dt>あなたの役割</dt><dd>オーナー</dd>');
    expect(html).toContain('<dt>参加人数</dt><dd>1人</dd>');
    expect(html).toContain('<time dateTime="2026-11-20T01:02:03.004Z">2026/11/20 10:02</time>');
    expect(html).toContain('<dd>終了手続き中</dd>');
    expect(html).toContain('<dd>参加者</dd>');
    expect(html).toContain('<dd>3人</dd>');
    expect(html).toContain('<time dateTime="2026-11-19T15:00:00.000Z">2026/11/20 00:00</time>');
    expect(html).toContain('<time dateTime="2026-11-21T00:30:00.000Z">2026/11/21 09:30</time>');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('削除できる日時');
    expect(html).not.toContain('synthetic-group');
  });

  it('Archivedは削除できる日時を示し、終了取消中を区別する', () => {
    const html = render([
      { ...active, lifecycle: 'ARCHIVED', activeParticipantCount: 0, deleteEligibleAt: '2027-11-20T00:00:00.000Z' },
      { ...active, groupId: 'synthetic-group-3', lifecycle: 'CANCELING' },
    ]);
    expect(html).toContain('<dd>アーカイブ済み</dd>');
    expect(html).toContain('<dt>削除できる日時</dt><dd><time dateTime="2027-11-20T00:00:00.000Z">2027/11/20 09:00</time></dd>');
    expect(html).toContain('<dd>終了手続きの取消中</dd>');
  });

  it('空の一覧をErrorにせず、作成の入口を案内する', () => {
    const html = render([]);
    expect(html).toContain('まだ参加しているグループはありません。');
    expect(html).not.toContain('<ol');
    expect(html).not.toMatch(/role="alert"/);
  });

  it('hasMoreでは51件目以降を表示できないことを示す', () => {
    expect(render([active], true)).toContain('新しい順に50件まで表示しています。');
    expect(render([active], false)).not.toContain('50件まで');
  });
});
