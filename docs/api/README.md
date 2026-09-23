# API設計書

## 正本と対象

| 契約 | 正本 | 責務 |
| --- | --- | --- |
| HTTP transport | [`openapi.yaml`](openapi.yaml) | 公開Endpoint、Method、Content-Type、HTTP envelope |
| GraphQL業務契約 | [`apps/api/schema.graphql`](../../apps/api/schema.graphql) | Query／Mutation、Input、Result、GraphQL Type／Field |
| 生成型 | `apps/api/src/presentation/graphql/generated`、`apps/web/src/shared/graphql/generated.ts` | SDLから生成し、手書きしない |
| 実装 | [`apps/api/src/app.ts`](../../apps/api/src/app.ts) | HonoとGraphQL YogaのHTTP Adapter |

OpenAPIはGraphQL業務TypeやFieldを再定義しません。業務契約の確認と変更は`apps/api/schema.graphql`を起点にし、`pnpm codegen`で生成型を同期します。

## 公開HTTP契約

- `GET /health`: Liveness
- `POST /graphql`: GraphQL over HTTPの公開Endpoint

`apps/api/src/app.ts`はGraphQL YogaのUI／transport／preflight境界として`GET`／`OPTIONS /graphql`も受理します。これらは現行の公開業務API契約ではなく、Clientが依存する安定Methodとして扱いません。Authentication、Authorization、CORSの未決事項をこの文書で採用しません。

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

```bash
pnpm api-docs:check
docker compose config
pnpm check
```

`api-docs:check`はOpenAPIとREADMEの公開Method集合、GraphQL SDLへのLink、固定Image、read-only mount、Request送信と外部Validatorの無効化を検査します。

Knowledge State: `GET /health`と`POST /graphql`は現行公開契約。各Contextの未実装Operation、認証Provider、公開Error、Rate limitは未決または別Taskの対象です。

関連Task: [#93](https://github.com/takeshi-arihori/kakei_app/issues/93)
