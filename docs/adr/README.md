# ADR

Decision本文はこのディレクトリで管理する。Owner承認、関連Task、実施記録はGitHub Issueへリンクする。新規ADRは衝突しないslugを使い、Proposedから始める。

| Decision | Status | 関係・証拠 |
| --- | --- | --- |
| [GitHub正本への切替](github-canonical-cutover.md) | Accepted | [Owner承認・切替実施記録 #17](https://github.com/takeshi-arihori/kakei_app/issues/17) |
| 旧ADR-14のNotion正本方針 | Superseded（#17のCutover実施記録発効時） | #17のCutover実施記録が発効点。旧ページは更新しない |
| 旧ADR-20のPublic Repository / Private Project / 公開Gate | Accepted、部分修正 | 正本・Rollbackの条件を新ADRがAmends。全部置換しない |

ほかの旧ADR全文は未移行である。現在のRepository不変条件は維持するが、過去ADRの詳細が必要な変更は[設計Gate](../product/design-gates.md)に従い、GitHub上で根拠を確定するまでReadyにしない。Notionの再取得で補わない。

ADRにはContext、Decision、Alternatives、Consequences、Implementation、Review Trigger、Owner承認日を含める。完全置換だけSupersedes/Superseded By、一部変更はAmendsで表す。承認済みの履歴を消さない。
