# 家計アプリ

1〜4人のGroupで共有支出を記録し、負担割合、精算候補、支払報告・受取確認、Archiveを追跡するアプリです。個人だけの収入・支出管理は対象外です。pnpm WorkspaceとTurborepoで管理するモノレポです。

## 現行仕様

- [GitHubの正本入口](docs/governance/README.md)から、現行文書の固定Commitと作業Boardを確認します。Notionは使用しません。
- [現行Product Scope・業務モデル](docs/product/current-model.md)が確定済みの業務Ruleを管理します。
- [未確定・未移行Gate](docs/product/design-gates.md)でAccepted範囲と未決事項を確認します。3 Bounded ContextとGroup Managementの最初のAggregate／Data Owner／Port／内部認可は関連ADRに従い、他Context、Persistence、本番認証等の未決事項を採用済みとして実装しません。

## 構成

```text
apps/
  web/       Next.js
  api/       Hono＋GraphQL Yoga API
infra/
  docker/    ローカル開発用のContainer設定
docs/
  api/       HTTP transport設計書とSwagger UI入力
```

`apps/worker`は現時点では存在しません。空のScaffoldは先行作成せず、対応Taskへ着手するときに責務、所有者、Runtime、最初の利用者を決めて追加します。`pnpm-workspace.yaml`は実在するApplicationを管理します。

保存レコードの暗号基盤は[API内の共有Infrastructure](apps/api/src/shared/infrastructure/protected-record/README.md)へ配置しています。現在の利用者はAPIだけです。`packages`は、複数Applicationで共有する必要性がAcceptedされた場合に追加します。

## 必要な環境

- Node.js 24以上
- pnpm 10.15.1
- Docker DesktopまたはDocker Engine＋Compose

## 初期構築

```bash
cp .env.example .env
pnpm install
pnpm db:up
```

PostgreSQLの起動状態を確認します。

```bash
pnpm db:ps
```

## 開発コマンド

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

`pnpm dev`はWebとAPIを並列起動します。

- Web: <http://localhost:3000>
- API: <http://localhost:3001>

APIのLivenessは`GET /health`、GraphQL endpointは`POST /graphql`です。`pnpm codegen`でRepository管理のSDLからAPI Resolver型とWeb Operation型を生成します。

## API設計書

HTTP transport設計書は[`docs/api/openapi.yaml`](docs/api/openapi.yaml)、GraphQL業務契約の正本は[`apps/api/schema.graphql`](apps/api/schema.graphql)です。Swagger UIはローカル閲覧専用で、Request送信と外部Validator通信を無効化しています。

```bash
docker compose up -d swagger-ui
```

<http://localhost:8081>で確認できます。Portは`.env`の`SWAGGER_UI_PORT`で変更できます。停止は`docker compose stop swagger-ui`です。更新手順と契約境界は[API設計書の入口](docs/api/README.md)を参照してください。

## 開発ガイド

- 実装ルールと文書の入口: [開発ガイド](docs/engineering/README.md)
- Project／Epic／Task／仕様／設計／ADRの正本はGitHubです。設計変更とADRの入口は[08. 設計変更・意思決定](docs/governance/README.md)です。
- 実装対象はReadyになったGitHub Taskから選び、PR前に関連文書を更新します。
- Codexでは`$prepare-github-work`でEpic／Taskを整え、`$implement-github-task`でReady TaskをTDD実装します。

### Codex Evaluator Harness

- Issueを保存する前に`work_planning_evaluator`でRequirement、Done Criteria、Design、Dependencies、Ready条件を確認します。
- 実装後は最新Diff、Issue、検証結果、Self Reviewを`task_evaluator`へ渡します。`pass`でFindingと不足Evidenceがない場合だけDraft PRへ進みます。
- `fail`は修正後に新しいEvaluatorで再評価し、`blocked`は阻害要因を解消するまで依存作業を止めます。
- [設定とRole](docs/engineering/codex-configuration.md)、[Harnessの実動確認手順](docs/engineering/codex-harness.md)

## TypeScript

- `tsc`: TypeScript 7 native compiler
- `tsc6`／`typescript` module: Framework・ESLint互換用のTypeScript 6

TypeScript 7.0にprogrammatic APIがない間は、公式推奨どおり両方を併用します。

## PostgreSQL

- 開発DB: `kakei`
- テスト用DB: `kakei_test`
- ポート: `5432`

値は`.env`で上書きできます。Volumeを削除しない限りデータは保持されます。

現在のDB疎通テストは`kakei_test`内の`test_task_92_api_probe` TEMP TABLEだけを使い、Commit時に自動削除します。永続Migrationは作成しません。
