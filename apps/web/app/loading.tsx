import { ContentState } from './_components/content-state';

/**
 * Route内容の読み込み中に表示する。共有外枠の読み込みは対象外。
 * @returns 完了状態や業務データを推測しない、静的なLoading表示。
 */
export default function Loading() {
  return <ContentState kind="loading" title="読み込んでいます" description="そのまま少しお待ちください。" />;
}
