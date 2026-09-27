---
name: code-review
description: 最終DiffをRequirement、Accepted Design、Repository docs、Test結果に照らしてSelf Reviewし、独立Evaluatorへ渡せる状態にする。
---

# Code Review

PR前のSelf Reviewとして、対象Taskの最終DiffをRequirement、Accepted Decision、Repository docs、Test結果へ照合する。個人的な好みや変更と無関係な既存Debtを理由にBlockしない。

このSkillは独立`task_evaluator`の代替ではない。Self Reviewで重大Findingを解消した後、`implement-github-task`が独立Evaluatorへ渡す。

## 最初に読む

- GitHub Task、Requirement、Done Criteria
- `pre-investigation`と設計Skillの成果
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [開発ガイド](../../../docs/engineering/README.md)
- 対象変更に適用されるRepository docs／Accepted ADR
- 最終Diffと`testing`結果

Review RuleはSkill本文へ複製せず、変更範囲に対応するdocsから取得する。特定の言語、DB、Framework、ORM、API Protocolを仮定しない。

## Review順序

1. Requirement／Done CriteriaとDiffを対応付ける。
2. 未実装、過剰実装、Scope外変更、未承認Decisionを確認する。
3. 適用されるArchitecture、Domain、Coding、API、Data、Frontend、Security、Operations等のdocsを選ぶ。
4. Correctness、DDD、SOLID、DRY、責務分離、依存方向、互換性、移行、Security等を**適用対象のdocs Ruleだけ**で確認する。
5. TestがRequirement／Contractを検証し、実装詳細だけを固定していないか確認する。
6. 関連docs、Schema、図、Runbook等の同期を確認する。
7. FindingをSeverity、Evidence、根拠docs、最小修正方針とともに整理する。

DDD／SOLID／DRY等の詳細確認が必要なら`solid-ddd-pr-review`へ委譲し、結果を重複なく統合する。

## Severity

- **Blocker**: 確定済みRequirement／Accepted Decision違反、重大なSecurity／Data破壊、未承認Decisionへの依存
- **Major**: Correctness Defect、重要な責務・依存境界の破壊、Compatibility／Migration／Concurrency等の重大Risk
- **Minor**: 局所的なClarity、Cohesion、Documentation等の低Risk改善

Project固有のSeverity補足がdocsにある場合はそちらを適用する。

## 修正Loop

Blocker／Majorは原因に応じて適切な設計、`implementation`、`testing`へ戻す。修正後は影響するVerificationを再実行し、最新Diffを再Reviewする。

MinorはTask Scope内で安全に修正できる場合は修正対象とし、Scope外なら理由とFollow-up要否を明記する。

## 出力

- **Result**: `Pass` または `Needs changes`
- **Findings**: Severity、File／Line、Issue、Requirement／docs根拠、修正方針
- **Reviewed scope**: Task、Decision、docs、Diff、Test
- **Verification**: 確認した検証結果
- **Residual items**: Scope外またはFollow-up
- **Evaluator input**: 独立Reviewへ渡すEvidenceの不足有無

## 完了条件

- Blocker／Majorが残っていない。
- 変更に適用されるRepository docsを確認した。
- Finding修正後の影響範囲を再検証した。
- 独立`task_evaluator`へ渡せるEvidenceが揃っている。
