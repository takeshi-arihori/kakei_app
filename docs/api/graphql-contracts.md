# GraphQL Operation契約

## 目的と正本境界

このcatalogは、実装済みのtop-level GraphQL OperationをUse Case、認可、失敗、TestへTraceする。GraphQL Type、Field、Input、Resultの構造は[`apps/api/schema.graphql`](../../apps/api/schema.graphql)を正本とし、この文書へSDLを複製しない。

OperationをSchemaへ追加・変更・削除するTaskは、同じ差分で対応entryとTest参照を更新する。未実装Operationを先行記載せず、未決の認証Provider、公開Error code、Pagination、Complexity、Rate limitは`Proposed`または`Open Question`として明示し、Accepted扱いしない。

Knowledge Stateは次の3値だけを使う。

- `Confirmed`: 現行Schema、実装、TestまたはAccepted Decisionで確認できる
- `Proposed`: TaskまたはADRで提案中であり、現行契約ではない
- `Open Question`: 判断根拠またはOwner Decisionが不足している

各`Query.<field>`／`Mutation.<field>` entryには、`Context`、`Use Case`、`Actor`、`Authorization`、`Input`、`Result`、`Error`、`Idempotency`、`Concurrency / Retry`、`Compatibility`、`Schema`、`Implementation`、`Test`を1件ずつ記載する。

## Query.apiStatus

- Knowledge State: Confirmed
- Context: Shared API。業務Bounded Contextに属さない疎通確認
- Use Case: ClientがGraphQL endpointの疎通状態を確認する
- Actor: 現行のGraphQL transportへ到達できるClient。本人性は要求しない（認証leaseを開かない未認証field）
- Authorization: 業務認可なし。共通GraphQL境界のRequest前提（`X-Kakei-Request: 1`、Originは存在すれば設定Originと完全一致、`Sec-Fetch-Site`は存在すれば`same-origin`）だけを満たす（[業務GraphQLの認証境界ADR](../adr/business-graphql-authentication-boundary.md)）
- Input: 引数なし。HTTP request envelopeは[`openapi.yaml`](openapi.yaml)を参照する
- Result: `ApiStatus!`を返す。Type／Field構造はSchemaを参照する
- Error: Operation固有の業務Errorはない。構文・検証・上限違反は[入口制限](#入口制限)の`INVALID_REQUEST`（400）、Request前提（`X-Kakei-Request`・Origin・`Sec-Fetch-Site`）の違反は403＋`REQUEST_REJECTED`。予期しないErrorは`NODE_ENV`に関係なく`SERVICE_UNAVAILABLE`へmaskし、`originalError`を出さない。公開Errorは8 code・固定文・requestIdだけ
- Idempotency: 状態を変更しないQueryで、operation IDまたはidempotency keyを使用しない
- Concurrency / Retry: 共有状態を変更しないため同じQueryを再実行できる。再試行Policyは採用していない
- Compatibility: Field名またはResult型の変更はSDL変更としてReviewする。Versioning方針は未決であり、このentryでは採用しない
- Schema: [`apps/api/schema.graphql`](../../apps/api/schema.graphql)
- Implementation: [`resolvers.ts`](../../apps/api/src/presentation/graphql/resolvers.ts)
- Test: [`app.spec.ts`](../../apps/api/src/app.spec.ts)、[`graphql-entry-authentication.spec.ts`](../../apps/api/src/presentation/graphql/graphql-entry-authentication.spec.ts)

## 入口制限

- Knowledge State: Confirmed（[Accepted ADR](../adr/graphql-entry-hardening.md)、#293・#316）
- 全Operationに共通の実行前検査。Operation entryへ個別に複製しない
- Transport: POST＋`application/json`の単一Operationだけ。GET・batch・`extensions`・GraphiQL・introspection（`__typename`は許可）は受け付けない。HTTP statusとBody上限は[`openapi.yaml`](openapi.yaml)を参照する
- 上限: token 1,000、深さ5、alias 5、top-level field 5、認証付きtop-level field 1、Mutationのtop-level field 1、directive 10。文書内のすべてのOperationに適用する
- 認証付きfield: 未認証で公開するroot fieldの許可List（[`graphql-entry.ts`](../../apps/api/src/presentation/graphql/graphql-entry.ts)の`PUBLIC_ROOT_FIELDS`、現在は`Query.apiStatus`だけ）にないroot field。Operationを追加するTaskは、未認証で公開する場合だけ許可Listへ足す
- Error: 違反は`{ errors: [{ message, extensions: { code: 'INVALID_REQUEST', requestId } }] }`（`data`なし、固定message）。全Compositionで同じ形
- Complexity: 導入しない。引数付きPagination・ネストList・Context横断fieldを追加するTaskでCost分析の要否を判定する
- Test: [`graphql-request-body.spec.ts`](../../apps/api/src/presentation/graphql/graphql-request-body.spec.ts)、[`graphql-document-limits.spec.ts`](../../apps/api/src/presentation/graphql/graphql-document-limits.spec.ts)、[`graphql-entry.spec.ts`](../../apps/api/src/presentation/graphql/graphql-entry.spec.ts)、[`app.spec.ts`](../../apps/api/src/app.spec.ts)

## Open Questions / Gate

- Group Management、Expense Recording、Settlementの公開Operationは、対応Use Case、本人性、認証認可、公開Error契約がReadyになったTaskで追加する
- 業務Operationの本人性（Operation単位の認証lease）、Origin・CSRF、公開Error code 8種、存在非開示の公開形（`NOT_FOUND`の同一化）、no-storeは[業務GraphQLの認証境界ADR](../adr/business-graphql-authentication-boundary.md)でAcceptedとなり、共通境界は#317で実装済み。業務Operationへの適用は各公開Task（#312ほか）で`Confirmed`にする
- Pagination、N+1は未決または別Taskの対象である。Complexityは[入口制限](#入口制限)のReview Triggerで判定する。Rate limitはProduction Gate（同ADR Decision 6）
- 未決事項をこのcatalogだけでAcceptedにせず、必要なDecisionと実装Evidenceが揃うまで`Confirmed`にしない

関連Task: [#142](https://github.com/takeshi-arihori/kakei_app/issues/142)
