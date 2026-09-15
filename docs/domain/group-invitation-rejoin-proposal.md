# Group招待・参加・再参加の判断入力

- Knowledge State: Accepted / Implemented internally。2026-09-13にProject OwnerがADR #52の案Aを採用し、Task #57でDomain／Application内部契約とfake Repository検証を実装した。本番接続と保存は未決Gateを維持する。
- Scope source: [現行Product Scope](../product/current-model.md)、[設計Gate](../product/design-gates.md)、[初回境界](group-management-first-boundary.md)
- Related accepted decisions: [整合性境界](../adr/group-management-consistency-boundary.md)、[Command本人性・認可・再試行](../adr/group-management-command-authorization.md)
- Accepted decision: [招待・再参加](../adr/group-invitation-and-rejoin.md)

## 1. Problem / Scope

Group Ownerが特定の利用者を招待し、その利用者だけが参加できるようにする。Groupは1〜4人であるため、複数の招待受諾が重なっても5人状態を作らない。脱退済みの利用者が再度参加するとき、過去の支出・精算責務と新しい在籍を混同しない。

成功は、招待の作成者・宛先・状態・期限を説明でき、受諾の成功時にはInvitation消費、Participant追加、参加履歴、版、operation結果が一括で成立すること。失敗時はこれらの一部だけを反映しないこと。

対象はGroup Managementの設計だけである。対象外は認証Provider、Tokenやメール配送、DB/Schema、GraphQL/UI、Group終了、Expense／Settlementの実装、Context間の認可連携、本番Persistenceである。C1は未充足であり、#42の保存AdapterをReadyにしない。

## 2. System Context

| Element | Type | Responsibility / Interaction | Evidence |
| --- | --- | --- | --- |
| 現在のGroup Owner | Actor / Group内Role | Active Groupの招待を開始し、Pending Invitationを取消す | current-model、ADR #52 |
| 招待された利用者 | Actor | 自分宛のInvitationを受諾して参加する | current-model: 招待された利用者が参加 |
| Group Management | Target System | Invitationと現在Participantを管理し、人数とOwnerの不変条件を守る | ADR #35／#36 |
| 本人性を確認する仕組み | External boundary（未決） | 信頼済みActorSubjectをApplicationへ渡す | ADR #36。Providerは未選定 |
| Expense Recording / Settlement | System内の別Context | 過去のParticipantと支払責務を所有する | ADR #24。参加・再参加と直接同期しない |

## 3. Use Cases

| Use Case | Actor | Goal / Trigger | Preconditions | Success Outcome | Boundary / Failure |
| --- | --- | --- | --- | --- | --- |
| InviteParticipant | 現在Owner | 特定の利用者をGroupへ招待する | Active Group、信頼済みActorが現在Owner、宛先Actorが決まる、Active 3人以下 | 期限7日のPending Invitationが作成される。枠は予約しない | 非Owner、Archived、同一ActorのActive在籍、4人、期限不正を拒否 |
| CancelInvitation | 現在Owner | Pending Invitationを無効にする | Active Group、現在Owner、Pending | InvitationがCancelledになる | 取消済み／消費済み／期限切れは変更しない。旧Owner発行分も現在Ownerが取消す |
| AcceptInvitation | 招待された利用者 | 自分宛のInvitationを受諾して参加する | 信頼済みActorが宛先、Pending、未期限切れ、Active Group、空き枠 | InvitationがConsumedになり、新Participantと参加履歴が同一commitでできる | 他人、取消・期限切れ、4人、Archived、既にActive、競合は部分反映なし |
| RejoinGroup | 脱退済み利用者 | 新しいInvitationを受諾して再び参加する | Left履歴、本人宛の有効Invitation、上記Accept条件 | 過去Participantを残し、新Participantと単調なjoinOrderを作る | 過去Expense／Settlementは変更しない |

## 4. Concrete Examples / Object Model

| Scenario | Objects / Relationship | Expected Rule / Outcome | State |
| --- | --- | --- | --- |
| 3人のG-AでOwner P-AがU-DへI-Dを作成 | Active={P-A,P-B,P-C}, I-D.target=U-D, Pending | I-DはParticipantではない。受諾でP-Dを追加し4人になる | Accepted |
| 3人のG-AでI-D/I-Eを同時に受諾 | 両者がv7、空き1枠を読む | 先にcommitした一方だけ4人へ成功。後続はConflictまたは再読込後CapacityExceeded。5人状態なし | Accepted |
| 4人のG-AでOwnerがI-Eを作ろうとする | ActiveCount=4 | Inviteを拒否し、Invitationを作らない | Accepted |
| I-Dの宛先U-D以外が受諾 | I-D.target=U-D、actor=U-E | 結果・Group存在を返さず、状態・履歴・operation結果を作らない | Accepted。外部Errorの形は本番認証Decision待ち |
| P-AがI-Dを発行後、P-BへOwner譲渡 | issuer=P-A、currentOwner=P-B、I-D=Pending | I-Dは有効で、P-Bが取消できる。P-Aは新規作成・取消不可 | Accepted |
| U-DがAccept成功後に応答を失う | 同じActor、operationId、fingerprint | 同じ最小結果を再取得し、Invitation消費・Participant追加を重複しない | Accepted |
| U-CがP-CとしてLeft後、新Invitationを受諾 | P-C.leftAtあり、U-C宛I-C2、maxJoinOrder=4 | 新P-C2、joinOrder=5を作り、P-Cを変更しない。過去責務は旧P-Cを参照する | Accepted / #57で内部契約を実装 |

