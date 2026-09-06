# GitHub正本への切替

- Status: Accepted
- Owner: Project Owner（takeshi-arihori）
- 承認日: 2026-09-05
- Decision Check: 方針変更あり
- 承認・発効記録: [Issue #17](https://github.com/takeshi-arihori/kakei_app/issues/17)
- 実装: [Board #18](https://github.com/takeshi-arihori/kakei_app/issues/18)、[切替 #19](https://github.com/takeshi-arihori/kakei_app/issues/19)

## Context

OwnerはNotionを今後一切使用しないと明示し、試験Boardの構築からGitHubへの正本切替・開発ルール変更まで今回進めることを承認した。Publicなコード開発とPrivateな作業Boardを両立する。

## Decision

RepositoryはPublicを維持し、Project #9はPrivateとする。Issueを要件・完了条件、Projectを進捗・Sprint、Repositoryを仕様・設計・ADR・運用文書の正本とする。Notionを再取得・更新・同期しない。公開確認済み情報だけを公開し、非公開のまま必要な現行情報はOwnerのPrivate保管先決定まで扱わない。

旧ADR-20のPublic Repository / Private Project / 公開Security Gateは維持する。Notion保持・切替前正本・Notionへ戻すRollbackという条件をAmendsする。旧ADR-14のNotion正本方針は、#17のCutover実施記録をもってSupersededとする。旧ページの変更・削除は行わない。

## Alternativesと理由

Notion併用はOwnerの利用停止意向に合わない。Repository全体のPrivate化はPublic開発を維持する承認方針に合わない。GitHub Issue・PR・Projectを連携させ、公開前ReviewとPrivate Boardによって情報の公開範囲を管理する。

## Consequences・Implementation

Boardと正本切替を別Task、別Branch、別Draft PRに分ける。Board実体検証、公開安全な現行仕様・ルール、独立Evaluatorのpassを確認後、#17とProject READMEへ固定Commitを指すCutover実施記録を保存する。Draft PRはMergeせず、develop未同期を明記する。次担当はその固定Commitを読む。

実施時点では上記の固定CommitをCutover根拠とした。その後、Boardと正本切替のPull Requestは2026-09-06にMergeされ、現在は`develop`を参照する。固定Commitは監査証跡として保持する。

移行漏れを隠さず、未移行・未確定事項を設計Gateとして管理する。旧Epic/Task全件の移行や要編集情報の生コピーはしない。現在の既知の業務Ruleは公開済みRepositoryの記録を整理し、新しい業務判断を加えない。

## Rollback・Review Trigger

原則forward-fix。重大欠損・Security事故の場合だけOwner判断でGitHubの既知の正常版へ戻す。Notion運用には戻さない。pilot ItemはArchive、ProjectはClose、Draft PRはCloseで取り下げ可能。公開済みSecretが判明した場合は削除だけで安全とせず失効と影響調査を行う。

仕様欠落、公開範囲の変更、運用障害、正本Commitの切替、PR Merge時に見直す。
