# ADR

Decision本文はこのディレクトリで管理する。Owner承認、関連Task、実施記録はGitHub Issueへリンクする。新規ADRは衝突しないslugを使い、Proposedから始める。

| Decision | Status | 関係・証拠 |
| --- | --- | --- |
| [GitHub正本への切替](github-canonical-cutover.md) | Accepted | [Owner承認・切替実施記録 #17](https://github.com/takeshi-arihori/kakei_app/issues/17) |
| [Mermaid図をRepository正本とする](mermaid-diagram-source-of-truth.md) | Accepted | [Owner承認 #13](https://github.com/takeshi-arihori/kakei_app/issues/13)、[実装Task #22](https://github.com/takeshi-arihori/kakei_app/issues/22) |
| [共有割り勘の設計境界と永続化方針](shared-expense-domain-boundaries.md) | Accepted（条件C1未充足） | [設計入力Task #9](https://github.com/takeshi-arihori/kakei_app/issues/9)、[条件付き承認 #24](https://github.com/takeshi-arihori/kakei_app/issues/24) |
| [Snapshot Revisionの保護と保持境界](snapshot-revision-security-and-retention.md) | Accepted（C1有効化はdevelop統合待ち） | [C1 ADR #55](https://github.com/takeshi-arihori/kakei_app/issues/55)、[判断入力Task #54](https://github.com/takeshi-arihori/kakei_app/issues/54) |
| 旧ADR-14のNotion正本方針 | Superseded（#17のCutover実施記録発効時） | #17のCutover実施記録が発効点。旧ページは更新しない |
| 旧ADR-20のPublic Repository / Private Project / 公開Gate | Accepted、部分修正 | 正本・Rollbackの条件を新ADRがAmends。全部置換しない |

ほかの旧ADR全文は未移行である。現在のRepository不変条件は維持するが、過去ADRの詳細が必要な変更は[設計Gate](../product/design-gates.md)に従い、GitHub上で根拠を確定するまでReadyにしない。Notionの再取得で補わない。

ADRにはContext、Decision、Alternatives、Consequences、Implementation、Review Trigger、Owner承認日を含める。完全置換だけSupersedes/Superseded By、一部変更はAmendsで表す。承認済みの履歴を消さない。

## Group ManagementのDecision

- [整合性境界とParticipantの表現](group-management-consistency-boundary.md): Accepted（条件付き）。GroupをRootとする初回整合性境界とRepository Portを採用。
- [Command本人性・認可・再試行](group-management-command-authorization.md): Accepted（条件付き）。信頼済みActorとGroup版による認可、成功結果の冪等再取得を採用。
- [招待・再参加のLifecycleと整合性境界](group-invitation-and-rejoin.md): Accepted。期限7日・枠予約なし・Owner譲渡後のPending継続・新Participantによる再参加を採用。

[設計分析](../domain/group-management-first-boundary.md)を参照する。Invitation lifecycleと再参加Participant寿命はAccepted。本番本人性・配送は未決である。Snapshot Revisionの保護・保持DecisionはAcceptedだが、正式Security Review passとAccepted ADRのdevelop統合が揃うまでC1は未充足とし、PersistenceはBlockedを維持する。
