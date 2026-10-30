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
- `src/shared/application`: API内で共有する技術契約の型・Portを置く。用途別Digestの契約を含み、業務Modelや具体暗号実装を置かない。他の共有Applicationだけを参照し、外部ModuleやContext内部へ依存しない。
- `src/shared/application/authentication`: [認証ADR](../adr/google-login-actor-session.md)と[内部Lifecycle契約](../security/google-authentication-lifecycle.md)に従うログイン試行・Actor対応・Sessionの技術Use CaseとPortを置く。Google本人確認は既存Verifier Portへ委譲し、Cookie／Transport、DB／暗号・Audit Adapter、Group Participant／Role／認可を混在させない。Clock／Entropy／原子的StoreをPortとして受け、Test-only StoreをProductionへ配置しない。新業務Contextや独立Packageを追加しない。
- `src/shared/infrastructure/protected-record`: APIの保存Adapterが使うCanonical AADとNode.js標準暗号のWrapperを置く。共有Infrastructure／共有Applicationへ依存でき、外部依存は採用済みの`node:crypto`だけを許可する。Context内部、Domain、Presentationへ依存しない。
- `src/shared/infrastructure/authentication/google-id-token-verifier.ts`: Google公式SDKによるIDトークン検証Adapterを置く。この正確なPathからの`google-auth-library`本体参照だけを追加許可し、他Module／Layer・SDK内部subpathを拒否する。新業務Contextや独立Packageは追加しない。入力／結果Portは共有Applicationに置き、SDK、Session、Actor登録、Group認可を混在させない。[技術契約](../security/google-id-token-verification.md)の検証・Error・通信境界を守る。protected-recordの外部依存許可を広げない。
- `src/shared/infrastructure/authentication`の認証暗号部品は[A2](../security/authentication-protected-storage.md)と[暗号README](../../apps/api/src/shared/infrastructure/authentication/README.md)に従い、認証専用Row Binding／strict Payload／AES-256-GCM／用途別HMACを所有する。暗号Moduleは採用済み`node:crypto`を使い、Port・保存型は共有Applicationに置く。鍵／Nonceは認証専用Provider Portから取得し、Actor登録・認可・Transaction・Audit insert・現在時刻判断・具体Cloud Providerを混在させない。Group用Codecを偽Group IDで流用せず、Test-only ProviderをProductionから参照しない。
- 認証の清掃／削除／Restoreは[保守契約](../security/authentication-maintenance.md)に従い、共有Applicationへ純粋Retention Policy／再試行Coordinator／opaque証跡Portを置く。専用Ledger HMAC／chain検証は認証Infrastructure、Lock／CAS／隔離移行はpostgresへ置く。通常Storeの許可状態を広げず、具体Provider・Scheduler・HTTP・退会認可を混在させない。
- Context Applicationは共有Applicationを、Context Infrastructureは共有Application／共有Infrastructureを参照できる。Domain・Presentationから共有技術基盤への参照、Applicationから共有Infrastructureへの参照を許可しない。複数Contextでの利用だけを理由に独立Packageを追加しない。
- `src/shared/infrastructure/authentication/postgres/`は[Store README](../../apps/api/src/shared/infrastructure/authentication/postgres/README.md)に従い、同一接続の認証保存・Audit・Scope leaseを所有する。このPath以下だけが共有Infrastructureから`pg`本体を参照でき、Application・認証暗号・他の共有Module・pg内部subpathへ許可を広げない。Callbackは共有ApplicationのScopeで本文handleを確定し、参加Repositoryへquery限定能力だけを渡す。Transaction所有・受付終了・commit／rollback・接続解放は参加能力に含めない。具体Provider・HTTP・業務Repository wiringを混在させない。
- `src/presentation/graphql`: GraphQL Schemaの読込、生成型、Context ResolverのCompositionなどTransport全体の共通処理だけを置く。Context固有のResolver、Input／Output変換、GraphQL認証・認可Adapterは`src/<context>/presentation/graphql`へ置く。
- DomainからHono、GraphQL、Prisma、Cloud SDKをImportしない。
- ApplicationはPortへ依存し、Infrastructureが内向きにPortを実装する。
- Resolverへ業務Rule、Repository呼出しの組立、個別の例外変換を散在させない。
- Group Management固有のPresentationを共通`src/presentation/graphql`へ置かない。
- Expense Recording／SettlementのDomainは実装済みである。未実装のApplication／Presentation／Infrastructureは、Accepted済みの個別Taskで必要になったときに追加する。
- `architecture-dependencies.spec.ts`でLayer逆転、Context横断、解決不能、ProductionからTestへの依存を検出する。

