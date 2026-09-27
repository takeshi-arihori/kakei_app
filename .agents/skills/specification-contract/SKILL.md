---
name: specification-contract
description: 個別Use Case／Command／操作仕様をPrecondition、Postcondition、Invariant、Failureへ分類し、RequirementからTestへTraceできる契約として整理する。
---

# Specification Contract

確認済みRequirementとDomain Ruleを、個別操作のTest可能な契約へ構造化する。このSkill自身が新しい業務Rule、技術Schema、Data制約を確定しない。

## 最初に読む

- GitHub TaskのRequirement／Done Criteria
- `domain-modeling`／`domain-design`の確認済み成果
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [Specification Contract Rule](../../../docs/engineering/specification-contract.md)
- [開発ガイド](../../../docs/engineering/README.md)
- 対象Product／Domain／Security／Testing等の関連docs

条件分類、責務境界、Knowledge State、Test Rule等の規範はRepository docsを正本とする。

## 進め方

1. User Goal、Actor、Trigger、成功結果、Requirement上の根拠を確認する。
2. 正常、境界、拒否、競合、再試行のうち対象Riskに関係するScenarioを抽出する。
3. 条件候補をPrecondition、Postcondition、Invariant、Failure／Rejectionへ分類する。
4. Authorization、Input Validation、Application Coordination、Domain Rule、Persistence Constraint等の責務を混同しない。
5. 各条件へEvidenceとKnowledge Stateを付ける。
6. 契約IDからTest Scenarioを導出し、`testing`へ渡す。
7. 契約漏れ、分類誤り、技術制約の業務Rule化、未確定事項の誤確定をReviewする。

## 補助Reference

`references/`は出力Templateや作業補助として利用できるが、Project Ruleの正本ではない。Referenceと`docs/`が矛盾する場合は`docs/`を優先する。

## 責務境界

- `domain-modeling`: Rule／Invariant／Boundary自体の発見・検証
- `domain-design`: 確認済みRuleをDomain要素へ変換
- `specification-contract`: 個別操作のTest可能な契約化
- `testing`: 契約とDone Criteriaから実際のTest／Verificationを作成・実行

既存Codeや外部技術上の制約はEvidenceとして区別し、それだけを業務契約の根拠にしない。

## 出力

- 対象Use Case／Command／操作
- PRE／POST／INV／FAILの契約IDと条件
- 各条件のEvidence／Knowledge State
- Failure時の状態保証
- Requirement／Domain RuleとのTrace
- Test Scenario
- Conflict／Open Question

## 停止条件

Invariantの根拠不足、正本Conflict、未承認Decisionが契約結果を左右する場合は該当条件をConfirmedにせず、依存する実装を止める。依存しない契約整理とTest候補の作成は継続する。

## 完了条件

- 契約がRequirementと確認済みDomain RuleへTraceできる。
- 確定事項と未確定事項を区別している。
- Failure時の状態保証とTest Scenarioがある。
- Project RuleをSkill／Referenceで再定義せず、docsを根拠にしている。
