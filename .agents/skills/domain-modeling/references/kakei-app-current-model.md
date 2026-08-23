# 家計アプリ 現行モデリング引き継ぎ

最終更新: 2026-08-23

このFileは、セッションを跨いでモデリングを再開するための探索入口である。要求・業務知識・設計判断の正本はNotion、最新判断は利用者の明示指示である。作業開始時にNotionを読み、差分があればこのFileも更新する。

## 参照するNotion

- [Requirement・Scope](https://app.notion.com/p/3a906467984f8180a7f3e4220eeaa47a)
- [業務内容・業務ルール](https://app.notion.com/p/3a906467984f8015b763fe95859ea6ec)
- [用語定義](https://app.notion.com/p/3a906467984f818b8a84d0b559cb6676)
- [ユーザージャーニー・ユースケース](https://app.notion.com/p/3a906467984f817a9a5ac19b4be025bd)
- [ドメイン設計](https://app.notion.com/p/3a906467984f80728058c839a403e6f0)
- [Accepted Product Decision: 家計履歴アーカイブへサービス方針を変更する](https://app.notion.com/p/3aa06467984f81169fdcc7d5e19c5b02)
- [未確定事項・Documentation Conflict](https://app.notion.com/p/3a906467984f814ba736c627901ead38)

## 2026-08-22 Scope Change（最新の利用者指示）

- 業務Domainは共有Group内の割り勘に限定し、個人だけの収支管理は扱わない。
- 1人でGroupを作成でき、招待された利用者が参加すると共有・割り勘を開始できる。
- 1 Groupの参加者は1〜4人。
- 1人の利用者は複数Groupを作成・参加できる。
- 夫婦・家計に限定せず、仕事仲間の飲み会など一時的な共同支出も対象とする。
- Core Domainは、複数参加者について支出ごとの割り勘率を決め、誰が誰へいくら支払うかと支払状況を追跡すること。
- Group削除とCSV出力を提供する。削除のLifecycleとCSVの範囲は未確定。
- レシート画像から明細名・金額を読み取り、登録済みCategoryを各明細へ割り当て、月別Category支出を参照できるようにする。
- Diagramは白黒を基本とする。1 Page内でSystem Context、Use Caseを配置し、Domain ModelとObject Modelだけを横並びにする。

この変更は、2026-08-19時点の「T・Yの2人限定」「個人用家計」「2人間の単一Payer／Payee」を置き換える。2026-08-23にNotion各Pageの先頭へ最新確定節を同期済みで、旧節は判断履歴として残している。

## Confirmed Decisions

### Groupと金額

- Groupは1〜4人のParticipantで構成する。
- 利用者は複数Groupへ所属できる。
- 個人収支は対象外で、記録は必ず割り勘Groupに属する。
- 支出ごとにParticipant別の割合を指定できる。
- 金額はJPYの1円単位整数。アプリ内では送金せず、外部で支払う。

### Group Role・権限（2026-08-22 Confirmed）

- Group作成者を最初のOwnerとし、ActiveなGroupにはOwnerを必ず1人だけ置く。
- OwnerだけがParticipantの招待、Group終了、Group全体のCSV出力を実行できる。
- Owner権限は、同じGroupのActiveなParticipantへ譲渡できる。
- Ownerは、Owner権限を譲渡するかGroupを終了するまで脱退できない。
- ActiveなParticipantは、Group Expenseの登録とSettlement Snapshotの開始を行える。
- Payment Instructionの支払報告は支払側、受取確認・差し戻しは支払先Participantだけが行える。

### 途中参加・脱退の時間境界（2026-08-22 Confirmed）

- Group Expenseを登録した時点のParticipantとSplit Allocationを固定する。
- 後から参加したParticipantを、登録済みGroup Expenseへ自動追加しない。
- ParticipantがGroupを脱退しても、登録済みGroup Expenseの実支払者・割り勘率・負担額は変更しない。
- 脱退者に既存の未精算残高またはPayment Instructionがある場合、その支払・受取確認責務は完了まで残す。
- 脱退者は新しく登録されるGroup Expenseの割り勘対象にはならない。
- 過去の支出・精算履歴からMembershipを削除せず、参加・脱退時点を追跡できるようにする。

### 割合と負担額（2026-08-22 Confirmed）

- Participantごとの割り勘率は10%単位で、0%、10%、20% … 100%から指定できる。1%単位の旧判断は本Ruleで置き換える。
- 1つのGroup Expenseに設定した割り勘率の合計は必ず100%とする。
- 0%のParticipantも許可し、その支出の負担額は0円とする。
- `支出額 × 割合 ÷ 100` の小数部分をいったん切り捨て、残った1円単位を小数部分が大きいParticipantから順に配る（最大剰余方式）。
- 例: 1,001円をA 30%、B 30%、C 40%で負担する場合、A 300円、B 300円、C 401円とする。
- 最大剰余の小数部分が同値なら、同率者に実支払者が含まれる場合は実支払者へ残りの1円を優先配布する。
- 実支払者が0%などで同率対象外なら、Group参加順で配布先を決める。
- 例: 1,001円をA 50%、B 50%で負担し、Aが実支払者ならA 501円、B 500円とする。

### 既存Settlement Modelの扱い

- 2人向けの単一Payer／Payee、Settlement Case、Request Snapshot、Archive Lifecycleは、3〜4人の具体例で再検証する。
- 「誰が誰へ支払うか」「支払ったか」を新しいCore Ruleとして扱う。
- 既存の却下・再申請・受取確認・Archiveルールは自動的に廃止せず、複数人精算の方向決定後に維持・変更を判断する。

### Group全体の精算（2026-08-22 Confirmed）

- 精算申請者は、Group内の未精算Group Expenseから今回の精算対象を明示的に選択する。「すべて選択」は選択操作のShortcutとして提供できる。
- 精算開始時に、選択したGroup Expenseの集合をSettlement Snapshotとして固定する。
- Settlement Snapshotには、対象Expense ID、各Expenseの金額・実支払者・割り勘率・負担額、Participant Balance、導出したPayment Instructionを保持し、作成後は変更しない。
- 精算開始後に登録されたGroup Expenseと、開始時に選ばなかったGroup Expenseは、そのSnapshotに含めず未精算のまま残す。
- 精算開始時刻が同じGroup Expenseであっても、Snapshotに選択されたかどうかで精算対象と未精算が混在し得る。時刻だけでは所属を判定しない。
- 精算対象の支出について、Participantごとに `実支払額合計 - 負担額合計` を精算残高として求める。
- 正の残高を受取側、負の残高を支払側とし、Group全体の残高合計は0円とする。
- SystemはGroup全体で残高を相殺し、支出ごとの債務関係を維持せず、送金回数が少なくなる支払指示を導出する。
- 例: Aが4,000円受取、Bが1,000円受取、Cが5,000円支払なら、`C → A 4,000円`、`C → B 1,000円`とする。
- 送金回数が最少になる精算案が複数存在する場合は、支払側と受取側をそれぞれGroup参加順に並べ、その順序を優先して一意に決める。
- 具体的には、最少送金回数の候補をPayment Instructionの`支払側参加順 → 受取側参加順`で辞書順比較し、最初の候補を採用する。
- 例: 参加順がA、B、C、Dで、AとBが各5,000円受取、CとDが各5,000円支払なら、`C → A 5,000円`、`D → B 5,000円`を採用する。

### Settlement Approval・Revision（2026-08-23 Confirmed）

- 精算申請を追跡する安定したSettlement Case IDを発行し、Case配下へ不変なSettlement Snapshot Revisionを関連付ける。
- Snapshot作成時に、選択Expense、Expense内容、Participant Balance、Payment Instruction候補、必要承認者を固定する。
- 必要承認者は、選択Expenseの実支払者またはSplit Allocationが0%より大きいParticipantとする。
- 申請者が必要承認者でもある場合は、申請操作を本人の承認として記録する。他の必要承認者は算出額と支払先を個別に承認または却下する。
- Settlement ApprovalにはParticipant、承認／却下、決定時刻を記録し、却下時は理由を必須とする。
- 1人でも却下したRevisionはRejectedとなり、Payment Instructionを有効化しない。
- 必要承認者全員が承認した時点でRevisionをApproved／Payment Activeとし、Payment Instructionを有効化する。
- Rejected Revisionは変更・削除せず、新しいRevisionを同じSettlement Caseへ`previousSnapshotId`で関連付けて再申請する。
- Settlement Caseを最初に申請した時点で、Caseが対象とするGroup Expense ID集合を固定する。
- Rejected Revisionから新版を作る場合も対象Expense ID集合は変えず、選択済みExpenseの追加・除外を許可しない。却下理由に対応する金額などの訂正は新版へ反映できる。
- Approval待ちまたは却下後に登録された新しいGroup Expenseは同じSettlement Caseへ追加せず、別のSettlement Caseで精算する。
- Awaiting Approval中は、対象Group Expenseを訂正できない。
- RevisionがRejectedになった場合だけ、同じGroup Expense IDを維持したまま、却下理由に対応する金額などを履歴付きで訂正できる。訂正履歴には変更者、変更時刻、変更理由、変更前後の値を残す。
- 手入力Group Expenseでは登録者、Receipt由来Group ExpenseではReceipt UploaderをSource Ownerとする。
- Rejected後のGroup Expenseを訂正できるのは、そのExpenseのSource OwnerまたはGroup Ownerだけとする。
- 必要承認者であってもSource Owner／Group Ownerでなければ元のExpenseを訂正できず、誤りは理由付き却下によって訂正権限者へ返す。
- Rejected Revisionは訂正前の値を保持し、新Revisionは訂正後のGroup ExpenseからBalanceとPayment Instruction候補を再計算する。
- RevisionがApproved／Payment Activeになった後は、対象Group Expenseを再び訂正できず、Archive後も不変とする。
- Rejected後の新Revisionを申請できるのは、Settlement Caseの元申請者または現在のGroup Ownerだけとする。
- 元申請者が脱退・対応不能でも、Group Ownerが同じSettlement Caseを引き継いで新Revisionを申請できる。
- 各Revisionへ実際の申請者を記録する。申請者が必要承認者でもある場合は、その申請操作を本人の承認として記録する。
- 新Revisionでは全必要承認者が改めて承認する。旧Revisionの承認結果を引き継がない。
- Approvalの却下と、支払後のPayment Attempt差し戻しを別Lifecycleとして扱う。
- Approval待ちに新しく登録されたGroup Expenseは、そのRevisionへ追加せず未精算で残す。

### 支払確認・差し戻し・再試行（2026-08-22 Confirmed）

- Payment Instructionごとに、`未払い → 支払報告済み → 受取確認済み`のLifecycleを管理する。
- 支払者の報告だけでは完了せず、支払先Participantの受取確認を必要とする。
- 支払先Participantは受取確認の代わりに、理由を記載して差し戻せる。
- 差し戻されたPayment Attemptと理由は履歴として保持し、再支払い時は同じPayment Instructionへ新しいPayment Attemptを追加する。
- Settlement Snapshot全体を作り直さず、対象Expense集合、精算残高、Payment Instructionは変更しない。
- MVPではPayment Instructionの一部金額だけを支払う部分支払は許可しない。
- Settlement Snapshot内のすべてのPayment Instructionが受取確認済みになった時点で精算完了とし、SnapshotをArchiveして編集不可にする。
- Archive済みSnapshotは月ごとに参照できる。

### Group終了・Archive（2026-08-22 Confirmed）

- 「Group削除」は即時の物理削除ではなく、業務上はGroupを終了してArchiveする操作として扱う。
- 未精算Group Expenseまたは進行中Settlement Snapshotが存在するGroupは終了できない。
- Groupの終了は利用者の明示操作で行う。Settlement SnapshotがArchiveされても、継続利用するGroupは自動終了しない。
- Archive済みGroupでは、新しいGroup Expenseの登録、招待、参加、精算開始を禁止する。
- Archive済みGroupの履歴参照とCSV出力は許可する。
- 利用者がGroupを物理削除する機能は提供しない。
- Archive済みGroupは`archivedAt`から1年間、読み取り専用で保持する。
- `deleteEligibleAt`はAsia/Tokyo基準で`archivedAt`の1暦年後とし、内部TimestampはUTCで保持する。
- `deleteEligibleAt`を経過したGroupは、定期Batchの次回正常実行時に物理削除する。Batchの具体的な実行頻度・時刻は実装設計で決める。
- Batchは再実行可能かつ冪等にし、一部失敗時に未削除Groupを次回以降再試行できるようにする。
- 物理削除前のEmail・Pushなどによる個別通知は行わない。
- Archive済みGroupの参照画面に`deleteEligibleAt`を常時表示し、期限までは履歴参照とOwnerによるCSV出力を許可する。
- 利用者操作による保持期限の延長・取消は許可しない。
- 物理削除では、Groupに属するMembership・Invitation・Group Expense・Split Allocation・Receipt画像・Receipt Item・Settlement Snapshot・Payment Instruction・Payment Attempt・月別集計用Dataを削除する。
- 物理削除後は、`deletionToken`、`deletedAt`、`reason = retention_expired`、`jobRunId`、`outcome`だけを持つ最小限のDeleted Group Tombstoneを残す。
- Deleted Group Tombstoneには、Group名、利用者ID、氏名、金額、支出内容、OCR結果、Receipt画像など、利用者または家計内容を特定できる情報を含めない。
- Deleted Group Tombstoneは`deletedAt`から1年間保持し、`tombstoneDeleteEligibleAt`を経過した次回のRetention Batchで物理削除する。
- Group業務DataとTombstoneの削除を同じBatch系統で扱い、それぞれの期限判定と再試行を独立して冪等に実行する。

### CSV Export Package（2026-08-22 Confirmed）

- OwnerはGroup全体を、複数CSVをまとめたZIPとして出力できる。
- Export Packageには`memberships.csv`、`expenses.csv`、`allocations.csv`、`receipt_items.csv`、`categories.csv`、`category_suggestion_rules.csv`、`settlements.csv`、`payment_attempts.csv`の8 CSVを含める。
- 各CSVはGroup ID、Expense ID、Settlement Snapshot ID、Payment Instruction IDなどの関連IDで結合できるようにする。
- 未精算Group Expense、Archive済みSettlement Snapshot、支払確認・差し戻し履歴、脱退済みMembershipを含める。
- Archive済みGroupも`deleteEligibleAt`までは出力できる。
- Receipt画像BinaryはExport Packageへ含めず、確定済みのReceipt Item名・金額・Categoryだけを`receipt_items.csv`へ含める。
- `receipt_items.csv`には調整前金額、配賦されたReceipt Adjustment、調整後金額、Expense Bundle IDも含める。
- `categories.csv`にはSystem標準／Group専用の区分、Category ID、名称、Active／Inactive、名称変更・無効化時刻を含める。
- `category_suggestion_rules.csv`にはGroup内で正規化した店舗名・品名、候補Category ID、更新時刻を含める。
- 物理削除後のDeleted Group TombstoneはCSV出力対象外とする。
- Export PackageはOwnerの要求時に生成して即時Downloadし、Server側へZIPを永続保存しない。
- Download失敗または再Download時は、その時点で保持しているGroup Dataから新しいExport Packageを再生成する。

### Receipt・Category

- レシート画像から複数のReceipt Itemを抽出する。
- CategoryはReceipt全体ではなくReceipt Itemごとに割り当てられる。
- 登録済みCategoryの例として食費・備品がある。
- 月別Category支出はItemのCategoryと金額から集計する。
- Receipt画像のUploaderだけが参照・編集できるReceipt Draftを最初に作成する。
- OCRとCategory分類の結果は自動確定せず、Receipt Draft上の候補として扱う。
- Uploaderは品名、金額、Category、購入日、Receipt合計を確認・修正してから確定する。
- DraftのReceipt Item金額合計とReceipt合計が整合しない場合は確定できない。税・値引きなどの合計Ruleは別途具体化する。
- 確定前のReceipt DraftとReceipt ItemはGroup Expense、Settlement Snapshot、月別Category集計へ含めない。
- Uploaderが確定したReceiptとReceipt Itemだけを、Group Expense登録フローの入力として共有する。
- 確定後のReceiptとReceipt Itemは、UploaderまたはGroup Ownerだけが修正できる。他のActive Participantは参照のみ可能とする。
- 関連するGroup ExpenseがSettlement Snapshotへ選択されるまでは修正可能とする。Awaiting Approval中はReceiptとReceipt Itemも編集不可にし、RevisionがRejectedになった場合だけ同じIDと変更履歴を維持して訂正できる。Approved／Payment Active以後は編集不可とする。
- 確定後の修正では変更者、変更時刻、変更前後の値を履歴として残す。
- Snapshot固定前に金額またはCategoryを修正した場合は、関連するGroup Expenseの負担額と月別Category集計を再計算する。Receipt ItemとGroup Expenseの対応単位は別途確定する。
- 1つ以上のConfirmed Receipt ItemをExpense Bundleへまとめ、1つのExpense Bundleから1つのGroup Expenseを作成する。
- Expense Bundleごとに実支払者とSplit Allocationを設定できる。同じReceipt内でもBundleが異なれば割り勘率を変えられる。
- 1つのReceiptから複数のExpense BundleとGroup Expenseを作成できる。
- 各Receipt Itemは必ず1つのExpense Bundleだけに所属し、MVPでは1つのItemを複数Bundleへ分割しない。
- Expense Bundleの金額は、所属するReceipt Item金額の合計と一致しなければならない。
- すべてのReceipt ItemがExpense Bundleへ割り当てられ、対応するGroup Expenseが登録されるまでは月別Category集計へ含めない。
- Receiptを使わずGroup Expenseを手入力することも許可する。
- Receipt画像は、関連するすべてのGroup Expenseを含むSettlement SnapshotがArchiveされるまで保持する。
- 関連する一部のGroup Expenseだけが精算済みの場合は画像を削除しない。
- 関連する全Group Expenseの精算完了後、再実行可能なImage Retention BatchでReceipt画像だけを物理削除する。
- 画像削除後も、確定済みReceipt Item、Category、Expense Bundleとの対応、変更履歴はGroupの`deleteEligibleAt`まで保持する。
- Group自体が物理削除される場合は、未削除のReceipt画像もGroup配下Dataとして削除する。
- 税・送料・値引き・Point利用はReceipt Adjustmentとして抽出・入力する。税・送料は正、値引き・Point利用は負のJPY整数とする。
- 特定Receipt Itemに明示的に紐づくReceipt Adjustmentは、そのItemだけへ反映する。
- Receipt全体に対するAdjustmentは、Adjustment適用前の正のReceipt Item金額を比率として各Itemへ配賦する。
- 配賦額は絶対値に対していったん切り捨て、残る1円を小数部分が大きいItemから配る最大剰余方式とする。同率時はReceipt上のItem記載順を使う。
- 負のAdjustmentは配賦額を各Itemから減算し、正のAdjustmentは加算する。調整後Item金額は0円未満にできない。
- Expense Bundle金額、Group Expense金額、月別Category集計には調整後Item金額を使う。
- 例: 110円、240円、200円のItemへReceipt全体の50円値引きを配賦すると、値引き額は10円、22円、18円、調整後金額は100円、218円、182円となる。
- System標準CategoryとGroup専用Categoryを併用する。CategoryはGroup内の全Participantで共有し、個人専用Categoryは持たない。
- System標準CategoryはSystemが管理し、Group Ownerは名称変更・無効化できない。
- Group OwnerはGroup専用Categoryを追加・名称変更・無効化できる。
- 使用済みCategoryは削除せず、無効化後も過去のReceipt Itemと月別Category集計に元のCategoryとして残す。
- 無効化したGroup専用Categoryは新しいReceipt Itemへ設定できない。
- OCR・自動分類では、System標準CategoryとActiveなGroup専用Categoryから候補を提示する。
- Categoryの名称変更ではCategory IDを維持し、変更履歴を残す。
- UploaderがReceipt Itemを確定したとき、Group内限定のCategory Suggestion Ruleとして`正規化した店舗名 + 正規化した品名 → Category ID`を保存する。
- 次回同じGroupで一致するItemを認識した場合、Category Suggestion RuleのCategoryを候補として優先提示するが、自動確定はしない。
- 同じKeyへ異なるCategoryが確定された場合は、最新の確定結果を次回候補に使い、過去の変更履歴を残す。
- Ruleが参照するGroup専用CategoryがInactiveになった場合、そのRuleを候補提示へ使わずSystem分類へFallbackする。
- Category Suggestion Ruleを他Groupへ共有せず、全利用者の修正結果を使った共通Model学習はMVPで行わない。
- Category Suggestion RuleはGroup配下Dataとして扱い、Groupの物理削除時に削除する。
- 月別Category集計は、Asia/Tokyoの購入日／利用日を表す`occurredOn`を基準にする。登録日・精算日・Archive日は使わない。
- ReceiptではUploaderが確定した購入日を`occurredOn`とし、手入力Group Expenseでは利用者が指定した発生日を必須とする。
- `occurredOn`が未入力または不正なReceipt Draft／Group Expenseは確定できない。
- Snapshot固定前に`occurredOn`を修正した場合は旧月から除外し新しい月へ再集計する。Snapshot固定後は変更できない。
- Archive済みSettlement Snapshotの月別表示は、全Payment Instructionの受取確認が完了してSnapshotをArchiveした`archivedAt`の月を使う。
- `archivedAt`の月判定もAsia/Tokyoで行い、精算開始日やSnapshot内Group Expenseの`occurredOn`はArchive所属月に使わない。
- 精算開始月と完了月が異なる場合は完了月だけへ表示し、複数月のGroup Expenseを含んでもSnapshotを複数月へ重複表示しない。
- 例: 2026-08-30に開始し2026-09-02に全受取確認が完了したSnapshotは、2026年9月のSettlement Archiveへ表示する。内包する8月購入のExpenseは8月のCategory集計に残る。

## Diagram Convention

- 対象File: `docs/modering/kakei_app.drawio`
- 利用者は基本的に既存Fileへの上書きを希望している。
- Pageは1つだけにする。
- 白背景、黒線、黒文字を基本とする。Knowledge Stateなど意味上必要な場合だけ補助表現を使う。
- `System Context`、`Use Case Model`を上段から配置する。
- 下段では`Domain Model`と`Object Model`だけを左右に横並びにする。
- System、Use Case、Domain、Objectを同じPageへ記載する。
- Use Case図を省略しない。
- Confirmedのみを確定表現で描き、未確定事項は本文または検討メモで管理する。

## Modeling Method

- [DDD×仕様駆動で回す高品質開発のプロセス設計（slide 24）](https://speakerdeck.com/littlehands/dddxshi-yang-qu-dong-dehui-sugao-pin-zhi-kai-fa-nopurosesushe-ji?slide=24) のsudoモデリングを参考にする。
- S: Actor、対象System、外部System、主要Interactionを確認する。
- U: Actorが達成したいGoalをUse Caseとして確認する。
- D: 概念、関係、多重度、Rule、Constraintを抽象化する。
- O: 具体値を持つ正常・境界・不正・競合例でDを反証する。
- DとOを往復し、具体例を作れない概念は理解不足としてOpen Questionへ戻す。
- Lifecycleや分岐が複雑な場合だけ、状態遷移図、業務フロー図、シーケンス図を補助的に使う。

## Open Questions

次回は一度に確定せず、具体例を置いて順番に深掘りする。

1. 未確定のまま放置されたReceipt Draftと画像をいつ削除するか。
2. Rejectedのまま継続しないSettlement Caseを取り下げられるか。その場合、固定していたExpenseを別Caseへ解放するか。
3. Source Ownerの訂正と元申請者／Group Ownerの再申請が同時に行われた場合の競合Rule。
4. 選択Expenseの相殺結果が0円でPayment Instructionが存在しない場合の承認・Archive Flow。
5. Payment Active後の取消、およびArchive成立後の再開・訂正を許可するか。

継続Tracker: [GitHub Issue #9](https://github.com/takeshi-arihori/kakei_app/issues/9)

2026-08-23時点の判断は、Requirement・Scope、業務内容・業務ルール、用語定義、ユーザージャーニー・ユースケース、ドメイン設計、Accepted Product Decision、未確定事項・Documentation Conflictの各Notion Pageへ同期済み。

## Known Conflict

- Notionの2026-08-19以前の節には2人限定・個人用家計・単一Payer／Payeeの履歴が残るが、各Page先頭の2026-08-23現行節が置き換える。
- RepositoryのREADME、AGENTS、engineering docsは2026-08-23の共有割り勘Scopeへ同期済み。旧語はDeprecatedな前提を説明する場合だけ使用する。
- Aggregate境界、Bounded Context、Data Owner、永続化、Event Sourcing／CQRS、Projection境界は未確定であり、関連ADRのAcceptedが必要。
- Property付きProject／Epic／Task／ADR管理先が未確定のため、Ready判定とTraceabilityは引き続きBlockされる。
- Conflictを実装で吸収しない。
