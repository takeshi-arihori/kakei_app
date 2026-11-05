# Worktree運用

この文書は、このProjectで追加のGit worktreeを使うときの保存先とLifecycleを定める。Branch、Commit、Task境界は[Delivery Workflow](delivery-workflow.md)に従う。

## 保存先

- 追加worktreeはProjectのprimary checkout直下にある`.worktree/<用途>/`へ作成する。
- 既にworktree内で作業中の場合も、worktreeを入れ子にせず、Projectのprimary checkoutの`.worktree/`を使う。
- `.worktree/`は作業用checkoutの保存先とし、その中のsource codeをprimary checkoutのsource codeとして扱わない。
- Projectの`.gitignore`で`/.worktree/`をignoreする。共通ruleを導入するときは、このProject内のignore設定も合わせて確認する。
- `.worktree/`配下のファイル、diff、未commit変更は、通常のProject rootとは独立したworktreeのGit stateとして確認する。

## 作成方法

希望する保存先を受け付けるworktree toolがあれば、その機能でProject rootの`.worktree/<用途>/`を指定する。保存先を指定できず、Project外の管理Directoryに作成する機能は、このProjectの保存先ruleを満たさない。`.worktree/`を求める作業では、primary checkoutからGitの`worktree add`を使い、保存先を明示する。

```bash
git worktree add -b feat/issue-number-short-name \
  .worktree/issue-number-short-name origin/develop
```

追加worktreeを作る前に、既存Branch／Worktree、dirty state、base Commitを確認する。Project rootの`.gitignore`に`/.worktree/`がなければ追加し、作成予定Pathがignoreされることを`git check-ignore`で確認する。ignoreされない状態では`worktree add`を実行せず、ignore設定を直すか阻害要因を解消する。Branch名とbaseはTaskとDelivery Workflowに合わせる。既に使われているBranchを再利用するときは、新しいBranchを作らず既存Worktreeを確認する。

## 後片付け

作業が完了したら、`.worktree/`配下のそのworktreeとローカルBranchを必ず削除する。完了は、PRのMergeを確認した時点とする。PRを作らない作業では、結果を保存して作業を終えた時点とする。

1. 未commit変更がないこと、関連する作業やProcessが残っていないことを確認する。
2. PRがある場合は、HEADがMerge済みPRのHeadと一致することを確認する。PRがない場合は、未push Commitがないことを確認する。
3. `git worktree remove`でworktreeを削除し、ローカルBranchを削除する。Squash mergeしたBranchは`git branch -d`で消せないので、2の確認後に`git branch -D`を使う。

次の場合は削除せず、理由を報告する。

- 他のSessionが作業中である。
- 未保存の内容が残っている、または変更を確認できない。

primary checkoutは削除しない。
