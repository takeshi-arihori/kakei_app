---
name: prepare-github-work
description: 検証済み要求と設計成果を、RepositoryのDelivery Ruleに従ってGitHub Epicの目的、Task名、Dependenciesへ変換する。Taskの詳細記入とReady判定は着手時のimplement-github-taskが行う。
---

# GitHub作業項目の準備

要求を、Epicの目的、Task名、Dependenciesへ変換する。Taskの詳細は着手時に`implement-github-task`が一度だけ書くので、ここでは書かない。Notionは読み書きしない。

レビューのみの依頼では提案と評価までに留め、GitHubへの書き込みは依頼された場合だけ行う。

## 最初に読む

- [Engineering Loop](../../../docs/engineering/engineering-loop.md)の設計フェーズ
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [Delivery Workflow](../../../docs/engineering/delivery-workflow.md)
- [PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)
- [正本入口](../../../docs/governance/README.md)
- 要求の変更範囲に対応するProduct／Domain／Architecture等のdocsとAccepted ADR

Epic／Task粒度、Ready、ADR、Project Field、公開Gate、Branch／PR等の具体RuleはRepository docsを正本とし、このSkillへ複製しない。特定の言語、DB、Framework、API方式を前提にTaskを作らない。

## Inputを検証する

1. [Engineering Loop](../../../docs/engineering/engineering-loop.md)のD0〜D2のうち、必要なものが成立しているか確認する。D0〜D2で確認済みの内容は再調査しない。
2. Problem、Goal、Scope、設計結果、Open Questionを取得する。
3. 未決DecisionはClarification、調査Task、ADR Proposal等へ分離し、依存Taskに依存先を記録する。

Evidenceが不足する場合、作業項目を推測で完成させず、不足する前段へ戻す。

## Work Breakdown

[Delivery Workflow](../../../docs/engineering/delivery-workflow.md)の粒度Ruleに従って、必要な場合だけEpicを作り、独立して検証可能なTaskへ分解する。記録する項目は同文書のEpic／Taskの節に従う。

設計結果でTask構成が変わる場合は、設計Taskを先に切り出し、後続を確定しない。

## Dependency／PR Planning

[PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)に従い、依存があるTaskについて順序、Stacked PRの要否、直接Base、Merge順序を決める。依存がなければ省略する。

## 独立Planning Evaluator

[Engineering Loop](../../../docs/engineering/engineering-loop.md)のD3の起動条件に該当する場合だけ、保存前に[独立Planning評価と保存確認](references/delivery.md)に従い、新しい`work-planning-evaluator`へproposalを渡す。該当しない場合は理由を1行で報告し、保存へ進む。

- `pass`: GitHub更新を依頼されている場合だけ保存へ進む。
- `fail`: 親AgentがPlanningを修正し、新しいEvaluatorで再評価する。
- `blocked`: Owner Decision、権限、正本Conflict等を報告して依存作業を止める。

Evaluatorはread-onlyで、GitHub更新は親Agentだけが行う。

## 保存後

GitHubへ書き込んだ場合は、[Delivery Workflow](../../../docs/engineering/delivery-workflow.md)の手順で実体を再取得して比較する。Evaluatorは使わない。

## 出力

- 使用／既存Epicと理由
- Epicの目的
- Task名、Dependencies、PR順序
- Decision／ADR状態
- Evaluatorの結果、または起動しなかった理由
- 未解決事項
- GitHub更新を行った場合のURLと再取得結果

## 完了条件

- 要求からEpic／Task名までTraceできる。
- 未決Decisionに依存するTaskに、依存先が記録されている。
- DependenciesとDelivery順序が明示されている。
- 必要な場合のStacked PR計画がある。
- Evaluatorを起動した場合は、重大Findingと不足Evidenceが残っていない。
