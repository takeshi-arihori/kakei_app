# Worktree運用

この文書は、このProjectで追加のGit worktreeを使うときの保存先とLifecycleを定める。Branch、Commit、Task境界は[Delivery Workflow](delivery-workflow.md)に従う。

## 保存先

- 追加worktreeはProjectのprimary checkout直下にある`.worktree/<用途>/`へ作成する。
- 既にworktree内で作業中の場合も、worktreeを入れ子にせず、Projectのprimary checkoutの`.worktree/`を使う。
- `.worktree/`は作業用checkoutの保存先とし、その中のsource codeをprimary checkoutのsource codeとして扱わない。
- Projectの`.gitignore`で`/.worktree/`をignoreする。共通ruleを導入するときは、このProject内のignore設定も合わせて確認する。
- `.worktree/`配下のファイル、diff、未commit変更は、通常のProject rootとは独立したworktreeのGit stateとして確認する。

## 作成方法

希望する保存先を受け付けるworktree toolがあれば、その機能でProject rootの`.worktree/<用途>/`を指定する。Codexのmanaged worktree作成機能が保存先を指定できず、Project外の管理Directoryに作成する場合は、このProjectの保存先ruleを満たさない。`.worktree/`を求める作業では、primary checkoutからGitの`worktree add`を使い、保存先を明示する。

```bash
git worktree add -b codex/feat-issue-number-short-name \
  .worktree/issue-number-short-name origin/develop
```

追加worktreeを作る前に、既存Branch／Worktree、dirty state、base Commitを確認する。Project rootの`.gitignore`に`/.worktree/`がなければ追加し、作成予定Pathがignoreされることを`git check-ignore`で確認する。ignoreされない状態では`worktree add`を実行せず、ignore設定を直すか阻害要因を解消する。Branch名とbaseはTaskとDelivery Workflowに合わせる。既に使われているBranchを再利用するときは、新しいBranchを作らず既存Worktreeを確認する。

## 後片付け

- 終了前に、worktreeに未保存の変更がないこと、関連する作業やProcessが残っていないことを確認する。
- Managed Codex worktreeはCodexのarchive機能を使う。
- 手動作成したworktreeは、未commit変更・未push Commitを確認し、必要な状態が保存済みの場合に限り`git worktree remove`で削除する。
- 作業中のworktree、変更を未確認のworktree、primary checkoutは削除しない。
