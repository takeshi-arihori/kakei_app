---
name: implement-github-task
description: 家計アプリのReady済みGitHub Taskを、仕様確認、TDD、検証、独立評価、文書更新、Draft PRまで一貫して実装する。
---

# GitHub Taskの実装

Ready済みTaskを、GitHubとRepositoryの正本に従って実装する。Notionは読み書きしない。

## Taskと作業環境を固定する

1. `docs/governance/README.md`、`AGENTS.md`、`docs/engineering/README.md`、`docs/engineering/delivery-workflow.md`を読む。
2. Task Issue、Project Field、Epic、Dependencies、Accepted ADR、固定Commitの仕様を取得する。
3. Status、Requirement、Done Criteria、Estimate、Decision Check、Related ADRがReady条件を満たすことを確認する。
4. `gh auth status`、同TaskのOpen PR、現在Branch、`origin/develop`、作業ツリーを確認する。
5. 無関係または所有者不明の変更を移動、破棄、Stage、Commitしない。必要なら`origin/develop`から隔離worktreeと`codex/` Branchを作る。

StatusをIn Progressにし、Issueへ開始記録を残す。`develop`へ直接CommitまたはPushしない。

## 変更範囲とDecisionを確認する

TaskをBounded Context、Data Owner、Aggregate、Application Use Case、GraphQL、画面、永続化、Event、Security、Audit、Runbookへ対応付ける。変更予定文書ごとに方針変更の有無を判断する。新しいDecisionが必要ならADRを提案し、OwnerのAcceptedまで実装を止める。

本番依存関係の追加、破壊的Migration、破壊的Schema変更は利用者の確認を得る。

## TDDと文書更新

Red → Green → Refactorを繰り返す。Bugは失敗する再現Testを先に作る。機械的な文書・設定変更で先行Testに価値がない場合は理由を記録し、構造検査、リンク検査、再取得など決定的な代替検証を行う。

実装と同じ差分でRepositoryの仕様、ADR、図、Schema、Migration Note、Runbook、開発ガイドを更新する。Secret、PII、実在金融情報、内部Security情報を公開Repository、Issue、PRへ書かない。

## 検証と独立Evaluator

package.jsonに存在するlint、typecheck、test、buildと、変更に必要なSchema・Migration・生成コード検査を行う。失敗を無視せず、変更起因、既存、環境を区別する。

今回のTask所有FileだけをStageし、Base SHAを固定する。`git diff --cached --binary --full-index <base-sha>`のSHA-256とFile一覧を記録する。新しい`task_evaluator` SubagentへTask URL、Requirement、Done Criteria、Project Field、設計範囲、Decision、Base SHA、Stage済み差分、checksum、File一覧、検証結果、文書、Security、Rollback、既知Riskを渡す。

同じEvaluatorを再利用しない。`findings`と`missingEvidence`が空のpassだけを合格とする。failは親Agentが修正・再検証し、新しいEvaluatorへ再依頼する。blockedは証拠と影響を利用者へ報告する。

## Commit、Draft PR、追跡更新

Evaluator pass後に限り、次を行う。

1. Stage済み差分へ無関係な変更や機密情報がないことを再確認する。
2. Conventional CommitsでCommitする。
3. BaseからCommitまでのpatch checksumとFile一覧がEvaluator承認時と一致することを確認する。
4. Task BranchをoriginへPushする。
5. 同TaskのOpen PRがなければ`develop`向けDraft PRを作る。既存PRがあれば更新する。
6. PRにTask URL、Requirement、Done Criteria、変更、検証、文書・Schema・Migration・Security・運用・Rollback、未実施事項、残Riskを記録する。
7. PRのURL、Head SHA、Base、Draft、Files、本文を再取得する。
8. IssueへPR URLと検証結果を記録し、Project StatusをReviewへ移して再取得する。

PRをReady化またはMergeしない。旧Notion URLやSource Notion IDは既存データの識別子としてのみ保持し、アクセス、更新、同期に使わない。

## 完了報告

Task・Epic・仕様・ADR、満たしたDone Criteria、主要File、TDDまたは代替検証、全検証結果、Security、残Risk、Branch、Commit、Draft PR、IssueとProject Statusを報告する。
