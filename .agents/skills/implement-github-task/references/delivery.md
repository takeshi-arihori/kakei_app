# 検証・独立評価・Draft PR

このReferenceは`implement-github-task`の操作手順を補助する。Project Ruleの正本は`docs/`であり、具体的な言語、Tool、Test Command、DB、Framework、API方式はここへ固定しない。

## 最終検証とSelf Review

1. [Testing Rule](../../../../docs/engineering/testing.md)と変更範囲の関連docsから、今回実行すべき検証Commandを取得する。
2. 変更範囲に必要なTest、静的Check、Schema／Migration／生成物／Operations等の検証を実行する。
3. 失敗を無視せず、変更起因、既存、環境を区別する。
4. [`code-review`](../../code-review/SKILL.md)で最終DiffをSelf Reviewする。
5. 必要な専門Reviewがある場合だけ対応Skillを利用する。
6. Blocker／Major相当のFindingを修正し、影響する検証を再実行する。

## 評価対象を固定する

Independent Evaluatorへ渡す直前に、Task所有の変更だけを評価対象として固定する。

最低限記録する。

- Base Commit／Branch
- 評価対象Diffを一意に識別できるChecksumまたはCommit／Index情報
- 変更File一覧
- 作業Treeの状態
- Requirement／Done Criteria
- Accepted Decisionと適用したdocs
- 実行した検証と結果
- 未実施検証と理由
- Self Review結果
- 文書／Security／Operations／Rollback等の影響
- 既知Riskと承認済み例外

無関係な変更を評価対象へ混ぜない。

## Independent Evaluator Loop

各Cycleで**新しい`task_evaluator`**を1つ起動する。同じEvaluator Threadを修正後の再評価に使用しない。

```text
task_evaluator
   │
   ├─ pass ─────▶ Draft PR工程
   │
   ├─ fail ─────▶ 親Agentが修正
   │                 │
   │                 ├─ 再検証
   │                 ├─ Self Review
   │                 └─ 新しいtask_evaluator
   │
   └─ blocked ──▶ 阻害要因を解消するまで停止
```

Evaluatorはread-onlyとし、親AgentだけがCode、文書、Stage状態、GitHubを変更する。

`pass`でも`findings`または`missingEvidence`が残る場合は合格扱いにしない。

## Evaluator pass後の整合確認

Evaluatorが承認したDiffと、実際にCommit／PushするDiffが同一であることを確認する。Hook、生成処理、Stage漏れ、追加修正等で差分が変わった場合は、その変更に必要な検証・Self Review・新しいEvaluator Cycleへ戻る。

## Commit／Push／Draft PR

[Delivery Workflow](../../../../docs/engineering/delivery-workflow.md)と[PR依存関係Gate](../../../../docs/engineering/pr-dependency-gate.md)に従う。

1. 公開対象へ無関係な変更や公開不可情報がないことを確認する。
2. レビュー可能な論理単位でCommitする。
3. Evaluator承認Diffとの一致を再確認する。
4. Task BranchをRemoteへPushする。
5. 同TaskのOpen PRがなければDraft PRを作成し、既存Open PRがあれば更新する。
6. Dependencyがある場合は正しいBaseと`Depends-On`を設定する。
7. PR本文へTask、Requirement／Done Criteria、変更、検証、文書／Security／Operations／Rollback、未実施事項、残Riskを記録する。
8. PRのURL、Head、Base、Draft状態、Files、本文を再取得して永続化を確認する。
9. RepositoryのIssue／Project追跡Ruleに従ってPR URLと状態を同期する。

PR Ready化・Mergeは別途明示依頼がある場合だけ行う。

## 完了報告

Task、満たしたDone Criteria、主要差分、TDD／Verification、Self Review、Independent Evaluator、Dependency／Stack、Branch／Commit／Draft PR、未実施検証、残Riskを報告する。
