# 独立Planning評価と保存確認

このReferenceは`prepare-github-work`のEvaluator操作手順を補助する。Epic／Task、Ready、ADR、Dependency、公開Gate等の具体Ruleは`docs/engineering/`と`docs/governance/`を正本とする。

## Proposal評価

起動条件は[Engineering Loop](../../../../docs/engineering/engineering-loop.md)のD3に従う。該当する場合は、GitHubへ保存する前に新しい`work-planning-evaluator`へproposalを渡す。同じEvaluatorを修正版の再評価に使わない。

ReviewInputへ最低限含める。

- 元要求、Problem、期待成果、制約、対象外
- 確認したGitHub／Repository正本と基準Commit
- 現状EvidenceとGap
- 既存Epic／Taskの検索結果と重複比較
- Epicの目的と期待成果
- 設計成果と影響範囲
- Task名の案
- Dependencies、並行可否、PR順序、Stacked PR要否とBase
- Decision Check／Related ADR／未決事項
- 公開Gateの確認結果

結果:

- `pass`: Findingと不足Evidenceが空なら保存へ進める。
- `fail`: 親Agentがproposalを修正し、新しいEvaluatorで再評価する。
- `blocked`: Owner Decision、権限、正本Conflict等を報告し、依存する保存を止める。

Evaluatorはread-onlyとし、Issue／Projectの変更は親Agentだけが行う。

## 保存と確認

GitHub更新を依頼されている場合だけ保存する。Evaluatorを起動した場合は、passしたproposalだけを保存する。

保存後は[Delivery Workflow](../../../../docs/engineering/delivery-workflow.md)の手順でIssue本文、Project Field、Status等を再取得して比較する。Evaluatorは使わない。一致しない場合は親Agentが修正し、再度比較する。修正できない場合は、成功済みの状態と阻害要因を報告する。

## 完了報告

- 使用／作成／更新したEpicとTask名
- Dependency GraphとPR順序
- Decision／ADR状態
- GitHub URL
- 保存した状態の比較結果
- Evaluatorの結果、または起動しなかった理由
- 未解決事項
