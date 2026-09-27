---
name: domain-modeling
description: 業務要求からConcept、Rule、Invariant、境界を発見・検証し、RepositoryのDomain docsへTraceできるモデルを整理する。
---

# Domain Modeling

対象Problem、Actor、Use Caseを起点に、具体例とモデルを往復して業務理解を検証する。このSkillは業務理解のWorkflowを担当し、Project固有のDomain Ruleや技術Ruleを正本として保持しない。

## 最初に読む

- 利用者の要求とGitHub上の関連Requirement
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [開発ガイド](../../../docs/engineering/README.md)
- [Domain Modeling Rule](../../../docs/engineering/domain-modeling.md)
- [Domain Design Rule](../../../docs/engineering/domain-design.md)
- 対象Product／Domain docs、Design Gate、Accepted ADR

現行業務モデル、Knowledge State、Diagram Rule等のProject固有ルールはdocsを正本とする。

## 進め方

1. Problem、Actor、Goal、Trigger、期待結果を確認する。
2. 用語、Concept、Rule、Invariant候補を具体例から抽出する。
3. 正常例だけでなく、境界・拒否・競合等の反例でRuleを検証する。
4. 同じ用語がContextごとに異なる意味を持つ場合は分ける。
5. Context、Ownership、Lifecycle、整合性要求をEvidence付きで整理する。
6. 各結論へRepository docsが定めるKnowledge Stateを付ける。
7. 確認済みRuleを`domain-design`へ、個別操作の契約化を`specification-contract`へ引き継ぐ。

外部技術や既存Data Shapeは現行動作のEvidenceとして参照できるが、それ自体を業務Ruleの根拠にしない。

## 補助Reference

`references/`は質問例、出力Template、モデリング手順等の補助として利用できる。ただし規範的なProject Ruleは`docs/`が正本であり、Referenceとdocsが矛盾する場合はdocsを優先する。

必要なReferenceだけを読む。入口へRule本文を複製しない。

## 責務境界

- `domain-modeling`: 業務Concept、Rule、Invariant、Boundaryの発見・検証
- `domain-design`: 確認済みRuleをDomain要素・責務境界へ変換
- `specification-contract`: 個別操作をTest可能な契約へ構造化
- `testing`: 契約とDone Criteriaを実際のTest／Verificationへ変換

このSkill単独でProduction Code、公開契約、Persistence構造を変更しない。

## 出力

- Problem／Actor／Use Case
- Ubiquitous Language候補と意味
- Rule／Invariant／BoundaryとEvidence
- Knowledge State
- 具体例／反例
- Context／Ownership候補
- Conflict／Open Question
- 次の`domain-design`／`specification-contract`への入力
- 更新対象のProduct／Domain docs

## 停止条件

重要Ruleの根拠不足、正本Conflict、未承認Decisionが結果を左右する場合は、該当部分をConfirmedへ昇格させない。依存しないモデリングと反例検討は継続する。

## 完了条件

- 確定事項と提案・未決事項を区別している。
- 各RuleをRequirement、具体例、Repository docsへTraceできる。
- 技術都合を業務Ruleとして確定していない。
- 後続設計へ渡す入力が明確である。
