import Link from 'next/link';
import { ContentState } from './_components/content-state';

/**
 * 不明なRouteを、業務上の認可拒否や存在確認へ対応付けずに扱う。
 * @returns 内部情報を含めない表示不可の説明とホームへの復帰導線。
 */
export default function NotFound() {
  return (
    <ContentState kind="unavailable" title="このページを表示できません" description="URLを確認するか、ホームへ戻ってください。">
      <Link className="home-link" href="/">ホームへ戻る</Link>
    </ContentState>
  );
}
