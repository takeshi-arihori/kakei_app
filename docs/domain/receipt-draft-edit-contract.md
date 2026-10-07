# Receipt Draft編集契約

[Task #200](https://github.com/takeshi-arihori/kakei_app/issues/200)の純Domain契約。[現行Product Model](../product/current-model.md)のUploader専用Draft編集、[ADR #170](../adr/receipt-category-consistency-boundary.md)のReceipt所有・版・不変履歴、[手動確定契約](receipt-manual-confirmation-contract.md)へTraceする。採用済みDecisionの変更ではない。

## 所有と入力

Expense Recordingの既存`Receipt` Rootに`editDraft`を追加する。Receipt ID・Uploader・Draft状態を保ち、購入日、宣言合計、記載順を含む全Item候補、順序・種別・額・対象を含む全Adjustment候補を置換する。入力からRootのID・Uploader・状態を変更させない。新しいAggregate、Domain Service、Context、Port、共有Packageは追加しない。

操作Actorは記録済みUploaderに限定する。現在Group OwnerであることだけではDraft編集を許可しない。Actor参照の値一致は内部Invariantであり、実本人性、Group資格、Active／Closing fenceの証明ではない。これらはApplicationが同判断点のSourceから確認する。

候補は未確認の値である。欠損／不正購入日、宣言合計不一致、空Item／Adjustment配列、空Category、重複Item参照、不適切なAdjustment符号・対象を編集中として保持できる。文字列・number・配列・Adjustment対象構造を検証してコピーするが、名称・正規化等の新Product Ruleは追加しない。number候補には非整数・負値・非有限値も保持でき、JPYとして採用する条件は既存の明示確認時に検証する。Adjustment種別の業務的妥当性も確定時に検証する。型を満たす候補を保持したことを金融値の承認と扱わない。

## PRE／POST／INV／FAIL

| 契約ID | 分類 | 条件・根拠 |
| --- | --- | --- |
| DE-PRE1 | PRE | RootがDraftであり、safe integerの`expectedVersion`が現在版に一致する。Actorが非空の記録済みUploader参照に一致する。ProductのUploader専用Ruleと既存版契約に従う。 |
| DE-PRE2 | PRE | `editedAt`は有限Date。購入日候補はstringまたはnull、合計・Item額・Adjustment額はnumber、Item参照・品名・Category参照はstring。候補配列の穴・null要素を拒否する。Adjustment対象はReceipt全体またはstring Item参照を持つItem対象。これはコピー境界の構造検証である。 |
| DE-POST1 | POST | 内容が変わった場合、同Receipt ID・Uploaderの新Draft Rootを返し、safe integer版を1つ進める。Actor、UTC、前後版、前後Draftの`DraftEdited`履歴を1つ追記する。ADR #170の所有・履歴へTraceする。 |
| DE-POST2 | POST | PREの全検証後、候補の内容と順序が同じなら同じRootを返す。参照・操作時刻だけの違いは履歴・版・編集時刻を増やさない。数値は`Object.is`で比較し、未完成NaNも決定的に扱う。 |
| DE-INV1 | INV | 新旧Root、Snapshot、Item、Adjustment、対象、履歴は不変。mutable入力の配列・要素・対象・Dateを後で変更しても候補と履歴は変化しない。拒否時に旧Root・版・全履歴を変えない。 |
| DE-INV2 | INV | Draft編集だけではConfirmed、Expense、Bundle登録完了にならない。共有支出・月次・精算への包含を開始しない。確認は最新期待版と明示的な手動確認値を要求し、日付・Category・配賦・合計の既存Validationと旧編集履歴を維持する。 |
| DE-FAIL1 | FAIL | Draft以外は`RECEIPT_NOT_DRAFT`、期待版不一致は`VERSION_CONFLICT`、Actor不正は`ACTOR_REFERENCE_INVALID`／`ACTOR_NOT_UPLOADER`、不正時刻は`UTC_INSTANT_INVALID`、候補構造不正は`RECEIPT_DRAFT_INVALID`として全体を拒否する。入力値を固定Errorへ含めない。 |
| DE-FAIL2 | FAIL | 実変更でsafe integer版上限を超える場合は`VERSION_OVERFLOW`。現在版が上限でも全条件を満たす同値操作は成功し、版を進めない。技術的な表現上限であり、Product金額上限ではない。 |

旧Draftから別の新Rootを計算できても純Domainの結果に限られ、保存先着を裁定しない。編集と確定の競合、実CAS、再送・結果照会は後続の保存契約に残る。

## 編集時刻・保持・後続Gate

各`DraftEdited.at`は実変更時のUTC factであり、最後の編集履歴から最終実編集を識別できる。Snapshot閲覧と同値操作では編集履歴を追加しない。これだけではProductのDraft30日削除を実行していない。初期作成時刻、時計Source、期限計算、Batch、削除fence、保護保存、Backup／回復は後続Gateである。

Category Active Source、実本人性・Group状態、OCR／画像Storage、永続化・CAS・durable再送、保護Record／Retention、公開API・画面・Projection／Suggestion、Confirmed／未割当Item一般編集とAdjustment構造訂正は今回の対象外。候補と前後Snapshotの保持量・コピーCostは、実保存方式の設計で評価する。純Domain履歴をAudit Log、Event Sourcing、保護済みStorage Schemaとして扱わない。

## Done CriteriaとTest Trace

`apps/api/src/expense-recording/domain/receipt-draft-edit.spec.ts`の76ケースを次へ対応させる。

| Done Criteria | 契約 | 検証 |
| --- | --- | --- |
| DE1 | DE-PRE1／DE-POST1 | Uploader編集、同ID・Uploader・Draft、購入日／合計／各Item候補、Item・Adjustment追加／削除／順序、全Adjustment種別・Item対象。 |
| DE2 | DE-PRE1／DE-PRE2／DE-FAIL1／DE-FAIL2 | Owner／他Participant・不正Actor、期待版・時刻・状態・候補構造・疎配列、旧版編集／確定拒否、safe版上限と拒否時旧Root維持。 |
| DE3 | DE-POST1／DE-POST2／DE-INV1 | 実変更だけ版・履歴更新、同値でもguard適用、未完成number、空候補、深いcopy／freeze、入力mutation、連続編集の前後Snapshotと旧履歴。 |
| DE4 | DE-INV2 | 確定前のBundle登録非完了、編集→失敗確定→再編集→明示確定、既存日付／Category／符号／合計Validation、候補と異なる確認入力、Confirmed／Bundle登録まで全編集履歴保持。 |
| DE5 | 全契約と文書同期 | TDD Red→Green、API全回帰・Architecture、Root `pnpm check`、文書リンク・差分検証、Self Reviewと新しい独立Evaluator、Issue／Draft PR追跡。 |

DB・GraphQL・BrowserのReceipt業務経路は未接続であり、このTestを実保存・公開認可・本番月次非包含の証拠として使わない。
