# 実装前Planの置き場所とEpic統合Branch

- Status: Accepted
- Owner: Project Owner（takeshi-arihori）
- 承認日: 2026-11-17
- Decision Check: 開発Processの変更あり
- 承認記録: [Issue #281](https://github.com/takeshi-arihori/kakei_app/issues/281#issuecomment-6931590542)（Owner会話承認「論点1〜4を推奨案で採用」）
- 関係: Supplements [GitHub正本への切替](github-canonical-cutover.md)。正本の分担は変えず、非正本の作業領域とEpic単位の統合Branchを加える

## Context

ADR #278では、設計判断と実装がそれぞれ別のIssue・PRになり、手戻りと往復が増えた。

- ADR Proposal PR（#279）、Accepted化の承認同期PR（#280）、分割後の実装Taskが、それぞれ別のPRになった。
- ADRに依存する実装は、ADRがAcceptedとして`develop`へ入るまでReadyにできなかった。
- TaskごとにPRを`develop`へMergeしていたため、Taskの順序によっては、整合証跡なしで開通するRestoreのような半端な状態が一時的に`develop`へ入る。これを避ける分割順序の設計に手間がかかった。

## Decision

### 1. Planと設計判断の置き場所

- 実装前のPlan、調査メモ、検討中の設計は、primary checkoutの`.claude/plan/<Issue番号>-<短い名前>/`に置く。`.gitignore`で`/.claude/plan/`を除外し、Commitしない。
- `.claude/plan/`は正本ではない。独立Reviewer、他のWorktree、他のSession、将来の参照が必要とする内容は、Issue、ADR、docs、PRのいずれかに書く。
- Ownerが採用した設計判断は、その判断に依存する最初の実装PRに、Accepted ADRとして同梱する。Proposal PRと承認同期PRは作らない。依存する実装がない判断だけを扱う場合は、ADRだけのPRにする。
- Accepted ADRを変更するときは、従来どおり新しいADRを作って履歴を残す。

### 2. Epic統合Branch

- Task Issueを2つ以上持つEpicを実装するときは、最新`develop`から`epic/<Epic番号>-<短い名前>`を作る。
- 各TaskのPRは、Epic Branch（Stackの場合は直接の前提Branch）をBaseにして、Squash mergeする。
- Epic Branchを`develop`へ追従させるときは、Baseを`epic/...`、Headを`develop`としたPRをmerge commitでMergeする。Epic Branchをrebaseしたり、force pushしたりしない。
- 一覧のTaskがすべてCloseしたら、Epic Branchから`develop`へのPRを作り、merge commitでMergeする。これにより、`develop`にTask単位の履歴が残る。このMergeはOwnerの明示依頼がある場合だけ行う。
- PRサイズの目安（約500行）はTask PRに適用する。Epic→`develop`のPRには適用せず、本文に含まれるTask PRを列挙する。
- Epic完了前に`develop`で必要な修正は、通常のTaskとして`develop`へ入れる。そのあと、Epic Branchを`develop`へ追従させる。
- 適用は、この決定より後に実装を始めるEpicからとする。進行中のEpic #202は従来のRuleのまま進める。

### 3. Stackの標準化

Epic内でも、Code上の依存があるTaskだけをStackで直列にする。独立したTaskは、それぞれEpic BranchからBranchを作り、並行してPRを出す。Stackの一番下のPRのBaseはEpic Branchとする。

### 4. Owner採否のGate

- 設計判断を含むPlanningでは、論点と推奨案をOwnerへ示し、実装前に会話で承認を得る。
- 承認を得たら、親Agentが日付と内容を1行で、ADR IssueまたはEpic IssueのCommentへ記録する。このCommentが承認の証跡になる。
- 承認Commentがない判断に依存するTaskは、Readyにしない。承認前の判断は`.claude/plan/`にだけ置き、ADRとしてCommitしない。
- ADRをAcceptedとしてCommitするときは、承認日と承認CommentへのLinkを書く。ReviewerはこのLinkの有無を確認する。

## Alternativesと理由

| 論点 | 不採用案 | 理由 |
| --- | --- | --- |
| 1 | 設計判断も`.claude/plan/`だけに置く | 承認済みの判断の履歴とReviewの根拠がRepositoryから消える |
| 1 | 現行どおり、Proposal PR → 承認同期PR → 実装PR | 往復が多いというProblemが残る |
| 2 | Epic→`develop`をSquashする | Task単位の履歴が`develop`から消え、Taskの追跡と部分的なRevertが難しくなる |
| 2 | 現行どおり、Taskごとに`develop`へ | 半端な状態を避けるための分割順序設計の負担が残る |
| 3 | Epic内のTaskを常に1本のStackにする | 独立したTaskまで直列になり、上流の修正がStack全体のrebaseに波及する |
| 4 | PRのReview時にOwnerが承認する | 不採用の判断が出ると実装の手戻りが大きい。未承認の判断を含む実装をMergeしない保証が、Reviewの運用だけになる |

## Consequences・Implementation

- `.gitignore`、AGENTS.md、[Engineering Loop](../engineering/engineering-loop.md)、[Delivery Workflow](../engineering/delivery-workflow.md)、[PR依存関係Gate](../engineering/pr-dependency-gate.md)、[Worktree運用](../engineering/worktree-management.md)、[正本入口](../governance/README.md)、関連Skillを同じPRで更新する。
- `epic/**`をBaseとするPRにも、CI（`品質検証`）と`依存PR確認`を実行する。
- `epic/**`のRuleset（Required check、削除禁止、force push禁止）はRepository設定であり、Ownerが設定する。設定するまでは、上記のRuleを運用で守る。
- Epic Branchが長く残るため、`develop`との衝突は追従PRで早めに解消する。

## Review Trigger

- Planを非公開にしたことで、独立ReviewやOwner承認の証跡が追えなくなった場合。
- Epic Branchが長く残り、`develop`との乖離や衝突の解消が負担になった場合。
- Epic→`develop`のPRが大きすぎて、統合時の確認が成立しなくなった場合。