## 5. Domain Concepts / Domain Model

| Concept | Meaning / Identity | Lifecycle | Relationships | State |
| --- | --- | --- | --- | --- |
| Invitation | 特定ActorへGroup参加の意思を伝える招待。InvitationIdで追跡する | Pending → Consumed / Cancelled / Expired | 1 Group、1 target Actor、1 issuer、0..1 resulting Participant | Accepted |
| Invitation target | 招待を受諾できる信頼済みActorSubject | Invitation作成時に固定 | Invitationの宛先。メールアドレスやTokenではない | Accepted内部契約 |
| Invitation issuer | Invitationを作成した当時のOwner | 作成時の事実として保持する | current Ownerと異なり得る | Accepted |
| Participant | Groupに参加した在籍の単位 | Active → Left。再参加時は新しいParticipantを作る | Groupが所有。過去Expense／Settlementは当時のParticipantを参照 | Accepted |
| Group Owner | Active Participantの現在Role | 譲渡で変更 | Invite/Cancelを許可する現在Role | Accepted |

### Implementation Evidence

Task #57はGroup Aggregate内へInvitationId、宛先Actor、発行者、作成時刻、7日固定の期限、Pending／Consumed／Cancelled／Expiredを追加した。InviteParticipant、CancelInvitation、AcceptInvitationはActive人数・現在Owner・宛先・期限・Active重複を同じGroup状態で検証する。ApplicationのGroupRepository PortはInvitation変更、Membership変更、Group版、Actor単位のoperation結果を単一commitへ渡す。Left Actorの受諾は旧Participantを保持したまま新ParticipantIdと過去最大+1のjoinOrderを作る。本番Persistence、本人性、配送、公開APIは実装していない。

| Model Element | Implementation Evidence | Alignment | Feedback | Knowledge State |
| --- | --- | --- | --- | --- |
| Active人数1〜4、Owner | `apps/api/src/domain/group-management/group.ts` | Aligned | Invitation作成・受諾でも人数とOwnerを同じAggregateで検証する | Confirmed / Accepted / Implemented |
| Active→Left履歴と再参加 | 同上 | Aligned | 同じActorのLeft履歴を残し、新しいParticipantを追加する | Accepted / Implemented internally |
| Invitation lifecycle | `apps/api/src/domain/group-management/group.ts`、`group-invitations.spec.ts` | Aligned | 7日固定、4状態、Owner認可、受諾時再検証を純粋Domainで検証する | Accepted / Implemented internally |
| 原子的Command契約 | `apps/api/src/application/group-management/group-command-service.ts`、`group-repository.ts`、`group-command-service.spec.ts` | Aligned | fake RepositoryでInvitation・Membership・版・operation結果の原子性、競合、応答喪失再送を検証する | Accepted / Implemented internally |

## 6. Business Rules / Invariants

| Rule ID | Rule | Applies To | Evidence | State | Counterexample / Boundary |
| --- | --- | --- | --- | --- | --- |
| GI-01 | Active Groupは1〜4人、OwnerはActive Participantで1人 | Group | current-model、ADR #35 | Confirmed / Accepted | 同時受諾で5人またはOwner不在を作らない |
| GI-02 | Ownerだけが招待する | InviteParticipant | current-model | Confirmed | Clientのowner=trueや旧Ownerを現在Ownerとして扱わない |
| GI-03 | Invitationは宛先の信頼済みActorだけが受諾できる | AcceptInvitation | ADR #36/#52 | Accepted | 他Actorへ招待結果・Group存在を漏らさない |
| GI-04 | 消費、Participant追加、joinOrder、Group版、operation結果は同一commitで成立する | AcceptInvitation | ADR #35/#36/#52 | Accepted | 応答喪失、同時受諾でInvitationだけ消費しない |
| GI-05 | Pending Invitationは作成時から7日で期限切れとなり、延長せず、取消または期限切れ後に受諾できない | Invitation | ADR #52 | Accepted | Client時刻で期限を延長しない |
| GI-06 | 再参加は旧Participantを再活性化せず、新ParticipantIdと未使用のjoinOrderを作る | RejoinGroup | ADR #52 | Accepted | P-Cの過去Expense参照をP-C2へ書き換えない |
| GI-07 | 参加・再参加は過去Expense／SettlementのParticipant、割合、支払責務を変更しない | Cross-context | current-model | Confirmed | Active membershipだけで過去Instructionを無効にしない |
| GI-08 | Invitationは枠を予約しない。4人時はInviteを拒否する。Owner譲渡後もPendingは継続し、現在Ownerが取消す | Invitation / Group | ADR #52 | Accepted | Pending InvitationをActive Participantとして数えない |

