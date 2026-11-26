import type { GroupCreationViewState } from '../group-creation-controller';

/**
 * グループ作成の操作と結果の案内を表示する。送信・操作IDの管理は呼出し元のControllerが行う。
 * @param props 現在の表示状態と押下時の処理。
 * @returns 作成ボタン（送信中・移動中は無効）と、状態の通知領域。
 */
export function CreateGroupPanel(props: Readonly<{
  /** 秘密値を含まない作成操作の状態。 */ state: GroupCreationViewState;
  /** 作成または同じ操作の再試行を1回要求する。 */ onSubmit: () => void;
}>) {
  const { phase, message } = props.state;
  const busy = phase === 'submitting' || phase === 'redirecting';
  return (
    <section className="group-create" aria-labelledby="create-group-heading" aria-busy={busy}>
      <h2 id="create-group-heading">グループを作成</h2>
      <p>あなたがオーナーとして、最初の参加者になります。</p>
      <button type="button" disabled={busy} onClick={props.onSubmit}>{phase === 'retry' ? 'もう一度試す' : 'グループを作成'}</button>
      <p role={phase === 'retry' || phase === 'failed' ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">{message}</p>
    </section>
  );
}
