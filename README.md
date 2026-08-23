# 家計アプリ

1〜4人のGroupで共有支出を記録し、負担割合、精算候補、支払報告・受取確認、Archiveを追跡するアプリです。個人だけの収入・支出管理は対象外です。pnpm WorkspaceとTurborepoで管理するモノレポです。

## 現行仕様

- 仕様の正本はNotionの[Requirement・Scope](https://app.notion.com/p/3a906467984f8180a7f3e4220eeaa47a)、[業務内容・業務ルール](https://app.notion.com/p/3a906467984f8015b763fe95859ea6ec)、[用語定義](https://app.notion.com/p/3a906467984f818b8a84d0b559cb6676)、[ドメイン設計](https://app.notion.com/p/3a906467984f80728058c839a403e6f0)です。
- 2026-08-23の各ページ先頭にある「現時点の確定仕様」「共有割り勘」の節を現行仕様とし、下方に残る個人用家計、2人限定、日付境界、単一Payer／Payeeの記述は判断履歴として扱います。
- Aggregate境界、Bounded Context、Data Owner、Event Sourcing適用範囲は未確定です。[未確定事項・Documentation Conflict](https://app.notion.com/p/3a906467984f814ba736c627901ead38)と関連ADRが解消されるまで、旧Repositoryルールを根拠に実装へ進みません。

## 構成

```text
apps/
  web/       Next.js
  api/       Hono＋GraphQL Yoga API
infra/
  docker/    ローカル開発用のContainer設定
```

`apps/worker`と`packages/*`は現時点では存在しません。空のScaffoldは先行作成せず、対応Taskへ着手するときに責務、所有者、Runtime、最初の利用者を決めて追加します。`pnpm-workspace.yaml`のglobは将来追加を受け入れるために先行定義しています。

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

## 開発ガイド

- 実装ルールと文書の入口: [開発ガイド](docs/engineering/README.md)
- Project／Epic／Task／仕様／設計／ADRの正本はNotionです。設計変更とADRの入口は[08. 設計変更・意思決定](https://app.notion.com/p/3a906467984f810b8ac7d4d416cc5296)です。
- 実装対象はReadyになったNotion Taskから選び、PR前に関連文書を更新します。
- Codexでは`$prepare-notion-work`でEpic／Taskを整え、`$implement-notion-task`でReady TaskをTDD実装します。

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
