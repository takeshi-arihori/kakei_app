# 共有割り勘MVP Expense／Receipt／Category 操作・画面境界

- Task: [#146](https://github.com/takeshi-arihori/kakei_app/issues/146)／親Epic [#90](https://github.com/takeshi-arihori/kakei_app/issues/90)。
- Baseline: develop `4391624caef1075246be8aa8de79ba1d8c9bdf9f`。Group Managementの前提Inventoryは[#144 / PR #145](https://github.com/takeshi-arihori/kakei_app/pull/145)で統合済み。
- Scope: Expense、Receipt、Adjustment／Bundle、Category／Suggestion、月別Category支出とそれらから見たGroup lifecycleの観測。Settlement／Paymentの実操作は後続Inventoryへ渡す。
- Knowledge State: 業務Ruleは参照先のConfirmed／Acceptedの転記。すべての画面分類・理由は`Proposed`。Domain Aggregate、Route、Navigation、Layout、API、製品採用のDecisionにはしない。

## 1. OwnershipとFrontendの境界

ADR #24で3 Contextを採用し、ADR #73でExpense Recordingが未精算Group Expenseとclose fence／終了判定Receiptを所有することを確認できる。一方、Receipt Draft／Item／Adjustment／Bundle、Category／Suggestion Rule、月次Read Modelの具体的Data Owner・Aggregate・Portは未決である。[設計比較](../domain/shared-expense-design-boundaries.md)のOwner／Aggregate表は候補であり、一括Acceptedにしない。

Source Ownerは業務上の訂正資格を表す。手入力Expenseでは登録者、Receipt由来ではUploaderであり、Data OwnerであるContextと同義ではない。Group ManagementはMembership／Owner／lifecycleの入力を所有し、SettlementはRevision／Snapshotの状態を所有する。Frontendは正本計算・最終認可・DB Accessを担当せず、BackendのRead／Command結果を表示する。

| Knowledge State | 読み方 |
| --- | --- |
| Confirmed Rule | current-modelまたはAccepted ADRの業務Rule。実装済み／公開済みを意味しない。 |
| Proposed | 画面分類・理由と明示されたOwner／Actor候補。Owner確認前で変更可能。 |
| Open Question | 正本に根拠のない編集・閲覧範囲等。推測で埋めない。 |
| Gate | Production接続や後続TaskのReady前に解消が必要。文書Inventory作成自体を阻害しない。 |

## 2. Source of Truth

各行のSource IDは下表の文書・節へTraceする。Actor／Owner欄で参照するIDも同じ正本を指す。

| ID | Source | 用途 |
| --- | --- | --- |
| P1 | [current-model: Groupと金額／Group Role・権限](current-model.md) | JPY整数、Group scope、Active Participantの登録資格。 |
| P2 | [current-model: 割合と負担額](current-model.md) | 10%単位、合計100%、0%、最大剰余、実支払者・参加順Tie-break。 |
| P3 | [current-model: 途中参加・脱退の時間境界](current-model.md) | 登録時Participant／Splitの固定と過去責務の維持。 |
| P4 | [current-model: Awaiting Approval取り下げ／確定Lifecycle／Settlement Approval・Revision](current-model.md) | Source Owner、Rejected訂正、Case／Expense期待版、非重複再送、編集不可、Withdrawn／Cancelled解放後の訂正。 |
| P5 | [current-model: Receipt・Category](current-model.md) | Draft本人制約、確定・共有、訂正、Bundle・Expense対応と全登録完了条件。 |
| P6 | [current-model: Receipt Adjustmentの各Rule](current-model.md) | 調整の符号、Item／全体配賦、最大剰余、非負制約、調整後金額。 |
| P7 | [current-model: Category／Category Suggestion Rule](current-model.md) | System標準・Group専用、Owner操作、履歴、無効化、Group限定の候補更新・Fallback。 |
| P8 | [current-model: occurredOn／月別Category集計／Archive所属月](current-model.md) | Asia/Tokyoの購入・利用日、日付Validation／再集計、Settlement Archive月との区別。 |
| P9 | [current-model: Issue #9のLifecycle・Retention／Receipt画像保持／Group終了／CSV](current-model.md) | Draft30日、画像削除条件、明細履歴の保持、deleteEligibleAt、画像BinaryのExport非包含。 |
| A24 | [ADR #24: 共有割り勘の設計境界](../adr/shared-expense-domain-boundaries.md) | 3 Context、State model、未決の個別Ownership／Port／Projection。 |
| A35 | [ADR #35: Group整合性境界](../adr/group-management-consistency-boundary.md) | Group／Membership／OwnerのData Owner。Expenseの集約契約は定めない。 |
| A36 | [ADR #36: Group Command本人性・認可・再送](../adr/group-management-command-authorization.md) | 信頼済みActorの内部境界と本番本人性Gate。operationId契約はGroup Commandに限定し、Expenseへ転用しない。 |
| A52 | [ADR #52: Invitation／再参加](../adr/group-invitation-and-rejoin.md) | 再参加時の新Participant ID、旧責務の維持。 |
| A55 | [ADR #55: Snapshot保護・保持](../adr/snapshot-revision-security-and-retention.md) | Snapshotの関与Policy、Left／再参加の独立評価、存在秘匿・保護。Receiptや全Expenseの閲覧契約へ無条件拡張しない。 |
| A73 | [ADR #73: Group終了・保持](../adr/group-close-consistency-and-retention-boundary.md) | Expense Recordingの未精算fact、Closing／Canceling／Archived、owner-at-archive、1暦年Retention。 |
| D | [design-gates](design-gates.md) | Category所属、他Context集約、予約・競合、Context間Port、本番本人性／wiring／運用の未決Gate。 |
| GMI | [Group Management Inventory](mvp-web-group-management-inventory.md) | Group選択・在籍・Owner／終了、Archive権限・CSV／保持期限の表示境界。 |
| API | [API入口](../api/README.md)／[GraphQL Operation Trace](../api/graphql-contracts.md) | 実装済み公開OperationはShared APIのQuery.apiStatusのみ。 |
| W | [Frontend Rule](../engineering/frontend.md) | 表示・入力、生成型、Client stateとServer state、同一Key再送の責務。公開契約Ready前にKey方式を決めない。 |
| K | [Coding Rule](../engineering/coding-standards.md) | JPY整数、UTC Timestamp／明示Timezone、Error・認可・依存方向。 |
| T | [Testing Rule](../engineering/testing.md) | 文書構造・Link・参照整合とRepository check。 |

## 3. 操作Inventory

39行を一つずつ独立screen、dialog／補助flow、既存screen内state transition、deferred／gatedへ分類する。非提供や未決の操作は理由と解消条件を記す。独立screenはRoute確定ではなく、既存screen内stateには表示・失敗・自動状態の観測も含む。Gate IDは§4、Follow-up IDは§7に対応する。

| ID | Capability／Operation | Source | Knowledge State（業務・未決） | Actor | Data Owner／Authorization Source | Presentation Boundary／理由（Proposed） | State or failure observation | Gate | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E01 | Expense／手入力登録 | P1・P2 | Confirmed Rule | Active Participant | Expense Recordingの未精算ExpenseはA73。登録資格はP1、在籍確認PortはG1/G2。 | dialog／補助flow（Proposed）。選択中Groupで金額・実支払者・Split・発生日を入力するため。 | JPY整数のGroup Expenseを登録。Source Ownerは登録者。Receipt入力を必須にしない。 | G1・G2 | F1・F8 |
| E02 | Expense／Split・負担額の確認 | P2 | Confirmed Rule | 登録するActive Participant | ExpenseのAllocationはExpense Recording候補。正本計算／認可境界はG1。 | 既存screen内state transition（Proposed）。支出入力中に割合とServer結果を確認するため。 | 10%単位、合計100%、0%を許可。最大剰余、同率なら実支払者、次にGroup参加順。負担額合計は支出額に一致。Frontendは正本計算を持たない。 | G1・G2 | F1・F7 |
| E03 | Expense／登録時Participantと途中参加・脱退の表示 | P3・A52 | Confirmed Rule | 参照権限を得たActor（範囲はG2） | Expenseの固定事実とGroup ManagementのMembershipを区別。閲覧認可時点はG1/G2。 | 既存screen内state transition（Proposed）。登録時の負担対象を同じExpense上で確認するため。 | 登録時Participant／Splitを固定。途中参加を過去Expenseへ追加せず、脱退で実支払者・割合・負担額を変えない。再参加IDを旧参加と同一視しない。 | G1・G2 | F1・F7 |
| E04 | Expense／発生日の入力・不正表示 | P8・K | Confirmed Rule | 登録するActive Participant | Expense Recording候補。日付ValidationはServerを正本とする。 | 既存screen内state transition（Proposed）。登録フォームで発生日の不正を修正するため。 | 手入力のoccurredOnは利用者指定の発生日。未入力／不正は確定不可。登録日や精算日を代用しない。 | G1・G2・G5 | F1・F7 |
| E05 | Expense／一覧・詳細・訂正履歴の参照 | P3・P4・A55 | Confirmed履歴／Open Question参照 | 参照ActorはG2で決定 | Expense Recording候補。A55のSnapshot参照PolicyをExpense一覧全体の認可に流用しない。 | 独立screen（Proposed）。支出と必要な履歴を選んで確認する入口が必要なため。 | 訂正前後や参加時点の履歴を保持。表示対象・Field・並び順・LeftのExpense参照範囲は未決。 | G1・G2・G5 | F1・F7 |
| E06 | Expense／手入力の通常訂正 | P4・P8 | Open Question | 通常訂正を許可するActorは未決 | 通常編集のOwner／Port・時点別権限はG1/G2。Rejected等の明示済み条件と区別。 | deferred／gated（Proposed）。通常手入力Expenseの編集権限・対象Fieldが正本で不足するため。 | 通常編集をSource Ownerまたは全Participantへ暗黙に許可しない。確認後に後続Taskで分類・契約化する。 | G1・G2 | F1 |
| E07 | Expense／Rejected後の訂正 | P4 | Confirmed Rule | Source Ownerまたは現在Group Owner | 手入力Source Ownerは登録者、Receipt由来はUploader。Case／Expenseの版契約はG1。 | dialog／補助flow（Proposed）。却下理由に対応する訂正と変更理由を入力するため。 | 同Expense IDを維持し、変更者・時刻・理由・前後値を履歴化。必要承認者というだけでは訂正不可。Case／Expense期待版が一致する先行操作だけ成立し、再申請と競合した後続は部分反映しない。 | G1・G2 | F1・F6 |
| E08 | Expense／Snapshot固定時の編集不可 | P4 | Confirmed Rule | 訂正を試みるActor | Expenseの変更境界とSettlementのRevision状態をPortで結ぶ（G1）。 | 既存screen内state transition（Proposed）。既存支出画面で現在の編集制約を観測するため。 | Awaiting Approvalでは訂正不可。Rejected時のみ明示条件で訂正可能。Approved／Payment Active後とSettlement Archive後は不変。Caseの申請・承認操作はF6へ。 | G1・G2 | F1・F6・F7 |
| E09 | Expense／Withdrawn・Cancelled後の解放と訂正 | P4 | Confirmed Rule | Source OwnerまたはGroup Owner | Expense RecordingとSettlementの予約／解放契約はG1。 | 既存screen内state transition（Proposed）。既存支出が解放され訂正対象になる状態を観測するため。 | Case全体の解放後は履歴付き訂正と別Caseへの選択が可能。旧CaseのSnapshot・承認・取消履歴は保持。Withdraw／Cancellationの実操作はF6へ。 | G1・G2 | F1・F6 |
| E10 | Expense／訂正競合・応答喪失の観測 | P4・W | Confirmed非重複／Gate方式 | 同じ訂正操作を行ったActor | Expense／Case版契約と再送の保存・本人確認・Key方式はG1/G2。Group Command A36を転用しない。 | 既存screen内state transition（Proposed）。訂正中の競合と結果不明を同じ操作内で回復するため。 | 先行訂正／再申請だけ成立し後続は部分反映なし。同一操作再送で二重訂正・二重Revisionを作らない。結果確認・Key変更条件・自動再試行は未決。Client状態だけで成功と判断しない。 | G1・G2 | F1・F7 |
| R01 | Receipt／画像入力・Draft作成 | P5 | Confirmed Rule | Uploader（Group内の作成資格はG2） | Receipt DraftのData Owner／集約は未決。Uploader専用という業務権限はP5。 | dialog／補助flow（Proposed）。画像入力から本人専用Draftを用意するため。 | 最初はUploaderだけが参照・編集できるDraft。OCR・分類の完了をもって公開Expenseにしない。画像形式・容量・通信失敗契約は未決。 | G1・G2・G3 | F2・F8 |
| R02 | Receipt／Draft参照・編集 | P5 | Confirmed Rule | Uploader本人 | Receipt Draft／OCR候補Ownerは未決。Group OwnerというだけではDraft閲覧を許可しない。 | 独立screen（Proposed）。本人が画像・明細候補を継続確認する作業境界が必要なため。 | DraftはUploader以外へ公開しない。未確定Draft／ItemはExpense・Snapshot・月別集計へ含めない。 | G1・G2・G3 | F2・F7 |
| R03 | Receipt／OCR・Category候補の確認 | P5・P7 | Confirmed Rule | Uploader | OCR／分類契約・保存境界はG1/G3。候補からの確定ActorはP5。 | 既存screen内state transition（Proposed）。Draft上で抽出候補を確認して修正するため。 | 画像から複数Itemを抽出し、System標準／Active Group Categoryから候補提示。自動確定しない。認識中・失敗・再試行の方式は未決。 | G1・G2・G3 | F2・F3・F7 |
| R04 | Receipt／明細・購入日・合計の確認修正 | P5・P8 | Confirmed Rule | Uploader | Draft／Item Ownerは未決。Uploader本人の編集権限はP5。 | 既存screen内state transition（Proposed）。同じDraftで候補のFieldを確認修正するため。 | 品名・金額・Item単位Category・購入日・Receipt合計を確認する。occurredOnは確定購入日。不正／未入力の日付は確定不可。CategoryをReceipt全体へ割り当てない。 | G1・G2・G3・G5 | F2・F3 |
| R05 | Receipt／Adjustment入力と配賦結果確認 | P6 | Confirmed Rule | Uploader（Draft入力） | AdjustmentのOwner／整合性単位はG1。配賦の正本はBackend。 | 既存screen内state transition（Proposed）。Draftの金額整合を同じ入力内で確認するため。 | 税・送料は正、値引き・Pointは負のJPY整数。特定Item紐付けはそのItemのみ、全体Adjustmentは調整前の正金額比例で配賦。絶対値の最大剰余、同率はItem記載順。調整後0円未満は拒否し、調整後金額をBundle／Expense／集計に使う。 | G1・G2・G3 | F2・F7 |
| R06 | Receipt／確定・整合不成立 | P5・P6 | Confirmed Rule | Uploader | Receipt／Itemの確定保存単位はG1。業務上の確定権限はP5。 | dialog／補助flow（Proposed）。本人が候補を確認して共有入力への確定を行うため。 | 調整を反映したItem金額とReceipt合計が整合しない場合は確定不可。Uploaderが確定したReceipt／ItemだけをGroup Expense登録入力として共有。OCR候補を確定と扱わない。 | G1・G2・G3 | F2・F8 |
| R07 | Receipt／BundleへのItem割当 | P5 | Confirmed Rule／Gate Actor | 割当Actorは未決（Uploader候補） | Bundle／ItemのOwnerと保存・認可時点はG1。候補Actorを採用済みにしない。 | dialog／補助flow（Proposed）。確定ItemをExpense単位へまとめる入力が必要なため。 | 1以上のConfirmed Itemで1 Bundle、1 Bundleから1 Expense。1 Receiptに複数Bundleを作れる。全Itemを各1 Bundleだけへ割当て、Itemの複数Bundle分割を提供しない。 | G1・G2 | F1・F2 |
| R08 | Receipt／Bundleごとの実支払者・SplitとExpense登録 | P1・P2・P5 | Confirmed Rule／Gate接続 | 登録資格はActive Participant、Bundle操作の詳細はG1/G2 | Group Expenseの未精算DataはExpense Recording（A73）、Bundle契約は未決。Receipt由来Source OwnerはUploader。 | dialog／補助flow（Proposed）。Bundleごとに支払者・割合を確認してExpenseにするため。 | Bundleごとに異なる実支払者／Splitを指定可。Bundle金額は所属Itemの調整後合計と一致。登録時のParticipant／SplitはE02/E03に従う。原子的登録単位は未決。 | G1・G2 | F1・F2・F8 |
| R09 | Receipt／全Item割当・全Expense登録の完了状態 | P5・P8 | Confirmed Rule | 認可済みActor（G2） | BundleとExpenseの整合性・月次QueryのSource境界はG1。 | 既存screen内state transition（Proposed）。登録フローの完了条件を既存Receipt上で観測するため。 | 全ItemのBundle割当と対応する全Expenseの登録が揃うまで月別Category集計へ含めない。部分登録の回復／原子性は未決。 | G1・G2 | F1・F2・F4 |
| R10 | Receipt／確定Receipt・Item参照 | P5 | Confirmed Rule | 他のActive Participantは参照のみ、Uploader／Ownerの更新はR11 | Receipt／Item Ownerは未決。確定Itemの共有と画像Binary権限を区別。 | 独立screen（Proposed）。確定明細を選んで確認する入口が必要なため。 | 確定Receipt／Itemの共有情報を参照。非Active Actorへの履歴範囲と画像そのものの閲覧権限はG2/G3。Draft候補を共有しない。 | G1・G2・G3 | F2・F7 |
| R11 | Receipt／Snapshot選択前の確定情報修正 | P5・P8 | Confirmed Rule | UploaderまたはGroup Owner | Receipt／Item Ownerは未決。更新権限P5、Expense／集計再計算境界G1。 | dialog／補助flow（Proposed）。確定済み明細の変更内容を確認して訂正するため。 | 関連ExpenseがSnapshotへ選択されるまでは履歴付き修正可。他Active Participantは参照のみ。変更者・時刻・前後値を保持。金額／Category変更は負担額と月次集計へ反映し、日付変更はM02へ。 | G1・G2 | F1・F2・F4 |
| R12 | Receipt／Rejected後の同ID訂正 | P4・P5 | Confirmed Rule | UploaderまたはGroup Owner | Receipt／Itemと関連Expense／Caseの整合・認可時点はG1。 | dialog／補助flow（Proposed）。却下に対応する確定Receipt訂正を行うため。 | RevisionがRejectedなら同IDと変更履歴を維持して訂正可能。Expense訂正の理由・版・同一操作非重複はE07/E10。Case新版の申請はF6へ。 | G1・G2 | F1・F2・F6 |
| R13 | Receipt／Snapshot固定時の編集不可 | P5・P4 | Confirmed Rule | 編集を試みるActor | Receipt／Itemの編集境界とSettlement状態の取得PortはG1。 | 既存screen内state transition（Proposed）。同じ確定Receiptで編集できない状態を示すため。 | Awaiting Approval中は編集不可。Rejected時のみ明示条件で訂正。Approved／Payment Active以後は編集不可、Settlement Archive後も固定する。 | G1・G2 | F1・F2・F6・F7 |
| R14 | Receipt／確定後の画像閲覧 | P5・P9 | Open Question権限／Confirmed保持 | 画像を参照できるActorは未決 | 画像StorageとReceiptのData Owner／閲覧契約はG1/G3。Item参照権限から画像閲覧を推定しない。 | deferred／gated（Proposed）。確定後画像の閲覧権限・取得契約が未決のため。 | Draft画像はUploader専用。確定後は保持条件だけ確定済みで、Uploader／Owner／全Participantのどれへ閲覧を許すかは未決。 | G1・G2・G3 | F2 |
| R15 | Receipt／Draft保持期限・Group終了時の削除状態 | P9・A73 | Confirmed Rule | Draft参照はUploader、削除はRetention Batch | Draft削除Owner／運用PortはG1/G4。Group終了はGroup Managementから連携。 | 既存screen内state transition（Proposed）。本人Draftの保持・失効を同じ作業境界で観測するため。 | 最終編集から30日後に削除可能。閲覧だけでは延長しない。期限到達後にDraft／OCR／Item候補／画像を削除。Group終了時の未確定Draftは次回Batchで削除。Closing開始だけで終了と扱わない。表示書式・Batch時刻は未決。 | G1・G2・G4・G5 | F2・F5・F7 |
| R16 | Receipt／画像の精算完了後削除状態 | P9 | Confirmed Rule | 画像参照ActorはR14、削除はImage Retention Batch | 各関連ExpenseのSettlement Archive確認と画像削除PortはG1/G4。 | 既存screen内state transition（Proposed）。既存Receiptで画像の保持状態を観測するため。 | すべての関連Expenseを含むSnapshotがArchiveされるまで保持。一部精算では削除せず、全関連精算完了後に画像だけを再実行可能Batchで削除。画像非取得時の公開応答は未決。 | G1・G2・G3・G4 | F2・F5・F6 |
| R17 | Receipt／画像削除後の明細・履歴保持 | P9・A73・GMI | Confirmed Rule | Active時の権限はG2、Archived時はowner-at-archive | Item／Category／Bundle対応／履歴のSource Ownerと読取PortはG1/G2。 | 既存screen内state transition（Proposed）。画像がなくても保持中の確定明細を参照するため。 | 画像削除後も確定Item／Category／Bundle対応／変更履歴をGroupのdeleteEligibleAtまで保持。Group物理削除時には未削除画像も削除。延長・復元UIを新設しない。 | G1・G2・G4 | F2・F5 |
| C01 | Category／System標準・Group専用の共有表示 | P7 | Confirmed Rule | Group内Participant（参照時点の契約はG2） | Categoryの所属Context／Data Ownerは未決（A24・D）。個人専用Categoryを持たない。 | 既存screen内state transition（Proposed）。明細分類やGroupの設定で使用可能Categoryを確認するため。 | System標準とGroup専用を併用し、Group内で共有。Inactiveと過去使用を区別。表示属性・一覧Read契約は未決。 | G1・G2・G5 | F3・F7 |
| C02 | Category／Group専用追加 | P7 | Confirmed Rule | 現在Group Owner | Category Ownerは未決。操作権限はP7、current Owner確認PortはG1/G2。 | dialog／補助flow（Proposed）。Group固有Categoryを入力して追加するため。 | OwnerのみGroup専用を追加。System標準の管理とは分離。重複名・命名Validationは未決。 | G1・G2 | F3・F8 |
| C03 | Category／Group専用の名称変更 | P7 | Confirmed Rule | 現在Group Owner | Category Ownerは未決。P7のOwner権限と履歴契約に従う。 | dialog／補助flow（Proposed）。対象Categoryと新しい名前を確認して変更するため。 | Category IDを維持し、名称変更履歴を残す。過去明細・集計の歴史的表示方式は未決。 | G1・G2・G5 | F3 |
| C04 | Category／Group専用の無効化 | P7 | Confirmed Rule | 現在Group Owner | Category Ownerは未決。無効化とSuggestion fallbackの境界はG1。 | dialog／補助flow（Proposed）。今後の分類対象から外す影響を確認するため。 | 使用済みCategoryは削除しない。Inactive後も過去Item・月次集計へ元Categoryとして残る。無効化時刻・履歴を保持。再有効化の新機能は採用しない。 | G1・G2 | F3 |
| C05 | Category／Inactiveを新Itemへ指定した場合の拒否 | P7 | Confirmed Rule | 明細を確定するUploader | Category状態とReceiptの同時認可・検証契約はG1。 | 既存screen内state transition（Proposed）。明細入力中に利用不可Categoryを修正するため。 | Inactive Group Categoryを新しいItemへ設定不可。入力中の無効化競合はServerを正本とし、公開Errorは未決。 | G1・G2 | F2・F3・F7 |
| C06 | Category／System標準変更・削除の非提供 | P7 | Confirmed非提供 | 管理はSystem、Group Ownerには変更権限なし | System標準の所有境界と管理実装は未決。Group UIでOwnerへ管理権限を与えない。 | deferred／gated（Proposed）。System標準はSystemが管理しOwnerが変更できないため。 | Group OwnerによるSystem標準の名称変更・無効化を提供しない。使用済みCategoryの削除も提供しない。System管理UIは本Task対象外。 | G1・G2 | F3 |
| C07 | Category／確定結果からSuggestion Rule保存 | P7 | Confirmed Rule | UploaderによるItem確定が契機（System保存） | Suggestion RuleのData Owner／正規化・保存契約は未決。Group内限定というScopeはConfirmed。 | 既存screen内state transition（Proposed）。明細の手動確定結果を次回候補へ反映するため。 | 正規化した店舗名＋正規化した品名→Category IDをGroup内に保存。同Keyへ別Categoryを確定したら最新結果を次回候補に使い、変更履歴を保持。独立した手動Rule CRUDは未決で採用しない。 | G1・G2・G3 | F2・F3 |
| C08 | Category／次回Suggestion候補・Inactive fallback | P7 | Confirmed Rule | 候補を確認するUploader | Suggestion／Category／OCRのSource境界と候補認可はG1/G3。 | 既存screen内state transition（Proposed）。Draftの候補提示に過去の確定結果を反映するため。 | 同Groupの一致Ruleを優先候補にするが自動確定しない。対象CategoryがInactiveならRuleを使わずSystem分類へFallback。他Group共有／共通Model学習はしない。RuleはGroup物理削除で削除。 | G1・G2・G3・G4 | F2・F3・F5 |
| M01 | Monthly Category／月別支出参照 | P5・P8 | Confirmed計算／Gate読取 | 集計を参照できるActor・範囲は未決 | 月次Read Model／Source Data Owner・Projection方式は未決（A24・D）。 | 独立screen（Proposed）。購入・利用月ごとのCategory支出を確認する入口が必要なため。 | Asia/TokyoのoccurredOnで所属月を判定。Receiptは確定購入日、手入力は利用者発生日。未確定Draftと全Bundle／Expense登録未完了Receiptは集計外。登録日・精算日・Group Archive日を使わない。Server結果を表示する。 | G1・G2・G5 | F4・F7・F8 |
| M02 | Monthly Category／日付訂正による再集計の観測 | P5・P8 | Confirmed Rule | 日付訂正を許可されたActor（E06/R11のGate・権限に従う） | Expense／Receiptと月次Source連携はG1。 | 既存screen内state transition（Proposed）。訂正結果による月別表示変化を同じ集計上で確認するため。 | Snapshot固定前のoccurredOn訂正は旧月から除外して新月へ再集計。固定後は変更不可。Settlement Archive月はSnapshotのarchivedAt（Asia/Tokyo）で、Expenseの購入月と別。Archive一覧操作はF6へ。 | G1・G2 | F1・F2・F4・F6 |
| X01 | Cross-boundary／Closing・Cancelingのread-only | A73・A55・GMI | Confirmed Rule | 従来の参照権限を持つActorのみ | 各Data Ownerが更新拒否を実施。Group lifecycleはGroup Management。Draftとの権限交差はG1/G2。 | 既存screen内state transition（Proposed）。既存画面でGroup終了処理中の操作制約を観測するため。 | Closing（Canceling含む）は開始前から認可済みの既存履歴参照のみ。新Expense・Receipt・Category等の業務Mutationを拒否。Group取消・再試行の実操作はGMIへ委譲。 | G1・G2 | F1・F2・F3・F7 |
| X02 | Cross-boundary／Archived履歴・保持期限 | A73・A55・P9・GMI | Confirmed Rule／Gate個別Read | owner-at-archiveのみ、保持期限まで | Group Managementの固定Owner Policyと各Source OwnerのRead契約で保護。 | 既存screen内state transition（Proposed）。Group終了後の既存履歴と期限を同じscopeで示すため。 | 新しい登録・訂正は不可。deleteEligibleAtを常時表示し、履歴・CSV権限は固定Ownerに限定。Draft本人制約との交差は未決として非公開Gate。CSV要求はGMIを再利用し、画像BinaryはExportに含めない。 | G1・G2・G4・G5 | F4・F5・F7 |

## 4. Gateと解消条件

| Gate | 未決／不足 | 後続Ready前の解消条件 |
| --- | --- | --- |
| G1 Ownership／整合性 | Receipt／Bundle／Adjustment／Category／SuggestionのOwner、Aggregate、月次Read、Expense予約／解放、版・原子的保存・再送方式。 | 対象RequirementとAccepted Design／必要ADRを揃え、各ContextのPort、競合／非重複契約をTestへTraceする。既存候補の採用はOwner Decisionへ渡す。 |
| G2 公開契約／本人性 | 公開業務Query／Mutation、Actorの本番本人性、Group scope、時点別権限、存在秘匿、公開Error、入力・Read範囲。 | 認証認可・Use Case・ErrorのAccepted契約、SDL／Operation catalog／生成型／Test、Production wiringを対象sliceで揃える。 |
| G3 OCR／画像 | OCR／分類Service、画像Storage、入力制限、timeout・再試行・非重複、確定後画像閲覧、保存保護。 | 所有Contextと公開認可・保護・削除契約を決定し、障害時と失効時の観測を検証する。製品名を本Inventoryで採用しない。 |
| G4 Retention運用 | Draft／画像／確定明細／Suggestionの削除、Group削除連携、Batch頻度、Backup／回復、監視。 | 各Source Ownerの冪等Deletion Port、部分失敗・再実行、期限・Backup境界、Runbookを確認する。Persistence／Security詳細をUIへ複製しない。 |
| G5 Presentation | Owner UX確認、i18n、日時書式、Route／Navigation／Layout、Loading／Empty／Error等の詳細state matrix。 | 各Context Inventoryと契約を入力に横断UXを確認する。未決の本人性・公開Error・Ownershipを画面側で確定しない。 |

本文のConfirmed RuleをBackendが実装済みとは扱わない。API sourceの現行SchemaとcatalogはQuery.apiStatusだけであり、Expense／Receipt／Categoryの業務Operationを未実装のままcatalogへ追加しない。

## 5. 認可・失敗・回復の境界

- Active Membership、現在Owner、Uploader、Source Owner、owner-at-archiveは意味の異なるActor条件。UI非表示を認可とせず、対象Groupと操作時点をBackendで検証する。
- DraftのUploader専用、確定Itemの他Active Participant参照、Source Owner／Ownerの訂正条件を分ける。Draftや確定後画像BinaryへのGroup Owner参照を推測しない。
- A55はSnapshot Revisionの関与Policyを規定する。Leftに残る責務や旧／新Participantの独立評価を考慮し、非Activeを全Context一律の拒否にしない。Expense／Receipt／月次Queryの詳細認可と存在秘匿応答はG2。
- P4の訂正・再申請競合は先行操作のみ成立、後続の部分反映なし、同一操作再送で非重複というConfirmed Ruleである。一方、公開Key、Fingerprint、成功結果再取得、権限変更後の確認、結果不明の照合、自動再試行の具体契約はExpense側のG1/G2である。Group CommandのA36契約を採用済みと書き換えない。
- SourceのCommand結果／Errorを正本とし、ClientのOptimistic stateや古いMembershipだけで成功を表示しない。新しい入力と同一操作の再送をどう識別するかは公開契約Ready後に設計する。
- Closing／Cancelingでは開始前から許可された既存履歴だけread-only、Archivedではowner-at-archiveが保持期限まで参照する。新しい業務Mutationは拒否する。Draftの本人制約とArchive権限の交差・読取対象はG1/G2として、許可が未確認のDataを公開しない。

## 6. 日付・明示的なOpen Question

occurredOnは購入日／利用日という業務日付で、内部Timestampと同一ではない。月次Category支出はAsia/TokyoのoccurredOnに従う。Settlement Archive所属月はSnapshotのarchivedAtであり、Expenseの購入月と区別する。TimestampはCoding Ruleに従ってUTCで保存・伝播し、Timezoneを明示する。

deleteEligibleAtはGroupのarchivedAtをAsia/Tokyoへ変換した同時刻の1暦年後（2月29日は翌年2月28日へclamp）である。Archived参照画面に常時表示する。Draft30日の算定・返却契約、表示書式、相対時刻、利用者Timezone、i18n／対応言語・翻訳キーは本Taskで採用しない。

| Open Question | 今回の扱い |
| --- | --- |
| 手入力Expenseの通常編集権限・Field、一覧／詳細／Leftの読取範囲 | E05/E06のGate。Rejected／解放後という明示済み条件から通常権限を推定しない。 |
| Bundle割当主体、保存単位、部分登録／訂正と予約の競合 | Actor候補・G1。Receipt UploaderやExpense登録資格と同義にしない。 |
| 確定後画像の閲覧、Draft本人制約とArchive権限の交差 | R14／X02のGate。確定Item参照と画像Binary参照を分ける。 |
| Category所属、名前重複、過去名称の表示、再有効化 | G1/G2/G5。Ownerによる既存追加・名称変更・無効化以外を採用しない。 |
| Suggestion Ruleの手動CRUD、正規化方式 | G1。確定時保存・次回候補というRuleだけConfirmed。新しい管理操作を提供しない。 |
| Expense側の再送Key／結果確認とReadの版・回復 | G1/G2。A36のGroup operationIdを転用しない。 |
| 月次Queryの閲覧権限、並び順／集計粒度、Projection、公開Error | G1/G2。Frontendに集計の正本を持たせない。 |
| Localization、日付・金額の表示、詳細状態・回復導線 | G5。Route／Navigation／visual layoutを決めない。 |

## 7. 後続Task候補

候補は作成済みTask／Ready状態ではない。本Taskで他のIssueを作らず、各成果を個別にReady評価する。

| ID | 候補成果 | 依存入力／Gate |
| --- | --- | --- |
| F1 | Expense Ownership／訂正・予約／版・再送契約 | E01–E10とR07–R13、P4、A24/A73、G1/G2。未決のAggregate／Port・Domain DecisionをOwnerへ渡す。 |
| F2 | Receipt Draft／確定／Bundle・OCR／Storage契約 | R01–R17、P5/P6/P9、G1–G4。本人専用・画像閲覧・確定／保存・削除と障害を確認する。 |
| F3 | Category／Suggestion Ownership・公開操作契約 | C01–C08、P7、G1–G4。Group Role照会、Inactive競合、履歴とGroup限定の境界を確定する。 |
| F4 | 月次Category Read contract／表示 | M01/M02、R09、P8、G1/G2/G5。Source・読取認可・整合性とProjection要否を先に確認する。 |
| F5 | Draft／画像／Group連携Retention運用 | R15–R17、C08、X02、P9、A55/A73、G4。削除・Backup・部分失敗とRunbookを検証する。 |
| F6 | Settlement／Payment操作Inventory | P4のCase／Revision／解放／編集制約とP8のArchive月を入力に、申請・承認・Withdraw／Cancellation・支払報告・受取確認・Archiveを別Inventoryへ写像する。 |
| F7 | 横断Navigation／journey・state matrix／App shell | GMI、本Inventory、F6のInventory、操作ごとの認可・回復契約を入力にUXを確認する。App shellはNavigation／共通状態のAccepted入力が揃ってから。 |
| F8 | 契約Ready後のvertical slice | 選んだ操作のInventory、Accepted Design、G1–G4の対象Gate解消、Schema／生成型／Error／wiringを個別Ready評価する。 |

## 8. Done Criteria traceと検証

| #146 Done Criteria群 | Evidence |
| --- | --- |
| Source・Knowledge State・Ownership・全行属性／一意分類と理由 | §1–§4、39行の10列。Actor／Data Owner候補をAcceptedにしていない。 |
| Group Expense／日付／Split／参加時点／訂正・編集不可／版・再送 | E01–E10、§5/§6。通常編集と回復の未決はGate。 |
| Receipt Draft／OCR候補／確認修正・確定／Adjustment／Bundle | R01–R09、P5/P6。Backend正本計算と全Item・Expense完了条件を明記。 |
| 確定Receipt参照・訂正／画像閲覧／保持・削除後履歴 | R10–R17、§5、G3/G4。未決閲覧はGate。 |
| Category／Suggestionの全操作・非提供・Fallback・保持 | C01–C08、§6、P7。個人専用・共通Model学習を採用しない。 |
| 月次Category支出・日付変更とArchive月の区別 | M01/M02、§6、P8。 |
| Closing／Canceling／Archived／Left・再参加・CSV連携 | E03、R17、X01/X02、§5、GMI/A55/A73。 |
| 公開API・本人性／Error／wiring・i18n等の未決Gate | §2、§4–§6。現行公開OperationはShared APIのapiStatusのみ。 |
| 後続TaskとScope | §7。Settlement／Payment実操作と横断UX・機能実装は後続。 |
| 親Epic・Delivery・Verification | Issue #146と#90へ追跡同期。文書のみのためProduction Code／Schema／ADR／図／Runbook変更は不要。 |

新しい業務挙動を追加しない文書Taskなので、振る舞いTestは追加しない。Source／Actor／Owner／失敗のTrace、一意分類と理由、Markdownの構造・Link／見出し参照、Knowledge State・公開Gateを検証し、Issue #146のDone Criteriaに従いRepository標準のpnpm checkを実行する。ローカルE2Eは文書のみのため省略可能で、実施範囲と結果はIssue／PRへ記録する。

残Risk: 画面分類はOwner UX確認前のProposed。Receipt／CategoryのOwnership、集約・公開認可／API・OCR／画像・Retention接続がReadyになるまで機能画面をProductionへ接続できない。文書TaskのReadyはこれら機能Gateを解除しない。

## 後続Decisionの追跡（2026-10-01）

[ADR #152](../adr/expense-settlement-consistency-boundary.md)で、ERの個別Group Expense Root、Settlement Case Rootと不変Revision、予約／精算更新の同期原子的commitを採用した。G1の個別Group Expense境界と原子性方針は部分解決したが、Receipt／Category、具体Port／版・再送／保存／認可の契約は残る。[Task #154](https://github.com/takeshi-arihori/kakei_app/issues/154)は手入力登録の純Domainだけを実装する。39操作の分類・Route・公開API・機能画面のReadyはこのDecisionだけで確定しない。
