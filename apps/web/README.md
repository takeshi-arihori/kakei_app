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

## Googleログイン

[`.env.example`](.env.example)を同Directoryの`.env.local`へコピーし、`NEXT_PUBLIC_GOOGLE_CLIENT_ID`に開発用Google Client IDを記載します。既存ファイルがある場合は上書きせず、必要なKEYだけ追記します。APIの`GOOGLE_CLIENT_ID`と同じ値を使い、Client SecretやAPI Keyは記載しません。

開発の`/login`がこの公開IDを参照し、公式GISと同一Originの4APIへ接続します。APIは通常の`dev`ではなく専用`dev:auth`を起動します。通常main/Productionは未有効です。[設定手順](../../README.md#googleログインの設定例)と[技術契約](../../docs/security/google-id-token-verification.md)を参照してください。

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


## 認証画面の検証

```bash
pnpm --filter @kakei/web test:auth:e2e
```

専用PG17末尾_testを`TEST_DATABASE_URL`で指定し、localhost:3000/127.0.0.1:3001を空けて実行します。Test所有の一時DBだけを作成・cleanupし、Google外部応答は合成、実SDK/実API/PG/Cookieを使います。Production入口の既存`test:e2e`と分離し、実Googleの成功とは別に記録します。契約と設定は[認証UI](../../docs/security/google-authentication-ui.md)、[開発Runbook](../../docs/operations/authentication-local-development.md)を参照してください。
