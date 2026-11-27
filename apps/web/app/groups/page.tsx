import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ContentState } from '../_components/content-state';
import { MyGroupListView } from '../../src/features/groups/components/my-group-list';
import { loadMyGroups } from '../../src/features/groups/graphql/my-groups-server';
import { CreateGroupSection } from './create-group-section';

/**
 * 自分のグループ一覧と作成操作の画面（#305 §5）。一覧はServer ComponentがRequestごとに取得する。
 * @returns 一覧と作成操作、または取得不能の案内。未ログインは戻り先なしで`/login`へredirectする。
 */
export default async function GroupsPage() {
  const result = await loadMyGroups((await headers()).get('cookie'));
  if (result.status === 'authentication-required') redirect('/login');
  if (result.status !== 'ok')
    return (
      <ContentState kind="unavailable" title="グループを表示できません" description="現在、グループの一覧を取得できません。時間をおいて、もう一度お試しください。">
        <Link className="home-link" href="/groups">再読み込み</Link>
      </ContentState>
    );
  return (
    <>
      <h1 className="auth-title">自分のグループ</h1>
      <CreateGroupSection />
      <MyGroupListView list={result.value} />
    </>
  );
}
