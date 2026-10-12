# Codex Harnessの実動検証

現行I5は[Issue #206](https://github.com/takeshi-arihori/kakei_app/issues/206)の[4専門Review契約](implementation-review.md)に従う。工程は[Engineering Loop](engineering-loop.md)、設定の責務は[Codex設定](codex-configuration.md)を参照する。下部の#130記録は当時の履歴であり、旧Roleの起動手順を現行Gateとして使わない。

## 起動と隔離

1. 最新develop、TaskのReady、Dependency、作業Treeを確認する。使用Client／Versionと、評価するBase／Diff／入力Bundleを記録する。
2. `.codex/config.toml`の4 ReviewerとPlanning RoleのTOML構文、参照、名前、指示を確認する。新しいCLI SessionでRoleを選択できることを確認する。通常Agentへ置き換えない。
3. 親はIssue、docs、設計、Diffと変更File本文、Test／QA、Self Review、未実施理由、Riskを内容付きでBundleへ固定する。Path・Byte数・SHA-256・区切りを照合し、容量不足や切詰めは停止する。
4. 各Reviewerは別Threadで同じ対象を評価する。結論を他Reviewerの入力へ混ぜない。同じCoordinatorの履歴をforkする場合は結果受領前に全員へ同じ入力を渡す。逐次実行で独立性を保てない場合はRoleごとに新しい隔離CLI Sessionを使う。

以下はCLIで隔離を確認する基本形。`PROJECT_CHECKOUT`と入出力Pathは親が指定する。通常の親設定を恒久的に変更しない。

```bash
rtk proxy codex exec --strict-config --sandbox read-only \
  -c 'approval_policy="never"' \
  --disable shell_tool --disable apps --disable plugins \
  --disable browser_use --disable browser_use_external \
  --disable computer_use --disable in_app_browser \
  --disable image_generation --disable goals --disable hooks \
  --disable worktrees --disable remote_plugin --disable workspace_dependencies \
  --json --output-last-message /tmp/review-result.json \
  -C "$PROJECT_CHECKOUT" - < /tmp/review-input.txt > /tmp/review-events.jsonl
```

起動前に使用CLIの`--version`、`exec --help`、`features list`でOptionを確認する。設定済みMCP等の外部書込み経路は別途無効化する。個人設定を除外する`--ignore-user-config`を使う場合は、検証対象のProject Roleを`-c 'agents.<role>.config_file="<role TOMLの絶対Path>"'`で明示し、Project登録と参照が一致することを別途確認する。Model／ReasoningはRepositoryへ固定せず、起動時の値と選択理由を記録する。対応しないModel／Optionを成功扱いにしない。

各子の実効Sandbox／承認PolicyとTool一覧を確認する。安全な一時Fileへの作成Probeの拒否と、親が確認したFile不在を記録する。GitHubへの実書込みProbeは行わない。`apply_patch`の存在とSandboxによる拒否を区別する。Shell／command executor、書込み可能なMCP／外部Tool、画像生成等の実効書込み経路が残る、または確認できない場合はblocked。利用可能Toolと実際のTool呼出しは別々に記録する。

`--ephemeral`は旧検証で子の親Thread解決に失敗した。保存ありの新規Sessionを使い、Session全文・認証情報・個人設定を公開しない。外側SandboxがCLI起動を拒否した場合も、CLI内部のread-onlyを外して回避しない。

## 集計と修正

親は[共通結果](implementation-review.md)をRole／子Thread ID／実効権限Evidenceへ結び付けて保存する。原結果を上書きせず、Finding統合後も出典を保持する。

`pnpm review:gate -- /tmp/review-cycles.json`で記録の契約と次工程を確認できる。入力は次の形とし、初回から修正後までの全Cycleを渡す。

```json
{
  "currentTarget": { "baseCommit": "base", "diffId": "current" },
  "cycles": [{
    "baseCommit": "base", "diffId": "current",
    "reviews": [{
      "role": "code_reviewer", "threadId": "実際の子UUID",
      "runtime": {
        "sandbox": "read-only", "approvalPolicy": "never",
        "availableTools": ["apply_patch", "clock__curr_time", "view_image", "web__run"],
        "sandboxEvidence": "親が照合したSession metadataの参照",
        "probeEvidence": "拒否結果と親によるFile不在確認の参照",
        "toolInventoryEvidence": "全Tool面と実呼出しの照合記録"
      },
      "output": { "role": "code_reviewer", "cycle": 0, "baseCommit": "base", "diffId": "current", "result": "pass", "findings": [], "missingEvidence": [], "reviewedScope": ["確認範囲"], "unverified": [], "residualRisk": [] }
    }]
  }]
}
```

例では1役だけを示している。実入力には4役すべてが必要。終了Codeはpass=0、fail=1、blocked=2。未知Toolは親が監査して許可するまで停止する。集計Scriptは入力記録を検証する補助であり、実効Sandboxの強制、Evidence参照の真偽、現在のFileとの一致を自動保証しない。親が実物を照合してから使う。

全員pass後にHook等が対象を変更した場合、旧passを履歴に残し、新しい対象のCycleへ`previousTargetInvalidated`（失効した理由と変更Evidenceの参照）を追加する。4役すべてを新Threadで再評価し、修正回数はリセットしない。Resource一覧／読取りの汎用Tool（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）は読取り機能として集計の許可一覧へ含める。接続先が公開する別のToolやShell等は別途監査し、書込み経路を残さない。

failでは親だけがScope内を修正し、Test／QA・Self Review後に4役すべてを新Threadで再評価する。修正回数と停止は共通契約に従う。blocked後に外部条件が解消して同じ修正回数で再開する場合も、新Threadの結果を使う。入力の任意の`blockedHistory`へ`{ "cycle": 0, "review": "停止時の通常Cycleと同形式のObject", "resolutionEvidence": "親が確認した解消根拠の参照" }`を保存する。`review`は例の文字列ではなく4役の原結果を含むObject。再開する`cycles[cycle]`と同じBase／Diffで、停止結果はblocked、解消根拠があり、全履歴と再開時でThread IDが重複しない場合だけ受け入れる。停止記録を捨てず、修正回数をリセットして上限を回避しない。対象変更は通常の修正Cycleとして扱う。

## 受入検証

- `pnpm review:check`: 全員pass、fail、blocked、対象／Role／Thread不一致、3回の修正上限等の決定的な契約検証。
- 安全な合成入力: Code・Test・仕様・Securityの各Findingを担当Roleが検出することを確認する。実GitHubやProduct Dataを使わない。
- 親が合成File／入力を修正してTestを実行し、新規4役が同じ修正後対象へpassするE2Eを最低1回行う。
- 実Taskの最終Diffは別の新規4役で評価する。全員passと対象一致の後だけDraft PRへ進む。
- `pnpm check`、TOML構文／参照、Skill frontmatter／文書Link、Self Reviewを行う。静的Checkを実動起動・権限制御の代替にしない。

公開Evidenceは[Issue #206実動記録](reviewer-harness-evidence.md)へ必要最小限で記録する。未実施・失敗・未確認を成功へ読み替えない。起動不可、権限不明、JSON不正、正本Conflictでは依存Deliveryを停止する。

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
