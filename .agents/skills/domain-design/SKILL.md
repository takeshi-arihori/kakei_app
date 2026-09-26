---
name: domain-design
description: 確認済み要求と業務RuleからEntity・Value Object・Aggregate・Domain Service・Domain Event・Portを設計し、DDD境界と依存方向を整理する。
---

# Domain Design

業務Requirementと確認済みDomain Ruleを、実装可能なDomain設計へ落とす。DB、GraphQL、UI、Frameworkの都合からDomain Modelを逆算しない。

## 入力

- GitHub TaskのRequirement／Done Criteria
- [現行Product Scope・業務モデル](../../../docs/product/current-model.md)
- [設計Gate](../../../docs/product/design-gates.md)
- [ドメイン設計ルール](../../../docs/engineering/domain-design.md)
- 関連Accepted ADR
- `pre-investigation`の調査結果

業務概念・Rule・Invariant自体の発見や再検証が必要なら、先に[domain-modeling](../domain-modeling/SKILL.md)を使う。個別Use Caseの契約をPRE／POST／INV／FAILへ構造化する場合は[specification-contract](../specification-contract/SKILL.md)を使う。

## 設計観点

- Entity: IdentityとLifecycleを持つか
- Value Object: 値で比較し、生成時に妥当性を保証できるか
- Aggregate: 同一Transactionで守るInvariantの最小境界か
- Aggregate Root: Aggregate外部からの変更入口とInvariant保護を担うか
- Domain Service／Policy: 単一Entity／VOへ自然に属さないStatelessなDomain Ruleか
- Domain Event: 既に起きた業務上の事実か
- Application Use Case: Orchestration、認可、Transaction Boundary、Port呼出しか
- Port: Domain／Applicationが必要とする外部能力を内側から定義しているか

AggregateやContextを、画面、Mutation、Table、既存Directoryを根拠に決めない。

## SOLID・依存方向

[Backend開発ルール](../../../docs/engineering/backend.md)と[コーディング規約](../../../docs/engineering/coding-standards.md)を参照し、DomainがFrameworkやInfrastructureへ依存しないこと、ApplicationがPortへ依存すること、責務ごとの変更理由が分離されていることを確認する。

## 出力

- 対象Use Case／業務Rule
- Entity／Value Object／Aggregate／Domain Service／Domain Eventの採否と根拠
- Application Use Case／Portとの責務境界
- InvariantとTransaction Boundary
- Context間参照方式とData Ownership
- 正常・境界・拒否・競合・再試行で必要なDomain Test
- 更新が必要なRepository文書／図／ADR
- Confirmed／Proposed／Open Question／Conflict

## 対象外

- API Schemaの具体設計は`api-design`へ委ねる。
- Table、Migration、Indexの具体設計は`database-change`へ委ねる。
- Production Code変更は`implementation`へ委ねる。

## 停止条件

新しいBounded Context、未承認のAggregate／Data Owner変更、Accepted ADRの変更、Context間連携方式など、Owner DecisionまたはADRが必要な場合はConfirmedとして確定せず、その判断に依存する実装を止める。

## 完了条件

- 各Domain要素の分類にRequirement／Rule／Invariantの根拠がある。
- API／DB都合を業務Ruleとして採用していない。
- 依存方向と責務境界が説明できる。
- Testと文書更新へTraceできる。
