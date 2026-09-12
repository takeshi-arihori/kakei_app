# Group招待・参加・再参加の判断入力

- Knowledge State: Proposed。2026-09-13にIssue #41の判断入力として作成した。Project OwnerのAcceptedまではInvitation、AcceptInvitation、再参加の実装へ進めない。
- Scope source: [現行Product Scope](../product/current-model.md)、[設計Gate](../product/design-gates.md)、[初回境界](group-management-first-boundary.md)
- Related accepted decisions: [整合性境界](../adr/group-management-consistency-boundary.md)、[Command本人性・認可・再試行](../adr/group-management-command-authorization.md)
- Decision proposal: [招待・再参加](../adr/group-invitation-and-rejoin.md)

## 1. Problem / Scope

Group Ownerが特定の利用者を招待し、その利用者だけが参加できるようにする。Groupは1〜4人であるため、複数の招待受諾が重なっても5人状態を作らない。脱退済みの利用者が再度参加するとき、過去の支出・精算責務と新しい在籍を混同しない。

成功は、招待の作成者・宛先・状態・期限を説明でき、受諾の成功時にはInvitation消費、Participant追加、参加履歴、版、operation結果が一括で成立すること。失敗時はこれらの一部だけを反映しないこと。

対象はGroup Managementの設計だけである。対象外は認証Provider、Tokenやメール配送、DB/Schema、GraphQL/UI、Group終了、Expense／Settlementの実装、Context間の認可連携、本番Persistenceである。C1は未充足であり、#42の保存AdapterをReadyにしない。

## 2. System Context

| Element | Type | Responsibility / Interaction | Evidence |
| --- | --- | --- | --- |
| 現在のGroup Owner | Actor / Group内Role | Active Groupの招待を開始し、Pending Invitationを取消す候補 | current-model: Ownerだけが招待 |
| 招待された利用者 | Actor | 自分宛のInvitationを受諾して参加する | current-model: 招待された利用者が参加 |
| Group Management | Target System | Invitationと現在Participantを管理し、人数とOwnerの不変条件を守る | ADR #35／#36 |
| 本人性を確認する仕組み | External boundary（未決） | 信頼済みActorSubjectをApplicationへ渡す | ADR #36。Providerは未選定 |
| Expense Recording / Settlement | System内の別Context | 過去のParticipantと支払責務を所有する | ADR #24。参加・再参加と直接同期しない |

## 3. Use Cases

| Use Case | Actor | Goal / Trigger | Preconditions | Success Outcome | Boundary / Failure |
| --- | --- | --- | --- | --- | --- |
| InviteParticipant | 現在Owner | 特定の利用者をGroupへ招待する | Active Group、信頼済みActorが現在Owner、宛先Actorが決まる | Pending Invitationが作成される | 非Owner、Archived、同一ActorのActive在籍、期限不正を拒否。枠予約はProposalの選択対象 |
| CancelInvitation | 現在Owner | Pending Invitationを無効にする | Active Group、現在Owner、Pending | InvitationがCancelledになる | 取消済み／消費済み／期限切れは変更しない。発行者が旧Ownerでも扱いをDecision化する |
| AcceptInvitation | 招待された利用者 | 自分宛のInvitationを受諾して参加する | 信頼済みActorが宛先、Pending、未期限切れ、Active Group、空き枠 | InvitationがConsumedになり、新Participantと参加履歴が同一commitでできる | 他人、取消・期限切れ、4人、Archived、既にActive、競合は部分反映なし |
| RejoinGroup | 脱退済み利用者 | 新しいInvitationを受諾して再び参加する | 左脱退履歴、本人宛の有効Invitation、上記Accept条件 | 過去Participantを残し、新Participantと新しいjoinOrderを作る候補 | 同じParticipantを再活性化するかはOwner Decision対象。過去Expense／Settlementは変更しない |

## 4. Concrete Examples / Object Model

