# Codex設定の管理と監査

[Task #131](https://github.com/takeshi-arihori/kakei_app/issues/131)として2026-09-27に最新`develop`（`bbf6adc1e41c6ca5d79d303842f0f42d765d634d`）と公式資料を照合した。実動確認は後続の[Task #130](https://github.com/takeshi-arihori/kakei_app/issues/130)で行う。

## Layerの責務

| Layer | 責務 |
| --- | --- |
| User-level | Project trust、利用者のModel／Reasoning、Machine／Provider／Credential、個人のPermission設定。Repositoryへコピーしない |
| `.codex/config.toml` | 2つのEvaluatorの参照先。親AgentのSandboxは固定しない |
| `.codex/agents/*.toml` | role名、説明、評価指示、JSON契約、`sandbox_mode = "read-only"` |
| 実行時 | 実効権限、利用可能Tool、Model、並列枠を確認。設定だけで実動成功とはしない |

根拠は公式の[Config Reference](https://developers.openai.com/codex/config-reference)、[Subagents](https://developers.openai.com/codex/multi-agent)、[JSON Schema](https://developers.openai.com/codex/config-schema.json)。Project設定はtrusted projectで読み込まれる。Machine／Provider等にはProjectで上書きできない設定がある。

## `.codex/`の全ファイルと全設定

監査時点のファイルは次の3つのみ。Cache、生成物、未参照の補助ファイルはなかった。

| File | 判断 |
| --- | --- |
| `config.toml` | role参照を保持し、既定値と説明の重複を削除 |
| `agents/task-evaluator.toml` | Engineering Loop I5の独立評価に必要。保持 |
| `agents/work-planning-evaluator.toml` | Engineering Loop D3の独立評価に必要。保持 |

### Project設定（変更前の全Key）

| Key | 判断・理由 |
| --- | --- |
| `agents.enabled = true` | 削除。現行の既定値と同じ。上位設定で無効なら読み込み確認で検出 |
| `agents.task_evaluator.description` | 削除。Agent TOMLの説明と二重管理になっていた |
| `agents.task_evaluator.config_file` | 保持。`agents/task-evaluator.toml`を明示参照 |
| `agents.work_planning_evaluator.description` | 削除。Agent TOMLの説明を正本にする |
| `agents.work_planning_evaluator.config_file` | 保持。`agents/work-planning-evaluator.toml`を明示参照 |

`#:schema`はEditor用コメントであり実行設定ではない。保持する。`config_file`は宣言元`.codex/config.toml`を基準に解決され、両Pathは`.codex/agents/`内の実在ファイルを指す。現行CodexにはAgent TOMLの自動探索もあるが、参照関係を明示するため登録を維持する。説明と振る舞いは各roleファイルだけで定義する。

### Agent TOML（両role共通の全Key）

| Key | 判断・役割 |
| --- | --- |
| `name` | 保持。`task_evaluator`／`work_planning_evaluator`の識別子 |
| `description` | 保持。role選択の説明の正本 |
| `sandbox_mode` | 保持。子の既定値を`read-only`にする |
| `developer_instructions` | 保持。参照docs、変更禁止、評価観点、JSON契約 |

Agent TOMLは子の設定Layerである。Model／Reasoningのrole指定はなく、実行時指定、共通Subagent設定、親設定から解決する。特定Modelへ固定する品質上の根拠は現時点でない。Product固有のDB／言語／Framework／API方式は固定せず、Repository docsを読む構造を維持する。

### 追加を検討した設定

| Key | 判断 |
| --- | --- |
| `agents.max_concurrent_threads_per_session` | 未設定。各CycleにEvaluatorを1つ使うLoopに固定並列数は不要。実行環境の既定値に任せる |
| `agents.interrupt_message` | 未設定。既定の有効状態でよい |
| `agents.default_subagent_model` | 未設定。親／実行環境の選択を利用 |
| `agents.default_subagent_reasoning_effort` | 未設定。同上 |
| `agents.max_threads` | 旧Aliasなので採用しない |
| Project共通のSandbox／Permission Profile | 追加しない。親の編集まで制限せず、Evaluatorの既定値をroleに置く |

監査前後ともdeprecated Key／旧Aliasは使っていない。Keyを追加する場合は公式Schemaと使用Versionの両方を確認する。

## 読み込み・権限の確認

1. Repositoryを作業Directoryとして開き、`codex --version`を記録する。App利用時はApp Versionを別途記録し、CLI Versionで代用しない。
2. User-levelの対象Projectがtrustedか確認する。未信頼なら利用者が内容を確認してtrustを設定する。利用者の絶対Pathやtrust設定をRepositoryへ保存しない。
3. TOML構文、参照Path、role名を確認する。変更後は新しいセッションを開く。
4. Agent一覧または起動Toolで両roleを確認する。role固有の指示とJSON契約が読み込まれることも確認する。
5. Evaluatorの実効権限とTool履歴を確認する。親だけがCode、文書、Index、GitHubを変更し、Evaluatorは読取りと判定だけを行う。

`sandbox_mode = "read-only"`はファイルシステムの既定値であり、GitHub等の外部サービスへの書込み権限を単独で取り消すものではない。#131で保証するのは、Evaluatorのfilesystem read-only既定値と、両roleの`developer_instructions`によるCode／文書／GitHub変更禁止までとする。Repository-local設定だけで外部Toolの実効書込み権限を保証できるとは扱わない。

GitHub等の外部Toolの実効権限は#130で検証する。Evaluatorに書込みToolが利用可能、または書込み不可を確認できない場合はHarness前提未達として`blocked`にする。Evaluatorへ書込みToolや認証情報を追加しない。

親の実行時Permission指定が子にも再適用され、roleのSandbox既定値より優先される場合がある。実効権限が`workspace-write`等ならOSによるread-onlyの成立を主張しない。実効read-onlyを確認できる環境で再検証し、確認できない間は#130の該当条件を未達として報告する。親全体を恒久的にread-onlyにして回避しない。

## Troubleshooting

| 症状 | 確認・対処 |
| --- | --- |
| Project設定が読まれない | 作業Directory、trust、上位／実行時設定、セッション再起動を確認 |
| roleが見つからない | TOML構文、参照Path、`name`、使用Version、User-levelの同名roleとの競合を確認 |
| Subagent Toolがない | 実効`agents.enabled`と環境の対応状況を確認。旧Aliasを追加しない |
| 変更が反映されない | 既存Threadを使い回さず新規セッションで確認 |
| 子も書込み可能と表示される | Permission overrideを確認。指示の遵守とSandboxによる強制を分けて記録 |
| 未知Keyがある | 使用Versionの`--help`を確認。対応版では`--strict-config`で検出し公式Schemaとも照合 |
| 並列枠が不足 | 結果を回収し次のCycleを順次起動。必要性を確認してから上限を設定 |

## 検証境界

TOML構文、公式Schema、参照整合、`pnpm skill-governance:check`は静的検証である。Schema照合では通常ConfigにないAgent metadata（`name`、`description`）を必須文字列として別途確認し、残りをConfig Schemaへ渡す。`developer_instructions`もAgentとして必須の非空文字列であることを確認する。

`codex doctor`はMachine全体も診断する。Configがloadedでも環境状態や接続の問題で非0終了するため、設定検証と診断全体の成功を混同しない。個人環境の診断全文はPublic Issue／PRへ貼らない。

#131は設定の監査・整理を担当する。独立起動、`pass / fail / blocked`、修正後の新しいEvaluator、実効権限、Draft PRへのGateの実動Evidenceは#130で記録する。[Engineering Loop](engineering-loop.md)の承認条件は維持する。
