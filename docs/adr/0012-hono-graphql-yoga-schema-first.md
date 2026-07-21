# ADR-0012: Hono＋GraphQL Yoga Schema First

- Status: Accepted
- Date: 2026-07-21
- Area: Backend
- Related Notion Task: https://app.notion.com/p/3a206467984f81bdbc52df979595b835
- Supersedes: ADR-0006
- Amends: ADR-0002のAPI Runtime名（インフラTopologyは維持）

## Context

TypeScriptを継続しながら、DDDのPresentation境界を薄く保ち、HTTP Framework固有の構造をDomain／Applicationへ持ち込まない構成が必要である。GraphQL契約はFrameworkのDecoratorではなく、Repositoryで直接レビューできるSDLを正本にしたい。

## Decision

- `apps/api`はHonoを薄いHTTP Adapter、GraphQL YogaをGraphQL実行基盤としてCloud Runで実行する。
- GraphQL SDLをRepositoryの正本とするSchema Firstを採用し、API Resolver型とWeb Operation型をGraphQL Code Generatorで生成する。
- Hono Handler／GraphQL ResolverはInput変換とApplication呼出しに限定し、Domain／ApplicationをHono、Yoga、GraphQL、Prismaから独立させる。
- TypeScript Modular Monolithを維持し、最初からGoとの分散構成にはしない。
- 将来、計測により高並行I/OまたはCPU並列WorkerがTypeScript RuntimeのSLOを満たせないと判明した場合だけ、該当処理をGoへ分離する新ADRを作成する。

## Alternatives

- NestJS＋GraphQL Code First: DIや規約は充実するが、今回の小規模APIではAdapterが厚くなりやすく、Decorator生成Schemaが契約の正本になる。
- TypeScriptのみでHTTP Frameworkを使わない: 依存は減るが、Routing、Middleware、Runtime Adapterを自前で保守する価値が現時点では小さい。
- Go＋Ginへ全面移行: 並行処理の選択肢は増えるが、WebとのTypeScript資産共有と開発速度を失う。実測ボトルネックがない段階では過剰である。
- Laravel／Rails／FastAPI: 生産性の高い選択肢だが、TypeScript採用という前提と型生成Workflowの一貫性を優先する。

## Consequences

- Domain／ApplicationのFramework独立性と、SDL差分のレビュー容易性を得る。
- NestJSのModule／DI／Guard規約は利用できないため、依存のComposition、認証・認可、Error変換の配置をRepository規約とTestで守る必要がある。
- Schemaと生成型の不整合をCIで検知する必要がある。
- 将来Goを導入する場合は別Process／Worker境界となり、契約、Observability、Deploymentの追加コストを負う。

## Implementation

- Hono `GET /health`とYoga `POST /graphql`の疎通Testを設ける。
- `apps/api/schema.graphql`からResolver型とWeb Operation型を生成する。
- DDDの最小例としてFramework非依存のJPY Money Value ObjectをUnit Testする。
- DB疎通例は`kakei_test`上のTEMP TABLEだけを使い、永続Migrationを追加しない。
- Notionの現行Architecture、Requirement、Epic、Task、RunbookをHono前提へ更新する。

## Review Trigger

- Hono／GraphQL YogaがSecurity、Performance、運用要件を満たさない場合。
- Schema管理方式またはAPI Protocolを変更する場合。
- Workerの高並行I/O／CPU処理が計測済みSLOを満たさず、Go分離の費用対効果を再評価する場合。
