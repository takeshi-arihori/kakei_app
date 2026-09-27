# 独立Planning評価と保存確認

このReferenceは`prepare-github-work`のEvaluator操作手順を補助する。Epic／Task、Ready、ADR、Dependency、公開Gate等の具体Ruleは`docs/engineering/`と`docs/governance/`を正本とする。

## Proposal評価

GitHubへ保存する前に、新しい`work_planning_evaluator`へproposalを渡す。同じEvaluator Threadを修正版の再評価に使わない。

ReviewInputへ最低限含める。

- 元要求、Problem、期待成果、制約、対象外
- 確認したGitHub／Repository正本と基準Commit
- 現状EvidenceとGap
- 既存Epic／Taskの検索結果と重複比較
- Requirement／Done Criteria
- 設計成果と影響範囲
- Epic／Task分解案
- Dependencies、並行可否、PR順序、Stacked PR要否とBase
- Ready判定
- Decision Check／Related ADR／未決事項
- 公開Gateの確認結果

結果:

- `pass`: Findingと不足Evidenceが空なら保存へ進める。
- `fail`: 親Agentがproposalを修正し、新しいEvaluatorで再評価する。
- `blocked`: Owner Decision、権限、正本Conflict等を報告し、依存する保存を止める。

Evaluatorはread-onlyとし、Issue／Projectの変更は親Agentだけが行う。

## 保存とpersisted評価

GitHub更新を依頼されている場合だけ、passしたproposalを保存する。保存後にIssue本文、Relation、Project Field、Status、URL等を再取得する。

その実体を**別の新しい`work_planning_evaluator`**へ渡し、proposalどおり永続化されたかを評価する。

persisted評価がfailした場合は、親Agentが保存状態を修正して再取得し、さらに新しいEvaluatorで再評価する。blockedなら成功済み状態と阻害要因を報告する。

## 完了報告

- 使用／作成／更新したEpicとTask
- Requirement／Done Criteria
- Dependency GraphとPR順序
- Ready判定
- Decision／ADR状態
- GitHub URL
- 保存した状態の再取得結果
- Proposal evaluator結果
- Persisted evaluator結果
- 未解決事項
