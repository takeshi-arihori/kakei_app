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
- `POST /auth/google/attempt`: 試行開始201。nonce/CSRFとAttempt Cookie
- `POST /auth/google/login`: Session発行204。Session設定とAttempt削除
- `GET /auth/session`: idle非延長のSession照会200、本人性なし401
- `POST /auth/logout`: 現在Sessionだけ失効204

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

## 認証HTTPの起動境界

Knowledge State: Confirmed。[HTTP契約](../../docs/security/authentication-http-boundary.md)と[Accepted ADR](../../docs/adr/authentication-http-and-development-boundary.md)が4操作の詳細を定める。通常mainの認証能力は未接続で503。使い捨てlocalhost入口だけが実Google SDK/実pg Store/実CSPRNG/共有Rateを接続し、Production有効化とは区別する。[専用開発Runbook](../../docs/operations/authentication-local-development.md)に従い、再起動後の非空専用DBは明示resetを要する。

全操作にX-Kakei-Request: 1、POSTに固定Origin完全一致、Cookie/CSRF/厳格JSON/stream18KiB/5秒制限、no-store/nosniffを適用する。Loginのcanonical CSRF不一致と期限切れ/消費済み/不在AttemptはOwner追補で一律409。CSRF Header欠落/形式不正は403、Logout有効SessionのCSRF不一致も403。共有Rateは429/Retry-After、能力障害や結果不明は503でCookieを変更しない。再開始409のAttemptだけ削除する挙動は有効Session競合409と区別する。Errorはcode/requestIdだけ、Actor/Google識別子/診断を返さない。

既存Client契約への削除/変更はなく、認証経路を追加する。Production契約のCookie名/属性はOpenAPIとHTTP契約に示すが、本番Provider/Ingress/Backup/退会のGateを満たすまで有効化しない。Forward-fixで修正し、HTTPを止める場合は開発入口を閉じる。使用済み共有予算をDownで消さない。GraphQL SDL/生成型は変更しない。
