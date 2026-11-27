import type { GroupLifecycle, GroupRole } from '../../../shared/graphql/generated';
import type { MyGroupList, MyGroupSummary } from '../graphql/group-graphql-response';

const lifecycleLabels: Readonly<Record<GroupLifecycle, string>> = {
  ACTIVE: '利用中',
  CLOSING: '終了手続き中',
  CANCELING: '終了手続きの取消中',
  ARCHIVED: 'アーカイブ済み',
};
const roleLabels: Readonly<Record<GroupRole, string>> = { OWNER: 'オーナー', PARTICIPANT: '参加者' };
// 内部TimestampはUTC、表示はAsia/Tokyoへ明示変換する（coding-standards）。
const dateTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function Time(props: Readonly<{ /** 検査済みのRFC 3339 UTC。 */ value: string }>) {
  return <time dateTime={props.value}>{dateTime.format(new Date(props.value))}</time>;
}

function GroupItem(props: Readonly<{ group: MyGroupSummary }>) {
  const { group } = props;
  return (
    <li className="group-item">
      <h3><Time value={group.createdAt} />に作成</h3>
      <dl>
        <div><dt>状態</dt><dd>{lifecycleLabels[group.lifecycle]}</dd></div>
        <div><dt>あなたの役割</dt><dd>{roleLabels[group.myRole]}</dd></div>
        <div><dt>参加人数</dt><dd>{group.activeParticipantCount}人</dd></div>
        <div><dt>参加した日時</dt><dd><Time value={group.joinedAt} /></dd></div>
        {group.deleteEligibleAt !== null && <div><dt>削除できる日時</dt><dd><Time value={group.deleteEligibleAt} /></dd></div>}
      </dl>
    </li>
  );
}

/**
 * 自分のグループ一覧を、APIが返した順（作成の新しい順）のまま表示する。
 * Group概要（`/groups/[groupId]`）は未提供なので、行はLinkにしない（#305 §5）。
 * @param props 検査済みの一覧。認可・並べ替え・件数判断はAPIの責務。
 * @returns 一覧、空状態、または50件を超える場合の案内。
 */
export function MyGroupListView(props: Readonly<{
  /** `myGroups`の検査済みの値。 */ list: MyGroupList;
}>) {
  const { items, hasMore } = props.list;
  return (
    <section className="group-list" aria-labelledby="my-groups-heading">
      <h2 id="my-groups-heading">参加しているグループ</h2>
      {items.length === 0 ? (
        <p>まだ参加しているグループはありません。「グループを作成」から始められます。</p>
      ) : (
        <ol>{items.map((group) => <GroupItem key={group.groupId} group={group} />)}</ol>
      )}
      {hasMore && <p>新しい順に50件まで表示しています。それより前のグループは、まだこの画面では表示できません。</p>}
    </section>
  );
}
