# Hono GraphQL API

Honoを薄いHTTP Adapter、GraphQL YogaをGraphQL実行基盤として使うTypeScript APIです。DomainとApplicationはFramework非依存に保ちます。

## コマンド

```bash
pnpm -C apps/api dev
pnpm -C apps/api lint
pnpm -C apps/api typecheck
pnpm -C apps/api test
pnpm -C apps/api test:e2e
pnpm -C apps/api build
```

## Endpoint

- `GET /health`: Liveness
- `POST /graphql`: GraphQL Yoga

GraphQL契約の正本は[`schema.graphql`](schema.graphql)です。Repository rootで`pnpm codegen`を実行し、Resolver型とWeb Operation型を更新します。

## テスト専用DB例

`test/test-database.integration.spec.ts`は`kakei_test`にTEMP TABLEを作成します。`ON COMMIT DROP`によりテスト中だけ存在し、永続SchemaやMigrationを変更しません。

## Domain設計Gate

現行Scopeは共有Groupの割り勘です。3 Bounded ContextとState modelはADR #24、Group Managementの最初のData Owner、Group Aggregate、Repository Port、内部Command認可はADR #35／#36で条件付き採用しています。他ContextのAggregateとData Owner、Context間Port、Persistence、本番認証、招待・再参加は未決のため、旧Repositoryルールを根拠にSchemaやModuleを追加しません。詳細はRepository rootの[ドメイン設計ルール](../../docs/engineering/domain-design.md)を参照してください。

## 将来のGo分離

現時点はTypeScript Modular Monolithを維持します。高並行I/OまたはCPU並列処理について計測済みのボトルネックが生じた場合だけ、対象WorkerをGoへ分離するADRを作成します。
