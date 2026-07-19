# 家計アプリ

pnpm WorkspaceとTurborepoで管理するモノレポです。

## 構成

```text
apps/
  web/       Next.js
  api/       NestJS API
  worker/    Outbox・Projection Worker（今後追加）
infra/
  docker/    ローカル開発用のContainer設定
```

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
pnpm build
```

`pnpm dev`はWebとAPIを並列起動します。

- Web: <http://localhost:3000>
- API: <http://localhost:3001>

## 開発ガイド

- 実装ルールと文書の入口: [開発ガイド](docs/engineering/README.md)
- Project／Epic／Task／仕様／設計／ADRの正本はNotionです。
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
