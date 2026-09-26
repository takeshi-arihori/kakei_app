---
name: testing
description: Requirement・契約・変更差分から必要なTest LevelとCaseを選び、TDDのRed作成からGreen・回帰・構造検証まで実施する。
---

# Testing

Testを実装詳細の確認ではなく、Requirement、Domain Rule、公開契約、障害境界を検証する証拠として設計・実行する。

## 入力

- GitHub TaskのRequirement／Done Criteria
- `pre-investigation`の現状・影響範囲
- 必要な`domain-design`／`api-design`／`database-change`の成果
- [テストとTDD](../../../docs/engineering/testing.md)
- 変更対象Code、既存Test、Schema、Migration

## TDD

新しい振る舞いとBug Fixは原則として次の順で進める。

1. Requirement／契約から次の最小Caseを選ぶ。
2. 意図した理由で失敗するTestを作り、Redを確認する。
3. `implementation`へ必要な振る舞いを引き継ぐ。
4. 実装後にTestをGreenにする。
5. Refactor後もGreenを維持する。
6. Done Criteriaを満たすまで繰り返す。

文書・Skill・機械的Configだけの変更で先行Testに価値がない場合は、理由を記録し、構造・Link・frontmatter・参照整合など決定的な代替検証を選ぶ。

## Test Levelの選択

- Domain Unit Test: Rule、Invariant、Value Object、Aggregate Behavior
- Application Test: Use Case、Authorization、Port連携、Transaction Boundary
- Integration Test: Repository、Migration、DB Constraint、Concurrency、Idempotency
- API／Schema Test: GraphQL／HTTP、Validation、Error、認証・認可、互換性
- Frontend／Component／E2E: UI状態、Accessibility、主要経路
- Operations Test: Batch、Retry、Rebuild、Backup／Restore、Migration
- 文書／Skill検証: Link、構造、frontmatter、Routing、代表Scenario

必要なLevelだけを選び、E2EへDomain Ruleの全分岐を押し込まない。

## Caseの観点

正常、境界、権限、失敗、競合、再試行を変更内容に応じて選ぶ。全項目を形式的に増やすのではなく、Done CriteriaとRiskへTraceする。

## 実行

変更したPackageのScriptを先に実行し、必要な場合はRootのCheckへ広げる。Repositoryの正本Commandは[テストとTDD](../../../docs/engineering/testing.md)を参照する。

実行していない検証は、理由と残Riskを明示する。Flaky TestをRetryだけで隠さない。

## 出力

- Requirement／Contract → Test Caseの対応
- 追加・変更したTest
- Redで確認した失敗理由
- 実行Commandと結果
- 回帰確認範囲
- 未実施の検証と残Risk
- Findingがある場合に戻すSkill（domain／api／database／implementation）

## 完了条件

- Done CriteriaがTestまたは明示的検証へTraceできる。
- 新しいDomain Ruleに必要なUnit Testがある。
- 変更に関係する失敗・競合・再試行を必要範囲で確認している。
- 最終実装に対するGreenと回帰結果が記録されている。
