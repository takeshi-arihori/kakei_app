---
name: domain-design
description: 確認済みRequirementと業務Ruleを、RepositoryのDomain Design docsに従ってDomain要素・責務境界・Invariant・Portへ落とす。
---

# Domain Design

確認済みの業務Ruleを実装可能なDomain設計へ変換する。外部技術や既存Data Shapeを業務Ruleの根拠にしない。

## 最初に読む

- `pre-investigation`の調査結果
- GitHub TaskのRequirement／Done Criteria
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [開発ガイド](../../../docs/engineering/README.md)
- [Domain Design Rule](../../../docs/engineering/domain-design.md)
- 対象Product／Domain docsとAccepted ADR

Domain要素の分類Rule、Layer、依存方向、Transaction／Event等の具体Ruleは上記docsを正本とする。このSkillへ複製しない。

## Routing

- 業務Concept、Rule、Invariant、境界自体の発見・再検証が必要: `domain-modeling`
- 個別操作のPRE／POST／INV／FAILをTest可能にする: `specification-contract`
- 確認済みRuleを設計要素へ落とせる: このSkillを続行

## 実施

1. 対象Use Caseと業務RuleをRequirementへTraceする。
2. Repository docsの分類Ruleに従って、Entity、Value Object、Aggregate、Domain Service／Policy、Domain Event等の採否を判断する。
3. Invariant、Lifecycle、変更単位、Transaction Boundaryを整理する。
4. Application Use Case／Portとの責務境界を整理する。
5. Context間参照とData OwnershipをAccepted Decisionへ照合する。
6. 正常・境界・拒否・競合・再試行のうちDomain Testが必要なCaseを`testing`へ渡す。
7. 変更するdocs／図／ADRの要否を整理する。

## 出力

- 対象Use Case／業務Rule
- Domain要素の採否とRequirement／docs上の根拠
- InvariantとTransaction Boundary
- Application／Portとの責務境界
- Context間参照とData Ownership
- Testへ渡すContract／Case
- 更新対象docs／図／ADR
- Confirmed／Proposed／Open Question／Conflict

## 停止条件

RepositoryのADR条件またはOwner Decision条件に該当する未承認Decisionが必要なら、該当部分をConfirmedとして確定しない。依存しない分析は継続する。

## 完了条件

- 各設計判断がRequirement、Domain Rule、Accepted Decision、Repository docsへTraceできる。
- 外部技術都合を新しい業務Ruleとして確定していない。
- 依存方向と責務境界を説明できる。
- Testと文書更新へ引き継げる。
