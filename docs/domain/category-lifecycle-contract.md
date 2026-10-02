# Group専用Categoryの変更と不変履歴

[Task #173](https://github.com/takeshi-arihori/kakei_app/issues/173)は[現行モデルのReceipt・Category](../product/current-model.md)、[Inventory C01–C06 / P7 / X01](../product/mvp-web-expense-receipt-category-inventory.md)と[ADR #170](../adr/receipt-category-consistency-boundary.md)の個別Category Rootを、Expense Recordingの純Domainとして実装する。Group専用の追加・名称変更・無効化と、System共有定義の参照を分離する。公開Operation、Source照会、保存Adapterはこの成果に含まれない。

## 所有と内部facts

`Category`が安定ID、System／GroupのScope、現在の名称・Active／Inactive、初回Snapshot、版と全変更履歴を所有する。IDはopaque nonblankな`CategoryId`であり、名称から生成・正規化しない。発番方式、全体一意性、DB形式は後続契約である。Group参照は[ADR #85](../adr/group-operation-locator-and-group-id-contract.md)のcanonical lowercase UUID値を使い、Group ManagementのEntity・Domain型・Repositoryには依存しない。

Group専用作成はActive、内部版1、`Created`履歴を生成する。履歴はstable Actor、UTC、action、変更前後のSnapshot、旧新版を保持し、作成前はSnapshot=null／版0とする。実変更ごとに新Rootと版+1を返し、初回定義と全履歴を保持する。現在定義・Scope・ID・履歴配列・各記録と前後Snapshotは不変である。業務履歴でありAudit Logや全面Event Sourcing、保護保存Schemaではない。

System定義は信頼されたSourceのid／name／statusを読取factsとしてimportする。ScopeはSystemだけでGroup参照を持たず、Group Ownerの両変更を拒否する。Group Actorによる作成履歴は生成しない。System読取時の内部版1はSourceの保存版ではなく、`deactivatedAt=null`はSystem管理時刻をここで生成しないという意味である。Systemの完全な変更履歴・管理時刻・管理APIはこのimportで実装済みとせず、必要なRead／CSV／管理契約で別途取得する。

## 契約とTest Trace

| ID | 条件と責務 | Test／Verification |
| --- | --- | --- |
| CA-PRE1 | Applicationが本人性、同判断点のGM現在Owner、Group Active／Closing fence、名称Product ValidationをSourceから確認する。Client roleを内部factsへ直接変換しない | 未接続Gate。pure Domainの成功を実認可・Group状態・Source照会の証拠にしない |
| CA-PRE2 | ID／Actor／Ownerはnonblank、Groupはcanonical、名前はstring fact、時刻は有限Date。変更はGroup一致・Actor=currentOwner・期待版safe integer一致 | 作成・変更の空参照／非Owner／Group不正・不一致／期待版／不正Date／名前fact型拒否 |
| CA-INV1 | ID・Scopeは固定、無効化で定義や過去参照を削除せず、再有効化しない。旧Root・初回・全履歴は不変 | 作成→rename→deactivate→Inactive rename、過去Item参照・初回保持、deep freeze、入力Date／DTO変異 |
| CA-POST1 | 実変更のみ新Root・版+1、Actor／UTC／action／前後定義／旧新版を不変append | 複数変更の全件履歴、Owner交代後のstable Actor、UTCコピー、元Root不変 |
| CA-POST2 | 同値rename／既にInactiveのdeactivateは元Rootを返し版・履歴・最初の無効化時刻を増やさない。guardは同値判定前にも実施 | no-opと非Owner／他Group／古版／不正UTCの拒否。公開再送Success／Idempotencyへ一般化しない |
| CA-FAIL1 | System標準のGroup変更、非Owner／他Group／版不一致はtyped固定Errorで拒否し部分更新しない | System Active／Inactive両変更拒否、旧Owner・再参加Participant参照拒否、同版代替Rootと古版拒否 |

Testは`apps/api/src/expense-recording/domain/category.spec.ts`。API architecture testでDomainからFramework／Infrastructure／他Contextの内部型への依存禁止も検証する。ローカルの同版Rootを2つ生成できることは、実保存先着・CAS・原子的commitが成立した証拠ではない。

## 名称とOwner判断

名称は前段でProduct Validationを通したstring factを無変換で保持する。ここでtypeofだけを技術境界として確認し、空文字／空白、文字種、長さ、trim、Unicode正規化、重複のProduct Ruleを新規採用しない。内部factoryの成功は任意Client名を受け付ける公開契約ではなく、名称Validation Gateの解消が公開Taskの前提となる。過去名称の画面表示方式も別Gateである。

現在Ownerのstable SubjectとActorの完全一致を確認する。旧Ownerや必要承認者というだけでは許可せず、再参加Participant IDをstable Actorに混同しない。Owner交代後は新しいSource factsを取得する。これらprimitive値は実Source照会・本人性の代替証拠ではない。

renameは名称だけを変更し、ID／Scope／状態／最初の無効化時刻を保つ。Inactiveの名称変更も再有効化を伴わない。deactivateはActive→Inactiveと最初の操作UTCを保持し、新Itemの選択時はApplicationが同判断点のActive定義を確認する。Receipt確定との競合照合は後続接続であり、古いCategory snapshotだけで新規利用を許可しない。削除・再有効化・公開Read／Query・Suggestion CRUDを追加しない。

## 拒否と残る接続

| Code | 条件 |
| --- | --- |
| CATEGORY_ID_EMPTY / GROUP_ID_INVALID | 空IDまたはcanonicalではないGroup参照 |
| ACTOR_REFERENCE_INVALID / ACTOR_NOT_OWNER | 空Actor／Ownerまたは現在Ownerとの不一致 |
| GROUP_MISMATCH / SYSTEM_CATEGORY_IMMUTABLE | 別Groupの変更またはSystem標準へのGroup変更 |
| VERSION_CONFLICT | 期待版がsafe integerでない・現在版と不一致、内部次版の安全範囲外 |
| UTC_INSTANT_INVALID | 有限Date以外の操作時刻 |
| NAME_FACT_INVALID / STATUS_INVALID | string以外の名前fact、Systemの状態集合外 |

Error messageは固定で名称・Actor等の入力を埋め込まず、公開GraphQL Errorへ直接露出しない。操作時刻の順序や現在時計との一致を新Ruleとして追加しない。

未接続Gateは本番本人性、GM公開照会Port／Group fence、Naming Validation、CategoryとReceiptの同時点・期待版照合、実CAS／operation再送／保存、保護Record kind・Schema・Key・Audit・Backup、Retention／Group削除、公開API／Read／UIである。System共有定義の寿命をGroup専用・Group参照履歴の寿命と区別し、[ADR #55](../adr/snapshot-revision-security-and-retention.md)／[ADR #73](../adr/group-close-consistency-and-retention-boundary.md)の保護・削除を維持する。純Domainの履歴をそのままplaintext DB／Logへ保存しない。

履歴appendのコピーCostと容量は変更数に応じて増え、保存接続前に実規模を検証する。current-modelのConfirmed業務Rule、Context map、Schema、Migration、Runbook、依存Package、公開契約に変更はない。未接続CodeのrevertでRollbackする。
