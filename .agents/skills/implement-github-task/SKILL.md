---
name: implement-github-task
description: 家計アプリのReady済みGitHub Taskを実装し、検証・独立評価を経てDraft PRまで届ける。
---

# GitHub Taskの実装

Ready済みTaskを、GitHubとRepositoryの正本に従って実装する。Notionは読み書きしない。

## Taskと作業環境を固定する

1. [delivery-workflow](../../../docs/engineering/delivery-workflow.md)のReady・Branch・文書影響を確認する。GitHub取得先と固定Commitは[正本入口](../../../docs/governance/README.md)で確認し、技術文書は変更に関係する箇所だけ読む。
2. Task Issue、Project Field、Epic、Dependencies、Accepted ADR、固定Commitの仕様を取得する。
3. Status、Requirement、Done Criteria、Estimate、Decision Check、Related ADRがReady条件を満たすことを確認する。
4. `gh auth status`、同TaskのOpen PR、現在Branch、`origin/develop`、作業ツリーを確認する。
5. 無関係または所有者不明の変更を移動、破棄、Stage、Commitしない。必要なら`origin/develop`から隔離worktreeと`codex/` Branchを作る。

GitHubへの最初の書き込み前に[保存と公開Gate](../../../docs/engineering/delivery-workflow.md#githubでの保存と公開gate)を確認する。開始記録を含む公開本文・添付ごとに機械検査と手動Reviewを行い、非公開情報は公開しない。

StatusをIn Progressにし、Issueへ開始記録を残す。`develop`へ直接CommitまたはPushしない。

## 変更範囲とDecisionを確認する

TaskをBounded Context、Data Owner、Aggregate、Application Use Case、GraphQL、画面、永続化、Event、Security、Audit、Runbookへ対応付ける。変更予定文書ごとに方針変更の有無を判断する。新しいDecisionが必要ならADRを提案し、OwnerのAcceptedまでその判断に依存する実装を止める。依存しない調査・文書整理は続け、既に承認された範囲で確認を繰り返さない。

本番依存関係の追加、破壊的Migration、破壊的Schema変更は利用者の確認を得る。

## TDDと文書更新

Red → Green → Refactorを繰り返す。Bugは失敗する再現Testを先に作る。機械的な文書・設定変更で先行Testに価値がない場合は理由を記録し、構造検査、リンク検査、再取得など決定的な代替検証を行う。

実装と同じ差分でRepositoryの仕様、ADR、図、Schema、Migration Note、Runbook、開発ガイドを更新する。Secret、PII、実在金融情報、内部Security情報を公開Repository、Issue、PRへ書かない。
公開JavaScript／TypeScript APIとFieldの日本語JSDocは[コーディング規約](../../../docs/engineering/coding-standards.md)に従う。

## 完了まで進める

実装・関連文書・検証が揃ったら、[SOLID／DRY／DDDレビューSkill](../solid-ddd-pr-review/SKILL.md)を使ってPR前レビューを行う。その後、[独立評価とDraft PR](references/delivery.md)を読み、評価、修正、Commit、Push、Draft PR、Issue／Project更新まで進める。初回実装だけで完了にしない。PR Ready化・Mergeは明示依頼がある場合だけ行う。
