# Next.js Web

Next.js 16のFrontendです。画面、入力、表示、Browser API、局所UI状態を担当し、業務Rule、認可の最終判断、DB AccessはHono APIのApplication／Domainへ委ねます。

## コマンド

Repository rootから実行します。

```bash
pnpm -C apps/web dev
pnpm -C apps/web lint
pnpm -C apps/web typecheck
pnpm -C apps/web test
pnpm -C apps/web build
```

開発Serverは<http://localhost:3000>で起動します。

## GraphQL

- API endpoint: Hono＋GraphQL Yogaの`POST /graphql`
- Operation: `src/shared/graphql/operations.ts`
- 生成型: `src/shared/graphql/generated.ts`
- Client: `src/shared/graphql/client.ts`

GraphQL Operation／Result型を手書きせず、Repository rootで`pnpm codegen`を実行して`apps/api/schema.graphql`から更新します。

外部から受け取るResponseは生成型だけに依存せず、Client境界でJSONと必要Fieldを実行時検証します。通信失敗、非2xx、JSON読取失敗、不正なResponse構造は`ApiTransportError`、妥当なGraphQL `errors`は`ApiGraphQLError`として区別し、Response本文をLogへ出しません。

## 境界

- Domain Model、Aggregate、Prisma ModelをWebへ共有しない
- Next.js Route HandlerへDomain LogicやDB Accessを置かない
- UIの表示制御でServer側の認可を代替しない
- API、Form、表示状態を分離する

現行Scopeは共有Groupの割り勘です。個人用家計、口座、収入Transaction、日付境界Archiveを現行画面の前提にしません。

詳細は[`AGENTS.md`](AGENTS.md)とRepository rootの[開発ガイド](../../docs/engineering/README.md)を参照してください。
