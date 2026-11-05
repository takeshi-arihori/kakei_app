# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

開発ルール・Gate・Routing・完了条件は`AGENTS.md`を唯一の正本とする（`apps/web/CLAUDE.md`と同じ方式）。ここへルールを複製しない。

@AGENTS.md

## Commands

Node 24+（`mise.toml`）、pnpm 10.15.1、Turborepo。DBはDocker Compose。

```bash
cp .env.example .env && pnpm install && pnpm db:up   # 初期構築（db:down / db:ps / db:logs）
pnpm dev            # Web(:3000)とAPI(:3001)を並列起動
pnpm check          # CI相当の全検証（skill-governance, github-item, api-docs, codegen:check, lint, typecheck, test, build）
pnpm lint | typecheck | test | build | test:e2e
pnpm codegen        # apps/api/schema.graphql からAPI Resolver型とWeb Operation型を生成（codegen:checkで差分検査）
pnpm api-docs:check # docs/api/openapi.yaml の検証
```

単一Testの実行（Vitest／Playwright）:

```bash
pnpm --filter @kakei/api exec vitest run src/path/to/file.spec.ts
pnpm --filter @kakei/web exec vitest run path/to/file.spec.ts
pnpm --filter @kakei/web exec playwright test e2e/xxx.spec.ts
```

- API: `test`は`vitest run src dev`、`test:e2e`は`test/`配下。型検査は`tsc6`。
- 認証付きAPI起動は`@kakei/api`の`dev:auth`（明示環境変数が必要、`.env`は自動読込しない。`docs/operations/authentication-local-development.md`）。Webは`test:auth:e2e`。

## Architecture

pnpmモノレポ（`apps/web`=Next.js 16／React 19、`apps/api`=Hono＋GraphQL Yoga）。`apps/worker`は存在しない。

APIは3つのBounded Context（`group-management`、`expense-recording`、`settlement`）と`shared`、Transport共通の`presentation/`で構成する。

- 4層必須: `Presentation -> Application -> Domain <- Infrastructure`。DomainはHono／GraphQL／pg／Cloud SDKをImportしない。未利用Layerの空Directoryは作らない。
- 現状: Group Managementはdomain／application／infrastructure(postgres)まで。Expense Recording・Settlementは**Domainのみ**。Context固有のGraphQL Presentationは未作成で公開経路は未接続（層ごとの状況表は`docs/engineering/backend.md`）。
- `src/shared/*`は技術契約・Port・暗号／認証Adapter。`pg`本体を参照できるのは`shared/infrastructure/authentication/postgres/`だけ。Context横断Importや、複数Contextで使うだけを理由にした独立Package化は不可。
- 依存方向は`apps/api/src/architecture-dependencies.spec.ts`が機械検査する。Import追加後はこのTestを確認する。
- GraphQL業務契約の正本は`apps/api/schema.graphql`、HTTP transportは`docs/api/openapi.yaml`。
- 業務Ruleは`docs/product/current-model.md`、未決事項は`docs/product/design-gates.md`、認証・暗号は`docs/security/`。
