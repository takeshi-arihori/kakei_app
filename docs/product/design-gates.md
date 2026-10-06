# 未確定・未移行Gate

GitHubへの管理先変更は、業務設計の承認や旧情報の全件移行を意味しない。根拠が不足する機能TaskはProjectのBlocked=Yesとし、Issueに不足、影響、解消条件を記録する。Notionへアクセスして補わない。

## 採用済み方針と残る設計Gate

[ADR #24](../adr/shared-expense-domain-boundaries.md)は2026-09-06に案Aを条件付きAcceptedとした。3 Context（Group Management、Expense Recording、Settlement）、MVP Modular Monolith、State model＋必要な不変業務履歴、Command／Query責務分離を採用する。全面Event Sourcingと別Store／非同期Projectionは初期採用しない。

- Group Managementの最初のData Owner、Aggregate、Repository Port、内部Command認可は後続ADR #35／#36で条件付きAcceptedとなった。Group終了のContext間Portは[ADR #73](../adr/group-close-consistency-and-retention-boundary.md)でAcceptedとなった。[ADR #152](../adr/expense-settlement-consistency-boundary.md)でER個別Group Expense Root、Settlement Case Rootと不変Revision、予約／精算更新の同期原子的commitを2026-10-01に採用した。[ADR #170](../adr/receipt-category-consistency-boundary.md)で2026-10-02にER Receipt Root／個別Category Rootと1Bundle・対応Expense登録の原子性を採用した。具体Port／lock順／冪等キー・結果、保護Record kind／Schema、終了以外のContext間認可は未決または未実装。
- Invitation lifecycleと再参加Participant寿命はADR #52でAcceptedとなった。Invitation／冪等記録の保存保護、Retention、BackupのDecisionはADR #55でAccepted済みであり、S1〜S3と#42／#94〜#97で段階的に実装・検証する。Persistence、本番本人性・認証・配送、Context間認可、Projectionの未決部分は必要な後続Decisionを経て確定する。
- 条件C1は2026-09-20に充足した。[保護・保持Decision](../adr/snapshot-revision-security-and-retention.md)のOwner Accepted、[正式Security Review pass](https://github.com/takeshi-arihori/kakei_app/issues/55#issuecomment-5748185586)、[PR #70](https://github.com/takeshi-arihori/kakei_app/pull/70)のdevelop統合（merge commit `d0546e46c614d4c081bb2adfd59da27cce9f70af`）を証拠とする。
- C1充足だけではPersistence TaskをReadyにしない。S0〜S3、[ADR #85](../adr/group-operation-locator-and-group-id-contract.md)と[ADR #102](../adr/close-intent-id-retention-boundary.md)のRepository同期、#86のApplication／Domain契約整合、#42のv2 Migration／PostgreSQL CIはDoneである。CloseIntent registryのDB強制一意性はGroup存続中と削除後1年のcleanup commitまでとし、期限後はCSPRNG UUIDv4の実用上一意性へ移る。読取・再送 #94は#42完了後の個別Ready評価を通過した。状態writer #95、公開commit #96、固定版認可lock #97は各依存完了後に個別Ready評価する。最新StatusはGitHub Projectを正本とする。実Context fence／Receipt配送、Key Provider、Audit Store、Retention／Backup Gateが揃うまで本番へwireしない。

[設計比較](../domain/shared-expense-design-boundaries.md)に残る候補を一括採用しない。条件に依存しない3 Contextの可視化や設計調査は、別TaskのReady評価を経て進められる。既存のHono／Next.js責務分離、JPY整数、機密平文禁止は維持する。

## 今回の移行範囲

現在の[業務モデル](current-model.md)は公開済みRepositoryの引き継ぎ記録を、取得済みの現行Scope/業務Ruleと照合して整理した。架空のActor・金額例を維持し、古い個人識別用の呼称、旧参照先、解消済み事項を未確定とする記述を除いた。業務判断の追加はしていない。

旧情報の分類は129対象中、公開可28・要編集77・非公開0・除外24・未分類0。取得不能だった非現行Source4件を別途除外すると133対象、除外28。必要な現行非公開情報は検出していない。この分類は全件移行や今後の公開を自動承認するものではない。

| 未移行範囲                                  | 現在の扱い・再開条件                                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧Project/Epic/Taskの全履歴・Relations      | 全件移行はしない。次に選択する成果をGitHub Issueへ明示し、依存とOwner承認を確認する                                                                                         |
| 旧ADR本文（14/20の関係要約以外）            | 現行不変条件を維持。詳細に依存する変更はGitHub上でADRを整えてOwner承認を得る                                                                                                |
| 旧UX、画面、API、Security、運用仕様の詳細   | current-modelと既存公開Repoだけで確定しない。対象Taskに必要な仕様をGitHubへ整理し、未決Decisionを分離する                                                                   |
| 要編集77件の旧本文・メタデータ              | 公開へ生コピーしない。今回の一般運用文書とは区別する                                                                                                                        |
| 既存draw.ioのメタデータ・一部割合例の不整合 | Ownerの検討用入力として保持し、正本や新仕様の根拠にしない。AIは変更または自動変換せず、採用が明示された内容だけを関連IssueまたはADRと`docs/diagrams/*.mermaid.md`へ反映する |
| 旧Source404の4件                            | 非現行の監査上の欠損。復元済みと主張しない。新しいDecisionの根拠にしない                                                                                                    |

旧管理先の再構築待ちというDC-003/005は、今回のGitHub入口・Field検証で管理先の部分を置き換える。旧Taskの依存や業務上の未決をまとめて解消したことにはしない。

## 公開前Gate

公開対象ごとに機械検査と手動Reviewを行う。Secret、PII、実在金融情報、内部Security情報、未分類・要編集の内容を公開しない。必要な現行非公開情報が新たに見つかった場合はOwnerへPrivate保管先を確認する。新規仕様を一般論から捏造しない。

## Group Management初回境界

[設計分析](../domain/group-management-first-boundary.md)、[整合性境界Decision](../adr/group-management-consistency-boundary.md)、[認可Decision](../adr/group-management-command-authorization.md)、[招待・再参加Decision](../adr/group-invitation-and-rejoin.md)、[Group終了Decision](../adr/group-close-consistency-and-retention-boundary.md)、[CloseIntentId保持Decision](../adr/close-intent-id-retention-boundary.md)、[operation locator／Group ID Decision](../adr/group-operation-locator-and-group-id-contract.md)へ具体化した。S0〜S3、#86、#42はDone。#94は読取Adapterとして個別Ready評価を通過し、#95〜#97は依存順に個別Ready評価する。#96はADR #102 Repository同期後に個別Ready評価する。本番本人性・配送、実Context fence／Receipt配送は未決または未実装であり、Production Key Provider／Audit Store／Retention Checkpoint／Backup／Deployment Gateも未実装である。

## 支出・精算の純Domain実装境界

[ADR #152](../adr/expense-settlement-consistency-boundary.md)の承認に基づき、[Task #154](https://github.com/takeshi-arihori/kakei_app/issues/154)は手入力支出の登録時固定factsと整数配賦の内部Domainを個別Ready評価した。現在GroupのActive／Actor本人性／Closing fenceは後続Applicationの責務であり、factoryを公開登録Use Caseとして使わない。Case／Port／Persistence／公開APIの後続Taskは具体契約とSecurity・運用Gateを別に満たす。本ADRはReceipt／Categoryや本番認証の採用、本番Protectionの有効化を意味しない。


## Receipt／Category境界の部分解決（2026-10-02）

[ADR #170](../adr/receipt-category-consistency-boundary.md)の承認対象はERのReceipt Root、System標準／Group専用を区別する個別Category Root、1Bundleと対応Expenseの共通原子的commitの3点だけである。System共有標準をGroup専用／Suggestionの削除へ巻き込まず、全Item割当・全Expense登録前の月次非包含を維持する。名称重複・正規化、Suggestion所有／保存、個別編集の影響範囲、確定後画像閲覧、具体Port／認可／再送／保護保存／運用／Projectionは未決または未実装Gateとして残る。純Domain Taskも個別Ready評価を行い、公開Use Caseの完成とは扱わない。


## Receipt Bundle編集・Snapshot固定の解決範囲（2026-10-02）

[ADR #179](../adr/receipt-bundle-edit-and-snapshot-lock.md)はUploaderだけのBundle操作、初Snapshot選択前の所属／payer／割合変更、選択後の永久固定、各既存Expense ID・Participant facts・履歴の維持、Rejected後のItem金額／Adjustment／Category訂正維持をAcceptedとする。初回Pair共通commit、段階登録、成功Pair保持、全Item／全Expense登録前の集計除外はADR #170を維持する。

[Task #179](https://github.com/takeshi-arihori/kakei_app/issues/179)の本文承認・文書同期後、Bundle純Domain Taskを個別Planning／Ready評価する。複数Pair編集の実保存atomicity、Snapshot選択との競合裁定、durable初選択lock、同判断点の版／実認可／Group fence、operation-result replay、実月次Projectionは後続Gateのままであり、この承認では実装済みにならない。Category／明細訂正のOwner権限、他Field、手入力Expense、画像閲覧、Suggestion、本番Protection／RetentionのGateを拡張しない。


## Bundle初回登録の純Domain trace（2026-10-03）

[Task #182](https://github.com/takeshi-arihori/kakei_app/issues/182)の[初回登録契約](../domain/receipt-bundle-registration-contract.md)とDomain Testは、Confirmed Itemの非空・一意割当、調整後合計と初回Expense対応、Uploader／版確認、不変履歴、段階登録と全割当完了の内部事実を扱う。実Group所属／本人性、共通atomic commit、durable再送結果、月次Projection、Bundle編集とSnapshot lock、Rejected後訂正の実装はこのSliceに含めない。Accepted Decisionを変更せず、公開API／画面Readyを引き上げない。

## Bundle初Snapshot選択と永久編集Policyの純Domain trace（2026-10-03）

[Task #184](https://github.com/takeshi-arihori/kakei_app/issues/184)の[初選択・永久編集lock契約](../domain/receipt-bundle-snapshot-lock-contract.md)は、Receiptが初回Pairを維持してSource初選択の参照・Actor・UTCを不変値として記録し、以後のItem所属／payer／割合の編集可否を永久に拒否する内部Policyを扱う。Rejected／Withdrawn／Cancelledでも解除しない。Sourceの選択ActorにUploader一致を要求せず、編集PolicyだけをUploader専用とする。実Sourceの初選択確認・選択資格、実編集Command、保存atomicity／CAS／durable lock／再送、本人性／Group fence、Rejected後Item訂正、Projection／API／画面は後続Gateのまま。Accepted Decisionと公開Ready状態を変更しない。

## Bundle payer／Split変更の純Domain trace（2026-10-03）

[Task #186](https://github.com/takeshi-arihori/kakei_app/issues/186)の[payer／Split変更契約](../domain/receipt-bundle-split-change-contract.md)は、Receiptの共通編集Policyを通過した内部factsと対応Expenseの値整合を確認し、同ID・同登録Participant集合／joinOrder・額・購入日・Source・初回事実を維持してpayer／割合／整数負担を変更する。不変履歴とamount訂正履歴を相互に保持し、初選択後はfacts取得を永久拒否する。DTOは認可capabilityではなく、実Source currentness・初選択と編集の原子裁定・Receipt読取版fence＋Expense CAS、本人性／Group fence、durable lock／再送、実Item移動／Rejected後Item訂正、保存／Projection／API／画面は後続Gate。Accepted Decisionと公開Ready状態を変更しない。

## Bundle Item移動の純Domain trace（2026-10-03）

[Task #188](https://github.com/takeshi-arihori/kakei_app/issues/188)の[Item移動・Expense額反映契約](../domain/receipt-bundle-item-movement-contract.md)は、両Bundleの共通永久Policy・一意所属・非空を守り、Item調整値と同Pairを維持して所属を移す。Callerが前後Receipt factsを両Expenseへ束縛し、現在payer／割合・登録集合／joinOrder・初回事実・既存履歴を維持して額・整数負担を再計算する。0円移動でも両履歴を追加する。DTOは認可capabilityではなく、実Source／本人性・Group fence、初選択との同時裁定、Receiptと両Expenseの共通atomic commit／CAS／durable再送、Rejected後Item訂正、保護保存／Projection／API／画面は後続Gate。Accepted Decisionと公開Readyを変更しない。

## 登録済みItem Category訂正の純Domain trace（2026-10-05）

[Task #190](https://github.com/takeshi-arihori/kakei_app/issues/190)の[Category訂正契約](../domain/receipt-item-category-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みConfirmed Item一件のCategoryだけを訂正し、同ID・金融値・Bundle対応・初選択・旧Snapshot・全履歴を保持する。対象Itemに対応するExpenseが未選択なら編集可能、初選択後は同判断点の関連CaseがRejectedの場合だけ許可する。他Bundleの状態を対象へ流用せず、所属／payer／割合の永久固定を解除しない。同Categoryでも条件を検証したsameRoot no-op。実Category Active／Group適合・Source現在版／本人性・Closing、訂正と初選択／再申請の保存裁定・CAS／再送、金額／Adjustment訂正、月次Projection／公開API／画面は後続Gate。Accepted Decisionと公開Readyを変更しない。


## 登録済みItem原額訂正とExpense反映の純Domain trace（2026-10-06）

[Task #192](https://github.com/takeshi-arihori/kakei_app/issues/192)の[原額訂正・財務反映契約](../domain/receipt-item-amount-correction-contract.md)は、Uploaderまたは現在Group Ownerが登録済みItem一件の原額を理由付き訂正し、既存Adjustment再配賦で影響する全Bundleの未選択／Rejected条件を検証する。各既存Expense ID・登録集合／payer／割合・初回事実・全履歴と旧精算Revisionを維持して額・負担へ反映する。Bundle永久lockを解除しない。Adjustment自体の編集、Draft／一般編集、実Source・認可／Group fence、全影響Root共通保存／CAS／再送、保護保存／Projection／API／画面は後続Gate。純Domain成功を実保存や公開Readyの証拠にしない。

## 既存Adjustment金額訂正の実装trace（2026-10-06）

[Task #194](https://github.com/takeshi-arihori/kakei_app/issues/194)の[Adjustment金額訂正契約](../domain/receipt-adjustment-amount-correction-contract.md)は、既存一件の額訂正と全再配賦、影響する登録Bundleの未選択／Rejected条件、同Expense IDの額・負担・不変履歴を純Domainで扱う。原額・Category・Pair／初選択永久lock・現在payer／割合・旧精算Snapshot・全既存履歴を維持する。既存の原額／割合／Item移動／手入力訂正も新Adjustment履歴を保持する。追加／削除・種別／適用先変更、Draft／一般編集、実Source・認可／Group fence・原子的保存／再送／保護保存、Projection／API／画面は後続Gate。Accepted本文・承認履歴・公開Ready状態を変更しない。
