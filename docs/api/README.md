# API設計書

## 正本と対象

| 契約 | 正本 | 責務 |
| --- | --- | --- |
| HTTP transport | [`openapi.yaml`](openapi.yaml) | 公開Endpoint、Method、Content-Type、HTTP envelope |
| GraphQL業務契約 | [`apps/api/schema.graphql`](../../apps/api/schema.graphql) | Query／Mutation、Input、Result、GraphQL Type／Field |
| GraphQL Operation Trace | [`graphql-contracts.md`](graphql-contracts.md) | 実装済みOperationとContext、Use Case、認可、失敗、Testの対応 |
| 生成型 | `apps/api/src/presentation/graphql/generated`、`apps/web/src/shared/graphql/generated.ts` | SDLから生成し、手書きしない |
| 実装 | [`apps/api/src/app.ts`](../../apps/api/src/app.ts) | HonoとGraphQL YogaのHTTP Adapter |

OpenAPIはGraphQL業務TypeやFieldを再定義しません。業務契約の確認と変更は`apps/api/schema.graphql`を起点にし、`pnpm codegen`で生成型を同期します。

## Backend配置と実装状況

3業務Contextの4層、shared、共通GraphQLと`app.ts`／`main.ts`の責務・実在Path・予定Pathは、[Backend配置ガイド](../engineering/backend.md#context別4層と共通入口の実装状況)を参照します。Context固有Resolver／入出力変換は`src/<context>/presentation/graphql`、SDL読込・生成型・Resolver集約の共通入口は`src/presentation/graphql`に配置します。

現在の公開GraphQL Operationは`Query.apiStatus`のみです。内部Domain／Use Case／Adapterの実装と、公開経路への接続・機能完成を区別します。確認基準CommitとContext別の未実装／未接続、未決Decisionは配置ガイドを参照してください。

Context／Layer／共有基盤の配置・責務やwiring、公開Operationを変更するTaskは、同じ差分で配置ガイドの実装状況・基準Commitと本入口の参照も同期します。公開契約の更新は下記のSDL／Operation catalog更新Ruleに従います。

## 公開HTTP契約

- `GET /health`: Liveness
- `POST /graphql`: GraphQL over HTTPの公開Endpoint
- `POST /auth/google/attempt`: 試行開始201。nonce/CSRFとAttempt Cookie
- `POST /auth/google/login`: Session発行204。Session設定とAttempt削除
- `GET /auth/session`: idle非延長のSession照会200、本人性なし401
- `POST /auth/logout`: 現在Sessionだけ失効204

`apps/api/src/app.ts`はGraphQL YogaのUI／transport／preflight境界として`GET`／`OPTIONS /graphql`も受理します。これらは現行の公開業務API契約ではなく、Clientが依存する安定Methodとして扱いません。業務AuthorizationやProduction Deploymentの未決事項をこの文書で採用しません。認証4操作は下記の承認済みHTTP契約へ分離します。

## Swagger UI

Swagger UIは開発者向けのローカル閲覧Serviceです。公式Imageを固定Versionで使用し、OpenAPI fileをread-only mountします。`Try it out`と外部Validator通信は無効です。

```bash
docker compose up -d swagger-ui
```

既定URLは<http://localhost:8081>です。`.env`の`SWAGGER_UI_PORT`でHost側Portを変更できます。

```bash
docker compose stop swagger-ui
```

本番へSwagger UIを配置しません。設計書へSecret、Token、PII、実在金融情報、内部Security情報、実際のGraphQL Variablesを含めません。

## 更新と検証

公開HTTP契約を変更するTaskは、実装、`openapi.yaml`、API README、互換性とRollbackまたはForward-fixを同じ差分で更新します。GraphQL Type／Fieldの変更はSDLと生成型を更新し、OpenAPIへ複製しません。

top-level GraphQL Operationを追加・変更・削除するTaskの担当者は、同じ差分で[`graphql-contracts.md`](graphql-contracts.md)の対応entryとTest参照を更新します。SDLを契約構造の正本、Operation catalogをUse Caseと実装EvidenceへのTrace正本として分離します。catalogのKnowledge Stateは`Confirmed`、`Proposed`、`Open Question`だけを使い、未決事項を実装済みとして記載しません。

```bash
pnpm api-docs:check
docker compose config
pnpm check
```

`api-docs:check`は専用validator testを実行した後、OpenAPIとREADMEの公開Method集合、GraphQL SDLとOperation catalogの完全一致、entryの必須項目とRepository参照、固定Image、read-only mount、Request送信と外部Validatorの無効化を検査します。

Knowledge State: `GET /health`と`POST /graphql`は現行公開契約。各Contextの業務OperationとProduction認証Provider/Deploymentは別Task/Gateです。認証HTTP Errorと共有Rateは本Taskの契約です。

関連Task: [#93](https://github.com/takeshi-arihori/kakei_app/issues/93)、[#142](https://github.com/takeshi-arihori/kakei_app/issues/142)

## 認証HTTPの起動境界

Knowledge State: Confirmed。[HTTP契約](../../docs/security/authentication-http-boundary.md)と[Accepted ADR](../../docs/adr/authentication-http-and-development-boundary.md)が4操作の詳細を定める。通常mainの認証能力は未接続で503。使い捨てlocalhost入口だけが実Google SDK/実pg Store/実CSPRNG/共有Rateを接続し、Production有効化とは区別する。[専用開発Runbook](../../docs/operations/authentication-local-development.md)に従い、再起動後の非空専用DBは明示resetを要する。

全操作にX-Kakei-Request: 1、POSTに固定Origin完全一致、Cookie/CSRF/厳格JSON/stream18KiB/5秒制限、no-store/nosniffを適用する。Loginのcanonical CSRF不一致と期限切れ/消費済み/不在AttemptはOwner追補で一律409。CSRF Header欠落/形式不正は403、Logout有効SessionのCSRF不一致も403。共有Rateは429/Retry-After、能力障害や結果不明は503でCookieを変更しない。再開始409のAttemptだけ削除する挙動は有効Session競合409と区別する。Errorはcode/requestIdだけ、Actor/Google識別子/診断を返さない。

既存Client契約への削除/変更はなく、認証経路を追加する。Production契約のCookie名/属性はOpenAPIとHTTP契約に示すが、本番Provider/Ingress/Backup/退会のGateを満たすまで有効化しない。Forward-fixで修正し、HTTPを止める場合は開発入口を閉じる。使用済み共有予算をDownで消さない。GraphQL SDL/生成型は変更しない。