| Scenario | Objects / Relationship | Expected Rule / Outcome | State |
| --- | --- | --- | --- |
| 3人のG-AでOwner P-AがU-DへI-Dを作成 | Active={P-A,P-B,P-C}, I-D.target=U-D, Pending | I-DはParticipantではない。受諾でP-Dを追加し4人になる | Confirmed scope + Proposed lifecycle |
| 3人のG-AでI-D/I-Eを同時に受諾 | 両者がv7、空き1枠を読む | 先にcommitした一方だけ4人へ成功。後続はConflictまたは再読込後CapacityExceeded。5人状態なし | Confirmed人数 + Proposed受諾原子性 |
| 4人のG-AでOwnerがI-Eを作ろうとする | ActiveCount=4 | 枠を予約しない案ではInviteを拒否する。枠予約案ではInvitation作成も枠を消費する | Proposed comparison |
| I-Dの宛先U-D以外が受諾 | I-D.target=U-D、actor=U-E | 結果・Group存在を返さず、状態・履歴・operation結果を作らない | Proposed。外部Errorの形は本番認証Decision待ち |
| P-AがI-Dを発行後、P-BへOwner譲渡 | issuer=P-A、currentOwner=P-B、I-D=Pending | 継続案ではI-Dは有効で、P-Bが取消できる。自動失効案ではI-Dを無効にする | Owner Decision Required |
| U-DがAccept成功後に応答を失う | 同じActor、operationId、fingerprint | 同じ最小結果を再取得し、Invitation消費・Participant追加を重複しない | Accepted ADR #36をInvitationへ適用するProposal |
| U-CがP-CとしてLeft後、新Invitationを受諾 | P-C.leftAtあり、U-C宛I-C2、maxJoinOrder=4 | 新P-C2、joinOrder=5を作り、P-Cを変更しない。過去責務は旧P-Cを参照する | Proposed。現実装はREJOIN_NOT_DECIDEDで拒否 |

## 5. Domain Concepts / Domain Model

| Concept | Meaning / Identity | Lifecycle | Relationships | State |
| --- | --- | --- | --- | --- |
| Invitation | 特定ActorへGroup参加の意思を伝える招待。InvitationIdで追跡する候補 | Pending → Consumed / Cancelled / Expired | 1 Group、1 target Actor、1 issuer、0..1 resulting Participant | Proposed |
| Invitation target | 招待を受諾できる信頼済みActorSubject | Invitation作成時に固定 | Invitationの宛先。メールアドレスやTokenではない | Proposed |
| Invitation issuer | Invitationを作成した当時のOwner | 作成時の事実として保持する候補 | current Ownerと異なり得る | Proposed |
| Participant | Groupに参加した在籍の単位 | Active → Left。再参加時は新しいParticipant候補 | Groupが所有。過去Expense／Settlementは当時のParticipantを参照 | Confirmed概念 / Proposed再参加寿命 |
| Group Owner | Active Participantの現在Role | 譲渡で変更 | Invite/Cancelを許可する現在Role | ConfirmedRole / Proposed invitation authority |

現行実装はGroup Aggregate内のActive/Left Participant、Owner、joinOrderを守り、同一Actorの再参加は`REJOIN_NOT_DECIDED`として拒否する。Invitationは未実装である。この実装事実を再参加方針の根拠にはせず、ProposalがAcceptedになった後に既存不変条件との整合を別Taskで実装する。

| Model Element | Implementation Evidence | Alignment | Feedback | Knowledge State |
| --- | --- | --- | --- | --- |
| Active人数1〜4、Owner | `apps/api/src/domain/group-management/group.ts` | Aligned | Accept成功は同じGroup整合性版へ含める必要がある | Confirmed / Accepted |
| Active→Left履歴 | 同上 | Aligned | 再参加は明示的に拒否される。新しいParticipantを作る案には変更が必要 | Proposed |
| Invitation lifecycle | 実装なし | Missing | DB/API設計から逆算しない | Proposed |

## 6. Business Rules / Invariants

| Rule ID | Rule | Applies To | Evidence | State | Counterexample / Boundary |
| --- | --- | --- | --- | --- | --- |
| GI-01 | Active Groupは1〜4人、OwnerはActive Participantで1人 | Group | current-model、ADR #35 | Confirmed / Accepted | 同時受諾で5人またはOwner不在を作らない |
| GI-02 | Ownerだけが招待する | InviteParticipant | current-model | Confirmed | Clientのowner=trueや旧Ownerを現在Ownerとして扱わない |
| GI-03 | Invitationは宛先の信頼済みActorだけが受諾できる | AcceptInvitation | 本人性の必要性、ADR #36 | Proposed | 他Actorへ招待結果・Group存在を漏らさない |
| GI-04 | 消費、Participant追加、joinOrder、Group版、operation結果は同一commitで成立する | AcceptInvitation | GI-01、ADR #35/#36 | Proposed | 応答喪失、同時受諾でInvitationだけ消費しない |
| GI-05 | Pending Invitationは期限切れまたは取消後に受諾できない | Invitation | 招待の必要検討項目 | Proposed | Client時刻で期限を延長しない |
| GI-06 | 再参加は旧Participantを再活性化せず、新ParticipantIdと未使用のjoinOrderを作る | RejoinGroup | 過去責務を不変にする必要 | Proposed | P-Cの過去Expense参照をP-C2へ書き換えない |
| GI-07 | 参加・再参加は過去Expense／SettlementのParticipant、割合、支払責務を変更しない | Cross-context | current-model | Confirmed | Active membershipだけで過去Instructionを無効にしない |
| GI-08 | Invitationが枠を予約するか、Owner譲渡で失効するかは実装前に決める | Invitation / Group | 未決事項 | Open Question | Pending Invitationが容量や権限を暗黙に占有しない |

