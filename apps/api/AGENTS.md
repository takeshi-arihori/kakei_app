# API開発ルール

このファイルは`apps/api`配下へ適用し、ルート`AGENTS.md`を補足する。

## レイヤと依存方向

実装パターンに応じて必要なレイヤ数を決める。

- Transaction Script / Active Record: 3層を許容する。`Presentation -> Application / Business Logic -> Infrastructure / Data Access`を基本とする。
- Domain Model / Event History Domain Model: 4層を必須とする。`Presentation -> Application -> Domain <- Infrastructure`の依存方向を守る。
- 4層が必要なContextでも、未利用Layerの空Directoryは先行作成しない。Business APIを公開する最初のTaskでPresentation Adapterを追加するなど、利用開始時に責務を実体化する。
- 実装パターンは既存Directory構成から逆算せず、業務Rule・Invariant・Lifecycle・履歴要件から判断する。

4層を採用するContextでは次の責務を守る。

- `src/<context>/domain`: Aggregate、Entity、Value Object、Domain Service、Domain Event、不変条件を持つ。
- `src/<context>/application`: Use Caseの順序、認可、Transaction境界、Port呼出しを調整する。
- `src/<context>/presentation`: Context固有の認証Guard、Input／Output変換、Command／Query呼出しだけを行う。
- `src/<context>/infrastructure`: Prisma、PostgreSQL、Firestore、KMS、Email、OAuthなどのAdapterを実装する。
- `src/shared/domain`: 複数Contextで意味と変更理由が一致するDomain型だけを置く。
- `src/presentation/graphql`: GraphQL Schema、生成型、Context Presentationの共通組み立てを置く。
- Context固有のPresentation／Infrastructureは最初の利用Taskで追加し、空Directoryを先行作成しない。
- Expense Recording／Settlementも、Accepted済みの実装対象へ着手するときにContext Directoryを追加する。
- DomainからHono、GraphQL、Prisma、Cloud SDKをImportしない。
- ApplicationはPortへ依存し、Infrastructureが内向きにPortを実装する。
- Resolverへ業務ルール、Repository呼出しの組立、個別の例外変換を散在させない。
- `architecture-dependencies.spec.ts`でLayer逆転、Context横断、解決不能、ProductionからTestへの依存を検出する。

## 戦術的DDD

- Value Objectは業務上の意味と制約を持つImmutableな値として、生成時に常に妥当性を保証する。
- Entityは同一性とLifecycleを持ち、状態変更を意図が分かる振る舞いとして公開する。
- Aggregate RootだけをRepositoryの保存・復元単位とし、Aggregate内不変条件を1 Transactionで守る。
- Public setterや貧血モデルを避け、Ruleを呼出し側へ漏らさない。
- Domain Serviceは1つのEntity／Value Objectへ自然に属さないStatelessなDomain Ruleだけに使う。
- Context間のRuleはApplication Policyと明示的なPortで調整し、他ContextのTableやEntityを直接操作しない。

## Event・永続化

- Event Sourcing、CQRS、Projection、Outboxの適用対象は未確定であり、旧Transaction／Settlementの範囲を採用済みとして扱わない。
- Accepted ADRでEvent Sourcingを採用したAggregateだけ、過去Eventから復元し、Commandに対して新しいEventまたはDomain Errorを返す。
- `decide`と`evolve`／`apply`を分離し、Aggregate内でI/O、現在時刻取得、乱数生成を行わない。
- Event名は既に起きた業務事実を過去形で表し、Immutableかつ非機密にする。
- Domain Event、Stored Event、Integration Event、Audit Log、Outbox Messageを同一型にしない。
- 採用時はappendをexpectedVersionで競合検知し、Accepted ADRが要求するAtomicityを守る。
- 技術的Snapshotを業務上のSnapshot Revisionと混同しない。採用時は派生Dataとし、Event全再生と同じ状態になることをTestする。

## テスト

- Domain RuleはDBやHonoを使わない高速なUnit Testから始める。
- Event Sourcingを採用したAggregateはGiven Event／When Command／Then Event or Errorで検証する。
- 採用済みのRepository、Event Store、Projection、Outbox、Migration、冪等性を実PostgreSQLのIntegration Testで検証する。
- GraphQL Testでは認証、認可、Validation、Error契約、Pagination、Complexity、N+1を確認する。
- Money、Split Allocation、Participant Balance／Payment Instruction導出、Settlement Lifecycle、認可PolicyのCritical Branchは100%を目標とする。