## Context別4層と共通入口の実装状況

確認基準はdevelop [`bc7ab5b9c4a3b794e255f8ce05dcd5f42135de1c`](https://github.com/takeshi-arihori/kakei_app/commit/bc7ab5b9c4a3b794e255f8ce05dcd5f42135de1c)を基点とする[#218](https://github.com/takeshi-arihori/kakei_app/issues/218)の認証HTTP・共有Rate・専用開発Composition追加後の差分（2026-10-23確認、以下の全表に適用）。2026-10-19の配置整理時はdevelop `c12ea1ef031e51de3ff2cec8793579212eb2ce6e`を確認したが、#218の追加を含む現在の実装状況とは区別する。Pathは特記しない限り`apps/api/`からの相対Pathである。これは配置と内部実装の確認であり、各機能の完了判定ではない。

4層は責務と依存方向を表す。4つのDirectoryが揃っていることや、Domain／Adapterが存在することを公開Use Caseの完成条件にしない。次の「実装済み」は記載した内部部品の存在を指す。「未実装」のPathは設計上の予定であり、現時点では存在しない。利用開始前に空Directoryを作らない。

### 業務Contextの4層

| Context | Layer | 実在Path・主要Code、または予定Path | 実装状況と責務 |
| --- | --- | --- | --- |
| Group Management | Domain | [`src/group-management/domain/`](../../apps/api/src/group-management/domain)、[`group.ts`](../../apps/api/src/group-management/domain/group.ts)、[`group-value-objects.ts`](../../apps/api/src/group-management/domain/group-value-objects.ts) | 実装済み。Group RootとParticipant／Invitation、Owner・参加・終了等の不変条件と値を所有する。 |
| Group Management | Application | [`src/group-management/application/`](../../apps/api/src/group-management/application)、[`group-command-service.ts`](../../apps/api/src/group-management/application/group-command-service.ts)、[`group-repository.ts`](../../apps/api/src/group-management/application/group-repository.ts)、[`group-close-coordinator.ts`](../../apps/api/src/group-management/application/group-close-coordinator.ts)、[`use-cases/`](../../apps/api/src/group-management/application/use-cases) | 実装済み。内部Command、認可Policy・再送・終了調整・保持期限削除とPortを所有する。#241の[`RegisteredRecipientInvitationService`](../../apps/api/src/group-management/application/use-cases/registered-recipient-invitation-service.ts)と[参加Port契約](../../apps/api/src/group-management/application/README.md)はfakeで内部調整を検証済み。実保存/共通消費は#242/#243、公開経路は未接続。 |
| Group Management | Infrastructure | [`src/group-management/infrastructure/postgres/`](../../apps/api/src/group-management/infrastructure/postgres)、[`group-repository.ts`](../../apps/api/src/group-management/infrastructure/postgres/group-repository.ts)、[`group-management-retention-adapter.ts`](../../apps/api/src/group-management/infrastructure/postgres/group-management-retention-adapter.ts) | 実装済み。ApplicationのPortをPostgreSQL保存・読取・原子的更新・削除へ適合する。公開経路へ未接続。 |
| Group Management | Presentation | 予定: `src/group-management/presentation/graphql/`（未作成） | 未実装。Context固有Resolver／認証・認可Adapter／Input・Output変換の配置先。 |
| Expense Recording | Domain | [`src/expense-recording/domain/`](../../apps/api/src/expense-recording/domain)、[`group-expense.ts`](../../apps/api/src/expense-recording/domain/group-expense.ts)、[`receipt.ts`](../../apps/api/src/expense-recording/domain/receipt.ts)、[`category.ts`](../../apps/api/src/expense-recording/domain/category.ts) | 実装済み。Group Expense／Receipt／Category Root、整数配賦、Bundle・訂正・不変履歴等の内部Rule。Domainへ渡すfactsは実本人性・現在認可・実保存の証拠ではない。 |
| Expense Recording | Application | 予定: `src/expense-recording/application/`（未作成） | 未実装。実Source・Group状態・認可の取得とUse Case調整、共通保存・競合・再送等は後続Task。 |
| Expense Recording | Infrastructure | 予定: `src/expense-recording/infrastructure/`（未作成） | 未実装。採用済み契約に基づく具体保存Adapter等を後続Taskで追加する。 |
| Expense Recording | Presentation | 予定: `src/expense-recording/presentation/graphql/`（未作成） | 未実装。Context固有Resolverと入出力変換の配置先。 |
| Settlement | Domain | [`src/settlement/domain/`](../../apps/api/src/settlement/domain)、[`settlement-case.ts`](../../apps/api/src/settlement/domain/settlement-case.ts)、[`entities/`](../../apps/api/src/settlement/domain/entities)、[`value-objects/`](../../apps/api/src/settlement/domain/value-objects)、[`payment-instruction-derivation.ts`](../../apps/api/src/settlement/domain/payment-instruction-derivation.ts) | 実装済み。Settlement Case Root、不変Snapshot Revision、支払Attempt・取消要求、残高・支払指示導出等の内部Rule。公開Use Caseや実保存は含まない。 |
| Settlement | Application | 予定: `src/settlement/application/`（未作成） | 未実装。Source選択・実認可・予約と精算の原子的更新等を調整するUse Caseは後続Task。 |
| Settlement | Infrastructure | 予定: `src/settlement/infrastructure/`（未作成） | 未実装。具体Portと保存・競合等の契約を確認して追加する。 |
| Settlement | Presentation | 予定: `src/settlement/presentation/graphql/`（未作成） | 未実装。Context固有Resolverと入出力変換の配置先。 |

予定Pathは配置規約を示すもので、個別TaskのReadyや未決契約の採用を意味しない。残る具体Port、実認可、保存・運用等のDecision／実装境界は[設計Gate](../product/design-gates.md)と各Taskで確認する。

### shared・共通GraphQL・Composition入口

`shared`は第4の業務Contextではない。共有Domainの意味と、共有Application／Infrastructureの技術責務を分ける。共通GraphQL入口は`shared/presentation`へ移さない。

| 実在Path・主要Code | 責務と現在の接続状況 |
| --- | --- |
| [`src/shared/domain/money.ts`](../../apps/api/src/shared/domain/money.ts) | 複数Contextで使うJPY金額のValue Object。業務Context固有のRuleを集める場所ではない。 |
| [`src/shared/application/`](../../apps/api/src/shared/application)、[`authentication/google-authentication-service.ts`](../../apps/api/src/shared/application/authentication/google-authentication-service.ts)、[`authentication/authentication-ports.ts`](../../apps/api/src/shared/application/authentication/authentication-ports.ts) | 用途別Digest・Google検証契約、ログイン試行／Actor／Sessionの内部技術Use CaseとPort。HTTP／Cookie・Group Roleとは分離する。#218の認証HTTP Adapterから呼ばれ、専用開発入口だけが実Storeへ接続する。通常mainの本番接続は未有効。 |
| [`src/shared/application/authentication/`](../../apps/api/src/shared/application/authentication)の[`authentication-retention-policy.ts`](../../apps/api/src/shared/application/authentication/authentication-retention-policy.ts)、[`authentication-cleanup-service.ts`](../../apps/api/src/shared/application/authentication/authentication-cleanup-service.ts)、[`authentication-deletion-service.ts`](../../apps/api/src/shared/application/authentication/authentication-deletion-service.ts)、[`authentication-restore-service.ts`](../../apps/api/src/shared/application/authentication/authentication-restore-service.ts) | 認証の期限Policy・清掃・削除再開・Restore Coordinatorと証跡Port。Schedulerや退会受付を実装済みとしない。 |
| [`src/shared/infrastructure/protected-record/`](../../apps/api/src/shared/infrastructure/protected-record)、[`authentication/google-id-token-verifier.ts`](../../apps/api/src/shared/infrastructure/authentication/google-id-token-verifier.ts)、[`authentication/`](../../apps/api/src/shared/infrastructure/authentication) | 保存用暗号Wrapper、Google公式SDK Adapter、認証専用Codec／Digest／Ledger検証。業務Modelや認可、具体Cloud Providerの所有先ではない。 |
| [`src/shared/infrastructure/authentication/postgres/`](../../apps/api/src/shared/infrastructure/authentication/postgres)、[`postgres-authentication-store.ts`](../../apps/api/src/shared/infrastructure/authentication/postgres/postgres-authentication-store.ts)、[`postgres-authentication-cleanup.ts`](../../apps/api/src/shared/infrastructure/authentication/postgres/postgres-authentication-cleanup.ts)、[`postgres-authentication-deletion.ts`](../../apps/api/src/shared/infrastructure/authentication/postgres/postgres-authentication-deletion.ts)、[`postgres-authentication-restore.ts`](../../apps/api/src/shared/infrastructure/authentication/postgres/postgres-authentication-restore.ts) | 認証Store・同Transaction Audit・Scope lease、および保守用のLock／CAS／隔離移行Adapter。#218の専用開発Compositionが認証Storeを接続する。本番Providerは未接続。[Store README](../../apps/api/src/shared/infrastructure/authentication/postgres/README.md)を参照。 |
| [`src/presentation/graphql/schema.ts`](../../apps/api/src/presentation/graphql/schema.ts)、[`generated/resolvers.ts`](../../apps/api/src/presentation/graphql/generated/resolvers.ts)、[`resolvers.ts`](../../apps/api/src/presentation/graphql/resolvers.ts) | SDL読込・Schema組立、生成型、Transport全体のResolver集約の入口。現行Resolverは`Query.apiStatus`のみで、Context Resolverの集約は今後の接続時に行う。 |
| [`src/app.ts`](../../apps/api/src/app.ts) | HonoとYogaを組み、`/health`と`/graphql`を提供する。4認証HTTP経路は注入能力へ委譲し、不在なら503で封鎖する。業務Use Case/Repositoryは組み立てない。 |
| [`src/main.ts`](../../apps/api/src/main.ts) | `createApp`をNode HTTP Serverへ渡し、Port・終了Signalを扱う起動入口。具体業務／認証Adapterを生成・注入していない。 |
| [`src/presentation/http/authentication/`](../../apps/api/src/presentation/http/authentication) | #218の共有認証HTTP境界。Origin/JSON/Cookie/公開Errorを所有し、認証Application/HTTP Portだけを使う。GraphQLへ認証Mutationを追加しない。 |
| [`dev/`](../../apps/api/dev)、[`authentication-development-runtime.ts`](../../apps/api/dev/authentication-development-runtime.ts) | localhost限定の使い捨て開発Composition。実SDK/pg Store/共有Rateを組み、専用DB・単一process lease・非空拒否を適用する。Production build/通常mainから除外する。 |

2026-10-19の旧基準Commitには[PR #228](https://github.com/takeshi-arihori/kakei_app/pull/228)の認証保守Codeが含まれる。その時点で[#217](https://github.com/takeshi-arihori/kakei_app/issues/217)に残ったActor MAC世代移行のMajorは、2026-10-21の追補で、旧公開読取集合への所属と旧MACを世代切替前に検証し、現行MAC世代へCASするよう修正した。新しい読取集合に旧MAC世代を含めない正常移行と、改竄旧MACおよび旧公開集合の世代外MACの拒否・rollbackを実DBで検証する契約は[保守仕様](../security/authentication-maintenance.md)に従う。修正は[PR #230](https://github.com/takeshi-arihori/kakei_app/pull/230)で統合済みであり、過去の未完了記録と修正・評価結果は#217で追跡する。[本番Capability](../operations/authentication-retention-restore.md)と本番公開接続は引き続き別Gateである。

### PortとResolverの依存例

[`GroupCommandService`](../../apps/api/src/group-management/application/group-command-service.ts)はコンストラクタでApplicationの[`GroupRepository`](../../apps/api/src/group-management/application/group-repository.ts)を受け、`load`／`findOperation`／`commit`を通じてDomainのGroupと期待版・再送結果を扱う。[`PostgresGroupRepository`](../../apps/api/src/group-management/infrastructure/postgres/group-repository.ts)がそのInterfaceを`implements`し、具体SQL・Transaction・暗号化保存を担う。PortがApplicationにあることは4層への違反ではない。ApplicationがPostgreSQL実装をImportする必要はなく、具体Adapterの選択・注入はCompositionの責務である。現行`app.ts`／`main.ts`にはこの接続がない。

Context固有Resolverを追加するときの配置例は`src/group-management/presentation/graphql/resolvers.ts`（予定）である。そこでInputをApplicationのCommandへ変換し、ResultをGraphQL Outputへ変換する。`src/presentation/graphql/resolvers.ts`はそれらを集約する共通入口とし、業務RuleやRepository呼出しの組立を持たせない。

許可する主なローカルImportを、既存の[Architecture Test](../../apps/api/src/architecture-dependencies.spec.ts)に対応させる。同一Context内の依存が基本であり、別Contextの内部Moduleを直接Importしない。

| 参照元 | 許可する参照先 |
| --- | --- |
| Context Domain | 同Context Domain、shared Domain |
| Context Application | 同Context Application／Domain、shared Domain／Application |
| Context Presentation | 同Context Presentation／Application、共通GraphQLの生成型 |
| Context Infrastructure | 同Context Infrastructure／Application／Domain、shared Application／Infrastructure |
| shared Domain / Application / Infrastructure | Domainはshared Domainのみ、Applicationはshared Applicationのみ、Infrastructureはshared Application／Infrastructureのみ |
| 共通GraphQL | 共通GraphQL、各Context Presentation。Context Application／Domain／Infrastructureを直接参照しない |
| 認証HTTP | 同じ認証HTTP Presentationと`shared/application/authentication`だけ。具体SDK/pg/cryptoと業務Contextへ依存しない |
| `dev/` | 専用開発Composition。分類済みProduction Moduleと開発Moduleを組み立て、Testへの参照を禁止する。ProductionからのImportも禁止する |
| `app.ts` / `main.ts` | 分類済みのProduction Moduleを組み立てる入口。ProductionからTest/開発Moduleへの参照禁止は適用される |

外部Moduleの許可は上段のLayer RuleとArchitecture Testに従う。特にGoogle SDKは指定Verifierの本体参照だけ、共有基盤からの`pg`本体は認証postgres配下だけを許可する。接続PeerのIP解析用`node:net`はHTTP共有Rate Adapterの正確なPathだけに追加許可する。生成型を参照できることは、共通Resolver実装への逆依存を許可する意味ではない。

### 公開段階・不整合の確認と更新契機

現行[SDL](../../apps/api/schema.graphql)、[Resolver](../../apps/api/src/presentation/graphql/resolvers.ts)、[Operation catalog](../api/graphql-contracts.md)を照合すると、公開GraphQL Operationは`Query.apiStatus`のみでMutationはない。Group／支出／精算の内部Domain、Group Applicationや保存Adapter、共有認証の存在だけでは、公開業務機能の完成や本人性・認可の本番接続を意味しない。

Architecture Testは、Productionと独立した開発CompositionのTypeScript配置分類と静的なImport／Export／require／dynamic importを解析し、Layer逆転・Context横断・解決不能参照・ProductionからTestへの依存・解析不能な動的Import・限定した外部依存の違反を検出する。Test ModuleとGraphQL生成Module自体はProduction走査から除外する。2026-10-19の配置整理時は1 File／82件passであり、#218ではHTTP/開発/限定IP解析の拒否例を追加し、1 File／85件を検証する。この結果は責務の意味的妥当性、業務Rule、全Layerの完成、実際のDI／公開経路、認証安全性・本番運用の保証ではない。

配置・依存の照合では、実在するContext／shared／共通入口が既存Ruleに収まり、Architecture Testにも違反がないため、Code移動・新Layer・境界変更は不要と判断した。一方、従来の「Expense Recording／SettlementのContext Directoryを今後追加する」という説明は既存Domainと不一致だったため、上段のRuleと本表を同期した。共通GraphQLとContext固有Presentationの区別もここで補足した。既存の[#63](https://github.com/takeshi-arihori/kakei_app/issues/63)（再配置）、[#107](https://github.com/takeshi-arihori/kakei_app/issues/107)（全量Review）、[#142](https://github.com/takeshi-arihori/kakei_app/issues/142)（Operation Trace）を再実施しない。

残る公開接続は既存の[#202](https://github.com/takeshi-arihori/kakei_app/issues/202)（認証・Group招待）、[#218](https://github.com/takeshi-arihori/kakei_app/issues/218)（認証HTTP）、[#219](https://github.com/takeshi-arihori/kakei_app/issues/219)（Google画面）、[#92](https://github.com/takeshi-arihori/kakei_app/issues/92)（公開契約）等へTraceする。具体Port・保存契約や本番Provider／業務HTTP接続の未決Decisionは[設計Gate](../product/design-gates.md)に従い、[#12](https://github.com/takeshi-arihori/kakei_app/issues/12)のAPI方式／Runtime比較も採用済みとはしない。#217の復旧MAC移行の旧Findingと修正・検証結果は同Taskで追跡する。配置説明の整備を理由に重複Issueや無関係なProduction修正を増やさない。新しい配置不整合や別の修正候補が見つかった場合は、根拠・既存Taskとの重複・必要Decisionを別Planningで確認する。

Context／Layer／共有基盤の追加・移動・責務変更、Resolver／Use Case／Adapterのwiring、公開Operationの追加・削除を行うTaskは、同じ差分で本節の実在／予定Path、実装状況、確認基準Commit、API入口の参照を同期する。文書統合直前にも最新developと再照合する。公開Operationは[Operation catalog](../api/graphql-contracts.md)も同時更新し、未決事項を実装済みへ昇格させない。

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

### #218の認証HTTP接続基準

基点develop `bc7ab5b9c4a3b794e255f8ce05dcd5f42135de1c`に対し、#218は前述のHTTP Adapter/共有Rateと専用開発Compositionを追加する。Webの同一Origin転送は`apps/web/app/auth/[...path]/route.ts`がdevelopmentだけで固定loopbackへ行い、Productionでは503を返す。通常API main、業務GraphQL、業務認可、本番Providerを有効化しない。Taskの最終検証・4専門Review・PR結果はIssue #218を参照する。

## 招待コード保存の採用設計（未実装）

[Task #233の設計](../security/invitation-code-lifecycle.md)は共有認証技術によるコードRecord所有、GMによるInvitation/operation所有、専用本人性leaseとGMのquery限定Scope参加を定める。既存withSession/GroupRepositoryを順番に呼んでも原子性は成立しない。

これは2026-10-27にOwnerが承認した[詳細設計ADR](../adr/invitation-code-lifecycle-and-protected-storage.md)であり、実装済みのLayer/保存形式を変更するものではない。承認同期のdevelop統合と個別Ready後、共有認証からGMへのimport、GMから認証TableへのSQL依存、Applicationへのpg/crypto露出を加えずに実装する。公開HTTP/OpenAPI/GraphQL/Composition接続とProduction有効化は別Gate。
