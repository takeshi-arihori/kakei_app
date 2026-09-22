# ADR

Decision本文はこのディレクトリで管理する。Owner承認、関連Task、実施記録はGitHub Issueへリンクする。新規ADRは衝突しないslugを使い、Proposedから始める。

| Decision | Status | 関係・証拠 |
| --- | --- | --- |
| [GitHub正本への切替](github-canonical-cutover.md) | Accepted | [Owner承認・切替実施記録 #17](https://github.com/takeshi-arihori/kakei_app/issues/17) |
| [Mermaid図をRepository正本とする](mermaid-diagram-source-of-truth.md) | Accepted | [Owner承認 #13](https://github.com/takeshi-arihori/kakei_app/issues/13)、[実装Task #22](https://github.com/takeshi-arihori/kakei_app/issues/22) |
| [共有割り勘の設計境界と永続化方針](shared-expense-domain-boundaries.md) | Accepted（条件C1充足済み） | [設計入力Task #9](https://github.com/takeshi-arihori/kakei_app/issues/9)、[条件付き承認 #24](https://github.com/takeshi-arihori/kakei_app/issues/24)、[C1証拠 #55](https://github.com/takeshi-arihori/kakei_app/issues/55) |
| [Snapshot Revisionの保護と保持境界](snapshot-revision-security-and-retention.md) | Accepted / Active | [C1 ADR #55](https://github.com/takeshi-arihori/kakei_app/issues/55)、[正式Review](https://github.com/takeshi-arihori/kakei_app/issues/55#issuecomment-5748185586)、[統合PR #70](https://github.com/takeshi-arihori/kakei_app/pull/70) |
| [Group operation locatorとGroup IDの保存契約](group-operation-locator-and-group-id-contract.md) | Accepted / Active | [ADR #85](https://github.com/takeshi-arihori/kakei_app/issues/85)、[契約Task #86](https://github.com/takeshi-arihori/kakei_app/issues/86)、[Adapter Task #42](https://github.com/takeshi-arihori/kakei_app/issues/42) |
| [Group終了の整合性と保持期限境界](group-close-consistency-and-retention-boundary.md) | Accepted / Active | [ADR #73](https://github.com/takeshi-arihori/kakei_app/issues/73)、[Owner承認](https://github.com/takeshi-arihori/kakei_app/issues/73#issuecomment-5755615829)、[正式Review](https://github.com/takeshi-arihori/kakei_app/issues/73#issuecomment-5755728805)、[統合PR #80](https://github.com/takeshi-arihori/kakei_app/pull/80) |
| 旧ADR-14のNotion正本方針 | Superseded（#17のCutover実施記録発効時） | #17のCutover実施記録が発効点。旧ページは更新しない |
| 旧ADR-20のPublic Repository / Private Project / 公開Gate | Accepted、部分修正 | 正本・Rollbackの条件を新ADRがAmends。全部置換しない |

ほかの旧ADR全文は未移行である。現在のRepository不変条件は維持するが、過去ADRの詳細が必要な変更は[設計Gate](../product/design-gates.md)に従い、GitHub上で根拠を確定するまでReadyにしない。Notionの再取得で補わない。

ADRにはContext、Decision、Alternatives、Consequences、Implementation、Review Trigger、Owner承認日を含める。完全置換だけSupersedes/Superseded By、一部変更はAmendsで表す。承認済みの履歴を消さない。

## Group ManagementのDecision

- [整合性境界とParticipantの表現](group-management-consistency-boundary.md): Accepted（条件付き）。GroupをRootとする初回整合性境界とRepository Portを採用。
- [Command本人性・認可・再試行](group-management-command-authorization.md): Accepted（条件付き）。信頼済みActorとGroup版による認可、成功結果の冪等再取得を採用。
- [招待・再参加のLifecycleと整合性境界](group-invitation-and-rejoin.md): Accepted。期限7日・枠予約なし・Owner譲渡後のPending継続・新Participantによる再参加を採用。
- [Group終了の整合性と保持期限境界](group-close-consistency-and-retention-boundary.md): Accepted / Active。Close Intent、Context所有fence／Receipt、Closing認可、2月29日clampを採用。正式Security ReviewとPR #80のdevelop統合を確認し、#75はReady評価済み。
- [Group operation locatorとGroup IDの保存契約](group-operation-locator-and-group-id-contract.md): Accepted / Active。Actor内全Group共通の再送locator、locator key rotation、canonical Group IDを採用する。#86が契約を、#42がPostgreSQL Adapterを実装する。

[設計分析](../domain/group-management-first-boundary.md)を参照する。Invitation lifecycleと再参加Participant寿命はAccepted。Snapshot Revisionの保護・保持Decisionは正式Security Review passとdevelop統合が揃い、C1は充足済みである。本番本人性・配送とProduction Gateは未決または未実装であり、PersistenceはS0〜S3とTask固有Gateに従う。
