# ドメイン設計ルール

## 目的

DDDは、業務上重要なRuleをDB、Prisma、GraphQL、NestJSの都合ではなく、ユビキタス言語とDomain Modelで表現するために使う。EntityやRepositoryを置くこと自体を目的にしない。

## 戦略的設計

- Core DomainはTransaction、Split Allocation、Settlement、共有家計の追跡可能性とする。
- Bounded ContextはMVPのModular Monolith内の論理境界であり、Microservice境界ではない。
- Context内のModelを他Contextへ共有しない。Context間はID、Published Language、Port、Integration Eventで連携する。
- 同じ言葉がContextごとに異なる意味を持つ場合、共通型へ統合せずContext内の言葉を優先する。
- 業務理解が変わったら、用語、Context Map、Aggregate、Event、Test、図を同時に見直す。

## Modelの選択

### 値オブジェクト

次を満たす値をValue Objectにする。

- 同一性ではなく値の等価性で比較する。
- Money、OccurredOn、AccountName、IdempotencyKeyのように業務上の名前と制約を持つ。
- 生成後はImmutableである。
- FactoryまたはConstructorで常に妥当な状態だけを生成する。
- Primitiveへ戻す処理は永続化やPresentationなど境界で行う。

Moneyは整数AmountとCurrencyを持つ。MVPのCurrencyはJPYで、収入・支出・精算は0円より大きく、負数でTransaction Typeを表さない。

### エンティティ

- Lifecycleを通じた同一性を持つ業務概念に使う。
- IDだけのData Holderにせず、状態変更を業務語彙のMethodとして表す。
- Public setterを避け、Invariantを破る中間状態を外へ公開しない。
- Prisma ModelやGraphQL TypeをEntityとして再利用しない。

### 集約

- 同一Transactionで必ず守るInvariantの最小境界にする。
- 外部からの変更入口をAggregate Rootへ限定する。
- RepositoryはAggregate Root単位で保存・復元する。
- Aggregate間参照はObjectではなくIDを基本とする。
- 画面、GraphQL Mutation、Tableのまとまりを理由にAggregateを大きくしない。

採用済み境界:

| Aggregate | Persistence | 主なInvariant |
| --- | --- | --- |
| Household | State | 共有世帯最大4人、Ownerは常に1人、移譲は受諾後に成立 |
| FinancialAccount | State | Household所属、Opening BalanceとBalance Dateの組、過去参照維持 |
| Transaction 1件 | Event Sourcing | JPY整数、Allocation合計、Transfer口座差、削除・復元条件 |
| Settlement 1件 | Event Sourcing | PayerとPayeeの差、正金額、取消Lifecycle |

HouseholdへAccount、Transaction、Settlementを内包しない。Account Balance、Monthly Summary、Pairwise Debtは複数Aggregateを跨ぐRead Model／Projectionとする。

### Domain ServiceとPolicy

- 1つのEntityやValue Objectへ自然に属さないStatelessなDomain RuleだけをDomain Serviceへ置く。
- Application Serviceを「Entityへ置きたくない処理」の退避先にしない。
- Accountの有効性、Membership、Category、Balance DateなどContext間の検証はApplication層がPortで取得して調整する。
- Settlement上限はPairwise Debtを参照する集約間Policyであり、Settlement単体のInvariantに偽装しない。

## 単一責任

責任は「変更理由」で判断する。

- Aggregate: 業務Invariantが変わる理由
- Application Handler: Use Caseの順序・認可・Transaction境界が変わる理由
- Resolver: GraphQL契約やPresentationが変わる理由
- Repository Adapter: 永続化方式が変わる理由
- Projector: 1つのRead Modelの導出Ruleが変わる理由

1つのClassが複数の変更理由を持つ場合は分割する。ただし、行数やMethod数だけを理由に細分化しない。Invariantを守るために一緒に変わる振る舞いはAggregate内へ凝集させる。

## ドメインイベント

- 既に起きた業務上の事実を過去形で命名する。
- Immutableで、AggregateのDecisionを再現できる非機密Dataだけを持つ。
- `event_id`、Aggregate ID／Type／Version、Event Type、Schema Version、Occurred At、Actor、Household、Command、Correlation、CausationをMetadataとして扱う。
- Timestamp、ID、外部参照値はApplicationからCommandへ渡し、Domain内で暗黙生成しない。
- 内部Domain EventをそのままIntegration Eventとして公開しない。
- Audit Logは「誰が何を試み、どう終わったか」、Outboxは配送作業Dataであり、Domain Eventと別概念とする。

## イベントソーシング

適用対象はTransactionとSettlementだけとする。他Contextへ拡張する場合はADRが必要。

基本形:

1. Stored EventまたはSnapshot＋残EventからAggregateを復元する。
2. Commandを`decide`し、新しいDomain EventまたはDomain Errorを得る。
3. Eventを`evolve`／`apply`して次状態を得る。
4. expectedVersion付きでEventをappendする。
5. 同期Projection更新とOutbox登録を同じPostgreSQL Transactionで確定する。

ルール:

- `decide`は現在状態とCommandだけに依存し、I/Oを行わない。
- `evolve`はEventだけから決定的に状態を更新する。
- 同じEvent列は常に同じ状態へ復元される。
- Event payload変更にはSchema VersionとUpcasterを用意する。
- Snapshotは正本ではなく、破損時にEventから再生成できる派生Dataとする。
- 機密平文をEvent、Snapshot、Outbox、Logへ含めない。必要時はRandomなPayload Referenceだけを保持する。

## 設計レビュー

実装前に次を答えられること。

- どのBounded ContextとAggregateがData Ownerか。
- RuleはAggregate内Invariantか、Aggregate間Policyか、表示用Ruleか。
- EntityとValue Objectの選択理由は何か。
- Command、Domain Event、Read Model、Portは業務語彙になっているか。
- 同時更新、二重送信、再試行、削除・復元でInvariantが守られるか。
- Security、Audit、完全削除、Projection Rebuildへどんな影響があるか。

## 参照元

- [05 DDD・Context Map・ユビキタス言語](https://app.notion.com/p/39a06467984f81e98cd2d669dc900b43)
- [06 ドメインモデル・集約・UML](https://app.notion.com/p/39a06467984f81b3b495f6ee2126fac5)
- [ADR-0001: Transaction・Settlement限定のEvent Sourcing](../adr/0001-transaction-settlement-event-sourcing.md)
- [ADR-0004: 同期Projection＋Transactional Outbox](../adr/0004-synchronous-projection-transactional-outbox.md)
