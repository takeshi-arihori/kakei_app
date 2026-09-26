---
name: specification-contract
description: 個別Use Case・Command・操作仕様をPrecondition、Postcondition、Invariant、Failureへ分類し、根拠・Knowledge State・TestへTraceできる契約として作成・レビューする。Domain Model自体の発見や技術Schema設計には使わない。
---

# Specification Contract

仕様作成・レビュー時に、対象操作の開始条件、成功後の保証、常に守るRule、拒否・失敗時の状態保証を明示する。既存のRequirement、Accepted Decision、Domain Ruleを入力とし、このSkillだけで新しい業務Ruleを確定しない。

## 進め方

1. Requirement、User Goal、Actor、Trigger、成功結果と根拠を確認する。
2. 正常、境界、拒否、競合、再試行の例から条件候補を抽出する。
3. 候補をPrecondition、Postcondition、Invariant、Failure／Rejectionへ分類する。
4. Authorization、Input Validation、Application Coordination、Domain Rule、DB Constraintを区別する。
5. 各条件へ根拠とKnowledge State（`Confirmed`、`Proposed`、`Assumption`、`Open Question`、`Conflict`）を付ける。
6. 契約IDから正常、境界、拒否、競合、再試行のTest Scenarioを導出する。
7. 契約漏れ、分類誤り、技術制約の業務Rule化、未確定事項の誤確定がないか確認する。

## 作業に応じて読む

| 作業 | 参照 |
| --- | --- |
| 条件の定義、分類、責務境界、拒否・失敗時の保証 | [Contract Rules](references/contract-rules.md) |
| 契約ID、出力Template、Traceability、Test Scenario | [Output Contract](references/output-contract.md) |
| 業務Concept、Rule、Invariant、Bounded Context自体の発見・検証 | [Domain Modeling](../domain-modeling/SKILL.md) |
| 確認済みRuleからEntity／VO／Aggregate等を設計 | [Domain Design](../domain-design/SKILL.md) |
| 契約から具体的なTestを作成・実行 | [Testing](../testing/SKILL.md) |

必要なReferenceだけを読む。入口へ詳細Ruleを複製しない。

## 責務境界

- `domain-modeling`は業務Concept、Rule、Invariant、Aggregate候補、Bounded Context候補を発見・検証する。
- `domain-design`は確認済みRuleをDomain要素と責務境界へ落とす。
- このSkillは確認済みまたは状態を明示したRuleを、個別操作のTest可能な契約へ構造化する。
- `testing`は契約IDとDone Criteriaから実際のTest Caseを設計・実行する。
- DB、Prisma、GraphQL、UI、Framework、既存Codeは業務契約の根拠そのものにしない。現行動作や技術制約の証拠として分けて扱う。
- GitHub IssueをRequirement／Done Criteria、Repositoryを仕様／設計／ADRの正本とする。Notionは読み書き・同期しない。

## 停止条件

Invariantの根拠不足、Knowledge Stateの`Open Question`／`Conflict`、正本間の矛盾、未承認Decisionが契約結果を左右する場合は、該当条件をConfirmedにせず依存する実装と正本反映を止める。影響、必要な判断、確認先を示し、依存しない契約整理とTest候補の作成は続ける。

成果は[Output Contract](references/output-contract.md)に従い、確定事項と未確定事項、拒否・失敗時の状態保証、根拠からTestまでのTraceを含める。
