# Hono GraphQL API

Honoを薄いHTTP Adapter、GraphQL YogaをGraphQL実行基盤として使うTypeScript APIです。DomainとApplicationはFramework非依存に保ちます。

## コマンド

```bash
pnpm --filter @kakei/api dev
pnpm --filter @kakei/api lint
pnpm --filter @kakei/api typecheck
pnpm --filter @kakei/api test
pnpm --filter @kakei/api test:e2e
pnpm --filter @kakei/api build
```

## Endpoint

- `GET /health`: Liveness
- `POST /graphql`: GraphQL Yoga

GraphQL契約の正本は[`schema.graphql`](schema.graphql)です。Repository rootで`pnpm codegen`を実行し、Resolver型とWeb Operation型を更新します。

## テスト専用DB例

`test/test-database.integration.spec.ts`は`kakei_test`に`test_task_92_api_probe` TEMP TABLEを作成します。`ON COMMIT DROP`によりテスト中だけ存在し、永続SchemaやMigrationを変更しません。

## 将来のGo分離

現時点はTypeScript Modular Monolithを維持します。高並行I/OまたはCPU並列処理について計測済みのボトルネックが生じた場合だけ、対象WorkerをGoへ分離するADRを作成します。
