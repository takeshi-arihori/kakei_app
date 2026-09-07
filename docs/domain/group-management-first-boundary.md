# Group Managementの最初の実装境界（設計案）

- Knowledge State: ConfirmedとProposedを分離。実装開始の承認ではない。
- Baseline: [develop固定Commit](https://github.com/takeshi-arihori/kakei_app/tree/cd2844543d71c3312740736a527add7315010c97)
- 根拠: [現行業務モデル](../product/current-model.md)、[Accepted ADR #24](../adr/shared-expense-domain-boundaries.md)
- Proposal: [整合性境界](../adr/group-management-consistency-boundary.md)、[本人性・認可・再試行](../adr/group-management-command-authorization.md)
- 条件C1は未充足。Persistence実装はBacklog / Blocked Yes。以下のPortも採用前の契約案である。

## 1. Problem / Scope

利用者が少人数の割り勘Groupを作り、参加者と管理責任を維持する。人数超過、Owner不在・複数化、古い権限による更新を防ぎ、脱退後も過去の支出・精算責務を壊さないことを観測可能な成果とする。

最初の候補はCreateGroup、TransferGroupOwnership、LeaveGroupの純粋Domainと、それらを呼ぶApplication・Repository Port契約である。招待から参加までのUse Caseも設計するが、本人性・招待のSecurity Decisionが未確定のため本番Commandの接続は後続とする。

対象外: Group終了実装、CSV、Retention Batch、Invitation配送・Token実装、再参加実装、Expense／Settlement変更、DB／Migration、GraphQL／UI、非同期Event／Projection。Group終了は別Contextの未精算・進行中確認を要し、最初のGroup Aggregateだけでは成立させない。

## 2. System Context

| Element | Type | Responsibility / Interaction | Evidence |
| --- | --- | --- | --- |
| 利用者 | Actor | 1人でGroupを作り、複数Groupへ所属する | current-model: Groupと金額 |
| 現在のGroup Owner | Actor / Group内Role | 招待・Owner譲渡、後続の終了・CSV | current-model: Group Role・権限 |
| Participant / 招待された利用者 | Actor | 本人の参加・脱退、脱退後は既存支払責務が残る | current-model: 途中参加・脱退 |
| 共有割り勘System | Target System | Group内の役割と在籍時点を管理する | ADR #24 |
| 本人性を確認する仕組み | External boundary（方式未決） | 操作者を識別する信頼済み結果を渡す | 認可ADR Proposal。認証製品は選定しない |
| Expense Recording / Settlement | System内の別Context | 登録時のParticipantを固定し、過去の責務を所有する | ADR #24 / current-model |

## 3. Use Cases / Commands

Command名・入力・戻り値はすべてProposedなApplication契約で、GraphQL Schemaではない。共通入力は信頼済みActorSubject、operationId。既存Group更新はgroupId、expectedVersionを持つ。時刻・IDは信頼境界内で生成し、Client申告Roleは採用しない。

| Use Case / Command | Actor・Goal・Trigger | Preconditions | Success Outcome | Failure / Boundary |
| --- | --- | --- | --- | --- |
| Groupを開始 / CreateGroup | 利用者が新しい割り勘を開始 | 本人性確認済み（方式未決） | 新Groupと作成者Participant、唯一のOwnerを同時生成。GroupId / ParticipantId / versionを返す | 認証なし拒否。同じoperationの再送は同一Group。同一人の別operationは別Groupを許す |
| 招待 / InviteParticipant（後続） | 現在のOwnerが仲間を招く | Active Group、現在Owner | 参加前のInvitationを作る案。まだParticipantにはしない | 非Owner、Archived拒否。宛先・期限・取消・人数枠予約は未決 |
| 参加 / AcceptInvitation（後続） | 招待された本人が参加意思を示す | 招待検証、Active Group、空き枠、同一利用者のActive重複なし（案） | Participantを追加し参加順・時刻を確定、招待消費と同時成立 | 招待不正・失効・人数超過・競合は部分反映なし。Ownerが代理で他人を参加させる経路は作らない案 |
| 管理責任を渡す / TransferGroupOwnership | 現在OwnerがtargetParticipantIdを指定 | Active Group、同じGroupのActiveな譲渡先 | Owner参照を原子的に切替。旧OwnerはParticipantのまま | 別Group・脱退者・非Owner拒否。自己譲渡は変更なし（案） |
| 自分が脱退 / LeaveGroup | Active Participant本人が離れる | Active Group、現在Ownerではない | ParticipantをLeftにし時刻を固定。過去のMembership・支払責務は残る | Active GroupのOwnerは拒否。Ownerによる他人の除名は対象外。別operationでの再脱退はAlreadyLeft（案） |

Archivedでの譲渡・脱退の具体的扱いは未決。初回契約はActive Groupに限定し、ArchivedはGroupNotActiveとして状態変更を拒否する案であり、既存の履歴参照・CSV権限を狭める判断ではない。Group名等の表示属性は最初の境界に必須とせず、必要になれば制約を別途確定する。

## 4. Concrete Examples / Object Model

すべて架空のID・Actor。UTCの時刻例とversionは技術契約案。

| Scenario / Objects | Relationship・Expected Rule | Outcome | State |
| --- | --- | --- | --- |
| 利用者U-AがG-Aを作る。P-A joinedAt=2026-09-07T00:00:00Z、joinOrder=1 | G-AのActive集合={P-A}、owner=P-A | 1人Group成立。U-AがG-Bを別途作ることも可 | 人数・作成者OwnerはConfirmed、ID・順序表現はProposed |
| G-AにP-A/P-B/P-C、v7。U-D/U-Eが同時参加 | 両者がv7を読む。Active人数の上限は4 | 片方だけv8へ成功、他方Conflict。再読込で4人を見てCapacityExceeded。5人状態なし | 上限Confirmed、CASはProposed |
| P-AがOwnerをP-Bへ譲渡 | P-A/P-BともActive、v8→v9 | owner=P-B、P-AはActiveのまま。P-Aの脱退は別Command | 譲渡先条件Confirmed、操作分離Proposed |
| v9でP-B→P-Cへの譲渡とP-Cの脱退が競合 | 同じ整合性版にOwnerと在籍を含める | 脱退が先なら譲渡は再検証で拒否、譲渡が先なら脱退はOwner制約で拒否 | 一意OwnerはConfirmed、直列化契約Proposed |
| 唯一のP-AがOwnerのG-Bから脱退 | 0人Active GroupとOwner不在は不正 | 変更なしでOwnerMustTransferOrEnd | Confirmed |
| P-Cが脱退。過去Expense E-Xの負担と支払指示I-Xが存在 | P-CのMembership参照を維持 | E-X/I-Xは無変更。新Expenseの対象外。I-Xの支払・受取責務は残る | Confirmed |
| Group保存後に応答喪失、同一operationIdで再送 | fingerprintもActorも同一 | 同じ結果、追加Group・履歴・版更新なし。別payloadはOperationMismatch | Proposed |
| 旧Owner P-Aが保存直前に権限を失う | 権限判定時のv10に対し他操作がv11成立 | 保存を拒否。最新状態から認可をやり直し、旧権限を使用しない | Proposed |
| U-Cが脱退後に再参加したい | 過去P-Cの履歴と新在籍の区別が必要 | 再参加ID／joinOrderがAcceptedになるまで参加実装をBlocked | Open Question |

## 5. Domain Concepts / Relationships / Lifecycle

| Concept | Meaning / Identity・代表属性 | Lifecycle / Relationships | State |
| --- | --- | --- | --- |
| Group | 割り勘の共同単位。GroupId、state、ownerParticipantId、version候補 | Active→Archived→期限削除はConfirmed。Active Participant 1〜4、過去の在籍記録0..nを保持。最初の実装はActiveでの操作のみ | 概念Confirmed、属性・所有境界Proposed |
| Participant | Groupに参加した主体。ParticipantId、subjectRef、joinedAt、leftAt、joinOrder候補 | Groupに必ず1つ所属。Active→Left。利用者1人は複数Groupに別の参加関係を持つ | 概念・時間境界Confirmed、ID寿命Proposed |
| Group Owner | Groupを管理するParticipantのRole | Active Group→Active Participantへの必須参照がちょうど1。独立Entity／Repositoryを作らない候補 | 一意性Confirmed、参照表現Proposed |
| Membership | Participantの参加・脱退の時間関係を表す語 | 参加・脱退履歴を残す。Participantとは別の重複した変更入口を作らない案 | 履歴必要Confirmed、モデル統合Proposed |

Group→Participantの所有方向を提案する。削除はRetention全体の設計Gateに従い、脱退でParticipantを物理削除しない。Owner Roleの独立寿命は持たせない。過去参加者を常時すべて読み込む実装は要求せず、現在状態と追加する不変履歴の整合性を同じCommitで守る案とする。履歴の保存形式・復元方式は未決。

### 既存実装との対応

| Model / Rule | Evidence（上記固定Commit） | Alignment | Feedback / State |
| --- | --- | --- | --- |
| Group / Participant / Owner | apps/api/src/domainにはshared/money.tsのみ | Missing | 対象Domain実装は未存在。Modelを既存DBから逆算しない |
| 認可・Command | apps/api/src/app.ts、presentation/graphql/resolvers.tsはhealth / apiStatusのみ | Missing | 認証済みActorの生成経路を前提に実装開始しない |
| JPY整数 | apps/api/src/domain/shared/money.ts | Aligned | 金額は今回対象外。実装事実は新業務Ruleの根拠にしない |

### Ubiquitous Language

| Japanese | English | Definition / Context | Avoided Terms | Example |
| --- | --- | --- | --- | --- |
| 割り勘グループ | Group | Group Managementで共有割り勘を行う単位 | 個人Household、Account | G-A |
| 参加者 | Participant | Groupに参加した主体。精算では過去時点の関係も重要 | 利用者IDとの同一視、常に現役という解釈 | LeftのP-Cにも支払責務が残る |
| グループ所有者 | Group Owner | 現在Groupを管理するParticipantのRole | Source Owner、支払者との混同 | P-AからP-Bへ譲渡 |
| 在籍関係 | Membership | Group Managementにおける参加・脱退の時間関係 | 脱退で履歴ごと削除されるMember | joinedAt / leftAt |
| 参加順 | Join Order | 金額端数・送金案Tie-breakで参照するGroup参加の順序 | DBの取得順 | P-A=1、P-B=2 |

## 6. Business Rules / Invariantsと配置

| ID | Rule / Applies To | Evidence | State | Placement候補 / 反例 |
| --- | --- | --- | --- | --- |
| GM-01 | Active Groupの人数1〜4 | current-model: Groupと金額、既存境界分析 | Confirmed（Active人数としてのモデル化はADRで確認） | Aggregate / 同時参加で5人にしない |
| GM-02 | 作成者が初期Owner。Active Groupには唯一のOwner | current-model: Group Role・権限 | Confirmed | Aggregate / 空Owner・2 Owner状態を公開しない |
| GM-03 | 譲渡先は同GroupのActive Participant | 同上 | Confirmed | Aggregate＋認可 / Left・他Groupを拒否 |
| GM-04 | Ownerは譲渡またはGroup終了まで脱退不可 | 同上 | Confirmed | Aggregate / 最後の1人の脱退を拒否 |
| GM-05 | 招待・終了・Group CSVはOwnerのみ | 同上 | Confirmed | Application認可 / Clientのowner=trueは証拠にしない |
| GM-06 | 参加・脱退で過去Expenseと精算責務を上書きしない | current-model: 途中参加・脱退 | Confirmed | Context間Policy / Leftは既存支払の権限消失と同義でない |
| GM-07 | Archived Groupは招待・参加不可 | current-model: Group終了・Archive | Confirmed | Aggregate / 正常な招待でも参加拒否 |
| GM-08 | 同利用者の同Group内Active参加は最大1。参加順はGroup内で単調・再利用なし | 重複・再試行対策、参加順Tie-breakの具体化 | Proposed | Aggregate / 同時重複参加・同時順序採番 |
| GM-09 | 版、Owner、在籍変更、必要履歴、operation結果が一括成立 | 正常・競合例からの整合性設計 | Proposed | Repository Portの原子性 / 保存失敗時に部分反映なし |
| GM-10 | Actorと対象Participantの対応は信頼済み本人性とGroup状態から判定 | 認可ADR Proposal | Proposed | Application認可 / なりすまし・他Group ID差替え拒否 |

## 7. Aggregate候補 / Repository Port

第一候補はGroupをRootとし、現在のParticipant状態・Owner参照・参加順採番を同じ整合性境界へ入れる。人数、譲渡先の在籍、Owner脱退禁止が同じ時点で成立する必要があり、最大4人の現在状態は小さい。GM-01〜04/08/09が理由であり、Tableの形は理由にしない。

代替はParticipantを独立AggregateとしてGroupとの同期Coordinatorで守る案。独立更新には向くが、人数とOwnerが跨るため一時的不整合を許せず、同じ原子性を別契約で回復するCostがある。Ownerを独立Aggregateにする案も責務譲渡中の不在・重複を招くため推奨しない。採否は境界ADRで決める。

以下は言語非依存の契約案。ApplicationがPortを定義しInfrastructureが実装する。DomainはI/Oしない。公開HTTP／GraphQL契約やDB製品をこの文書では選ばない。

| Port operation | Input → Output | Guarantee / Failure |
| --- | --- | --- |
| GroupRepository.load | GroupId → GroupState＋version またはNotFound | OwnerとActive参加集合は同一版。ORM型を返さない。返却状態を変更しても保存まで共有状態を変えない |
| GroupRepository.commit | newState、expectedVersion（作成時Absent）、operation{actorSubject, operationId, fingerprint}、membershipChanges → Committed{ids,version} / Conflict / AlreadyExists / OperationMismatch / Unavailable | create-if-absent / compare-and-swap。状態・版・参加脱退履歴・operation結果を全成功または全失敗。失敗しても元状態・履歴不変 |
| GroupRepository.findOperation | actorSubject＋operationId → result＋fingerprint またはMissing | 同じActorのoperation結果を照合。異なるActorへ結果を返さない。応答喪失時は先に照合し、Missing時だけ最新状態で再判断 |

operationIdはActor内で全Group・Command共通の一意な名前空間とし、fingerprintはCommand種別、対象Group／Participant、expectedVersion、入力を含む案。サーバ生成時刻・IDは含めず最初の成功結果を再利用する。初回成功後にOwnerを失った再送では、同じActorへ最小限のCommand結果（ID・versionのみ）を返す案で、現在Groupの閲覧権限を付与しない。この例外を含め認可ADRのOwner判断が必要。

競合後に入力・期待版を変える操作は新operationIdを用いる。Conflictを無条件に自動再試行しない。Unavailableでは成功したか不明な場合があるためfindOperationで照合する。失敗結果は永続記録しない案。冪等結果の保持期間、削除、fingerprint保護、DB側の原子性は未決であり、in-memory fakeの成功はPersistence適合の証拠にならない。

ActorSubject解決、Clock、ID発行はApplication境界で注入可能にする。業務Entityへ認証Tokenを渡さない。検証済みInvitationを受け取る内部操作は、公開経路から直接呼べない契約が成立してから後続で導入する。

他Context向けの照会候補はversion付きGroupMembershipView（GroupId、groupState、ParticipantId、active、joinOrder、ownerParticipantId）。用途は「この時点の在籍」であり、Settlementの過去支払責務の判定には使わない。照会後の脱退とExpense作成の競合を解く契約は未決。これをAcceptedなContext間Portとして公開・実装しない。

## 8. Confirmed Decisions

ADR #24の3 Context、MVP Modular Monolith、State model＋不変業務履歴、Command／Query分離を維持する。GM-02〜07、人数1〜4、複数Group所属、参加・脱退履歴はcurrent-modelのConfirmed Rule。PR #27は2026-09-06T12:03:31ZにMerge済みで、Accepted文書の統合記録である。C1の充足証拠ではない。

## 9. Proposed / Assumptions

| Item | Type | Reason | Validation Needed |
| --- | --- | --- | --- |
| Group Rootに現在の在籍とOwnerを置く | Proposed | 人数・譲渡・脱退の同時不変条件 | 境界ADR Accepted |
| 譲渡と脱退は別Command | Proposed | 1操作1結果にし、旧Ownerは譲渡後に残れる | OwnerのUX／業務確認。既存比較文書の複合操作案を採用済みとしない |
| 自己譲渡No-op、再脱退AlreadyLeft、Archived更新拒否 | Proposed | 成功・失敗を観測可能にする | 境界ADR Accepted |
| version CAS、operation結果との原子Commit | Proposed | 競合と応答喪失への対処 | 境界・認可ADR Accepted |
| テスト内のActorSubjectは架空で、認証済みと仮定 | Assumption | 本番認証なしでも純粋モデルを検証するため | 本番接続前に別途認証方式のAccepted Decision |

## 10. Open Questions / Conflicts

| ID | Type | Question | Impact / Required Evidence |
| --- | --- | --- | --- |
| OQ-G1 | Open Question | 4人上限はActive在籍数か。再参加時のID・順序・履歴はどうするか | 境界ADRでActive上限、再参加延期の可否をOwner判断。過去Memberを人数へ混ぜない案 |
| OQ-G2 | Open Question | 本人性の信頼元、招待宛先・期限・取消・消費、枠予約をどうするか | 認可ADRと後続招待設計Task。参加Command本番接続はBlocked |
| OQ-G3 | Open Question | 脱退・Owner変更と他Context操作の認可判定時点 | 版付き照会だけで解決済みにしない。後続Context間整合性ADRが必要 |
| OQ-G4 | Open Question | Archivedでの譲渡・脱退・Owner不在とCSV責任 | 初回Scope外。Group終了・Retention実装前に別Decision |
| OQ-G5 | Open Question | 冪等記録の保存期限・最小化・削除・本人性との関係 | 認可ADR、後続保存設計。PersistenceのReadyを阻害 |
| C1 | Conflict | Snapshot平文禁止と業務必須情報保存の解釈・保護 | ADR #24の別Security ADR＋Owner Accepted＋独立Security Review。今回解消しない |

## 11. Next Modeling Step / Delivery Gate

1. Ownerが2つのADR Proposalの選択肢・制約を確認し、Accepted／Rejected／修正要求を明示する。文書PRのMergeは採用の代わりにならない。
2. Accepted後にRequirement・DCを採用案へ更新し、純粋Domain→Applicationとfakeによる契約検証の順に1〜2日TaskをReady評価する。現在は全実装TaskをBacklog / Blocked Yesとする。
3. 招待・再参加、Context間認可、C1の設計を必要な順に進める。C1未充足のPersistence実装はBlockedを維持し、Owner承認だけでSecurity Reviewを省略しない。

## GitHub delivery map

[設計Task #37](https://github.com/takeshi-arihori/kakei_app/issues/37)は[設計Epic #12](https://github.com/takeshi-arihori/kakei_app/issues/12)配下。実装能力は[Group Epic #34](https://github.com/takeshi-arihori/kakei_app/issues/34)へ分離する。以下は計画時点の要約で、進捗の正本は[Private Project #9](https://github.com/users/takeshi-arihori/projects/9)。SprintはOwner Planningまで未設定。

| Task | Estimate | Dependencies / 初期Status | Deliverable |
| --- | --- | --- | --- |
| [#37 設計パッケージ](https://github.com/takeshi-arihori/kakei_app/issues/37) | 1日 | #9/#31 Done、#24条件付きAccepted / Review | 本分析、ADR Proposal、Task、Merge記録のDraft PR |
| [#38 Group生成](https://github.com/takeshi-arihori/kakei_app/issues/38) | 1日 | ADR #35/#36 Accepted、設計統合待ち / Backlog・Blocked Yes | 初期ParticipantとOwnerを持つ純粋Domain |
| [#39 譲渡・脱退](https://github.com/takeshi-arihori/kakei_app/issues/39) | 2日 | #38 Done、ADR #35/#36 Accepted / Backlog・Blocked Yes | 在籍・Owner遷移Domain |
| [#40 Application・Port](https://github.com/takeshi-arihori/kakei_app/issues/40) | 2日 | #38/#39 Done、ADR #35/#36 Accepted / Backlog・Blocked Yes | fakeによる認可・競合・再送契約検証 |
| [#41 招待・再参加設計](https://github.com/takeshi-arihori/kakei_app/issues/41) | 1日 | 現行Ruleを入力、採用は対象外 / Backlog・Blocked No | Owner判断用の比較表とADR入力 |
| [#42 保存Adapter](https://github.com/takeshi-arihori/kakei_app/issues/42) | 暫定2日 | #40、保存Security Decision、C1未充足 / Backlog・Blocked Yes | 将来の保存契約Integration検証。Ready前にSchema・移行・見積り再具体化 |

ADR [#35](https://github.com/takeshi-arihori/kakei_app/issues/35)と[#36](https://github.com/takeshi-arihori/kakei_app/issues/36)はそれぞれ判断整理1日、Proposed / Backlog・Blocked Yes。OwnerのDecision待ち時間は見積りに含めない。C1は[#24](https://github.com/takeshi-arihori/kakei_app/issues/24)で未充足を追跡し、#42へ紐付ける。
