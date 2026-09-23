# Group Managementの最初の実装境界（設計案）

- Knowledge State: 2026-09-08のADR #35／#36条件付きAcceptance、2026-09-13のADR #52 Acceptance、Task #57の内部契約実装、2026-09-20のC1充足、2026-09-21のADR #73 Acceptance、2026-09-22のADR #85 Acceptanceを反映。残るOpen QuestionとBlockedを分離する。
- Baseline: [実装開始時のdevelop固定Commit](https://github.com/takeshi-arihori/kakei_app/tree/68d9c469605f554306f773a929250d8b1f642d05)
- 根拠: [現行業務モデル](../product/current-model.md)、[Accepted ADR #24](../adr/shared-expense-domain-boundaries.md)
- Decision: [整合性境界](../adr/group-management-consistency-boundary.md)、[本人性・認可・再試行](../adr/group-management-command-authorization.md)、[招待・再参加](../adr/group-invitation-and-rejoin.md)、[Group終了](../adr/group-close-consistency-and-retention-boundary.md)、[operation locator／Group ID](../adr/group-operation-locator-and-group-id-contract.md)
- 条件C1、S0〜S3、#86のActor内全Group共通locatorとcanonical Group IDのApplication／Domain契約は充足済み。#42はv2 Migration／PostgreSQL CIを実装・統合済み。#94はread adapterとしてReady評価を通過し、#95〜#97を各依存に従って個別Ready評価する。

## 1. Problem / Scope

利用者が少人数の割り勘Groupを作り、参加者と管理責任を維持する。人数超過、Owner不在・複数化、古い権限による更新を防ぎ、脱退後も過去の支出・精算責務を壊さないことを観測可能な成果とする。

最初の境界はCreateGroup、TransferGroupOwnership、LeaveGroup、InviteParticipant、CancelInvitation、AcceptInvitationの純粋Domainと、それらを呼ぶApplication・Repository Port契約である。Invitation lifecycleと再参加Participant寿命はADR #52で採用し、#57でDomain／Application内部契約とfake Repository検証を追加した。Group終了のClose Intent、Context fence／Receipt、Archive／取消、保持期限はADR #73で採用し、#75でDomain／Application内部契約を実装する。本番本人性・配送・公開Command接続は後続とする。

対象外: CSV実装、Retention Batch、Invitation配送・Token実装、Expense／Settlementの実fence、DB／Migration、本番Persistence、GraphQL／UI、非同期Event／Projection。Group終了は別Contextの未精算・進行中確認を要するため、#75では公開Portとfake contractまでとし、実Context Adapterを本番へwireしない。

## 2. System Context

| Element                        | Type                          | Responsibility / Interaction                                                                                | Evidence                               |
| ------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 利用者                         | Actor                         | 1人でGroupを作り、複数Groupへ所属する                                                                       | current-model: Groupと金額             |
| 現在のGroup Owner              | Actor / Group内Role           | 招待・Owner譲渡、後続の終了・CSV                                                                            | current-model: Group Role・権限        |
| Participant / 招待された利用者 | Actor                         | 本人の参加・脱退、脱退後は既存支払責務が残る                                                                | current-model: 途中参加・脱退          |
| 共有割り勘System               | Target System                 | Group内の役割と在籍時点を管理する                                                                           | ADR #24                                |
| 本人性を確認する仕組み         | External boundary（方式未決） | 操作者を識別する信頼済み結果を渡す                                                                          | 認可ADR Decision。認証製品は選定しない |
| Expense Recording / Settlement | System内の別Context           | 登録時のParticipantと過去の責務を所有し、Group終了時は各書込み境界でfenceを設置してversion付きReceiptを返す | ADR #24 / ADR #73 / current-model      |

## 3. Use Cases / Commands

CreateGroup、TransferGroupOwnership、LeaveGroupのCommand名・入力・戻り値はAcceptedなApplication契約で、GraphQL Schemaではない。InviteParticipant、CancelInvitation、AcceptInvitationもADR #52で内部契約としてAcceptedし、#57で実装する。共通入力は信頼済みActorSubject、operationId。既存Group更新はgroupId、expectedVersionを持つ。時刻・IDは信頼境界内で生成し、Client申告Roleは採用しない。

| Use Case / Command                      | Actor・Goal・Trigger                    | Preconditions                                                                 | Success Outcome                                                                                   | Failure / Boundary                                                                           |
| --------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Groupを開始 / CreateGroup               | 利用者が新しい割り勘を開始              | 本人性確認済み（方式未決）                                                    | 新Groupと作成者Participant、唯一のOwnerを同時生成。GroupId / ParticipantId / versionを返す        | 認証なし拒否。同じoperationの再送は同一Group。同一人の別operationは別Groupを許す             |
| 招待 / InviteParticipant（#57）         | 現在のOwnerが仲間を招く                 | Active Group、現在Owner、Active 3人以下、宛先Actor確定                        | 期限7日のPending Invitationを作る。枠は予約せず、まだParticipantにはしない                        | 非Owner、旧Owner、Archived、4人、Active重複を拒否                                            |
| 招待取消 / CancelInvitation（#57）      | 現在OwnerがPending Invitationを取り消す | Active Group、現在Owner、Pending                                              | InvitationをCancelledにする。旧Owner発行分も現在Ownerが取消可能                                   | 旧Owner、非Owner、Consumed／Cancelled／Expiredを拒否または変更なしの契約で扱う               |
| 参加 / AcceptInvitation（#57）          | 招待された本人が参加意思を示す          | 宛先Actor一致、Pending、7日以内、Active Group、空き枠、Active重複なし         | Invitation消費、新Participant、単調joinOrder、履歴、版、operation結果が同時成立                   | 他Actor、取消・期限切れ、人数超過、競合は部分反映なし。Owner代理参加経路は作らない           |
| 管理責任を渡す / TransferGroupOwnership | 現在OwnerがtargetParticipantIdを指定    | Active Group、同じGroupのActiveな譲渡先                                       | Owner参照を原子的に切替。旧OwnerはParticipantのまま                                               | 別Group・脱退者・非Owner拒否。自己譲渡は変更なし                                             |
| 自分が脱退 / LeaveGroup                 | Active Participant本人が離れる          | Active Group、現在Ownerではない                                               | ParticipantをLeftにし時刻を固定。過去のMembership・支払責務は残る                                 | Active GroupのOwnerは拒否。Ownerによる他人の除名は対象外。別operationでの再脱退はAlreadyLeft |
| 終了開始 / StartGroupClosing（#75）     | 現在OwnerがGroup終了を開始              | Active Group、現在Owner、期待版一致                                           | `Closing`、closeIntentId、cutoffを同一版で固定し、Context fenceを要求                             | 非Owner、古い版、Archived、別Intentを拒否                                                    |
| 終了確定 / ArchiveGroup（#75）          | 現在Ownerが終了を確定                   | Closing、両Contextの一致する終了可能Receipt、Owner／Group version／Intent一致 | `Archived`、owner-at-archive、archivedAt、deleteEligibleAtを一括固定                              | Receipt欠落／不一致、未精算、進行中、非Owner、古い版を変更なしで拒否                         |
| 終了取消 / CancelGroupClosing（#75）    | 現在Ownerが終了処理を取り消す           | Closing、現在Owner、期待版一致                                                | unfence前にCASで`Canceling` phaseを予約し、両Contextの一致するunfence Receipt後だけ`Active`へ戻す | 非Owner、片方未解除、別Group／Intent、Archive先勝ちを拒否。取消予約先勝ち後はArchive不可     |

通常のMembership／Owner変更契約はActive Groupに限定し、Closing／ArchivedではGroupNotActiveとして状態変更を拒否する。Closing中は従来許可された既存履歴のread-only参照とcurrent Ownerによる取消だけを許可する。Archive時に`ownerAtArchiveParticipantId`を固定し、保持期限までの履歴参照とCSV責任を持つ。Group名等の表示属性は最初の境界に必須とせず、必要になれば制約を別途確定する。

## 4. Concrete Examples / Object Model

すべて架空のID・Actor。UTCの時刻例とversionはAccepted契約の具体例。

| Scenario / Objects                                                   | Relationship・Expected Rule          | Outcome                                                                         | State                          |
| -------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------ |
| 利用者U-AがG-Aを作る。P-A joinedAt=2026-09-07T00:00:00Z、joinOrder=1 | G-AのActive集合={P-A}、owner=P-A     | 1人Group成立。U-AがG-Bを別途作ることも可                                        | Confirmed / Accepted           |
| G-AにP-A/P-B/P-C、v7。U-D/U-E宛Invitationが同時受諾                  | 両者がv7を読む。Active人数の上限は4  | 片方だけv8へ成功、他方Conflict。再読込で4人を見てCapacityExceeded。5人状態なし  | Accepted / #57で内部契約を実装 |
| P-AがOwnerをP-Bへ譲渡                                                | P-A/P-BともActive、v8→v9             | owner=P-B、P-AはActiveのまま。P-Aの脱退は別Command                              | Confirmed / Accepted           |
| v9でP-B→P-Cへの譲渡とP-Cの脱退が競合                                 | 同じ整合性版にOwnerと在籍を含める    | 脱退が先なら譲渡は再検証で拒否、譲渡が先なら脱退はOwner制約で拒否               | Confirmed / Accepted           |
| 唯一のP-AがOwnerのG-Bから脱退                                        | 0人Active GroupとOwner不在は不正     | 変更なしでOwnerMustTransferOrEnd                                                | Confirmed                      |
| P-Cが脱退。過去Expense E-Xの負担と支払指示I-Xが存在                  | P-CのMembership参照を維持            | E-X/I-Xは無変更。新Expenseの対象外。I-Xの支払・受取責務は残る                   | Confirmed                      |
| Group保存後に応答喪失、同一operationIdで再送                         | fingerprintもActorも同一             | 同じ結果、追加Group・履歴・版更新なし。別payloadはOperationMismatch             | Accepted。保存期間は未決       |
| 旧Owner P-Aが保存直前に権限を失う                                    | 認可判定時のv10に対し他操作がv11成立 | 保存を拒否。最新状態から認可をやり直し、旧権限を使用しない                      | Accepted                       |
| U-Cが脱退後に本人宛の新Invitationを受諾                              | 過去P-Cの履歴と新在籍の区別が必要    | 新ParticipantIdと過去最大より大きいjoinOrderを発行し、P-Cと過去責務は変更しない | Accepted / #57で内部契約を実装 |

## 5. Domain Concepts / Relationships / Lifecycle

| Concept     | Meaning / Identity・代表属性                                                                                  | Lifecycle / Relationships                                                                                                             | State                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Group       | 割り勘の共同単位。GroupId、state、ownerParticipantId、version                                                 | Active→Closing→Archived→期限削除。Closing内に取消を予約する`Canceling` phaseを持つ。Active Participant 1〜4、過去の在籍記録0..nを保持 | 概念・属性・所有境界・終了Lifecycle Accepted |
| Participant | Groupに参加した主体。ParticipantId、subjectRef、joinedAt、leftAt、joinOrder                                   | Groupに必ず1つ所属。Active→Left。再参加は新ParticipantIdと単調joinOrder。利用者1人は複数Groupに別の参加関係を持つ                     | 概念・時間境界・再参加ID寿命Accepted         |
| Invitation  | Group Ownerが特定のtrusted Actorへ発行する参加機会。InvitationId、target、issuer、createdAt、expiryAt、status | Group Aggregate内でPending→Consumed／Cancelled／Expired。Participantでも人数枠予約でもない                                            | ADR #52でAccepted / #57で内部契約を実装      |
| Group Owner | Groupを管理するParticipantのRole                                                                              | Active Group→Active Participantへの必須参照がちょうど1。独立Entity／Repositoryを作らない                                              | 一意性Confirmed、参照表現Accepted            |
| Membership  | Participantの参加・脱退の時間関係を表す語                                                                     | 参加・脱退履歴を残す。Participantとは別の重複した変更入口を作らない                                                                   | 履歴必要Confirmed、モデル統合Accepted        |

Group→Participantの所有方向を採用する。削除はRetention全体の設計Gateに従い、脱退でParticipantを物理削除しない。Owner Roleの独立寿命は持たせない。過去参加者を常時すべて読み込む実装は要求せず、現在状態と追加する不変履歴の整合性を同じCommitで守る。履歴の保存形式・復元方式は未決。

### 既存実装との対応

| Model / Rule                             | Evidence（上記固定Commit）                    | Alignment                          | Feedback / State                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Group / Participant / Owner / Invitation | apps/api/src/group-management/domain/group.ts | Aligned（#38／#39／#57）           | Group生成、Active／Left履歴、Owner譲渡、本人脱退、Invitation lifecycle、受諾、新Participantによる再参加を純粋Domainで実装。Archive invariantはS0、Persistenceは#42／#94〜#97へ分割                                                                     |
| 認可・Command                            | apps/api/src/group-management/application     | Aligned（#40／#57／#86の内部契約） | 信頼済みActor入力、最新Group状態によるDomain認可、期待版競合、InvitationとMembershipの原子的変更集合、Actor単位のoperation再送、応答喪失回復をApplicationとin-memory fakeで検証。本番本人性・保存Adapter・公開APIは未実装で、#42／#94〜#97のGateを維持 |
| JPY整数                                  | apps/api/src/shared/domain/money.ts           | Aligned                            | 金額は今回対象外。実装事実は新業務Ruleの根拠にしない                                                                                                                                                                                                   |

### Ubiquitous Language

| Japanese       | English     | Definition / Context                               | Avoided Terms                          | Example                     |
| -------------- | ----------- | -------------------------------------------------- | -------------------------------------- | --------------------------- |
| 割り勘グループ | Group       | Group Managementで共有割り勘を行う単位             | 個人Household、Account                 | G-A                         |
| 参加者         | Participant | Groupに参加した主体。精算では過去時点の関係も重要  | 利用者IDとの同一視、常に現役という解釈 | LeftのP-Cにも支払責務が残る |
| グループ所有者 | Group Owner | 現在Groupを管理するParticipantのRole               | Source Owner、支払者との混同           | P-AからP-Bへ譲渡            |
| 在籍関係       | Membership  | Group Managementにおける参加・脱退の時間関係       | 脱退で履歴ごと削除されるMember         | joinedAt / leftAt           |
| 参加順         | Join Order  | 金額端数・送金案Tie-breakで参照するGroup参加の順序 | DBの取得順                             | P-A=1、P-B=2                |

## 6. Business Rules / Invariantsと配置

| ID    | Rule / Applies To                                                                                                                    | Evidence                                 | State                                              | Placement候補 / 反例                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| GM-01 | Active Groupの人数1〜4                                                                                                               | current-model: Groupと金額、既存境界分析 | Confirmed（Active人数としてのモデル化はADRで確認） | Aggregate / 同時参加で5人にしない                                                |
| GM-02 | 作成者が初期Owner。Active Groupには唯一のOwner                                                                                       | current-model: Group Role・権限          | Confirmed                                          | Aggregate / 空Owner・2 Owner状態を公開しない                                     |
| GM-03 | 譲渡先は同GroupのActive Participant                                                                                                  | 同上                                     | Confirmed                                          | Aggregate＋認可 / Left・他Groupを拒否                                            |
| GM-04 | Ownerは譲渡またはGroup終了まで脱退不可                                                                                               | 同上                                     | Confirmed                                          | Aggregate / 最後の1人の脱退を拒否                                                |
| GM-05 | 招待・終了・Group CSVはOwnerのみ                                                                                                     | 同上                                     | Confirmed                                          | Application認可 / Clientのowner=trueは証拠にしない                               |
| GM-06 | 参加・脱退で過去Expenseと精算責務を上書きしない                                                                                      | current-model: 途中参加・脱退            | Confirmed                                          | Context間Policy / Leftは既存支払の権限消失と同義でない                           |
| GM-07 | Archived Groupは招待・参加不可                                                                                                       | current-model: Group終了・Archive        | Confirmed                                          | Aggregate / 正常な招待でも参加拒否                                               |
| GM-08 | 同利用者の同Group内Active参加は最大1。参加順はGroup内で単調・再利用なし                                                              | ADR #35                                  | Accepted                                           | Aggregate / 同時重複参加・同時順序採番                                           |
| GM-09 | 版、Owner、在籍変更、必要履歴、operation結果が一括成立                                                                               | ADR #35／#36                             | Accepted                                           | Repository Portの原子性 / 保存失敗時に部分反映なし                               |
| GM-10 | Actorと対象Participantの対応は信頼済み本人性とGroup状態から判定                                                                      | ADR #36                                  | Accepted                                           | Application認可 / なりすまし・他Group ID差替え拒否。本番本人性は未決             |
| GM-11 | 現在Ownerだけが7日期限の宛先Actor束縛Invitationを作成・取消でき、Pendingは人数枠を予約しない                                         | ADR #52                                  | Accepted                                           | Aggregate＋Application認可 / 4人、Active重複、Archived、旧Ownerを拒否            |
| GM-12 | Accept時に宛先・期限・Active・空き枠・重複を再検証し、消費と新Participantを同一版で成立させる。Left Actorの旧Participantは変更しない | ADR #52                                  | Accepted                                           | Aggregate＋Repository Port / 同時受諾の片方だけ成功、再参加は新ID・単調joinOrder |
| GM-13 | Group終了は現在Ownerが開始し、両Contextの同一Group／Intent／cutoffに束縛した有効Receiptが揃う場合だけ確定する                        | ADR #73                                  | Accepted                                           | Application coordination＋Aggregate / 他Context Tableを直接参照しない            |
| GM-14 | Closingでは既存履歴read-onlyとcurrent Ownerの取消だけを許可し、access-affecting mutationを拒否する                                   | ADR #73                                  | Accepted                                           | Domain＋Access Policy / fence後の新規業務Commandを拒否                           |
| GM-15 | Archive時のOwner、UTC時刻、Asia/Tokyo基準1暦年後の期限を固定し、2月29日は翌年2月28日へclampする                                      | ADR #73                                  | Accepted                                           | Aggregate＋Clock / Archive後の変更と再計算を禁止                                 |

## 7. Aggregate / Repository Port

GroupをRootとし、現在のParticipant状態・Owner参照・参加順採番を同じ整合性境界へ入れる。人数、譲渡先の在籍、Owner脱退禁止が同じ時点で成立する必要があり、最大4人の現在状態は小さい。GM-01〜04/08/09が理由であり、Tableの形は理由にしない。

不採用の代替はParticipantを独立AggregateとしてGroupとの同期Coordinatorで守る案。独立更新には向くが、人数とOwnerが跨るため一時的不整合を許せず、同じ原子性を別契約で回復するCostがある。Ownerを独立Aggregateにする案も責務譲渡中の不在・重複を招くため採用しない。

以下は言語非依存のAccepted契約。ApplicationがPortを定義しInfrastructureが実装する。DomainはI/Oしない。公開HTTP／GraphQL契約やDB製品をこの文書では選ばない。

| Port operation                | Input → Output                                                                                                                                                                                                           | Guarantee / Failure                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GroupRepository.load          | GroupId → GroupState＋version またはNotFound                                                                                                                                                                             | OwnerとActive参加集合は同一版。ORM型を返さない。返却状態を変更しても保存まで共有状態を変えない                                                         |
| GroupRepository.commit        | newState、expectedVersion（作成時Absent）、operation{actorSubject, operationId, fingerprint}、membershipChanges、invitationChanges → Committed{ids,version} / Conflict / AlreadyExists / OperationMismatch / Unavailable | create-if-absent / compare-and-swap。状態・版・Invitation作成／取消／消費・参加脱退履歴・operation結果を全成功または全失敗。失敗しても元状態・履歴不変 |
| GroupRepository.findOperation | actorSubject＋operationId → result＋fingerprint またはMissing                                                                                                                                                            | 同じActorのoperation結果を照合。異なるActorへ結果を返さない。応答喪失時は先に照合し、Missing時だけ最新状態で再判断                                     |

#57ではこのPortの責務を変えず、GroupStateにInvitation lifecycleを含め、`commit`の原子的な変更集合へInvitation作成・取消・消費とParticipant追加を加えた。本番Schemaは#42で完了し、read adapter #94、状態writer #95、公開commit #96、Access Policy SQL #97へ分けている。Production Security Gateまで本番へwireしない。

operationIdはActor内で全Group・Command共通の一意な名前空間とし、fingerprintはCommand種別、対象Group／Participant、expectedVersion、入力を含む。サーバ生成時刻・IDは含めず最初の成功結果を再利用する。初回成功後にOwnerを失った再送では、同じActorへ最小限のCommand結果（ID・versionのみ）を返し、現在Groupの閲覧権限を付与しない。

競合後に入力・期待版を変える操作は新operationIdを用いる。Conflictを無条件に自動再試行しない。Unavailableでは成功したか不明な場合があるためfindOperationで照合する。失敗結果は永続記録しない。冪等結果の暗号化・保持・削除とlocator契約はAccepted ADR #55/#85で定めた。PostgreSQL read、状態・履歴writer、atomic commit、固定版認可lockの実装証拠は#94〜#97で順に追加する。in-memory fakeの成功はPersistence適合の証拠にならない。

ActorSubject解決、Clock、ID発行はApplication境界で注入可能にする。Group IDはcanonical lowercase UUIDとし、信頼済み`nextGroupId`の本番実装は`crypto.randomUUID()`からUUIDv4を生成する。業務Entityへ認証Tokenを渡さない。Invitationのtrusted Actor内部契約は#57で導入するが、本番宛先解決・配送・公開経路からの接続は別Security Decisionまで行わない。

Group終了ではApplicationがExpense RecordingとSettlementのClose Fence Portを呼び、各Contextが原子的なfence、進行中Commandのdrain／rollback、判定、Receipt発行、unfenceを所有する。Group Managementは型付きReceiptのgroupId、Intent、cutoff、context、fence versionを検証する。取消は最初のunfence前にGroupRepositoryのCASで`Canceling` phaseを予約し、Archive先勝ちならunfenceを呼ばず、取消予約先勝ちならArchiveを拒否する。実配送、Outbox、Receipt保護、監視、回復Runbookは後続Taskまで本番へ接続しない。

他Context向けの照会候補はversion付きGroupMembershipView（GroupId、groupState、ParticipantId、active、joinOrder、ownerParticipantId）。用途は「この時点の在籍」であり、Settlementの過去支払責務の判定には使わない。Group終了のfence PortはADR #73でAcceptedしたが、通常時の照会後に起きる脱退とExpense作成の競合を解く契約は未決である。終了Portを一般的なMembership Portとして拡張しない。

## 8. Confirmed Decisions

ADR #24の3 Context、MVP Modular Monolith、State model＋不変業務履歴、Command／Query分離を維持する。GM-02〜07、人数1〜4、複数Group所属、参加・脱退履歴はcurrent-modelのConfirmed Rule。ADR #35／#36によりGroup Root、Repository Port、内部Command認可と冪等再送を条件付きAcceptedとし、ADR #52によりInvitation lifecycle、受諾原子性、新Participantによる再参加、ADR #73によりGroup終了のClose Intent、Context fence／Receipt、Closing認可、owner-at-archive、2月29日clampをAcceptedした。PR #27はADR #24のAccepted文書統合記録で、C1の証拠は後続のADR #55、正式Security Review、PR #70である。

## 9. Remaining Assumptions / External gaps

| Item                                                            | Type                                      | Reason                                                                                                                                          | Validation Needed                                                             |
| --------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| テスト内のActorSubjectは架空で、認証済みと仮定                  | Assumption                                | 本番認証なしでも純粋モデルを検証するため                                                                                                        | 本番接続前に別途認証方式のAccepted Decision                                   |
| 本番のInviteParticipant／CancelInvitation／AcceptInvitation接続 | External gap                              | 内部契約から本番Actor本人性・宛先解決・公開Errorへ接続するDecisionが未Accepted                                                                  | 別Security DecisionまでGraphQL／HTTPへ公開しない                              |
| Invitation／operation結果の保存                                 | Security / Persistence implementation gap | 最小保存、暗号化、Retention、削除のDecisionと独立Security Reviewは完了。ADR #85がlocator keyとGroup IDの保存契約を追補し、#86はPR #91で完了した | #42のMigration後、#94〜#97を依存順に実装。本番wiringはProduction Gateまで禁止 |

## 10. Open Questions / Conflicts

| ID    | Type                          | Question                                                         | Impact / Required Evidence                                                                                          |
| ----- | ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| OQ-G2 | Open Question                 | 本番本人性の信頼元、宛先解決、Token、配送、公開Errorをどうするか | 別Security Decisionまで参加Commandの公開接続はBlocked                                                               |
| OQ-G3 | Partially resolved 2026-09-21 | 脱退・Owner変更と他Context操作の認可判定時点                     | Group終了はADR #73のfenceで解決。通常時のContext間認可は版付き照会だけで解決済みにせず、Task #76と後続契約に従う    |
| OQ-G4 | Resolved 2026-09-21           | Archivedでの譲渡・脱退・Owner不在とCSV責任                       | ADR #73でArchive後の変更拒否、owner-at-archive固定、保持期限までのread／CSV責任をDecision済み                       |
| OQ-G5 | Resolved 2026-09-22           | 冪等記録の保存期限・最小化・削除・本人性との関係                 | ADR #55とADR #85でDecision済み。#86の契約証拠は完了し、保存証拠は#42／#94〜#97で追加する                            |
| C1    | Resolved 2026-09-20           | Snapshot平文禁止と業務必須情報保存の解釈・保護                   | ADR #55＋Owner Accepted＋独立Security Review＋PR #70。S0〜S3と#86は完了し、保存Adapter証拠は#42／#94〜#97で追加する |

## 11. Next Modeling Step / Delivery Gate

1. ADR #35／#36の条件付きAccepted記録は[PR #44](https://github.com/takeshi-arihori/kakei_app/pull/44)でRepositoryとGitHubへ統合済み。各実装Taskは一括昇格せず、Requirement・DCと実依存を個別にReady評価する。
2. [#38](https://github.com/takeshi-arihori/kakei_app/issues/38)、[#39](https://github.com/takeshi-arihori/kakei_app/issues/39)、[#40](https://github.com/takeshi-arihori/kakei_app/issues/40)の初回Domain／Application契約は完了。本番Adapterへ接続しない。
3. #57でInvitation／再参加の内部契約を実装し、C1はADR #55と正式Security Reviewで充足した。S0〜S3と#86はDone。#42はv2 Migration／PostgreSQL CIとしてReady評価を通過し、#94〜#97は依存完了後に個別Ready評価する。本番本人性・配送、実Context fence、Production Gateは別作業とする。

## GitHub delivery map

[設計Task #37](https://github.com/takeshi-arihori/kakei_app/issues/37)は[設計Epic #12](https://github.com/takeshi-arihori/kakei_app/issues/12)配下。実装能力は[Group Epic #34](https://github.com/takeshi-arihori/kakei_app/issues/34)へ分離する。以下は計画時点の要約で、進捗の正本は[Private Project #9](https://github.com/users/takeshi-arihori/projects/9)。SprintはOwner Planningまで未設定。

| Task                                                                                      | Estimate | Dependencies / 初期Status                      | Deliverable                                                                                        |
| ----------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [#37 設計パッケージ](https://github.com/takeshi-arihori/kakei_app/issues/37)              | 1日      | PR #43 Merge済み / Done                        | 本分析、ADR Proposal、Task、Merge記録                                                              |
| [#38 Group生成](https://github.com/takeshi-arihori/kakei_app/issues/38)                   | 1日      | PR #49 Merge済み / Done                        | 初期ParticipantとOwnerを持つ純粋Domain                                                             |
| [#39 譲渡・脱退](https://github.com/takeshi-arihori/kakei_app/issues/39)                  | 2日      | PR #50 Merge済み / Done                        | 在籍・Owner遷移Domain                                                                              |
| [#40 Application・Port](https://github.com/takeshi-arihori/kakei_app/issues/40)           | 2日      | PR #51 Merge済み / Done                        | fakeによる認可・競合・再送契約検証                                                                 |
| [#41 招待・再参加設計](https://github.com/takeshi-arihori/kakei_app/issues/41)            | 1日      | PR #53 Merge済み / Done                        | [比較表とADR](group-invitation-rejoin-proposal.md)。ADR #52は2026-09-13にAccepted                  |
| [#57 Invitation内部契約](https://github.com/takeshi-arihori/kakei_app/issues/57)          | 2日      | PR #59 Merge済み / Done                        | Invitation lifecycle、受諾原子性、再参加をDomain／Applicationとfakeで検証。本番Persistenceは対象外 |
| [#75 S0: Group終了](https://github.com/takeshi-arihori/kakei_app/issues/75)               | 2日      | PR #82 Merge済み / Done                        | Close Intent、Context fence／Receipt、Archive／取消、保持期限のDomain／Application契約             |
| [#74 S1: Schema／Migration](https://github.com/takeshi-arihori/kakei_app/issues/74)       | 1日      | PR #78 Merge済み / Done                        | PostgreSQL Schema、Migration、runtime `pg`                                                         |
| [#77 S2: protected record codec](https://github.com/takeshi-arihori/kakei_app/issues/77)  | 1日      | PR #79 Merge済み / Done                        | Canonical TLV、AEAD Envelope、Key／Nonce Port                                                      |
| [#76 S3: Access Policy](https://github.com/takeshi-arihori/kakei_app/issues/76)           | 1日      | PR #83 Merge済み / Done                        | access policy／blind index／transaction contract                                                   |
| [#86 locator／Group ID契約](https://github.com/takeshi-arihori/kakei_app/issues/86)       | 2日      | PR #91 Merge済み / Done                        | Application locator contract、fake、UUID fixture。PostgreSQLは対象外                               |
| [#42 v2 Migration／PostgreSQL CI](https://github.com/takeshi-arihori/kakei_app/issues/42) | 1日      | Done、PR #99をdevelopへ統合、PR／merge後CI成功 | legacy v1 fail-closed、v2 locator・key-state・close履歴Schema、実DB CI                             |
| [#94 Group読取／再送](https://github.com/takeshi-arihori/kakei_app/issues/94)             | 2日      | #42完了後の個別Ready評価通過                   | load、candidate locator lookup、no-decrypt miss、暗号化結果読取                                    |
| [#95 Group状態writer](https://github.com/takeshi-arihori/kakei_app/issues/95)             | 2日      | #42／#94完了後に個別Ready評価                  | 状態・履歴・索引のCAS writer                                                                       |
| [#96 公開commit](https://github.com/takeshi-arihori/kakei_app/issues/96)                  | 2日      | #42／#94／#95完了後に個別Ready評価             | operation result／locatorと原子的commit、rotation lock                                             |
| [#97 Access Policy SQL](https://github.com/takeshi-arihori/kakei_app/issues/97)           | 2日      | #42／#94／#95／#96完了後に個別Ready評価        | 固定policy版とSQL row lock。Production Gateまで本番wiring禁止                                      |

ADR [#35](https://github.com/takeshi-arihori/kakei_app/issues/35)と[#36](https://github.com/takeshi-arihori/kakei_app/issues/36)は2026-09-08に条件付きAcceptedされ、記録はPR #44でdevelopへ統合済み。ADR [#52](https://github.com/takeshi-arihori/kakei_app/issues/52)は2026-09-13にAcceptedされ、記録はPR #58でdevelopへ統合済み。C1は[#55](https://github.com/takeshi-arihori/kakei_app/issues/55)の正式ReviewとPR #70統合により2026-09-20に充足した。ADR [#73](https://github.com/takeshi-arihori/kakei_app/issues/73)は2026-09-21にAcceptedされ、正式Security ReviewとPR #80統合を完了した。#74〜#77と#86はDone。Persistenceは#42／#94〜#97で追跡し、本番wiringとは分ける。
