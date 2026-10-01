import type { ReactNode } from 'react';

/** Route内容の事実が確定した呼出し元から受け取る表示契約。 */
export type ContentStateProps = Readonly<{
  /** Loadingだけを穏やかな通知対象にする。業務Error種別を推測しない。 */
  kind: 'loading' | 'empty' | 'unavailable';
  /** 本文の見出し。Emptyは空集合が確認できた場合だけ選ぶ。 */
  title: string;
  /** 内部Errorや業務データを含めない、状態に対応した利用者向け説明。 */
  description: string;
  /** 呼出し元が提供できる復帰導線。再送可能性や権限を本Componentで判断しない。 */
  children?: ReactNode;
}>;

/**
 * Main内のRoute全体に、Loading／Empty／Unavailableの説明を配置する。
 * @param props 確定した状態と説明。API取得・Error変換・認可判断は呼出し元の責務。
 * @returns Loadingだけをstatusとして通知する、本文の見出しと説明・復帰導線。
 */
export function ContentState(props: ContentStateProps) {
  return (
    <div className="content-state" role={props.kind === 'loading' ? 'status' : undefined}>
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      {props.children}
    </div>
  );
}
