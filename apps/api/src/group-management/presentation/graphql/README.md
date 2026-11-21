# Group Management GraphQL Presentation

[Group一覧ADR](../../../../../../docs/adr/group-create-and-my-group-list-contract.md) §1・§2の`Mutation.createGroup`と`Query.myGroups`を公開する（#312）。SDLは[`schema.graphql`](../../../../schema.graphql)、Operationごとの契約は[Operation catalog](../../../../../../docs/api/graphql-contracts.md)を正本とする。

| Module | 責務 |
| --- | --- |
| `group-management-resolvers.ts` | 共通GraphQLの`AuthenticatedOperation.run`でOperation単位の認証lease内に入り、`actorSubject`だけをCommand／Queryへ渡してUse Caseを呼ぶ。Use Case未注入なら認証leaseを開かず`SERVICE_UNAVAILABLE` |
| `group-graphql-mapping.ts` | `operationId`の小文字canonical UUIDv4検査、一覧と作成結果のSDL形への写像（写像表にない値は一覧全体の失敗） |
| `group-public-error.ts` | 業務Errorから公開Errorへの唯一の写像。`OPERATION_MISMATCH`だけを公開し、それ以外は`SERVICE_UNAVAILABLE`へmaskする |

- 本人性・Origin・CSRF・公開Errorの形・no-storeは共通`src/presentation/graphql`が担う。ここでは共有認証・Domainを直接Importしない（[依存表](../../../../../../docs/engineering/backend.md)）。
- 入力検査は本人性とCSRFの後に行う。違反ではUse Caseを呼ばない。
- 業務Errorは公開Errorとしてlease内で投げる。認証はcommitし、業務値は返さない。業務commit後に認証commitが失敗した場合は共通境界が結果不明として`SERVICE_UNAVAILABLE`を返し、Clientは同じ`operationId`で再送する。
- Use Caseは`createApp`の`groupManagement`へCompositionが注入する。開発Compositionへの注入と実DBでの検証は#314、一覧の実読取Adapterは#310。

`group-management-graphql.spec.ts`は、Fakeの認証能力とUse Caseで`/graphql`入口を通した契約（認証・CSRF・入力形式・写像・公開Error・封鎖・再送の透過）を検証する。Fakeの成功は実DB・実Sessionでの動作の証明ではない。
