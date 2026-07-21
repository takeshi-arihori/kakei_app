# Architecture Decision Records

Accepted／Superseded ADRの正本はこのディレクトリで管理する。Notionは判断候補と関連Taskの整理に利用し、採用済みDecisionの正本にはしない。

## 運用

1. 判断候補と関連TaskをNotionで整理する。
2. 採用する場合は[`template.md`](template.md)を基に連番のADRを作成する。
3. ADRを実装と同じPull Requestでレビューする。
4. Merge時点でStatusを`Accepted`とする。
5. 方針変更時は既存ADRを上書きせず、新しいADRを追加して旧ADRを`Superseded`へ変更する。

## 必須項目

- Status: `Accepted`または`Superseded`
- Date
- Area
- Related Notion Task
- Context
- Decision
- Alternatives
- Consequences
- Implementation
- Review Trigger

## 一覧

- [ADR-0001: Transaction・Settlement限定のEvent Sourcing](0001-transaction-settlement-event-sourcing.md)
- [ADR-0002: GCP＋Neon＋Cloudflareのインフラ構成](0002-gcp-neon-cloudflare-infrastructure.md)
- [ADR-0003: 機密PayloadをFirestore＋Cloud KMSへ分離](0003-sensitive-payload-firestore-kms.md)
- [ADR-0004: 同期Projection＋Transactional Outbox](0004-synchronous-projection-transactional-outbox.md)
- [ADR-0005: JWTをHttpOnly Cookieで管理](0005-jwt-http-only-cookie.md)
- [ADR-0006: NestJS GraphQL Code First（ADR-0012により廃止）](0006-nestjs-graphql-code-first.md)
- [ADR-0007: pnpm Workspace＋Turborepoモノレポ](0007-pnpm-turborepo-monorepo.md)
- [ADR-0008: 暗号化pg_dumpをCloudflare R2へ保存](0008-encrypted-pg-dump-cloudflare-r2.md)
- [ADR-0010: 外部明細取込方針（廃止）](0010-external-statement-import-superseded.md)
- [ADR-0011: Accepted ADRをリポジトリで管理](0011-manage-accepted-adrs-in-repository.md)
- [ADR-0012: Hono＋GraphQL Yoga Schema First](0012-hono-graphql-yoga-schema-first.md)
- [ADR-0013: Component／Package DirectoryをTask着手時に作成](0013-just-in-time-component-scaffolding.md)
