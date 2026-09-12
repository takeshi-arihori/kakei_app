# Group招待・再参加のLifecycleと整合性境界

- Status: Proposed
- Decision record: [GitHub ADR Proposal #52](https://github.com/takeshi-arihori/kakei_app/issues/52)
- Related Task: [#41](https://github.com/takeshi-arihori/kakei_app/issues/41)
- Proposed Date: 2026-09-13
- Decision Owner: Project Owner
- Related ADR: [共有割り勘の設計境界](shared-expense-domain-boundaries.md)、[整合性境界](group-management-consistency-boundary.md)、[Command本人性・認可・再試行](group-management-command-authorization.md)
- Analysis: [招待・参加・再参加の判断入力](../domain/group-invitation-rejoin-proposal.md)
- Decision Check: 方針変更あり（Invitation lifecycle、再参加のParticipant寿命、認可時点を追加で決める）
- Relationship: ADR #35/#36の未決事項を補完するProposal。C1のSecurity条件、Persistence #42、本番認証・配送の採用を代替しない。

## Context

現行ScopeはOwnerによる招待と、招待された利用者の参加を要求する。一方で、招待の宛先本人性、期限、取消、人数枠、Owner譲渡中の扱い、受諾とParticipant追加の原子性、脱退後の再参加は未決である。現在のGroup実装は同一Actorの再参加を明示的に拒否している。

## Decision Proposal

Project Ownerへ次の案Aを提案する。

- InvitationはGroup Managementが所有する、宛先の信頼済みActorに束縛されたPending recordとする。InvitationはParticipantや人数枠ではない。
- Pending Invitationはサーバ生成のexpiryAtまで有効とし、期限は7日、延長は行わず再発行する。現在OwnerはPending Invitationを取消できる。
- Active人数が4人ならInviteParticipantを拒否する。3人以下では複数Invitationを作れるが、枠を予約しない。AcceptInvitation時にGroupの最新version、Active、宛先、期限、空き枠、Active重複を再検証する。
- Owner譲渡後も既存Pending Invitationは有効とする。発行者は作成時の事実として残り、現在Ownerは取消できる。旧Ownerは譲渡後に新規作成・取消を行えない。
- AcceptInvitationはInvitation消費、新ParticipantId、未使用で単調なjoinOrder、Membership履歴、Group version、operation結果を1つの原子的commitで成立させる。Conflictを自動再試行しない。応答喪失は同じActorとoperationIdで照合する。
- LeftになったActorの再参加は、新Invitationの受諾だけで認める。新しいParticipantIdと過去最大より大きいjoinOrderを発行し、旧Participant、過去Expense、Settlement責務を変更しない。

このProposalは本番の認証Provider、Token形式、配送方法、DB/暗号化、Retention、公開GraphQL Errorを選定しない。Accepted後もそれらの実装は別Task／DecisionでReady評価する。

## Alternatives

| Option | Invitation / Capacity | Owner譲渡 | Rejoin | Benefit | Cost / Risk |
| --- | --- | --- | --- | --- | --- |
| A: 宛先束縛・受諾時再検証・新Participant（Proposal） | 期限7日、取消可、枠予約なし。4人ならInvite拒否 | Pendingは継続、現在Ownerが取消 | 新ID・単調joinOrder | 枠を期限切れ招待で塞がず、過去責務を明確に残す | 受諾時に枠が埋まり失敗し得る。期限7日のProduct確認が必要 |
| B: Invitationで枠予約 | Pendingが将来枠を占有 | 発行者の権限変更で自動取消 | 旧IDを再活性化 | 招待者に参加可能性を約束できる | 招待放置で容量を失い、予約・期限・取消の競合が増え、過去責務と現在在籍を混同し得る |
| C: Owner譲渡で全Pending自動失効 | 枠方式は別途必要 | 全て無効 | 新IDまたは旧IDは別途 | 現在Ownerの意図だけでPendingを扱える | 招待された利用者の同意を譲渡で失わせ、再発行・通知が必要 |

## Consequences / Required Follow-up

- InvitationとParticipant追加はGroupの人数・Owner・joinOrderと同じ整合性境界で扱う候補である。ただしData model、Repository Port拡張、保存方式は未実装である。
- AcceptInvitationに必要なtrusted ActorはADR #36の内部契約に留まる。本番本人性・宛先解決・外部Errorは別Security Decisionまで公開しない。
- 期限7日、再発行、取消、枠予約なし、Owner譲渡後の継続、新Participant方式はProject Ownerの明示Acceptedが必要である。Rejectedなら本Proposalを採用せず、#41の比較表だけを記録する。
- 同一ActorのLeft履歴を許すため、Groupの`REJOIN_NOT_DECIDED`はAccepted後に別Taskで変更候補となる。既存Groupの履歴や他Context参照を直接書き換えない。
- 受諾後にExpense／SettlementがどのParticipantを参照し、参加・脱退・Expense作成が競合した時の認可時点は別Context間Decisionである。
- C1未充足、冪等operation結果の保存期限・削除・保護、Invitationの保存最小化・暗号化、Backup／Projectionは未決である。Persistence #42をReadyにしない。

## Implementation Boundary

Owner Accepted前にInvitation、AcceptInvitation、再参加、Schema、Migration、GraphQL、HTTP、配送、Token、認証Providerを実装しない。Accepted後に少なくとも次を個別TaskとしてReady評価する。

1. Invitation lifecycleとAcceptInvitationのDomain/Application契約・fake検証。
2. 本番本人性・宛先解決・外部ErrorのSecurity Decision。
3. 保存方式がC1と独立Security Reviewを満たす場合だけのPersistence Adapter。
4. Expense Recording／SettlementへのParticipant参照・認可時点のContext間契約。

## Owner Decision

未決。Project Ownerは案A、B、C、または修正案を選び、少なくとも期限、枠予約、Owner譲渡後のPending、再参加Participant寿命を明示する。ProposalのMergeやIssue更新だけではAcceptedにならない。

## Rollback / Review Trigger

Proposedの間はこの文書と関連Issueを取り下げられる。Accepted後の変更はこのADRを直接書き換えず、新しいADRで互換性、既存Invitation、Membership履歴、削除、forward-fixを判断する。認証方式、配送、期限、Group終了、Context間認可、保存Security条件の変更をReview Triggerとする。
