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

## Mutation.createGroup

- Knowledge State: Confirmed
- Context: Group Management（[Group一覧ADR](../adr/group-create-and-my-group-list-contract.md) §1、#312）
- Use Case: ログインした本人がGroupを作成し、作成者が最初のActive ParticipantかつOwnerになる（`GroupCommandService.createGroup`）
- Actor: 認証lease（`activity`）の`actorSubject`だけ。Inputに`actorSubject`・Role・Participantを持たせない
- Authorization: 業務GraphQLの共通境界（`X-Kakei-Request`、一致Origin必須、canonical形式の`X-CSRF-Token`、lease内のSession束縛CSRF照合。[業務GraphQLの認証境界ADR](../adr/business-graphql-authentication-boundary.md)）を通った本人なら作成できる。Group単位の認可はない
- Input: `CreateGroupInput.operationId`だけ。小文字canonicalのUUIDv4以外は、本人性とCSRFを確かめた後にUse Caseを呼ばず`INVALID_INPUT`
- Result: `CreateGroupResult.groupId`だけ。`participantId`・`version`は返さない
- Error: `AUTHENTICATION_REQUIRED`、`REQUEST_REJECTED`、`INVALID_INPUT`、`OPERATION_MISMATCH`（同じ`operationId`を別Commandで使用済み）、`SERVICE_UNAVAILABLE`（`UNAVAILABLE`、`GROUP_ALREADY_EXISTS`、その他のApplication Error、想定外例外、業務commit後の認証commit失敗による結果不明、Use Case未注入）。写像は[`group-public-error.ts`](../../apps/api/src/group-management/presentation/graphql/group-public-error.ts)の1 Module。構文・検証違反（未知のInput field等）は[入口制限](#入口制限)の`INVALID_REQUEST`
- Idempotency: 同じActor・同じ`operationId`の再送は最初と同じ`groupId`を返す（Use Caseの既存再送照合）。別のActorには結果を返さず、再送の成功は一覧の閲覧権限を与えない
- Concurrency / Retry: Clientは作成の1回の意図ごとに`crypto.randomUUID()`で生成し、結果不明（`SERVICE_UNAVAILABLE`、通信断）では同じ値で再送する。成功または確定Errorの後は破棄する
- Compatibility: 結果へのGroup要約の追加は互換的に行える。Field名・型の変更はSDL変更としてReviewする
- Schema: [`apps/api/schema.graphql`](../../apps/api/schema.graphql)
- Implementation: [`group-management-resolvers.ts`](../../apps/api/src/group-management/presentation/graphql/group-management-resolvers.ts)、[`group-graphql-mapping.ts`](../../apps/api/src/group-management/presentation/graphql/group-graphql-mapping.ts)、[`use-case-inputs.ts`](../../apps/api/src/group-management/application/use-case-inputs.ts)。Use Caseは`createApp`の`groupManagement`へ注入する（開発Compositionへの注入は#314）
- Test: [`group-management-graphql.spec.ts`](../../apps/api/src/group-management/presentation/graphql/group-management-graphql.spec.ts)（Fakeの認証能力とUse Case）、[`app.spec.ts`](../../apps/api/src/app.spec.ts)。実DBでの作成と再送は#314
- Web Client（#315）: BrowserのClient Componentが同一Originの`/graphql`（[`app/graphql/route.ts`](../../apps/web/app/graphql/route.ts)、developmentだけ固定loopbackへ転送）へ送る。CSRF Tokenは`/auth/session`から得る。操作IDの保持と再送は[`group-creation-controller.ts`](../../apps/web/src/features/groups/group-creation-controller.ts)、送信は[`create-group-client.ts`](../../apps/web/src/features/groups/graphql/create-group-client.ts)。Server Actionsは使わない

## Query.myGroups

- Knowledge State: Confirmed
- Context: Group Management（[Group一覧ADR](../adr/group-create-and-my-group-list-contract.md) §2〜§4、#308・#312）
- Use Case: ログインした本人が、いま参照できる自分のGroupを一覧で確認する（`MyGroupQueryService.listMyGroups`）
- Actor: 認証lease（`activity`）の`actorSubject`だけ。引数なし
- Authorization: 業務GraphQLの共通境界（`X-Kakei-Request`、Originは存在すれば一致、CSRF不要）を通った本人。一覧の対象と再認可（Archived以外は自分のActive Participant、ArchivedはownerAtArchiveだけ）はApplicationが行う
- Input: なし
- Result: `MyGroupList`（`items`と`hasMore`）。各要素は`groupId`、`lifecycle`（ACTIVE／CLOSING／CANCELING／ARCHIVED）、`myRole`（OWNER／PARTICIPANT）、`activeParticipantCount`、`createdAt`、`joinedAt`、`deleteEligibleAt`（Archivedだけ値あり）。時刻はRFC 3339 UTC（ミリ秒）。作成の新しい順（同時刻は`groupId`昇順）に最大50件。空は`items: []`・`hasMore: false`
- Error: `AUTHENTICATION_REQUIRED`、`REQUEST_REJECTED`、`SERVICE_UNAVAILABLE`（読取障害、Application Error、写像できない値、想定外例外、Use Case未注入。一部だけは返さない）。非在籍のGroupは含まれないだけで、`NOT_FOUND`を使わない
- Idempotency: 状態を変更しないQuery。認証leaseのidle延長だけが起こる
- Concurrency / Retry: 同じQueryを再実行できる。読取の固定版照合は読取Port（#310）が行う
- Compatibility: cursor pagination（`after`引数と`endCursor`）は後から互換的に追加できる。Group名等の表示属性は未提供
- Schema: [`apps/api/schema.graphql`](../../apps/api/schema.graphql)
- Implementation: [`group-management-resolvers.ts`](../../apps/api/src/group-management/presentation/graphql/group-management-resolvers.ts)、[`group-graphql-mapping.ts`](../../apps/api/src/group-management/presentation/graphql/group-graphql-mapping.ts)、[`list-my-groups.ts`](../../apps/api/src/group-management/application/use-cases/list-my-groups.ts)。PostgreSQLの読取Adapterは#310、開発Compositionへの注入は#314
- Test: [`group-management-graphql.spec.ts`](../../apps/api/src/group-management/presentation/graphql/group-management-graphql.spec.ts)、[`list-my-groups.spec.ts`](../../apps/api/src/group-management/application/use-cases/list-my-groups.spec.ts)、[`app.spec.ts`](../../apps/api/src/app.spec.ts)。実DBでの一覧は#310・#314
- Web Client（#315）: `/groups`のServer Componentが[`my-groups-server.ts`](../../apps/web/src/features/groups/graphql/my-groups-server.ts)（`server-only`）からServer間で送る。開発Session Cookie 1つだけを転送し、`X-Kakei-Request: 1`を付け、Originを付けず、no-store。development以外ではAPIへ接続しない

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

- Group Managementのその他のOperation（概要、Membership、招待等）、Expense Recording、Settlementの公開Operationは、対応Use Case、本人性、認証認可、公開Error契約がReadyになったTaskで追加する
- 業務Operationの本人性（Operation単位の認証lease）、Origin・CSRF、公開Error code 8種、存在非開示の公開形（`NOT_FOUND`の同一化）、no-storeは[業務GraphQLの認証境界ADR](../adr/business-graphql-authentication-boundary.md)でAcceptedとなり、共通境界は#317で実装済み。`Mutation.createGroup`と`Query.myGroups`（#312）で`Confirmed`とした。後続の業務Operationも各公開Taskで`Confirmed`にする
- Pagination、N+1は未決または別Taskの対象である。Complexityは[入口制限](#入口制限)のReview Triggerで判定する。Rate limitはProduction Gate（同ADR Decision 6）
- 未決事項をこのcatalogだけでAcceptedにせず、必要なDecisionと実装Evidenceが揃うまで`Confirmed`にしない

関連Task: [#142](https://github.com/takeshi-arihori/kakei_app/issues/142)
