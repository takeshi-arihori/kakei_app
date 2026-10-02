# Receipt Bundleの編集とSettlement Snapshot後の固定

- Status: Proposed
- Owner: takeshi-arihori
- Proposed: 2026-10-02
- Owner Accepted: 未承認（個別の業務条件は確認済み。統合した本ADR本文への明示承認待ち）
- Proposal / Decision evidence: [Task #179](https://github.com/takeshi-arihori/kakei_app/issues/179)
- Amends: [ADR #170](receipt-category-consistency-boundary.md)のBundle actor、編集範囲、精算後訂正のGate
- Preserves: [ADR #152](expense-settlement-consistency-boundary.md)、[ADR #55](snapshot-revision-security-and-retention.md)、[ADR #73](group-close-consistency-and-retention-boundary.md)、3 Context、Modular Monolith、State model＋不変履歴

## Context

[現行Product Model](../product/current-model.md)では、Uploaderが確定したReceipt Itemを1つ以上まとめるExpense BundleからGroup Expense（支出）を1件作り、1つのReceiptから複数のBundleとGroup Expenseを登録できる。Itemはそれぞれ1つのBundleにだけ所属し、各Bundle額は調整後Item額の合計となる。すべてのItem割当と対応するGroup Expense登録が完了するまで、そのReceiptを月別Category集計へ含めない。

[ADR #170](receipt-category-consistency-boundary.md)はExpense RecordingによるReceipt／Category所有と、初回の1 Bundle＋対応Group Expenseの共通commitをAcceptedとしている。一方、Bundle操作Actor、登録済みBundleの編集、精算中の編集、個別Fieldの影響は後続契約へ残している。[ADR #152](expense-settlement-consistency-boundary.md)はGroup Expenseの登録時Participant factsと履歴付き訂正、Settlement Snapshotの不変性を定める。

Ownerは2026-10-02に、Bundle操作はUploaderのみ、Snapshot初選択前のBundle Item移動とpayer／Split割合変更を許可し、一度でもSnapshotに選ばれた後はこれらを却下・取消・関連付け解除の後も再開しないことを個別回答で確認した。さらに、Rejected後のReceipt Item金額・Adjustment・Category訂正は現行Ruleを維持し、対応するBundle由来Group Expense金額・負担および月次Category集計を更新する方針を確認した。本ADRの統合本文はまだOwner承認前である。

## Decision (Proposal)

1. **用語と対応**: Bundleは、1つ以上のConfirmed Receipt Itemをまとめ、そのまとまりからGroup Expense（支出）を1件作る単位である。各Itemはちょうど1つのBundleに属する。Bundleは空にできず、最後のItemを移す操作は拒否する。
2. **操作主体**: Receipt UploaderだけがBundleへの初回割当、Item移動、Bundleに対応するpayerとSplit Allocation割合の変更を行える。Group OwnerであることだけではBundle操作権限を与えない。手入力Group ExpenseのRuleは変更しない。
3. **編集期間**: 対応するGroup ExpenseがSettlement Snapshotに初めて選ばれる前に限り、UploaderはBundle Itemの所属、payer、Split Allocation割合を変更できる。一度でもSnapshotへ選択された後は、これら3つの事実を永久に変更できない。Rejected、Cancelled、関連付け解除の後にも再開しない。
4. **登録済みGroup Expenseの更新**: 変更前後で同じBundleに対応するGroup Expense IDを維持し、変更前／変更後の値を不変履歴へ追記する。Bundle金額は調整後Item金額の合計、各人の負担は現在のpayerとSplit Allocation割合から算出する。Item移動が複数の登録済みBundleへ影響する場合、それぞれの対応Group Expense IDを維持し、各Expenseの変更履歴を追加する。
5. **Participant facts**: payer／割合変更では当該Group Expenseの登録時Participant集合、各Participant ID、joinOrderを維持する。Participantの追加・除外はこのDecisionの対象外とする。現行の1〜4人、割合0〜100の10%刻み、合計100%というDomain制約を維持する。
6. **Rejected後のItem訂正**: Snapshot選択後にRevisionがRejectedとなった場合、既存Product Modelが許すReceipt Itemの金額、Adjustment、Category訂正を維持する。調整後Item額の訂正はBundle／Group Expense金額と各人の負担へ反映し、Category訂正は月次Category集計へ反映する。この訂正経路はBundle Item所属、payer、Split Allocation割合の永久固定を解除しない。他のReceipt Item Fieldの訂正Ruleも本ADRでは変更しない。
7. **初回登録、部分進行、月次集計**: 初回のBundleと対応Group Expenseは、ADR #170の一対ごとの共通commit境界を維持する。複数のBundle Pairは段階的に登録でき、1つのPairの失敗で別Pairの成功を取り消さず、失敗Pairを再試行可能とする。Uploaderの再送時に同一Group Expenseを再利用して重複を防ぐことをProduct上の結果要件とする。全Itemの割当と全対応Group Expense登録の両方が揃うまでReceiptを月次Category集計へ含めない。

## Alternatives

| 対象 | 提案 | 比較した案と理由 |
| --- | --- | --- |
| Bundle操作Actor | Uploaderのみ | Group OwnerもBundleを変える案は採らない。Group OwnerであることとReceipt Uploaderであることは別の権限だからである。 |
| Snapshot後のBundle変更 | 初回選択後は永久固定 | Rejected／取消後にBundle構成やpayer／割合を再開する案は採らない。Snapshotで確認されたBundle対応を後から差し替えない。 |
| Snapshot後のItem訂正 | Rejected後の既存Item訂正Ruleを維持 | すべてのReceipt Item factsを永久固定する案は採らない。従来の明細訂正を残し、Bundle所属・payer・割合の固定とは区別する。 |
| Group ExpenseのParticipant | 登録時集合を維持し割合だけ変更 | 新たなParticipant追加・除外は本Decisionから導出せず、既存Expenseの歴史上の参加者を守る。 |

## Consequences

UploaderはSnapshot前に、Itemを一度だけBundleへ所属させ、明細構成に応じてpayerとSplit Allocationを整えられる。Item移動で関係する複数Bundleの合計と既存Group Expenseが変わる。Snapshotへ入った構成、payer、割合はその後も固定され、却下後の明細値訂正は既存Item訂正Ruleに沿って別に処理される。

複数の登録済みBundleをまたぐItem移動では、Receipt対応と影響する複数Expenseの更新が全て整合している必要がある。Snapshot選択と編集の同時発生をどう保存上直列化するか、複数Pair変更のcommit単位、CAS／version、成功結果の永続的な再取得、Projection更新条件はこのProduct Decisionだけでは解決しない。

## Implementation and Remaining Gates

- 純Domain候補は、Confirmed Receipt ItemとBundleの一意対応／非空条件、調整後金額の集計、payer／割合の検証、既存Group Expense IDと不変履歴を保った変更結果を表現できる。純Domainの新Root生成やローカル版検証は実保存・競合裁定の証拠ではない。
- 登録済み複数Pairに影響するItem移動、Item訂正、初回Snapshot選択の保存競合には、Application／Persistenceで影響範囲・期待版・一括commit／rollbackを設計し、同一判断点で検証する。
- Uploader本人性、同時点Group資格／Closing fence、Snapshotが一度でも選ばれた事実のdurable lock、CAS、応答喪失後のoperation結果再取得／重複防止を、実StorageとApplicationの後続Gateで検証する。
- 実際の月次ProjectionへReceiptを含める条件と、Rejected後のItem訂正反映もProjection契約・Testで検証する。
- 初回Pair登録の原子性、別Pair成功の維持と失敗Pairのみの再試行、全Pair完了前の集計除外はADR #170の境界を維持し、具体Adapter／Schema／APIは個別Ready Taskなしに導入しない。

## Review Trigger / Rollback

Snapshotの不変内容を保つためにItem移動と精算開始を原子的に裁定できない、Group Expense ID／履歴維持と複数Pair更新の両立ができない、または実月次Projectionが全Item／Group Expense完了条件を守れない場合は、実装で意味を変えず、新しいProposalで該当するDecisionを再検討する。実装Defectはforward-fixまたはPR revertで修正し、Accepted Decisionの承認履歴を削除しない。

## Owner Approval

- 個別の業務条件確認: Ownerの2026-10-02の対話回答。
- 本Proposalの統合本文: **Ownerの明示承認待ち**。承認Issue／日付を取得後に記録し、ApprovedとなるまでStatusをProposedに保つ。
