---
name: api-design
description: Domain/Application契約を公開APIへ写像し、GraphQL・HTTP・Input／Output・Error・認証認可境界・互換性を設計する。
---

# API Design

APIをDomain Ruleの正本にせず、確認済みのUse Caseと契約を外部公開境界へ写像する。

## 入力

- GitHub TaskのRequirement／Done Criteria
- `pre-investigation`および必要なら`domain-design`の成果
- [API設計書](../../../docs/api/README.md)
- `apps/api/schema.graphql`
- [Backend開発ルール](../../../docs/engineering/backend.md)
- [テスト方針](../../../docs/engineering/testing.md)
- 関連Accepted ADR

## 設計観点

- 公開するQuery／Mutation／HTTP Endpointと責務
- Input、Output、Result Union、Error Code、Field Error
- AuthenticationとApplication Authorizationの境界
- Group／Resource単位のIDOR対策
- Pagination、Filter、Sort、件数制限
- Depth／Complexity、N+1、DataLoaderなどAPI固有の負荷境界
- Idempotency、Retry、Concurrencyを外部契約へどう表すか
- Correlation ID、観測可能性、公開してよいError情報
- Schemaの後方互換性、Deprecation、Migration、Rollback／Forward-fix

GraphQL業務契約の正本は`apps/api/schema.graphql`、HTTP Transportの正本は`docs/api/openapi.yaml`とする。両者の責務を重複させない。

## 責務境界

- Resolver／HTTP AdapterはPresentation Adapterとして薄く保つ。
- Domain Rule、Repository呼出しの組立、Transaction制御をResolverへ置かない。
- Input ValidationとDomain Invariantを区別する。
- API都合で新しいDomain Ruleを確定しない。
- DB SchemaやMigrationをAPI契約から直接決めない。

## 出力

- 変更する公開契約と正本File
- Operation／EndpointごとのInput／Output／Error
- 認証・認可境界
- 互換性分類（互換／非互換）と移行方針
- Pagination／負荷／N+1等の非機能条件
- 必要なUnit／Integration／Schema／E2E Test
- 更新対象のAPI文書、Schema、生成型
- Open Question／Conflict／ADR要否

## 停止条件

API Protocol、Schema正本、認証・認可方式、Context間公開契約などAccepted Decisionを変える必要がある場合は、ADRがAcceptedになるまで依存する確定・実装を止める。

## 完了条件

- 公開契約がRequirementとApplication Use CaseへTraceできる。
- Domain Model、DTO、GraphQL Type、Persistence Modelを同一型として共有していない。
- 互換性・移行・検証方法が明示されている。
