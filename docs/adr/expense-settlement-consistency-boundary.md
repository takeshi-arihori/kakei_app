# 支出・精算の集約と予約の原子的確定境界

- Status: Accepted（対象Decisionのみ。実Adapter完成・本番有効化を意味しない）
- Owner: takeshi-arihori
- Proposed / Owner Accepted: 2026-10-01
- Approval evidence: [ADR 152](https://github.com/takeshi-arihori/kakei_app/issues/152)
- Implementation: [Task 154](https://github.com/takeshi-arihori/kakei_app/issues/154)、[Epic 153](https://github.com/takeshi-arihori/kakei_app/issues/153)
- Amends: [ADR #24](shared-expense-domain-boundaries.md)の未決だった個別Aggregate／予約整合性境界。3 Context、Modular Monolith、State model＋不変業務履歴を維持する
- Preserves: [ADR #55](snapshot-revision-security-and-retention.md)、[ADR #73](group-close-consistency-and-retention-boundary.md)

## Context

[現行業務モデル](../product/current-model.md)は、Group Expenseの登録時Participant／payer／Split／負担額の固定、同IDの履歴付き訂正、Case対象Expense集合の固定、不変Snapshot Revision、全員承認／支払確認／取消をConfirmedとしている。ADR #24では個別Aggregateと予約の確定方式は未決だった。

支出単位の訂正とCase全体の状態遷移を明確に所有させ、訂正と再申請の競合やCaseと予約の部分反映を防ぐ境界が必要である。既存Table、Provider、公開GraphQL型を業務モデルの根拠にしない。

Ownerは2026-10-01に「支出ごとの集約＋精算Case集約＋予約と精算更新を同じトランザクションで確定する」案の採用確認へ「承認で」と回答した。Proposed比較から次の3点だけをAcceptedへ進める。

## Decision

1. Expense Recordingが個別Group ExpenseをRootとして所有する。Expense ID、購入日、金額、実支払者、登録時Participantと配賦、Source Owner、履歴付き訂正と版を同じExpenseの境界へ集約する。Group Managementは現在のGroup／Membership／Roleを所有し、過去の支出事実へ後からmembershipを反映しない。
2. SettlementがCaseをRootとして所有する。初回の対象Expense ID集合を固定し、不変Snapshot Revision、承認・却下、取り下げ・取消、Payment Instruction／AttemptのLifecycleをCaseの境界で判断する。Revisionの内容は不変な値／保存Recordとして保持し、独立した可変Rootとして訂正しない。
3. MVP Modular Monolithでは、Expenseの予約／解放とCase／Revisionの更新を同じ同期トランザクションで全成功または全rollbackとして確定する。各Contextの公開Application Portと原子的commit境界を協調させ、他ContextのEntity／Repository／Tableを直接操作しない。期待Case版と対象Expense版の確認を含む具体契約は後続Taskで設計・検証する。

Source Ownerは手入力では登録者、Receipt由来ではUploaderという既存Ruleを維持する。登録Actorの安定参照とParticipantの寿命を混同しない。認可、現在membership、fence、競合の同一判断点はApplication／各Owner Adapterの責務である。

### この承認で確定しない事項

Receipt／BundleのAggregate、CategoryのContext所属、本番本人性・認証Provider、公開GraphQL／Error、月次Readの契約は別Decisionである。共通commitの具体Port signature、lock順、transaction lifetime、冪等キー／結果保存、各Contextの保護Record kind／Schema／Migration、実Key Provider／Audit／Backup／Deploymentは未決または未実装のGateを維持する。既存snapshot-revision kindへ別Recordを押し込まない。

## Alternatives

| 対象 | 採用 | 比較した代案とTrade-off |
| --- | --- | --- |
| Expense境界 | 個別Expense Root | Group単位のExpense集合Rootは複数支出の固定を扱いやすいが、独立登録・訂正が同Rootで競合する |
| Settlement境界 | Case Rootと不変Revision | Revision／Instruction別Rootは変更単位を小さくするが、全員承認・Attempt0取消・全件完了の原子的状態遷移が複雑になる |
| 予約確定 | 同期の共通原子的commit | 分散予約と補償は別Processへ分けやすいが、未完了予約・孤児・結果不明・復旧が増える。単純な順次Port呼出しでは部分反映なしを保証できない |

## Consequences

支出の過去事実と精算のLifecycleが各Ownerへ凝集し、同ID訂正と固定Case集合を区別できる。Case履歴が増える場合の競合／読取Costと、共通commit境界の責務を後続設計で評価する。将来のProcess分離には新たなADRと整合性・補償契約が必要となる。

純Domainの登録・配賦は実Storage／Providerを選ばず着手できる。予約／認可／公開Use CaseはこのDecisionだけでReadyにならず、Task固有の契約・Security・運用Gateを満たす必要がある。

## Implementation

Task 154は最初の手入力登録Domainだけを実装する。ERのGroupExpense factory、必要Value Object、機械判定可能なError、deep immutableな登録factsと整数配賦を対象とする。現在GroupのActive判定、信頼Actor、Closing fenceは後続Applicationで扱う。Domain factoryを公開登録Use Caseの完成と扱わない。

JPY負担はBigIntによる最大剰余で求め、同率の実支払者、続いてGroup参加順で決定する。0%は0円で保持する。登録時のfactsはcopyして固定し、加入・脱退・再参加やcallerのmutable inputから旧支出へ変更を伝播させない。OccurredOnは購入暦日でTimezone変換しない。JS safe integerの制限は技術制約として明記し、新たなProduct上限にしない。

後続Case／Application／Persistence／公開APIのTaskは別に契約とReady判定を行う。[設計Gate](../product/design-gates.md)で残る条件を追跡する。正式Contextmapの3 Contextは不変のため、今回新たな図は追加しない。

## Review Trigger / Rollback

Case履歴による競合・性能問題、別Processへの分離、共通commitの実装でOwner境界や部分反映なしを守れない場合、新しいADRで見直す。実装の問題はforward-fixまたはPR revertで対応し、承認証跡を削除して未決へ戻さない。Decision変更はOwnerの明示承認を要する。