## 7. Ubiquitous Language

| Japanese | English | Definition | Context | Avoided Terms | Example |
| --- | --- | --- | --- | --- | --- |
| 招待 | Invitation | 特定Actorへ参加機会を与える、Participantではない記録候補 | Group Management | Member、招待URL | I-D is Pending |
| 宛先 | Invitation target | Invitationを受諾できる信頼済みActor | Group Management | 任意のリンク利用者 | U-D |
| 発行者 | Invitation issuer | Invitationを作った当時のOwner | Group Management | 常に現在Owner | P-A |
| 受諾 | Accept invitation | Invitation消費と新しい在籍を同時に成立させる操作候補 | Group Management | Ownerによる代理追加 | I-D → P-D |
| 再参加 | Rejoin | Left履歴を残したActorが新Invitationで新たに参加すること | Group Management | LeftをActiveへ戻すこと | P-C → P-C2 |
| 枠予約 | Capacity reservation | Pending Invitationが将来の人数枠を占有する方式 | Group Management | Active Participant | 3人時のI-D |

## 8. Confirmed Decisions

- Active Groupは1〜4人で、現在Ownerが1人だけである。根拠はcurrent-modelとADR #35。
- OwnerだけがParticipantを招待でき、招待された利用者が参加する。根拠はcurrent-model。ただしInvitationの詳細Lifecycleは未決。
- 脱退後も過去の支出・精算責務を上書きしない。根拠はcurrent-model。
- 本番本人性、公開Command、Persistenceは未決であり、信頼済みActorの内部契約を本番認証の証拠にしない。根拠はADR #36。

## 9. Proposed / Assumptions

| Item | Type | Reason | Validation Needed |
| --- | --- | --- | --- |
| 宛先Actorに束縛されたInvitationとPending/Consumed/Cancelled/Expired lifecycle | Proposed | 他人の受諾と二重消費を防ぐため | Ownerが本人性の前提をAcceptedする |
| 期限はサーバClockで判定し、期限値は作成時に固定する | Proposed | Client時刻の操作を避け、再試行を決定的にするため | 期限の長さと延長可否をOwnerが選ぶ |
| 枠はInvitation作成時に予約せず、Accept時にだけ再検証する | Proposed | 期限切れ招待で空き枠を塞がないため | 4人時のInvite可否と受諾失敗体験をOwnerが選ぶ |
| 旧Owner発行のPending Invitationは譲渡後も有効で、現在Ownerが取消できる | Proposed | 発行時の正当性と現在の管理責任を両立するため | 自動失効とのTrade-offをOwnerが選ぶ |
| 再参加は新ParticipantId・単調なjoinOrderを使う | Proposed | 過去責務と現在在籍を混同しないため | Expense/Settlementとの参照契約を後続で確認する |

## 10. Open Questions / Conflicts

| ID | Type | Question / Conflict | Impact | Required Decision / Evidence |
| --- | --- | --- | --- | --- |
| OQ-I1 | Open Question | 招待期限は何時間／日か。延長や再発行を許可するか | UX、期限判定、再送 | Ownerが期限と再発行Ruleを選ぶ |
| OQ-I2 | Open Question | 4人時にInviteを拒否するか、Pendingを作成するか。枠を予約するか | 容量、競合、通知 | Ownerが枠予約方式を選ぶ |
| OQ-I3 | Open Question | Owner譲渡後、旧Owner発行Invitationを自動失効するか | 権限、招待の信頼性 | Ownerが継続／自動失効を選ぶ |
| OQ-I4 | Open Question | 宛先Actorを本番でどう解決し、招待をどう配送するか | Security／Privacy、公開API | 本番認証・配送の別ADR |
| OQ-I5 | Open Question | 再参加後のParticipant参照をExpense／Settlementがいつ採用するか | Context間認可、過去責務 | Context間契約ADR。今回は実装しない |
| OQ-I6 | Conflict | 既存Groupは同一Actorの再参加を拒否するが、Product Scopeは招待参加を要求する | Domain実装とProposalの差 | Owner Accepted後に別実装Taskで変更を検証 |

## 11. Next Modeling Step

1. Project Ownerが[ADR Proposal](../adr/group-invitation-and-rejoin.md)の期限、枠予約、Owner譲渡後の扱い、再参加ID寿命を選ぶ。
2. Accepted後に、Invitation Data Owner、公開本人性、保存最小化、Context間参照を別Ready Gateで具体化する。
3. AcceptInvitation実装Taskは、上記DecisionとC1/Persistenceの依存を再評価してから1〜2日に分割する。
