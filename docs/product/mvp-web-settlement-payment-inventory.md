# 共有割り勘MVP Settlement／Payment 操作・画面境界

- Task: [148](https://github.com/takeshi-arihori/kakei_app/issues/148)／親Epic [#90](https://github.com/takeshi-arihori/kakei_app/issues/90)。
- Baseline: develop `583adf327a7a912f847ac8fcfa46a652c4e68e70`（PR #147統合済み）。
- Scope: 精算選択・申請・承認／却下・新版・取り下げ・取消、支払報告／確認・差し戻し、Archive、認可・回復・Group lifecycleの観測。
- Knowledge State: 業務RuleはConfirmed／Accepted出典の転記、全画面分類はProposed。未決Aggregate・公開契約・本人性や具体Route／Layoutを採用しない。

## 1. Ownershipと未決境界

ADR #24の3 ContextとState model、ADR #55のSettlement保護Data Owner／読取Policy、ADR #73のSettlement close fenceと進行中factの所有はAcceptedである。Settlement Case、Snapshot Revision、Approval、Payment Instruction、Payment AttemptはConfirmed業務概念だが、具体Aggregate／Repository／Expense予約・解放の原子性は未決。候補の[設計比較](../domain/shared-expense-design-boundaries.md)を一括採用しない。

Expense Recordingは未精算Expenseを、Group ManagementはMembership／Owner／lifecycle／固定版Access Policyを所有する。Context間は公開Portを使い他ContextのTable／Key／暗号化Payloadを直接参照・複製しない。FrontendはServerの正本結果を表示し、金額・Balance・送金最適化・最終認可を所有しない。

Confirmed Ruleは公開済み・実装済みという意味ではない。Proposedは画面分類・明示候補、Open Questionは不足する契約、Gateは後続Ready前の解消条件。現在の業務公開GraphQLはQuery.apiStatusだけで、本Inventoryを未実装Operation catalogへ追加しない。

## 2. Source of Truth

| ID | Source | 用途 |
| --- | --- | --- |
| P1 | [current-model: Group全体の精算／割合と負担額](current-model.md) | 選択、固定Snapshot、Balance、最少送金と参加順。 |
| P2 | [current-model: Settlement Approval・Revision／Group Role](current-model.md) | Activeの開始、必要承認者、申請・承認・却下・新版・訂正境界。 |
| P3 | [current-model: Awaiting Approval取り下げ／Issue #9確定Lifecycle](current-model.md) | Withdrawn、Cancellation、Case／Expense版競合、No Payment Required、不変Archive。 |
| P4 | [current-model: 支払確認・差し戻し・再試行](current-model.md) | 外部送金、Instruction／Attempt、部分支払非提供、全受取確認。 |
| P5 | [current-model: Receipt・CategoryのArchive所属月](current-model.md) | Asia/Tokyo archivedAtとoccurredOn、跨月・非重複表示。 |
| P6 | [current-model: Group終了／Retention／CSV／画像保持](current-model.md) | GroupとSettlementのArchive区別、期限・CSV・画像削除入力。 |
| A24 | [ADR #24](../adr/shared-expense-domain-boundaries.md) | 3 Context・State modelと残Aggregate／Port Gate。 |
| A35 | [ADR #35](../adr/group-management-consistency-boundary.md) | Group／Membership／Ownerの所有。 |
| A36 | [ADR #36](../adr/group-management-command-authorization.md) | 内部Actor境界。Group CommandのoperationIdを転用しない。 |
| A52 | [ADR #52](../adr/group-invitation-and-rejoin.md) | 再参加の新IDと過去責務。 |
| A55 | [ADR #55](../adr/snapshot-revision-security-and-retention.md) | 保護方式、Snapshot最小保存・関与Policy、固定版Read、Audit／Retention。 |
| A73 | [ADR #73](../adr/group-close-consistency-and-retention-boundary.md) | close fence／終了判定Receipt、Closing・Canceling／ArchivedとOwner固定期限。 |
| GMI | [Group Management Inventory](mvp-web-group-management-inventory.md) | 在籍・Owner・Group終了・CSV／期限の入力。 |
| ERI | [Expense／Receipt／Category Inventory](mvp-web-expense-receipt-category-inventory.md) | 元支出訂正・Receipt不変・購入月／画像保持。 |
| D | [design-gates](design-gates.md) | 具体集約・予約／Context契約・本番接続のGate。 |
| API | [API入口](../api/README.md)／[Operation Trace](../api/graphql-contracts.md) | 現行apiStatusと公開業務Operation未実装。 |
| W | [Frontend Rule](../engineering/frontend.md) | Server正本、状態分離、公開契約Ready後の再送・入力。 |
| K | [Coding Rule](../engineering/coding-standards.md) | JPY整数、UTC Timestamp・明示Timezone、Error／Security。 |
| T | [Testing Rule](../engineering/testing.md) | 権限・失敗・競合と文書検証。 |

## 3. 操作Inventory

33行すべてに一つのPresentation分類と理由を持たせる。独立screenはRoute決定ではなく、state transitionには表示・自動遷移・障害の観測を含む。Gateは§4、Follow-upは§7を参照する。

| ID | Capability／Operation | Source | Knowledge State | Actor | Data Owner／Authorization Source | Presentation Boundary／理由（Proposed） | State or failure observation | Gate | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | Settlement／Case・Revision一覧と詳細 | P2・A55 | Confirmed履歴／Gate一覧 | 認可済みActor（X01） | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。Group Access PolicyはGroup Management。一覧の粒度・FieldはG2。 | 独立screen（Proposed）。進行中の精算と必要な履歴を選んで確認するため。 | Case IDと不変Revisionを区別する。一覧・並び順・未精算Expenseの読取範囲は未決。 | G1・G2・G5 | F1・F2・F5 |
| S02 | Settlement／対象Expenseの明示選択 | P1・P2 | Confirmed Rule | Active Participant | 未精算ExpenseはExpense Recording（A73）。選択・予約PortはG1。 | dialog／補助flow（Proposed）。今回精算する支出を選ぶ作業境界が必要なため。 | 未精算Expenseを明示選択。「すべて選択」は選択Shortcut。未選択・開始後の登録Expenseは含めない。同時刻でも所属は選択IDで判定。予約競合・選択可能Readは未決。 | G1・G2 | F1・F2・F6 |
| S03 | Settlement／Snapshot内容の確認 | P1・P2 | Confirmed Rule | 申請するActive Participant、参照はX01 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。Expense内容取得と固定の原子性はG1。 | 既存screen内state transition（Proposed）。申請入力中に固定される支出と算出結果を確認するため。 | 対象Expense ID、金額・実支払者・Split・負担額、Balance、Payment Instruction候補を固定し作成後不変。初回CaseのExpense ID集合を固定。Frontendが再計算して正本にしない。 | G1・G2 | F1・F2・F5 |
| S04 | Settlement／Participant Balanceの確認 | P1 | Confirmed Rule | X01の認可済みActor | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。Serverの算出Resultと説明Field契約はG1/G2。 | 既存screen内state transition（Proposed）。選択支出の精算残高を同じ申請・詳細上で確認するため。 | 実支払額合計−負担額合計。正は受取、負は支払、Group合計0円。JPY整数の正本はServer。 | G1・G2 | F1・F2・F5 |
| S05 | Settlement／送金指示候補の確認 | P1・P4 | Confirmed Rule | X01の認可済みActor | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。送金最適化と参加順入力PortはG1。 | 既存screen内state transition（Proposed）。支払先と送金回数の根拠を同じ精算内で確認するため。 | Group全体で相殺して送金回数を最少化。最少候補を支払側参加順→受取側参加順の辞書順で一意に選ぶ。支出ごとの債務は維持しない。実送金はSystem外。 | G1・G2 | F1・F2・F5 |
| S06 | Settlement／必要承認者・本人承認の確認 | P2・A52 | Confirmed Rule | 申請Actorと固定された必要承認者 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。Participant寿命はGroup Management、固定・本人照合PortはG1/G2。 | 既存screen内state transition（Proposed）。誰の承認が必要かを同じSnapshot上で確認するため。 | 実支払者またはallocation>0のParticipantをRevision作成時に固定し待機中に変更しない。申請者自身が必要承認者なら申請操作を本人承認として記録。旧／新Participant IDを混同しない。 | G1・G2 | F1・F2・F5 |
| S07 | Settlement／初回申請 | P1・P2・P3 | Confirmed Rule | Active Participant | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。Case／Revisionの保存・予約・認可はG1/G2。 | dialog／補助flow（Proposed）。固定対象と必要承認者を確認して申請するため。 | Case IDを発行しSnapshot Revisionを関連付ける。通常Awaiting ApprovalでPaymentを有効化しない。本人のみ必要承認者かつ全Balance0ならS17。公開Input・版・Key・失敗はGate。 | G1・G2・G3 | F1・F2・F6 |
| S08 | Settlement／承認 | P2・A55 | Confirmed Rule | 当該Revisionの必要承認者本人 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。固定Actor資格・現在Policyと保存の同一判断点はG1/G2。 | dialog／補助flow（Proposed）。金額・支払先を本人が確認して承認するため。 | Participant・判断・決定時刻を記録。全員承認でApproved／Payment Active、全Balance0ならS17。Ownerというだけで他者分を承認しない。競合・二重送信の公開契約はGate。 | G1・G2・G3 | F1・F2・F5 |
| S09 | Settlement／理由付き却下 | P2 | Confirmed Rule | 当該Revisionの必要承認者本人 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。判断と版・理由保存の契約はG1/G2。 | dialog／補助flow（Proposed）。誤りと却下理由を訂正権限者へ返すため。 | 理由必須。1人の却下でRejected、Payment Instructionを有効化しない。Approval却下とPayment Attempt差し戻しを別Lifecycleとして表示。 | G1・G2・G3 | F1・F2・F5 |
| S10 | Settlement／RejectedとExpense訂正の観測 | P2・P3・ERI | Confirmed Rule | Expense訂正はSource Ownerまたは現在Owner、他承認者は理由付き却下 | Expense Recordingが未精算factを所有。Case／Expense版・整合性PortはG1。 | 既存screen内state transition（Proposed）。却下された精算で訂正待ちの状態を観測するため。 | Rejected Revisionの旧値は不変。Expense同ID・理由／変更者・時刻・前後値履歴を維持。Case／Expense期待版が一致する先行訂正／再申請のみ成立し後続は部分反映なし。同一操作再送は非重複。実際のExpense／Receipt訂正はERIへ。 | G1・G2 | F1・F2・F6 |
| S11 | Settlement／同Caseの新版再申請 | P2・P3 | Confirmed Rule | 元申請者または現在Group Owner | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。訂正後Expenseの読取・期待版・予約契約はG1。 | dialog／補助flow（Proposed）。訂正結果を同じ精算Caseの新版として確認して申請するため。 | 同CaseへpreviousSnapshotId付き新Revision。初回対象Expense集合は維持し追加／除外不可。訂正後にBalance／Instruction再計算、全員が再承認し旧承認を継承しない。実申請者を記録し必要承認者なら本人承認。元申請者の脱退時も現在Ownerが引継ぎ可能。 | G1・G2・G3 | F1・F2・F6 |
| S12 | Settlement／Awaiting Approval・Rejectedの取り下げ | P3 | Confirmed Rule | 元申請者または現在Group Owner | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。Case全件解放とExpense Recording整合はG1。 | dialog／補助flow（Proposed）。理由と全件解放の影響を確認して取り下げるため。 | 理由必須、Case全体だけをWithdrawn終端へ。全Expense解放、旧Snapshot／承認／却下／訂正履歴保持。一部解放・同Case再開／再申請なし。承認成立を意味せずPaymentを有効化しない。Approved以後はS13。 | G1・G2・G3 | F1・F2・F6 |
| S13 | Settlement／Payment Activeの取消要求 | P3 | Confirmed Rule | 元申請者または現在Group Owner | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。Attempt不在・取消予約・支払競合の原子性はG1。 | dialog／補助flow（Proposed）。理由と全体取消の条件を確認して同意を求めるため。 | Payment Attemptが1件もない場合だけ理由付き取消要求。Cancellation Pendingへ進め、全必要承認者の同意まで新しい支払報告禁止。Attempt存在時の一部／全体取消は不可。 | G1・G2・G3 | F1・F2・F6 |
| S14 | Settlement／取消同意 | P3 | Confirmed Rule | 固定された必要承認者本人 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。取消判断保存と全員成立契約はG1。 | dialog／補助flow（Proposed）。Case全体取消に本人が同意するため。 | 全員同意でCancelled終端と全件解放。取消履歴を保持。取消同意は通常Approvalと別判断。 | G1・G2・G3 | F1・F2・F5 |
| S15 | Settlement／取消拒否・支払再開状態 | P3 | Confirmed Rule | 固定された必要承認者本人 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。拒否成立後の状態・支払解禁はG1。 | dialog／補助flow（Proposed）。全体取消を拒否して既存精算を継続するため。 | 拒否でPayment Activeへ戻る。取消拒否の理由必須は正本にないため採用しない。通常支払報告の再開はServer結果で判定。 | G1・G2・G3 | F1・F2・F5 |
| S16 | Settlement／Withdrawn・Cancelled後の解放履歴 | P3・ERI | Confirmed Rule | 参照はX01、解放Expense訂正はSource Owner／Owner | Settlement履歴とExpense Recordingの現行Expenseを区別。Readと解放PortはG1。 | 既存screen内state transition（Proposed）。終端Caseと解放支出の現状を同じ履歴で区別するため。 | 履歴を保持、Expense全件を別Caseへ選択可能。解放Expenseは履歴付き訂正可能、実操作はERI。旧Caseを復活させない。 | G1・G2 | F1・F2・F6 |
| S17 | Settlement／No Payment Required・直接Archive | P2・P3 | Confirmed Rule | 固定された必要承認者、ArchiveはSystem | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。承認成立とArchive固定の契約はG1。 | 既存screen内state transition（Proposed）。送金不要の精算完了を通常精算と区別して確認するため。 | 全Balance0ならInstructionを作らず、通常の必要承認者全員承認でPayment Activeを経ず直接Archive。申請者だけが必要承認者なら申請時即時Archive。Archive時刻Fieldの公開契約はGate。 | G1・G2・G3 | F1・F2・F5 |
| P01 | Payment／有効な支払指示の参照 | P2・P4・A55 | Confirmed Rule | 当該RevisionへのX01認可済みActor | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。Read資格とPayment状態取得はG1/G2。 | 独立screen（Proposed）。精算後に自分の支払・受取責務を確認する入口が必要なため。 | 承認前候補を支払義務として扱わない。Approved／Payment Activeで有効化。未払い→支払報告済み→受取確認済みをInstruction単位で観測。外部送金手段は本Taskで選定しない。 | G1・G2・G5 | F1・F2・F5 |
| P02 | Payment／外部支払の報告 | P4・P3 | Confirmed Rule | Instructionの支払側Participant本人 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。本人資格・Attempt作成と競合はG1/G2。 | dialog／補助flow（Proposed）。外部で行った支払を本人が報告するため。 | 支払者の報告だけでは完了しない。Cancellation Pending中は禁止。実送金はSystem外。支払日時等の入力FieldとVersion／Key契約は未決。 | G1・G2・G3 | F1・F2・F5 |
| P03 | Payment／受取確認 | P4 | Confirmed Rule | Instructionの支払先Participant本人 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。Attempt版・本人照合と完了成立はG1/G2。 | dialog／補助flow（Proposed）。受取側が実際の受取を確認するため。 | 本人の受取確認でInstructionを完了。全Instruction完了ならP07。支払側／Ownerが代理確認できるとは扱わない。 | G1・G2・G3 | F1・F2・F5 |
| P04 | Payment／理由付き差し戻し | P4 | Confirmed Rule | Instructionの支払先Participant本人 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。差し戻しAttemptと理由の履歴はG1。 | dialog／補助flow（Proposed）。受取未確認の理由を支払側へ返すため。 | 理由を記載して差し戻し、Attemptと理由を履歴保持。Approval却下と別Lifecycle。SnapshotやExpense集合・Balance・Instructionは変更しない。 | G1・G2・G3 | F1・F2・F5 |
| P05 | Payment／差し戻し後の再支払報告 | P4 | Confirmed Rule | Instructionの支払側Participant本人 | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。同InstructionのAttempt寿命と再送非重複はG1/G2。 | dialog／補助flow（Proposed）。差し戻された支払を新しいAttemptとして報告するため。 | 同じInstructionへ新しいAttemptを追加し過去Attemptは保持。新しい支払報告と同一報告の再送を区別する具体Keyは未決。Snapshotを作り直さない。 | G1・G2・G3 | F1・F2・F5 |
| P06 | Payment／部分支払の非提供 | P4 | Confirmed非提供 | 支払側Participant | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。金額不変・入力ValidationはG1/G2。 | deferred／gated（Proposed）。MVPでInstructionの一部金額だけの支払を許可しないため。 | 部分支払UIを提供しない。送金指示の額をClientで変更して報告しない。公開Validation応答は未決。 | G1・G2 | F1・F2 |
| P07 | Payment／全受取確認とArchive | P4・P3 | Confirmed Rule | 受取確認者、Archive成立はSystem | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。最後の確認と不変Archiveの同一判断点はG1。 | 既存screen内state transition（Proposed）。精算全体の完了を既存指示上で観測するため。 | 全Instruction受取確認済みで精算完了・Snapshot Archive。Payment Attemptがある限り取消不可。Archive後は対象Expense／Approval／Instruction／Attemptも固定。Groupの終了は自動実行しない。 | G1・G2・G3 | F1・F2・F5 |
| A01 | Archive／月別Settlement履歴参照 | P4・P5・A55 | Confirmed Rule／Gate Query | X01・X05で認可済みActor | Snapshot保護DataはSettlement（A55）、本操作の具体Aggregate／PortはG1。月別Read Model・Query認可はG1/G2。 | 独立screen（Proposed）。精算が完了した月ごとの履歴を確認する入口が必要なため。 | Asia/Tokyo archivedAtの完了月だけ表示。開始月やExpense occurredOnで分類しない。複数購入月を含んでも同Snapshotを複数月へ重複表示しない。Expense購入月集計はERIで別表示。 | G1・G2・G5 | F1・F2・F5 |
| A02 | Archive／Revision・判断・Attemptの不変履歴 | P2・P3・P4・A55 | Confirmed Rule | X01・X05で認可済みActor | Settlementが保存保護対象を所有（A55）。Aggregate／公開FieldはG1/G2。 | 既存screen内state transition（Proposed）。同じ精算詳細で旧版と判断・支払履歴を確認するため。 | 旧Rejected Revision・previousSnapshotId、承認／却下／訂正／取消、差し戻しAttemptを履歴として保持。保持中の範囲はGroup期限に従う。本文の暗号化Payloadや個人識別情報をLogへ複製しない。 | G1・G2・G3・G4 | F1・F2・F4・F5 |
| A03 | Archive／再開・取消・訂正・補正の非提供 | P3 | Confirmed非提供 | 操作を試みるActor | Settlement／Expense Recordingの不変条件、公開拒否はG1/G2。 | deferred／gated（Proposed）。MVPではArchive後の再開や過去上書き補正を許可しないため。 | Snapshot／対象Expense／判断／Instruction／Attemptを再開・取消・訂正しない。補正が必要なら過去を上書きしない別Product Decision／Taskで検討。 | G1・G2 | F1・F2 |
| X01 | Security／Snapshot Revision読取認可 | A55・A52・A73 | Confirmed内部契約／Gate公開 | current Owner、関与Active／Left、旧／新Participantは独立判定 | Group ManagementのGroupAccessPolicyPort、Settlementの最小復号・関与Predicate。 | 既存screen内state transition（Proposed）。対象Revisionへの参照可否を同じ一覧・詳細で観測するため。 | Active Groupのcurrent Ownerは保持中全Revision。Activeはrequester／required approver／payer・payee／Expense payerまたはallocation>0の関与。Leftは旧IDがrequired approver・payer・payeeの離脱前由来Revision／未完了責務だけ。再参加IDへ拡張しない。非在籍は存在非開示。 | G1・G2・G3 | F1・F2・F4・F5 |
| X02 | Security／Read障害・同一requestId再送 | A55・A73 | Confirmed内部契約／Gate公開応答 | X01のActor | Group Access Policy固定版callbackとSettlement保護／Audit。 | 既存screen内state transition（Proposed）。参照中の失敗と再取得を同じ読取境界で扱うため。 | 内部Readは固定groupVersion／accessPolicyVersionの下で最小復号・関与判定・durable Audit・Serialization。timeout／Connection loss／Deadlock／例外／return直前版不一致はPayload破棄・rollback・generic Unavailable。Request全体を同requestIdで再送。公開Error／本番bindingはG2。 | G2・G3・G4 | F2・F4・F5 |
| X03 | Recovery／Command競合・応答喪失 | P3・W・A36 | Confirmed一部Rule／Gate方式 | 同じ業務操作を行った本人 | Settlement／Expense版と操作結果保存・Actor照合はG1/G2。 | 既存screen内state transition（Proposed）。更新中の競合や結果不明を同じ操作内で回復するため。 | 訂正／新版再申請は同一操作で二重訂正・二重Revisionを作らない。他CommandのKey・Fingerprint・結果再取得・権限変更後の照合／自動再試行は未決。Group operationIdやRead requestIdをCommandへ転用しない。Client状態だけで成功判定しない。 | G1・G2・G3 | F1・F2・F5 |
| X04 | Group／Closing・Cancelingのread-only | A73・GMI | Confirmed Rule | 終了前から参照認可済みのActor | Group lifecycleはGroup Management、Settlement close fence／終了判定ReceiptはSettlement。 | 既存screen内state transition（Proposed）。同じ精算画面でGroup終了処理中の制約を確認するため。 | 従来許可済み履歴だけread-only。新しい精算・承認・支払等の業務Commandは拒否し、証拠不足でGroup Archiveしない。Group取消・再試行操作はGMI。終了判定Receiptとレシート画像を区別。 | G1・G2・G3・G4 | F1・F2・F4・F5 |
| X05 | Group／Archivedの固定Owner参照・期限 | A73・A55・P6・GMI | Confirmed Rule | owner-at-archiveのみ | Group Managementの固定Owner／期限PolicyとSettlementのRead・Retention。 | 既存screen内state transition（Proposed）。Group終了後の履歴と保持期限を既存参照上で確認するため。 | Group ArchiveとSettlement Archiveは別。保持期限deleteEligibleAtを常時表示、Asia/TokyoのGroup archivedAt同時刻の1暦年後（2月29日翌年2月28日clamp）。新しい業務Command不可。CSVは固定Ownerに限定、GMIへ。 | G2・G3・G4・G5 | F2・F4・F5 |
| X06 | Cross-boundary／画像保持・CSV・Group削除連携 | P6・ERI・GMI・A55 | Confirmed Rule／Gate運用 | 参照はX01/X05、削除は各Source Owner Batch | Settlement Archive factはSettlement、画像Owner詳細は未決、Group保持制御はGroup Management。 | 既存screen内state transition（Proposed）。精算完了後の保持対象と期限を同じ履歴から区別するため。 | Receipt画像は全関連Expenseを含むSnapshot Archiveまで保持、一部精算では削除しない。画像削除後のItem等はGroup期限まで保持。CSVのsettlements／payment_attemptsは既存Package入力、画像Binaryは含めない。削除・Backup・Key失効・Audit運用は各Owner Portへ。 | G1・G2・G3・G4 | F1・F4・F5 |

## 4. Gateと解消条件

| Gate | 未決／不足 | 後続Ready条件 |
| --- | --- | --- |
| G1 Domain／整合性 | Case／Revision／Instruction／Attempt集約、Expense選択・予約／解放・訂正／新版競合、保存単位・版・再送結果。 | 個別Accepted Design／必要ADR、Context Portと原子的InvariantをTestへTrace。旧Transaction候補を流用しない。 |
| G2 公開契約／本人性 | 業務Query／Mutation、本人性・Group scope、認可時点、Read範囲・公開Error、FieldとKey。 | Selected Use Caseの認証認可・Error契約、SDL・catalog・生成型・Testとwiringを揃える。内部Unavailable／requestIdを公開契約へ暗黙採用しない。 |
| G3 保護の本番接続 | A55の保護方式はAccepted。Case／Revision保存、Key Provider、durable Audit、原子性と配送の本番Adapterは未実装。 | Adopted方式の適用Record／PortとProduction Adapter・障害・版整合のEvidenceを揃える。方式を再び未決としない。 |
| G4 運用／Retention | Group削除連携、Snapshot／Attempt／画像・Backup／Key失効、Checkpointと回復Runbook。 | 各Data Ownerの冪等Port、部分失敗・期限・失効・再実行と監視を検証。 |
| G5 Presentation | 横断UX確認、Navigation／Route、i18n・日時表示、詳細状態・回復導線とApp shell。 | 3 Inventory＋操作認可／回復を入力にOwner UXを確認。業務契約不足を画面で確定しない。 |

## 5. 認可・失敗・再送

Snapshot ReadのA55 Policyは「Group全員が全Revisionへ常にアクセス可能」ではない。current Owner、Active関与者、Leftの旧ID、再参加の新旧ID、固定owner-at-archiveを区別する。Read認可をCommandの承認／支払資格へ拡張しない。Ownerの全Revision参照権は他ParticipantのApproval／受取確認の代理権ではない。

A55の固定版callbackは最小復号、関与判定、durable Audit、Response Serializationまで保護する。index missで復号せず存在非開示、内部障害はPayloadを返さずUnavailable、同requestIdでRequest全体再送。本番の公開Responseと本人性が決まるまではFrontendへ内部契約を直接公開しない。

ConfirmedなCase／Expense訂正競合は先行成立のみ・後続部分反映なし・同一操作非重複。一方、一般のSettlement／Payment Commandのoperation ID、Fingerprint、結果確認、権限変更後の照合はG1/G2。Group Command A36の結果再取得契約やRead requestIdを採用済みとして転用しない。ClientのOptimistic表示だけで成功にしない。

Withdraw／Cancellation／Approval／Paymentの競合は必要な原子的契約がG1にある。状態の非表示だけでServer認可や競合安全性を満たしたことにしない。本人が承認者だけの場合の直接Archiveと通常支払完了Archiveを区別し、払っていない精算へ支払済み表示を生成しない。

## 6. 日付・Archive・Open Question

Settlement Archiveの所属月はAsia/TokyoのSnapshot archivedAt。購入月はExpense occurredOnで、精算開始月・Group Archive月ではない。8月30日申請・9月2日受取確認完了なら9月Settlement Archive、8月購入Expenseは8月Category集計に残る。複数購入月でもSnapshotを月別に重複表示しない。No Payment Requiredは全員承認成立で直接Archiveし、架空の受取確認を作らない。具体archivedAt公開Field・日時書式はG2/G5。

Group Archiveは別の明示Owner操作で、未精算Expense／進行中Settlementの不在と有効なContext証拠が必要。精算完了でGroupを自動終了しない。Group期限はA73の1暦年後・2月29日clamp、内部UTC Timestampを保ち表示Timezoneを明示する。

| Open Question | 扱い |
| --- | --- |
| Case・Instructionの集約と保存、Expense予約・全件解放 | G1。単一Transaction／別Port等を未承認で確定しない。 |
| 一覧・選択支出のRead範囲／入力Field／公開Error | G2。A55のSnapshot Read Policy以外へ無条件展開しない。 |
| 承認／取消／支払競合、一般CommandのKey・再送結果確認 | G1/G2。明示済み訂正／再申請RuleだけConfirmed。 |
| Cancellation拒否の理由、支払証憑・新しい通知・代理操作 | 正本根拠なし。MVP追加機能として採用しない。 |
| 本番Key Provider／Audit／本人性／Port wiring／Backup | G2–G4。採用保護Ruleと未実装Adapterを区別。 |
| i18n・日付表示・Navigation／詳細state matrix | G5。後続UX入力とOwner確認を必要とする。 |

## 7. 残りのDeliveryと依存入力

下記は後続候補・Gateであり、作成済みReady Taskではない。親Epic #90は機能接続条件が不足するためBacklog／Blocked Yesを維持する。

| ID | 後続成果 | 入力と順序 |
| --- | --- | --- |
| F1 | Expense／Settlement Ownership・Domain／Port契約 | E/Receipt Inventory＋本表＋A24/A55/A73、G1。必要DecisionをOwnerへ渡し、個別Ready TaskでDomain実装。 |
| F2 | 本人性・公開GraphQL／Error契約と実接続 | 選んだUse CaseのAccepted契約、G1–G3。本番認可・SDL／生成型／catalog／TestとAdapter Evidenceの後に機能画面へ。 |
| F3 | 横断Navigation／journey／state matrix→App shell | GMI＋ERI＋本Inventoryを入力にUX案作成。Owner UX確認でNavigation／共通状態のAccepted入力を揃え、その後にApp shellを個別Ready化。 |
| F4 | 保護・Retention・実fence／配送・Backup運用 | A55/A73、Source Owner別Port、G3/G4。未精算／進行中証拠・部分削除・回復を本番で検証。 |
| F5 | Component／Accessibility・状態検証 | F3の共通UX入力と操作ごとの認可・公開Error・回復契約。Keyboard／Focus／200% Zoom／Reduced Motionを対象にする。 |
| F6 | 契約Ready後のvertical slice | F1/F2/F4の対象Gate＋F3のApp shell／Navigation、必要なF5。Group／Expense／Settlementを一括Readyにせずslice単位で進める。 |

Dependency: 本Inventory→F3 UX→Owner確認→App shell。F1とF2/F4の設計準備はUXと独立して進められるが、本番機能Codeは対象DecisionとReady Gateまで待つ。前提PR統合後は最新develop、未統合Code依存がある場合だけPlanningでStackを明示する。WIP1、1 Task／Branch／PR。文書完成を「残りの機能実装完了」と報告しない。

## 8. Done Criteria trace・検証と文書影響

| Done Criteria群 | Evidence |
| --- | --- |
| Source／Knowledge／全行属性・一意分類 | §1–§4、33行×10列、全画面案Proposed。 |
| Expense明示選択・固定内容・Balance・最少指示・承認者 | S02–S07、P1/P2。 |
| Approval／Rejected・新版・訂正競合／非重複 | S08–S11、X03、ERI。 |
| 全CaseWithdraw・取消同意／拒否・解放 | S12–S16、P3。 |
| Payment報告・確認・差し戻し・再試行・非部分支払 | P01–P07、P4。 |
| No Payment Required・Archive不変・月境界 | S17、A01–A03、§6。 |
| Read権限・固定版・失敗再送／Group境界 | X01–X06、§5、A55/A73。 |
| 未決公開API・本番保護／運用・後続Graph | §4–§7。現行Query.apiStatusのみ。 |

文書のみのため新しい振る舞いTest／TDDは追加しない。Source trace、構造・参照・公開情報とpnpm checkで検証し、ローカルE2Eは省略理由をIssue／PRへ記録する。Self Review後に新しいtask_evaluatorへ最新文書ハッシュを渡す。実結果はIssue／PRで追跡する。

既存Rule・Accepted ADRを変更しないためDomain／Schema／生成型／Migration／図／Runbook／AGENTS／skill更新は不要。新規文書とTask／Epic追跡のみを同期。残RiskはProposed UXとG1〜G5であり、仕様整理の完了で本番Gateは解除しない。
