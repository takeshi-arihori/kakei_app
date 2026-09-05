# GitHub正本の入口

Notionは読み書きしない。2026-09-05のOwner承認は[ADR #17](https://github.com/takeshi-arihori/kakei_app/issues/17)に記録した。切替の実施結果と、現在使用する**固定Commit URL**も同Issueの「Cutover実施記録」で管理する。

## 何をどこで管理するか

| 情報 | 正本 |
| --- | --- |
| Epic・TaskのRequirement、Done Criteria、依存、Owner、PR URL | GitHub Issue本文 |
| Status、Sprint、Story Points、優先度、分類 | [Private Project #9](https://github.com/users/takeshi-arihori/projects/9)のField |
| 現行仕様・業務Rule・設計・運用文書 | このRepositoryの指定された固定Commit |
| Decision本文・Status・履歴 | docs/adr。承認と切替実行の証跡は関連Issue |
| 実装のレビューと統合 | develop向けPull Request |

同じ情報を二重に編集しない。Issue本文にProject Fieldの要約を記載した場合は同時更新し、食い違いを再取得で検出する。ProjectだけPrivateにしてもPublic RepositoryのIssue/PRは公開される。

## develop未同期の期間

今回のPRはDraftのままで、Mergeしない。したがって、`develop`をそのまま読むと旧運用指示が残る。
次の担当者は最初にADR #17のCutover実施記録から固定Commitを開き、そのCommitのAGENTS.md、Skill、仕様を使う。切替実施記録がまだなければ切替準備中であり、完了と推測しない。

Scrum Working AgreementとIssue Formは[PR #20](https://github.com/takeshi-arihori/kakei_app/pull/20)の承認済み[固定Commit](https://github.com/takeshi-arihori/kakei_app/tree/85f3d6205171ab3e28d0ba9a92b87d90eb183a19)を使用する。FormがdevelopにMergeされるまでは通常の新規Issue画面に自動表示されないため、この固定CommitのFormを基にIssue本文を整える。

正本切替Taskは[Issue #19](https://github.com/takeshi-arihori/kakei_app/issues/19)。文書とSkillの固定CommitはそのDraft PR作成後にADR #17へ追記する。Merge後にOwnerが確認して正本参照先をdevelopへ更新する。Branch名だけを正本の識別子にしない。

## 読む順序

1. [現行Product Scope・業務モデル](../product/current-model.md)
2. [未確定・未移行Gate](../product/design-gates.md)
3. [ADR一覧](../adr/README.md)
4. [開発ガイド](../engineering/README.md)と対象Issue
5. [Scrum Working Agreement](https://github.com/takeshi-arihori/kakei_app/blob/85f3d6205171ab3e28d0ba9a92b87d90eb183a19/docs/engineering/scrum-working-agreement.md)

## 公開と保留

公開前にSecret・PII・実在金融情報・内部Security情報を機械検査と手動Reviewで確認する。未分類・要編集・非公開情報をPublic Repositoryへ書き込まない。必要な現行非公開情報が見つかった場合はOwnerのPrivate保管先決定まで停止する。

旧Source ID/URLは出典識別だけに使う。旧ページへアクセスする手順、同期Job、Tokenは不要。未移行範囲はdesign-gatesで明示し、存在しない根拠を推測しない。旧Epic/Taskの一括移行は今回行わない。
