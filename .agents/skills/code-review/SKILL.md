---
name: code-review
description: 最終DiffをRequirement・Accepted ADR・Repositoryルール・Test結果に照らしてレビューし、Correctness・境界・互換性・保守性のFindingを整理する。
---

# Code Review

最終Diffを対象TaskのRequirementとAccepted Designへ照らし、実質的な問題だけをEvidence付きで報告する。個人的な好みや変更と無関係な既存Debtを理由にBlockしない。

## 入力

- GitHub Task、Requirement、Done Criteria
- Accepted ADR、関連Repository文書
- `pre-investigation`および設計Skillの成果
- 最終Diff
- `testing`のTest／検証結果

## Review観点

### 要件・Correctness

- Requirement／Done Criteriaを満たしているか
- 正常、境界、権限、失敗、競合、再試行の必要Caseが欠けていないか
- 未承認Decisionを実装で確定していないか

### DDD・SOLID・依存方向

Domain変更またはApplication／Backend境界に影響する場合は[SOLID・DRY・DDD PRレビュー](../solid-ddd-pr-review/SKILL.md)を適用する。その結果をこのReviewへ統合し、同じFindingを重複して報告しない。

### API

- 公開契約と実装・Schema・生成型が一致するか
- 認証・認可、Input Validation、Error、互換性が設計通りか
- Domain RuleがResolver／Transportへ漏れていないか

### Database

- Schema／Migration／RepositoryがData Ownerと設計へ一致するか
- Constraint、Index、Transaction、Concurrency、Idempotencyが妥当か
- Migration、Rollback／Forward-fix、既存Data互換性が不足していないか

### Test・文書

- TestがRequirementと契約を検証しているか
- 実装詳細だけを固定していないか
- 関連する仕様、Schema、Migration Note、図、Runbookが同期されているか
- Skill／文書変更ではLink、frontmatter、Routing、指示整合が確認されているか

### Security／Privacy

Secret、PII、実在金融情報、内部Security情報の混入、過剰なLog、認可漏れ、Error情報漏えいを確認する。

## Severity

- **Blocker**: 確定済み要件／Accepted Decision違反、重大なSecurity／Data破壊、未承認Decisionへの依存
- **Major**: Correctness Defect、重要な境界破壊、互換性・Migration・競合上の重大な欠陥
- **Minor**: 局所的なClarity、Cohesion、Documentation、低Riskの改善

各FindingにFile／Line、観測事実、問題となる根拠、最小限の修正方法を含める。

## 修正ループ

Blocker／Majorは`feature-development`側で適切な`domain-design`／`api-design`／`database-change`／`implementation`／`testing`へ戻し、修正・再検証後に再Reviewする。本Skill自身から統括Skillを呼び戻さない。

## 出力

- **Result**: `Pass` または `Needs changes`
- **Findings**: Severity、File／Line、Issue、根拠、修正方針
- **Reviewed scope**: Task、ADR、Diff、Test
- **Verification**: 確認したTest／検証結果
- **Residual items**: Scope外またはFollow-up事項

## 完了条件

- Blocker／Majorが残っていない。
- Requirement、Architecture、API、DB、Test、Docsのうち変更に関係する観点を確認した。
- Finding修正後の影響範囲が再検証されている。
