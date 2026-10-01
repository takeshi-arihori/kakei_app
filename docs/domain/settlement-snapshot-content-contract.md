# 選択支出から固定する精算Snapshotの算術内容

[Task #158](https://github.com/takeshi-arihori/kakei_app/issues/158)の内部Domain契約。[現行モデル](../product/current-model.md)のGroup全体の精算とApproval／Revisionを正本とする。[ADR #152](https://github.com/takeshi-arihori/kakei_app/issues/152)のCase-owned不変Revisionに渡す算術内容の部分能力を実装する。[ADR #24](https://github.com/takeshi-arihori/kakei_app/issues/24)の3 Contextと[ADR #52](https://github.com/takeshi-arihori/kakei_app/issues/52)のParticipant履歴を維持し、新しいDecisionは採用しない。

## 責務と入力

`SettlementSnapshotContent`は同一性や可変Lifecycleを持たない不変Value Object。Group参照と明示選択した支出factsを保持し、Participant別残高、Payment Instruction候補、必要承認者を導出する。値比較はcanonicalに並べた全元factsで行う。派生値は同じ元factsから決定される。

入力はSettlement-ownedなprimitive型`SnapshotExpenseFact`と`SnapshotExpenseAllocation`。他ContextのEntity／Domain型／Tableを参照しない。支出参照、Group、JPY額、実支払者、固定Participant／参加順／割合／負担額を含む。金額は内部`bigint`、通貨はJPYに固定し、合算がNumberの安全整数を超えても丸めない。公開APIのScalar・Port signature・JSON・保存Schemaをこの型で決めない。

ERは元Expenseと最大剰余配賦を所有する。Settlementは配賦を再計算しない。後続Applicationが、認可された同一Group・同一判断点の未精算支出をERの公開Applicationから取得し、正しい配賦済みfactsとして渡す必要がある。値・集合・保存則の検証は、そのSource確認、本人性、Active状態、fence、期待Expense版、予約commitの証明にならない。

ContentはCase／SnapshotのID発番、作成時刻、`previousSnapshotId`、全Revision履歴、Approval／Attempt状態、支出の訂正や予約、保存を扱わない。登録Actor・購入日・表示名等の保存／画面用の追加factsも本算術内容のScope外。実Revision化・保存・公開接続の前には、それぞれの契約とGateを満たす必要がある。[ADR #55](https://github.com/takeshi-arihori/kakei_app/issues/55)の保護Record完成を、このplaintext Domain値の存在から推測しない。

## 契約とTest Trace

| ID | 条件と担当 | 観測する検証 |
| --- | --- | --- |
| SSC-PRE1 | 後続Applicationが認可／Source／固定判断点／未精算対象を確認して配賦済みfactsを渡す | 本Taskでは未接続Gateとして明示。factoryを公開Use Caseと扱わない |
| SSC-INV1 | 明示選択のみcopyしてdeep freeze。未選択・後発支出を追加せず元支出を変更しない | 選択外／後発支出、入力・出力deepmutation、旧内容の保持 |
| SSC-INV2 | 各Participantの残高=実支払額合計−負担額合計、総和0。0と過去／再参加IDを保持 | 複数支出相殺、ER端数facts保持、1人／0円／大整数合算、6人の過去union |
| SSC-INV3 | 必要承認者はpayerまたは正割合のunion。参加順で固定し現在membershipで置換しない | payer0%、正割合burden0、相殺後net0を含め、非payer全0%のみ除外 |
| SSC-POST1 | [最少候補の契約](settlement-calculation-contract.md)を再利用し不変候補を保持。全員0なら候補空、承認不要にはしない | #157 solverとの一致、全員0でも必要承認者保持、入力逆順の同一結果 |
| SSC-FAIL1 | 値・集合・保存則・参加順対応が矛盾すればtyped拒否。入力と業務状態を変更しない | 下記拒否コードと拒否前後の入力比較 |

必要承認者をburden額や最終Balanceの非0で絞らない。1円をA50%／B50%／C0%、payer Cへ配賦して負担がA1円／B0円／C0円になってもA・B・C全員が必要。Balance全員0も同様に必要承認者を保持し、全員承認後のNo Payment Required／Archive判定はCaseの後続Taskへ渡す。

支出はIDの文字列比較、allocationとBalance・必要承認者は履歴上の参加順でcanonicalに並べる。これは入力順に依存しない値比較のための内部表現であり、支出の業務表示順を追加するDecisionではない。参加順は[ADR #85](https://github.com/takeshi-arihori/kakei_app/issues/85)のcanonical Group参照で区切った同じGroup内で照合する。同じParticipant IDの異なる参加順や、別IDへの同参加順再利用は矛盾として拒否する。

## 拒否分類

`SnapshotContentInvariantViolation`は次を分類し、入力額や参照をmessageへ出さない。

| コード | 条件 |
| --- | --- |
| GROUP_REFERENCE_INVALID | canonical lowercase UUIDでないGroup参照 |
| SELECTION_EMPTY | 選択支出が0件 |
| EXPENSE_REFERENCE_EMPTY / EXPENSE_DUPLICATED | 空／空白のみ／string以外の支出参照、集合内重複 |
| EXPENSE_GROUP_MISMATCH | 選択支出が対象Groupと異なる |
| EXPENSE_AMOUNT_INVALID | 支出額がbigint以外または負 |
| ALLOCATION_COUNT_INVALID | 単支出の固定allocationが1〜4人以外 |
| PAYER_NOT_PARTICIPANT | 実支払者がその支出の固定allocation内に存在しない |
| ALLOCATION_PERCENTAGE_INVALID / ALLOCATION_PERCENTAGE_TOTAL_INVALID | 0〜100の10%刻み違反、合計100%以外 |
| ALLOCATION_BURDEN_INVALID / ALLOCATION_BURDEN_TOTAL_INVALID | 負担がbigint以外・負、負担合計が支出額と異なる |
| ZERO_SHARE_BURDEN_INVALID | 0%のParticipantへ非0負担を与える |
| PARTICIPANT_ORDER_CONFLICT | 支出間でParticipant IDと参加順の対応が矛盾 |

Participantの空参照・無効参加順・単支出内のID／参加順重複は既存`SettlementInvariantViolation`のPARTICIPANT_ID_EMPTY／JOIN_ORDER_INVALID／PARTICIPANT_DUPLICATED／JOIN_ORDER_DUPLICATEDで拒否する。

## 性能・接続前のGateと文書影響

単支出の登録時人数1〜4と、複数支出の歴史上のParticipant unionを区別する。unionを4人へ切り詰めず、新たなProduct上限を追加しない。残高集計は選択facts数に比例するが、導出後の最少候補探索は指数的なcostを持つ。公開Snapshot操作へ接続する前に実入力規模・CPU／timeout／制限方針を評価する。6人fixtureや先行8人fixtureは上限の採用ではない。

状態遷移、Context配置、所有権、公開API、保存Schema、保護Record、UI、運用手順は本Taskで変更しない。そのためcurrent-model／Accepted ADR本文／正式図／Schema／Migration／Runbookの更新は不要。予約・Case更新の同期原子的commitはADR #152の後続契約と実Adapterで検証し、本VOの成功を予約成立と扱わない。

最新developで統合された[Settlement Inventory](../product/mvp-web-settlement-payment-inventory.md)に残っていた集約／原子性の旧未決記述は、既存Owner AcceptedなADR #152へ同期する。33操作のPresentation分類は維持し、具体Port・保存・公開接続等の残Gateを解除しない。
