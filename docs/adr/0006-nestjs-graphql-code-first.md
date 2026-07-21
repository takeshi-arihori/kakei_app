# ADR-0006: NestJS GraphQL Code First

- Status: Superseded
- Superseded by: ADR-0012
- Date: 2026-07-11
- Area: Backend
- Related Notion Task: なし（移行済みNotion ADRを参照）
- Legacy Source: https://app.notion.com/p/39a06467984f81f89312ea6134da79cf

## Context

NestJSの型定義から一貫したGraphQL契約とWeb型生成を行う。

## Decision

- `@ObjectType`／`@InputType`等からSchemaを生成する。
- 生成SchemaをRepositoryでレビューする。
- Web Operation型をGraphQL Code Generatorで生成する。
- Domain Model／Prisma ModelをGraphQLへ直接公開しない。

## Alternatives

- Schema First: SDL正本として明快だがNestJS側との二重管理が増える。
- 併用: 正本が曖昧になる。

## Consequences

- 型安全性を得るが、生成Schema差分と破壊的変更をCIで検知する必要がある。

## Implementation

- Schema Check、Operation Check、Codegen差分をCI必須にする。

## Review Trigger

- FrameworkまたはGraphQL Schema管理方式を変更する場合。