## 7. Ubiquitous Language

| Japanese | English | Definition | Context | Avoided Terms | Example |
| --- | --- | --- | --- | --- | --- |
| 招待 | Invitation | 特定Actorへ参加機会を与える、Participantではない記録 | Group Management | Member、招待URL | I-D is Pending |
| 宛先 | Invitation target | Invitationを受諾できる信頼済みActor | Group Management | 任意のリンク利用者 | U-D |
| 発行者 | Invitation issuer | Invitationを作った当時のOwner | Group Management | 常に現在Owner | P-A |
| 受諾 | Accept invitation | Invitation消費と新しい在籍を同時に成立させる操作 | Group Management | Ownerによる代理追加 | I-D → P-D |
| 再参加 | Rejoin | Left履歴を残したActorが新Invitationで新たに参加すること | Group Management | LeftをActiveへ戻すこと | P-C → P-C2 |
| 枠予約 | Capacity reservation | Pending Invitationが将来の人数枠を占有する方式。ADR #52では採用しない | Group Management | Active Participant | 3人時のI-D |

## 8. Confirmed Decisions

- Active Groupは1〜4人で、現在Ownerが1人だけである。根拠はcurrent-modelとADR #35。
- OwnerだけがParticipantを招待でき、招待された利用者が参加する。Invitationは期限7日・延長なし・再発行、枠予約なし、4人時Invite拒否とする。根拠はcurrent-modelとADR #52。
- Owner譲渡後もPending Invitationは継続し、現在Ownerが取消す。旧Ownerは新規作成・取消を行えない。根拠はADR #52。
- Invitation消費、新Participant、単調joinOrder、履歴、Group version、operation結果は原子的に成立する。再参加は旧Participantを変更しない。根拠はADR #52。
- 脱退後も過去の支出・精算責務を上書きしない。根拠はcurrent-model。
- 本番本人性、公開Command、Persistenceは未決であり、信頼済みActorの内部契約を本番認証の証拠にしない。根拠はADR #36。

## 9. Accepted scope / Remaining assumptions

| Item | State | Reason | Follow-up |
| --- | --- | --- | --- |
| 宛先Actorに束縛されたInvitationとPending/Consumed/Cancelled/Expired lifecycle | Accepted / Implemented internally | 他人の受諾と二重消費を防ぐため | 本番宛先解決は別Decision |
| 期限はサーバClockで判定し、作成時から7日、延長なし・再発行 | Accepted / Implemented internally | Client時刻の操作を避け、再試行を決定的にするため | 本番Clock接続は公開境界Taskで検証 |
| 枠はInvitation作成時に予約せず、4人時はInvite拒否、Accept時にも再検証 | Accepted / Implemented internally | 期限切れ招待で空き枠を塞がないため | 同時受諾をfake Repositoryで検証済み |
| 旧Owner発行のPending Invitationは譲渡後も有効で、現在Ownerが取消できる | Accepted / Implemented internally | 発行時の正当性と現在の管理責任を両立するため | Owner譲渡後の権限をDomain Testで検証済み |
| 再参加は新ParticipantId・単調なjoinOrderを使う | Accepted / Implemented internally | 過去責務と現在在籍を混同しないため | Context間参照は別Decision |

## 10. Open Questions / Conflicts

| ID | Type | Question / Conflict | Impact | Required Decision / Evidence |
| --- | --- | --- | --- | --- |
| OQ-I4 | Open Question | 宛先Actorを本番でどう解決し、招待をどう配送するか | Security／Privacy、公開API | 本番認証・配送の別ADR |
| OQ-I5 | Open Question | 再参加後のParticipant参照をExpense／Settlementがいつ採用するか | Context間認可、過去責務 | Context間契約ADR。今回は実装しない |
| OQ-I7 | Open Question | Invitationとoperation結果を本番でどう保護・保持・削除するか | Security／Privacy、Persistence | 保存Security Decision。#42をReadyにしない |

## 11. Next Modeling Step

1. 公開本人性・宛先解決・配送を別Security DecisionとReady Gateで具体化する。
2. 保存最小化・保護・RetentionとContext間参照をそれぞれのDecisionへ分離する。Task #57の内部fake検証を本番接続・保存の証拠にしない。
3. C1未充足とPersistence #42のBacklog / Blocked Yesを維持する。
