# 手入力支出の履歴付き金額訂正と版

[Task #168](https://github.com/takeshi-arihori/kakei_app/issues/168)は[現行モデル](../product/current-model.md)と[Expense Inventory E07–E10](../product/mvp-web-expense-receipt-category-inventory.md)の明示済み訂正条件を、[ADR #152](../adr/expense-settlement-consistency-boundary.md)の個別Group Expense Rootへ反映する。最初の独立Sliceとして金額だけを扱い、通常編集E06、他Field、Receipt由来支出のDecisionを追加しない。「金額など」というProduct Scopeを金額だけへ変更するものではない。

## 所有と固定事実

Expense Recordingが`GroupExpense`の現在Snapshot、`initialSnapshot`、版、全`corrections`を所有する。初回版は1、訂正成功ごとに+1。`snapshot()`は現在版の不変事実を返し、初回と過去の額は初回事実と訂正履歴へ保持する。各記録は変更したstable Actor、操作UTC、元理由、訂正前後の全事実、旧新版、対象Caseの参照・読取版・Lifecycleを保持する。全面Event Sourcingや独立履歴Rootは採用しない。

Expense ID／Group／Source Owner／購入日／登録時Participant集合・joinOrder・割合／payerは維持する。参加・脱退・再参加でこれらを置換しない。新金額と負担額だけを新Snapshotとして生成し、既存登録の整数配賦を共用する。0%は0円、最大剰余の同率はpayer、対象外なら登録参加順を優先し、負担合計を新金額に保つ。型・ID・safe integerは内部制約で公開ScalarやProduct上限ではない。

## 契約とTest Trace

| ID | 条件と責務 | Test／Verification |
| --- | --- | --- |
| EC-PRE1 | Applicationが本人性、同Group・同判断点currentOwner／Group lifecycle／fence、Case対象所属・状態・版、Withdrawn／Cancelledの全対象実解放、Case／Expense期待版とSourceを確認。先着CAS／共通atomic commit／故障全rollback／operation結果再送を担う | 未接続Gate。Caller内部factsを認可・全解放・保存先着の実証拠にしない |
| EC-PRE2 | Root自身の期待Expense版とSource Case版一致、Group／Expense一致、canonicalCase、Rejectedまたは全解放済みWithdrawn／Cancelled、SourceOwnerまたは現在Owner、非空理由・UTC | 状態別／全解放false／各版・参照不正、Owner交代・stableSource、必要承認者／旧Owner等拒否 |
| EC-INV1 | 同IDと全登録固定facts、初回・旧Snapshot・旧履歴不変、現在membershipへ置換なし | fixed参照・割合／順／payer／日付／Source保持、複数訂正、callerとnested出力mutation |
| EC-POST1 | 新非負safe JPY整数から既存配賦を再計算、新Rootと現在facts、Expense版+1 | 1000→1201／0／1／最大safe整数／同率payer／0%payer外で歴史joinOrder／合計保存 |
| EC-POST2 | Actor／UTC／元理由／前後facts／旧新版／SourceCase factを不変履歴append、同額の明示訂正も記録 | 全3許可状態、Owner操作とSourceOwner別、複数履歴、UTCコピー／理由空白保持／旧Root不変 |
| EC-FAIL1 | 不正額・理由・Date・資格・版・参照・状態はtyped固定message、部分更新なし | 各拒否と成功／失敗の不変性、同版2つの代替訂正を保存winner／operation再送と区別 |

Testは`apps/api/src/expense-recording/domain/expense-amount-correction.spec.ts`。既存登録68件の配賦・登録Validation・固定Participantを維持する。既存の全364配分算術検証を再利用し、訂正用の別配賦アルゴリズムを作らない。

## Source判断と訂正資格

`caseFact`はApplicationがSourceから同判断点で確認したprimitive内部事実で、他ContextのEntity／Domain型／Repositoryを参照しない。Group／Expense／canonicalCase参照と期待Case版一致を検証するが、この値だけで実際のCase対象所属や保存CASが成立したとは主張できない。`allTargetsReleased`もSource確認の結果で、Clientの自己申告を認可証拠として受けない。具体Port／lock／Client DTO／保護Record署名を採用した型ではない。

Rejectedなら同じExpense IDで却下に対応する金額訂正を許可する。Withdrawn／Cancelledは全対象実解放を確認した場合だけ許可し、未選択の通常編集へ一般化しない。AwaitingApproval、Approved／PaymentActive、CancellationPending、Archived、未選択は拒否する。Source Ownerは手入力の登録stable Actor、現在Ownerの資格は同Group Source factへ依存する。必要承認者というだけでは訂正不可。LeftのSourceOwnerやActorと再参加Participantの寿命を混同しない。Groupが実際に更新可能かはApplicationのPREである。

同額の明示訂正を新業務Ruleで禁止したり、履歴なしのno-opへ変えたりしない。理由と時刻のある訂正として版を進める。同じoperationの再送に元結果を返す契約は別責務で、旧期待Expense版の再投入はこのRootでは拒否する。日時順、理由と却下文の一致解析などの新Ruleは追加しない。

## 拒否と後続接続

| Code | 条件 |
| --- | --- |
| EXPENSE_VERSION_CONFLICT | 期待するExpense版が不正または現在と不一致 |
| CASE_FACT_MISMATCH / CASE_REFERENCE_INVALID | Source Group／対象Expense不一致、Case参照不正 |
| CASE_VERSION_CONFLICT | Case読取版・期待版が不正または不一致 |
| EXPENSE_NOT_CORRECTABLE | 許可状態外または解放状態の全件確認なし |
| ACTOR_NOT_SOURCE_OWNER_OR_OWNER | stableSourceOwnerまたは現在Ownerと一致しない |
| CORRECTION_REASON_EMPTY / UTC_INSTANT_INVALID | 空／空白／文字列以外の理由、不正操作Date |

Actor／Owner空参照と不正額は既存IDENTIFIER_EMPTY／AMOUNT_INVALIDを再利用する。固定Error messageへ主体・金額・理由を埋め込まず公開Errorへ直結しない。

訂正は旧Settlement Snapshotを変更しない。[Case再申請契約](settlement-case-revision-contract.md)が同じ対象集合の訂正後Sourceから新Revisionを生成する。実Source照会と訂正／再申請／解放の先着・期待Case／Expense版・全rollbackは、ADR152の共通atomic commitで後続Application／各Owner Adapterが検証する。純DomainのローカルGuardや2つの同版Root生成を、その実証拠にしない。

未接続Gateは通常編集・他訂正Field・Receipt／Bundle／Category・本番本人性・認可Port・Group fence・予約／実解放／保存CAS・operationキーと再送結果・保護Schema／Key／Audit／Backup・公開GraphQL／Read／UIである。ADR55／73の保護Retentionを維持し、金額・Actor・理由をplaintext Log／DBへ保存しない。

履歴copyと容量は訂正数に応じて増え、公開保存前に実規模・CPU／timeout／容量を評価する。Confirmed RuleとAccepted境界を変えないためcurrent-model／ADR／Contextmapは変更不要。I/O・Schema・Migration・UI・運用変更がなく、対応文書も更新不要。Data変更はなく、未接続CodeのrevertでRollbackする。
