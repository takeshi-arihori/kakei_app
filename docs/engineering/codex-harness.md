# Codex Harnessの実動検証

対象は[Task #130](https://github.com/takeshi-arihori/kakei_app/issues/130)。設定の責務と監査結果は[Codex設定](codex-configuration.md)、工程と合否条件は[Engineering Loop](engineering-loop.md)を正本とする。

## 起動前提

- 対象Repositoryをtrusted projectとして開く。
- `.codex/config.toml`と参照先のAgent TOMLを構文・Schema・参照整合で確認する。
- 使用するClientとVersion、基準Commit、Diff、ReviewInputを記録する。
- `work_planning_evaluator`と`task_evaluator`が起動Toolで選択できることを確認する。通常Agentへ置き換えて成功扱いにしない。
- 個人設定、認証情報、セッション履歴の全文をEvidenceへコピーしない。

## 起動方法

親Agentへ対象roleとReviewInputを渡し、独立Subagentとしての起動を明示する。

```text
work_planning_evaluatorを新しい独立Subagentとして起動し、
Problem、Requirement、Done Criteria、現状Evidence、設計、
Task分解案、Dependencies、Decisionをread-onlyで評価してください。
RepositoryとGitHubは変更せず、role既定のJSONを返してください。
```

Implementationでは`task_evaluator`を指定し、Requirement、Done Criteria、関連docs、Base Commit、Diff識別子、変更File、Test結果、未実施理由、Self Review、残Riskを渡す。

起動APIはClientで異なる。この実行環境では`collaboration.spawn_agent`の`agent_type`へrole名を指定できる。Tool名の表示だけで成功とせず、子の起動結果、role固有指示、判定JSONを確認する。

## 実効read-onlyの確認

Agent TOMLの`read-only`指定と子の実効権限を照合する。親の実行時Permission overrideが再適用される環境では、子も`workspace-write`になる場合がある。指示に従って編集しなかったことと、Sandboxが編集を禁止したことを区別する。

切り分けには、通常作業セッションとは別の一時的なread-only CLIセッションを使える。通常作業の親設定やProject共通設定は変更しない。下記は検証専用Promptを用意した場合の例である。

```bash
rtk proxy codex --version
rtk proxy codex exec --strict-config --sandbox read-only \
  --json --output-last-message /tmp/harness-result.json \
  - < /tmp/harness-prompt.txt > /tmp/harness-events.jsonl
```

上記は初回の起動診断で使った例であり、Shell経由のGitHubアクセスを残すため合格用には使わない。実TaskのEvaluatorは次の隔離条件で起動する。使用するCLIの`--version`と`exec --help`で全Optionが利用可能なことを先に確認する。`PATH`に古いCLIがある場合は、確認済みの実行Fileを例中の`codex`の代わりに指定する。OptionがないVersionでは同等の隔離を確認できるまでGateを止める。

```bash
rtk proxy codex exec --strict-config --sandbox read-only \
  -c 'approval_policy="never"' \
  --disable shell_tool --disable apps --disable plugins \
  --disable browser_use --disable browser_use_external \
  --disable computer_use --disable in_app_browser \
  --json --output-last-message /tmp/harness-result.json \
  -C "$PROJECT_CHECKOUT" \
  - < /tmp/harness-prompt.txt > /tmp/harness-events.jsonl
```

`PROJECT_CHECKOUT`はtrustedな対象Checkoutの絶対Pathを親が指定する。実行Fileの場所や個人の設定PathをRepositoryへ固定しない。Promptには対象IssueのRequirement／Done Criteria、関連docs、Project状態、Dependency、基準Commit、最新Diff、Test結果、Self Review、既知Riskを**内容付きで**渡す。Shellを無効にした子はFile PathやURLだけでは正本を取得できない。`--output-last-message`のJSONだけでなく、Eventと子Sessionを見てproject-local role名、子ID、実効Sandbox、使えるToolと実際のTool呼出しを確認する。外部書込みTool、Shell、操作型Browser／Computerが子へ残る場合、または権限を確認できない場合は`blocked`にする。

安全な一時File作成Probeでread-only Sandboxの拒否とFile不在を確認する。GitHubへの試験書込みは行わない。FilesystemのProbeだけでGitHub書込み不可とは推論せず、外部連携とShellのTool境界も確認する。CLI自体の起動が外側のSandboxで拒否される場合は実行許可を得る。CLI内部の`--sandbox read-only`は維持し、Sandbox無効化で回避しない。`--ephemeral`は今回のCLIでは子Agentの親Thread解決に失敗して`no thread with id`になったため使用しない。これは観測結果であり、全Versionでの原因確定ではない。

子の実効権限情報、実施Tool、親による変更前後のGit状態をEvidenceへ記録する。Git状態だけではGitHubへの書込み禁止を証明できないため、外部Toolの利用履歴も確認する。権限情報が得られなければ強制read-onlyは未確認とする。

## 合否と再評価

| 結果 | 親の操作 |
| --- | --- |
| `pass`かつfindings／missingEvidenceが空 | 対象Diffの一致を確認して次工程へ進む |
| `fail` | 指摘を修正し、再検証・Self Review後、新しいEvaluatorで評価 |
| `blocked` | 依存工程を停止し、未決Decision・権限・正本Conflictを解消 |
| JSON不正／証拠不足／未実施 | 合格扱いにせず原因を確認 |

修正後に同じEvaluator Threadを再利用しない。検証用Caseではメモリ上のPlanning／ReviewInputを親が補正し、実Projectへ架空のIssueや判断を保存しない。本番Deliveryの変更は通常の親Agentだけが行う。

## 安全な検証Case

| Case | 入力 | 観測対象 |
| --- | --- | --- |
| P1 | 曖昧なDone Criteriaと検証方法のない文書Planning | 親が修正できる不足を検出 |
| P2 | P1を観測可能なDone Criteria・検証方法へ修正 | 新しいPlanning Evaluatorで再評価 |
| B1 | Ownerの重要判断が未承認という架空の前提 | `blocked`と依存工程の停止 |
| I1 | 文書リンク追加のReviewInputから検証Evidenceを意図的に省略 | 不足Evidenceを検出 |
| I2 | 親がリンク・リンク先を検証して結果を補完 | 新しいTask Evaluatorで再評価 |

期待と違う結果もそのまま記録する。合成Caseの合格は実Taskの最終Diffの承認を代替しない。最終Diffは別の新しいEvaluatorへ渡す。

## Troubleshooting

- roleが見つからない、Configが読まれない、未知Key: [設定のTroubleshooting](codex-configuration.md#troubleshooting)を確認する。
- CLI起動が`Operation not permitted`: 外側の実行制限とCLI内部のSandboxを切り分ける。
- 子の実効権限が期待と異なる: 親の実行時Permission指定を確認し、専用セッションで再検証する。
- `pass`でもFindingが残る: Gateを開けず、不足を補って新しいEvaluatorへ渡す。
- Evaluatorが変更を行う: そのCycleを合格にせず、変更範囲を確認して原因を解消する。
- CLI版とApp版で結果が異なる: Versionと起動方法を別々に記録する。片方の結果をもう片方の成功証拠にしない。
- `--ephemeral`で`no thread with id`: 保存ありの新規CLI Sessionで再試行し、親と子のThread識別子・結果を確認する。
- Filesystemはread-onlyでもGitHub書込みToolが子へ公開される: Tool一覧と実効権限を別途確認し、書込みを禁止できない環境ではHarness前提未達としてGateを止める。CLIの`--ignore-user-config`やApps／Pluginsの無効化だけで外部Tool・Shell経由のGitHubアクセスが消えるとは仮定しない。

## Evidenceの記録項目

Client／Version、Base／評価Diff、読み込んだConfig、role名、子識別子、ReviewInput概要、実際のJSON結果、親の修正、再検証、新しい子、実効権限、Tool履歴、Gate判断、Draft PRまたは検証終了結果を記録する。

`pnpm check`はRepository QAであり、Subagent起動と権限制御を自動検証するものではない。文書・Configのみの場合は構文・Schema・リンク確認をTDDの代替とし、実動検証と区別して報告する。

## 実行記録（2026-09-27）

実行対象のIssue #130はOpenで`work: task` Labelがある。PR #129はMerge済み、設定監査PR #132もMerge済み。最初の実行基準は`0becaf9f55a56d5d1d5ad6863a2f7ecb2d984897`。その後`origin/develop`を取り込み、検証Branchの基準を`9ab16789af6fd25c9f3f3c9b2039fec9bcdc85aa`へ更新した。GitHubのIssueにProject Itemはなく、Ready Fieldを確認できないため、Project Readyを推測しない。

| Case／検証 | 実際の結果 |
| --- | --- |
| Codex CLI | `codex-cli 0.157.1`。trusted Repositoryでproject-local設定と両Agent TOMLを読取。実行CLIは`--strict-config --sandbox read-only --ephemeral` |
| Planning P1（合成Case） | 新しい`work_planning_evaluator`が曖昧なDone Criteriaと検証方法の不足を`fail`として返した |
| Planning P2 | P1に対しDone Criteriaと検証を補った。CLIの新規Evaluator起動が`no thread with id`で失敗し、判定JSONを得られなかった。独立Planning Reviewは未達 |
| Planning P3 | 別のEvaluatorがPlanning案を`fail`。文書化と静的CheckだけではIssue #130が求める両Loopの実動Evidenceにならないと指摘 |
| Planning B1 | Owner承認待ちという架空Caseに新しいEvaluatorが`blocked`を返し、Decision前にReadyへ進めないことを確認 |
| Implementation I1 | `task_evaluator`がREADMEリンクの実在／解決結果の不足を`fail`として返した |
| Implementation I2 | 親がREADMEのローカルLinkと手順見出しを確認し、`pnpm check`の成功結果を追加。**新しい**`task_evaluator`が`pass`（findings／missingEvidenceなし） |
| 実効権限 | 1つのread-only CLIセッションではPlanning子が実効`read-only`とrole指示の読込を報告。しかし別のEvaluator起動では`no thread with id`となり、両roleそれぞれの継続起動を証明できなかった。別の親subagent環境は`workspace-write`を報告。両roleの強制read-onlyが一貫して有効という条件は未達 |
| 再実行（保存なし） | `--ephemeral`を指定した新しいread-only CLIセッションも、custom role起動時に`no thread with id`で停止。使用上限に達したセッションには最終JSONがなく、成功扱いにしない |
| 再実行（保存あり） | `--ephemeral`を外したCodex CLI 0.157.1の新規Sessionでは、project-localの両roleが独立起動した。合成CaseでPlanning P1=`fail`、修正後に新EvaluatorのP2=`pass`、Implementation I1=`fail`、証拠補完後に新EvaluatorのI2=`pass`。P1とI1の子は実効`read-only`を報告。P2とI2の子は権限を結果へ記載しなかったため、その2件の子ごとの実効権限は未確認 |
| Decision待ち | 保存あり・`--ignore-user-config`・roleファイルの明示参照で、新しいPlanning子`/root/planning_b1_independent`がOwner未承認Decisionを`blocked`と判定。子は実効`read-only`、承認Policy `never`、Network `restricted`を報告 |
| 外部Tool | 同じB1の子は`github_create_issue`、`github_update_issue`、`github_merge_pull_request`等のGitHub書込みToolが公開されていると報告。Toolは呼び出していない。Tool一覧・権限を機械的に取得しておらず、自己報告の正確性と書込み不可は未確認。`--ignore-user-config`だけではproject-local roleを選択できず、roleファイルの明示参照を加えた実行でも書込み不可を証明できなかった |
| 外部Toolを無効化した再試行 | CLI起動時にApps、Plugins、Browser、Computer Useを無効化してもproject-local Planning子は起動し、B1を`blocked`と判定。子の自己報告ではTool一覧にGitHub書込みToolはなかった。ただし同じCLI設定のread-only Sandboxから、親が読取り専用の`gh api rate_limit`を実行するとExit 0でGitHubへ到達した。ShellとGitHub認証が残るため、外部書込み不能は立証できない |
| Repository QA | 更新した`develop`基準で`pnpm check`成功。Skill Governance、API docs、Codegen、Lint、Typecheck、Test、Buildが通過。`git diff --check`も成功 |
| 最新差分の独立Review | 新しいproject-local `task_evaluator`が本手順書を含む3文書の現差分を確認し`blocked`と判定。GitHub書込み不能、P2／I2の実効権限、実Taskの全LoopのEvidence不足を指摘。Issue本文の一時ファイルはCLI Sandboxから読めなかった可能性があるため、Issue正本全体の照合成功とは扱わない |
| 親以外の変更 | CLI起動前後でHEAD、Index、README差分、手順書のSHA-256は一致。CLIはread-only指定で、Agentに書込みを依頼せず、書込み試行もしていない |

したがって、両roleの独立起動、合成Caseでの`fail → 親が入力修正 → 新Evaluatorでpass`、Decision待ちの`blocked`を確認できた。Project ConfigとRole TOMLの認識も確認できた。一方、P2／I2の子ごとの実効権限、GitHub書込みToolの利用不可、実Taskの全Loopを通じたDraft PR Gateの実動Evidenceは未確認である。親subagentの`workspace-write`環境をroleのread-only設定と同等に扱わない。[公式Subagentsの権限説明](https://learn.chatgpt.com/docs/agent-configuration/subagents)でも、子は親の実行時SandboxとToolを継承し得るため、Role TOMLだけで外部Toolの制限を主張しない。

**Issue #130はBlockedのままとする。** CLIのread-only SandboxからGitHubへ到達でき、子AgentのTool一覧を絞ってもShell経由の外部書込み不能を立証できない。#131で定めた外部Tool境界を満たす実行方法を確定し、最新Diffで両roleの実効権限と全Loopを再検証する必要がある。書込みToolを使わなかったことだけで書込み不能とは扱わず、Draft PR Gateは通過させない。

## 追補: 文書Taskを使ったHarnessの実動確認（2026-09-27）

上のBlocked判定はPR #138時点の記録である。今回は文書だけを変更する#130を検証対象にした。**Product機能のE2E Testは対象外である。** Product Requirement、Domain Rule、DB Schema、API Schema、UIなどのProduct挙動を変更していないためである。一方、#130の成果物はCodex Harnessそのものなので、完了条件である**HarnessのPlanning／Implementation Loop、両Evaluatorの独立起動・権限境界・Draft PR GateはE2Eで実動確認する。** `pnpm check`はRepository QAであり、このHarness E2Eの代わりにはならない。

利用者の#130実装指示を受け、`origin/develop`の`cc2328158171ae6af53be936b98ff5e5bbaa565c`から`codex/chore-issue-130-harness-gates`を作成した。PR #129、#132、#138はMerge済み、#127はClosedで、未Merge PRへの依存はない。Project #9の#130は、追補計画の保存前評価後にTask／Validation／AI・Tooling／Medium／Estimate 1／Milestone「開発支援基盤」としてReadyに設定し、保存後評価のpassを確認してからIn Progressに移した。元のIssue作成より前にD3を通したとは主張しない。

CLI 0.157.1の専用Sessionで、上記の隔離Flagを使いproject-localの`work_planning_evaluator`を起動した。親がIssue #130／#131、PR #132の現況、Project Field、Repository Rule、既存runbook、修正案を内容付きで渡した。最初の評価はReady根拠と依存状態で`fail`、以降もHarness検証条件の不足、fail-cycleの代替条件、Estimate根拠を指摘する`fail`が続いた。親が計画を修正し、**毎回新しい子**で再評価した結果、GitHub保存前の子`01a0e2cc-5684-7b81-8fce-9de01fb42771`が`pass`（findings／missingEvidence空）となった。その後に親がIssue本文とProject Fieldを保存し、再取得した内容を別の子`01a0e2d1-2aff-7ba1-a917-331dcdb29144`が`pass`（同じく空）と判定した。これが文書Taskを使った`fail → 親が修正 → 再評価 → 新Evaluator`とPlanning Gateの観測結果である。

この2つの子Sessionの記録には、CLI Version 0.157.1、親Thread ID、`sandbox_policy: read-only`、`approval_policy: never`、Tool呼出しなしが残る。read-only CLIでの安全な一時File作成Probeは`patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings`となり、Fileは存在しなかった。隔離FlagでShell、Apps、Plugins、操作型Browser、Computerを無効化したため、子へGitHub書込みToolとShellを公開していない。読み取り専用のWeb検索Toolは残り得る。個人の認証設定やSession全文はRepositoryへ保存しない。

文書差分については`pnpm check`、Link、`git diff --check`、Self Reviewの後、**新しい**`task_evaluator`へIssue正本・関連docs・最終Diff・検証結果を渡した。子`01a0e2da-9671-7742-8c00-043b895cdd7e`は`pass`（findings／missingEvidence空）で、実効Sandboxは`read-only`、承認Policyは`never`、Tool呼出しはなかった。評価Diff一致を確認した後にCommit、Push、[Draft PR #139](https://github.com/takeshi-arihori/kakei_app/pull/139)を作成した。これはHarnessのDelivery Gateの検証結果であり、Product機能のE2E Test結果ではない。
