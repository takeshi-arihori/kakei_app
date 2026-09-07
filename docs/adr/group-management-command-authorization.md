# Group Commandの本人性・認可・競合と再試行

- Status: Proposed
- Decision record: [GitHub ADR #36](https://github.com/takeshi-arihori/kakei_app/issues/36)
- Related Task: [設計Task #37](https://github.com/takeshi-arihori/kakei_app/issues/37)
- Proposed Date: 2026-09-07
- Decision Owner: Project Owner
- Owner Decision / Accepted Date: 未取得
- Related ADR: [ADR #24](shared-expense-domain-boundaries.md)、[整合性境界Proposal](group-management-consistency-boundary.md)
- Analysis: [最初の実装境界](../domain/group-management-first-boundary.md)
- Decision Check: 方針変更あり（認可・再試行方式を具体化する）
- Relationship: ADR #24の未決詳細を補完する。C1のSecurity ADR／充足証拠を代替しない。

## Context

Client申告のParticipantId・Owner Roleだけでは本人性を証明できない。Owner変更と古い権限での更新、応答喪失後の再送が重なってもGroup Invariantを守る必要がある。現状APIには本人性を確認する実装がなく、既存Security詳細は未移行である。

## Decision（提案A、未採用）

- 最初はApplicationに信頼済みActorSubjectを渡す内部契約だけを定義する。テストは架空Actorとfakeを用いる。認証Provider、Session、Token検証を選定したことにはしない。本番Presentation接続はそのDecisionまでBlocked。
- CreateGroupは信頼済みActor本人を作成者とする。TransferGroupOwnershipは同じ版の現在Ownerだけ、LeaveGroupは同じ版のActive Participant本人かつ非Ownerだけ。非Ownerの他人除名は提供しない。
- 認可した版と保存のexpectedVersionを一致させ、権限が変わったら部分保存せず競合失敗とする。Clientが渡すRoleやsubjectの自己申告を信頼済みActorへ変換しない。
- 未認証、本人不一致、他Group参照、不正招待は状態・履歴・operation結果を作らない。外部応答は非在籍者にGroup存在を漏らさないUnavailableToActorへ統一する案。内部のNotFound／Forbiddenとの変換は本番接続前に定義する。
- Actor内operationIdを全Command共通で一意とし、分析文書のfingerprintで対象・内容を束縛する。同一Actor・同一内容の成功済み再送だけ同じ最小結果を返す。異なる内容はOperationMismatch、異なるActorからの結果取得は拒否する。
- 成功済みCommand結果の再取得は現在のOwner権限が失われても同じActorに限り許す案。返却は当該結果のID・versionだけで現在Groupの参照権限は付与しない。Ownerの明示判断が必要な例外である。
- 未記録／失敗後の操作は最新状態で再認可する。Conflictで変更した入力・期待版を使う場合は新operationId。成功したか不明なUnavailableは同一operationを照合する。失敗結果は記録しない案。

## Alternatives

| Option | 利点 | 不利益 |
| --- | --- | --- |
| A: 信頼済みActor＋Group版で認可し原子的な結果記録 | 権限変更と更新の競合・応答喪失を扱える | 結果保存の最小化・保持・削除が必要。本番は後続Security Decision待ち |
| B: 各再送で現在権限だけ再評価 | 過去成功結果の返却例外がない | 譲渡成功後の応答喪失を旧Ownerが確認できない。別の操作照会方式が必要 |
| C: 認証方式・招待まで同時に実装 | 利用者が操作できる経路まで届けられる | 未移行Security判断とInvitation Lifecycleを一度に確定する必要があり、最初の1〜2日境界を越える |

## Consequences / Open Questions

- 招待の宛先本人性、期限、取消、消費と参加の原子性、招待中の人数枠、旧Owner発行招待の扱いは後続設計TaskでADR入力へ分離する。InviteParticipant／AcceptInvitationはこのProposalだけで実装Readyにならない。
- ActorSubjectと利用者の対応、認証失効、本番Error、Rate limit、Auditの最小項目は未決。本番経路接続をBlockedにする。
- 冪等記録とfingerprintの保存期限・削除・保護は未決。Group削除後も識別可能なoperation結果を残してよいとは判断しない。Persistence実装をBlockedにする。
- Leftへの支払責務はSettlementが過去Instructionに基づいて判定する。在籍照会のfalseを全Context共通の拒否に使わない。Context間の競合契約は別Decision。
- C1の最小保存、暗号化・鍵管理、Group内認可、Backup／Projection含む保持・削除、独立Security Reviewは今回未充足のまま。

## Implementation / Acceptance Gate

OwnerはA/B/C、本人脱退のみ、認可版の固定、結果再取得の例外、失敗結果非保存、後続Gateを判断する。Acceptedまでは依存Application実装TaskをReadyにしない。Accepted後も内部fake検証を本番認証・保存の証拠にしない。

権限表の許可／拒否、別Group ID差替え、旧Ownerの保存競合、同一再送、payload不一致、異なるActor、保存成功後の応答喪失、Unavailableの照合を検証する。認証Secretや実在する利用者DataはFixture／Logへ含めない。

## Rollback / Review Trigger

ProposedをRejectedにする場合は依存TaskのRequirement・DC・Decision Checkを戻す。採用後の方式変更は新ADRへ分離する。認証Provider採用、招待・再参加、本番接続、退会／削除、跨Context操作、監査要件の発生をReview Triggerとする。
