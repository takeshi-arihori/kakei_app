---
name: testing
description: Requirement・Contract・変更Riskから必要なTest／検証を選び、TDDのRedからGreen・回帰までをRepository docsに従って実施する。
---

# Testing

Testを実装詳細の確認ではなく、Requirement、業務Rule、公開契約、障害境界を検証するEvidenceとして設計・実行する。Skill自身は特定のProgramming Language、Test Framework、Runner、Commandを固定しない。

## 最初に読む

- GitHub TaskのRequirement／Done Criteria
- `pre-investigation`と必要な設計Skillの成果
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [Testing Rule](../../../docs/engineering/testing.md)
- 対象変更に関係するArchitecture／Domain／API／Data／Frontend／Operations等のdocs

具体的なTest Level、Tool、Command、Coverage、Fixture、E2E等のProject Ruleはdocsを正本とする。

## TDD Loop

新しい振る舞いとBug Fixは原則として次を繰り返す。

1. Requirement／Contractから次の最小Caseを選ぶ。
2. 関連docsに従って最小のTestまたは決定的検証を用意する。
3. 新しい振る舞いでは意図した理由でRedになることを確認する。
4. `implementation`へ必要な振る舞いを引き継ぐ。
5. 実装後にGreenを確認する。
6. Refactor後もGreenを維持する。
7. Done Criteriaが残る場合は次のCaseへ進む。

文書、Skill、設定等で先行Testに価値がない場合は、理由を記録し、関連docsが定める構造・参照・Schema・静的Check等の代替検証を選ぶ。

## Case選択

正常、境界、権限、失敗、競合、再試行等から、Done Criteriaと変更RiskへTraceできるCaseだけを選ぶ。形式的に全組合せを増やさない。

Test LevelやIntegration範囲は変更対象の責務境界と関連docsから選ぶ。Domain Ruleを外側の高Cost Testだけへ押し込まない。

## 実行

Repositoryの正本Commandは[Testing Rule](../../../docs/engineering/testing.md)から取得する。変更範囲に必要な最小Checkから開始し、Riskに応じて広げる。

実行していない検証は理由と残Riskを明示する。失敗をRetryだけで隠さず、変更起因、既存、環境を区別する。

## 出力

- Requirement／Contract → Test／Verificationの対応
- 追加・変更したTest／検証
- Redで確認した失敗理由
- 実行Commandと結果
- 回帰確認範囲
- 未実施検証と残Risk
- Findingがある場合の戻り先Skill

## 完了条件

- Done CriteriaがTestまたは明示的検証へTraceできる。
- 変更Riskに必要なCaseを確認している。
- 最終実装に対するGreen／回帰結果が記録されている。
- Testの具体RuleをSkill本文ではなくdocsから適用している。
