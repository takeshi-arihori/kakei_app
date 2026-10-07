# 家計アプリ API

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

GraphQL契約の正本はRepositoryの[`apps/api/schema.graphql`](schema.graphql)です。Repository rootで`pnpm codegen`を実行し、Resolver型とWeb Operation型を更新します。

`apps/api/src/app.ts`はGraphQL YogaのUI／transport／preflight境界として`GET`／`OPTIONS /graphql`も受理しますが、現行の公開業務API契約は`POST /graphql`だけです。ClientはGET／OPTIONSによる業務Operation実行へ依存しません。

HTTP transportのOpenAPI設計書とローカルSwagger UIの利用方法は[`docs/api/README.md`](../../docs/api/README.md)を参照してください。OpenAPIはGraphQL Type／Fieldを再定義しません。

## テスト専用DB例

`test/test-database.integration.spec.ts`は`kakei_test`にTEMP TABLEを作成します。`ON COMMIT DROP`によりテスト中だけ存在し、永続SchemaやMigrationを変更しません。

## Domain設計Gate

現行Scopeは共有Groupの割り勘です。3 Bounded ContextとState modelはADR #24、Group Managementの最初のData Owner、Group Aggregate、Repository Port、内部Command認可はADR #35／#36で条件付き採用しています。Invitation lifecycle、受諾原子性、新Participantによる再参加はADR #52で採用し、Domain／Application内部契約とfake Repository検証をTask #57で実装しています。Group ManagementのPostgreSQL保存境界とRetention削除順序はADR #55／#73／#85／#102／#115に従います。他ContextのAggregate、本番本人性・配送・公開Error、Retention Coordinator、Context別削除、Checkpoint／Witness、Backup／Restore、Runbook、本番wiringは各Gateが完了するまで追加・接続しません。詳細はRepository rootの[ドメイン設計ルール](../../docs/engineering/domain-design.md)を参照してください。

## 将来のGo分離

現時点はTypeScript Modular Monolithを維持します。高並行I/OまたはCPU並列処理について計測済みのボトルネックが生じた場合だけ、対象WorkerをGoへ分離するADRを作成します。

## 保存レコードの保護基盤

[共有Infrastructureの保護基盤](src/shared/infrastructure/protected-record/README.md)をGroup ManagementのPostgreSQL Adapterで使用します。用途別Digestの型・Portは`src/shared/application/purpose-separated-digest.ts`に置き、Applicationから暗号Infrastructureへの依存を避けます。暗号基盤はAPI内で管理し、独立Packageにはしません。具体鍵Providerと本番接続は既存のGateに従います。
