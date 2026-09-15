# 独立Planning評価と保存確認

## 独立Planning Evaluator Loop

親AgentだけがGitHubを更新する。書き込み前に新しい`work_planning_evaluator` Subagentへproposalを渡し、pass後に書き込む。書き込み後はIssue、Project Field、Status、URLを再取得し、別の新しいEvaluatorへpersisted評価を依頼する。同じEvaluatorを再利用しない。

ReviewInputには元要求、対象外、参照URLと固定Commit、現状とGap、検索結果、重複比較、全Property、Requirement、Done Criteria、依存関係、Ready判定、Decision Check、ADR、未決事項を含める。さらに、公開可否の分類結果、未分類0件、機械検査と手動Review、公開しなかった情報、Private保管先待ちの有無を証拠として必須にする。`findings`と`missingEvidence`が空のpassだけを合格とする。failは修正して新しいEvaluatorで再評価し、blockedは証拠と影響を利用者へ報告する。

## 結果を報告する

ProjectとEpic、作成・更新したIssue、Ready判定、未解決事項、GitHub URL、Project Fieldの永続化結果、Evaluator結果を報告する。
