# Backend開発ルール

この文書は`apps/api`の静的な実装ルールを定める。Repository全体の入口はルート`AGENTS.md`、DDDの判断基準は[domain-design.md](domain-design.md)、テスト方針は[testing.md](testing.md)を正本とする。

## レイヤと依存方向

実装パターンに応じて必要なレイヤ数を決める。

- Transaction Script / Active Record: 3層を許容する。`Presentation -> Application / Business Logic -> Infrastructure / Data Access`を基本とする。
- Domain Model / Event History Domain Model: 4層を必須とする。`Presentation -> Application -> Domain <- Infrastructure`の依存方向を守る。
- 実装パターンは既存Directory構成から逆算せず、業務Rule、Invariant、Lifecycle、履歴要件から判断する。
- 未利用Layerの空Directoryを先行作成しない。Context固有のPresentation／Infrastructureも、Accepted済みTaskで利用を開始するときに追加する。

4層を採用するContextでは次の責務を守る。

- `src/<context>/domain`: Aggregate、Entity、Value Object、Domain Service、Domain Event、不変条件を持つ。
- `src/<context>/application`: Use Caseの順序、認可、Transaction境界、Port呼出しを調整する。
- `src/<context>/presentation`: Context固有の認証Guard、Input／Output変換、Command／Query呼出しだけを行う。
- `src/<context>/infrastructure`: Prisma、PostgreSQL、Firestore、KMS、Email、OAuthなどのAdapterを実装する。
- `src/shared/domain`: 複数Contextで意味と変更理由が一致するDomain型だけを置く。
- `src/presentation/graphql`: GraphQL Schemaの読込、生成型、Context ResolverのCompositionなどTransport全体の共通処理だけを置く。Context固有のResolver、Input／Output変換、GraphQL認証・認可Adapterは`src/<context>/presentation/graphql`へ置く。
- DomainからHono、GraphQL、Prisma、Cloud SDKをImportしない。
- ApplicationはPortへ依存し、Infrastructureが内向きにPortを実装する。
- Resolverへ業務Rule、Repository呼出しの組立、個別の例外変換を散在させない。
- Group Management固有のPresentationを共通`src/presentation/graphql`へ置かない。
- Expense Recording／Settlementは、Accepted済みの実装Taskへ着手するときにContext Directoryを追加する。
- `architecture-dependencies.spec.ts`でLayer逆転、Context横断、解決不能、ProductionからTestへの依存を検出する。

## Domain・Applicationの配置

概念をEntity、Value Object、Aggregate、Domain Serviceへ分類する基準は[domain-design.md](domain-design.md)に従う。Directory名からDomain Modelを逆算しない。

- Aggregate RootはAggregateの外部入口となり、不変条件を守る追加責務を持つEntityとして扱う。RepositoryはRootを通してAggregateを保存・復元する。
- Aggregate Rootは`src/<context>/domain/<aggregate-root>.ts`の1 Moduleとして扱い、`entities/`へ同一Typeを重複配置しない。
- 独立したIdentityとLifecycleを持つ新規または個別Refactor対象のChild Entityは`src/<context>/domain/entities/`へ置く。
- 値で比較し、生成時に妥当性を保証する新規または個別Refactor対象のImmutableなValue Objectは`src/<context>/domain/value-objects/`へ置く。
- 既存Moduleは、この配置ルールを理由に別Taskなしで移動しない。
- Domain Service、Domain Event、不変条件固有Typeは凝集度に応じて`domain/`直下または責務を限定したSubdirectoryへ置き、分類目的だけの空Directoryを作らない。
- Use CaseはApplication Layerへ置く。新規または個別Refactor対象の業務操作の入口は`src/<context>/application/use-cases/`を基本とする。
- 既存のApplication Serviceは専用Refactor Taskまで維持する。Port、Policy、Coordinatorは名前と責務を明確にし、独立した変更理由または利用者を持つ場合に分割する。

## Event・永続化

Event Sourcing、CQRS、Projection、Outboxの採否と適用範囲は[domain-design.md](domain-design.md)およびAccepted ADRを正本とする。未確定DecisionをDirectory、Schema、Event、Repositoryの存在によって採用済みと解釈しない。

- Event Sourcingを採用したAggregateでは`decide`と`evolve`／`apply`を分離し、Aggregate内でI/O、現在時刻取得、乱数生成を行わない。
- Domain Event、Stored Event、Integration Event、Audit Log、Outbox Messageを同一型にしない。
- Event Storeを採用する場合は`expectedVersion`で競合を検出し、Accepted ADRが要求するAtomicityを守る。
- 技術的Snapshotを業務上のSnapshot Revisionと混同しない。

## テスト

テスト全体の正本は[testing.md](testing.md)とする。Backendでは特に次を確認する。

- Domain RuleはDB、Hono、GraphQLを使わないUnit Testから始める。
- 採用済みのRepository、Migration、Event Store、Projection、Outbox、冪等性は実PostgreSQLまたは合意した分離環境でIntegration Testする。
- GraphQLでは認証、認可、Validation、Error契約、Pagination、Depth／Complexity、N+1、Schema差分を確認する。
- Critical BranchのCoverage目標は[testing.md](testing.md)に従う。
