# GitHub正本の入口

Notionは読み書きしない。2026-09-05のOwner承認と切替実施結果は[ADR #17](https://github.com/takeshi-arihori/kakei_app/issues/17)に記録した。2026-09-06に切替PRがMergeされ、現在は`develop`を正本として使用する。

## 何をどこで管理するか

| 情報 | 正本 |
| --- | --- |
| Epic・TaskのRequirement、Done Criteria、依存、Owner、PR URL | GitHub Issue本文 |
| Status、Sprint、Story Points、優先度、分類 | [Private Project #9](https://github.com/users/takeshi-arihori/projects/9)のField |
| 現行仕様・業務Rule・設計・運用文書 | このRepositoryの`develop` |
| Decision本文・Status・履歴 | docs/adr。承認と切替実行の証跡は関連Issue |
| 実装のレビューと統合 | develop向けPull Request |

同じ情報を二重に編集しない。Issue本文にProject Fieldの要約を記載した場合は同時更新し、食い違いを再取得で検出する。ProjectだけPrivateにしてもPublic RepositoryのIssue/PRは公開される。

## Cutover実施記録

[Scrum Board試験構築 PR #20](https://github.com/takeshi-arihori/kakei_app/pull/20)と[GitHub正本切替 PR #21](https://github.com/takeshi-arihori/kakei_app/pull/21)は2026-09-06にMerge済みである。`develop`にはIssue Form、Working Agreement、GitHub中心のSkill、正本入口、公開Gateが揃っている。

PR #20の固定CommitとPR #21の固定Commitは切替過程の監査証跡として保持する。日常作業では固定Commitへ戻らず`develop`を参照する。正本切替Taskは[Issue #19](https://github.com/takeshi-arihori/kakei_app/issues/19)に記録されている。

## 読む順序

1. [現行Product Scope・業務モデル](../product/current-model.md)
2. [未確定・未移行Gate](../product/design-gates.md)
3. [ADR一覧](../adr/README.md)
4. [開発ガイド](../engineering/README.md)と対象Issue
5. [Scrum Working Agreement](../engineering/scrum-working-agreement.md)
6. [図の管理ルール](../engineering/diagram-governance.md)

## 公開と保留

公開前にSecret・PII・実在金融情報・内部Security情報を機械検査と手動Reviewで確認する。未分類・要編集・非公開情報をPublic Repositoryへ書き込まない。必要な現行非公開情報が見つかった場合はOwnerのPrivate保管先決定まで停止する。

旧Source ID/URLは出典識別だけに使う。旧ページへアクセスする手順、同期Job、Tokenは不要。未移行範囲はdesign-gatesで明示し、存在しない根拠を推測しない。旧Epic/Taskの一括移行は今回行わない。
