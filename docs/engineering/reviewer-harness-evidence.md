# Issue #206: 4専門Reviewerの実動記録

2026-10-12、Codex CLI 0.157.1で[Issue #206](https://github.com/takeshi-arihori/kakei_app/issues/206)の受入検証を実施した。契約は[4専門Review](implementation-review.md)、起動方法は[Harness](codex-harness.md)を参照する。下記の合成Caseと実Taskの最終Reviewは別の評価である。

## 対象と隔離

基準developは`57f7674d4696589de973c14d5ebebea1e1be402f`。Planningは公開設計案の親CLI `01a12f2f-a2cb-7a02-9a42-972f99b4ceae`と保存後の親CLI `01a12f33-9cf8-7823-b437-69829a065d30`でそれぞれpass。Planning Roleは維持し、実装Gateだけを4役へ移行した。

各Roleは個別の新規CLI SessionからProject登録と同じTOMLを明示参照し、別のcustom role子Threadを起動した。`--ignore-user-config`、`--strict-config`、read-only／承認neverとHarness記載の機能無効化を併用した。構成済みModelがCLI非対応だったため、検証時だけ`gpt-6-sol`を指定した。RepositoryのModel／Reasoning設定は追加していない。

全8子のSession metadataでRole、read-only、neverを確認した。ALL_TOOLSは`apply_patch`、`clock__curr_time`、`view_image`、`web__run`。Shell、GitHub／MCP書込み、操作型Browser等の外部書込み経路はなかった。協業・待機の制御面と実呼出しも照合し、Reviewer間の結論交換はなかった。各子による唯一の一時File作成ProbeはSandboxに拒否され、親も全対象Fileの不在を確認した。実GitHubへの書込みProbeは行っていない。

## 合成Case F0 → F1

実Productに接続しない2 FileのFixtureを使った。整数入力長の両境界、固定ラベル、labelだけの返却を契約とし、secretは架空値`SYNTHETIC_ONLY`だけを使用した。[構造化Evidence](evidence/issue-206-reviewers.json)に契約、両版の全File本文、Hash算出方法、親子Thread ID、開始時刻、Tool／Probe、個別原結果、Testログ、集計入力を保存している。個人設定、認証情報、Private Projectの生データ、Session全文は含めていない。

| Cycle | Diff SHA-256 | Test／集計 |
| --- | --- | --- |
| 0 / F0 | `afdaf44d3a7f40a450976f49d4b8a024ada7f0fd0f04d85aad00e57fab029edf` | 既存2 Testは成功したが、4役すべてfail。Gateはfail／repair（Exit 1） |
| 1 / F1 | `0cd13ad6ec6590b9fde9619d85e802cf7f90f4957730afd4904381a3766bdf74` | 親がTest追加でRedを確認後、3関数を修正。8 Test成功。新規4役すべてpass、Finding／不足Evidenceなし。Gateはpass／draft-pr（Exit 0） |

| Role | F0の子Thread / 検出内容 | F1の新しい子Thread |
| --- | --- | --- |
| code_reviewer | `01a12f43-5906-7803-bb7a-fc1c64b8eb40` / 負数許可・上限一致拒否 | `01a12f47-dcf6-72a0-8025-77bf31945c1d` |
| test_reviewer | `01a12f40-93ba-7eb3-ab20-141d61c229ab` / 境界・ラベル完全一致・secret除外のTest不足 | `01a12f47-eb51-77d2-93e1-6531b68a3826` |
| spec_reviewer | `01a12f40-a388-7b21-ad0a-a25a5bf703cf` / 契約の固定ラベル等が未実装 | `01a12f47-bad3-7323-ae0e-cdbc792d90da` |
| security_reviewer | `01a12f40-df3c-7631-a5c7-017a0eedb993` / 架空secretが返却値へ混入 | `01a12f47-a43b-7fd2-8551-ccc4c0ddaa78` |

F0のCode起動1回がModel capacityで判定前に失敗した。同じ固定入力で新Sessionを起動した上表の結果を採用し、元の失敗ログは親が別途保持した。起動失敗をpassや修正Cycleに数えていない。Reviewer自身はShellを持たず、Testは親の実行結果と提示された全文を照合した。Security F1の子はProbe File不在を独立確認していないと明記しており、親による実物確認で補完した。

## 決定的な停止条件とRepository QA

`pnpm review:check`の17契約Testで、4役pass、1役fail、1役blocked、欠落・重複・古い対象・Thread再利用、不正JSON相当の入力、権限不明／書込みTool、Blocker、最大3回の修正と最後のpassを検証する。最終Code Reviewの指摘を受け、pass後の対象変更・失効Evidenceと新規4役の履歴、およびblocked解消後の原結果・解消根拠・同一対象・新Thread・修正回数維持の回帰Testを追加した。CLI 0.162系で列挙された汎用Resource読取り3 Toolは、親が読取り機能と確認して許可一覧へ追加した。未解消blockedはstop、Cycle 3でもfailならrepair-limit／stopとなる。これは集計の契約検証であり、実際に4回LLMを起動した記録とは区別する。

実動集計はEvidenceの`gateInput`を一時JSONへ取り出し、`node scripts/qa/review-gate.mjs <JSON>`で再現できる。最後のCycleを除いて`currentTarget`をCycle 0へ合わせればfail／repairとなる。Evidence参照先は親の実物照合を記録しており、Script単体がSandboxや原結果の真正性を保証するものではない。

TOML構文・5 Role参照・read-only・Planning Roleの不変、Skill Governance、134件の文書Link／Skill frontmatter、`git diff --check`と`pnpm check`が成功した。公式Config SchemaでProject設定と各RoleのConfig Layerを検証し、Role固有のname／descriptionは必須非空・参照整合とCLIのstrict loadで確認した。Root QAのApplication工程はTurboの同一入力Cacheを使用した。Product機能、API、DB、依存Packageを変更していないためProduct E2Eは非該当。Harness E2Eは上記の実動で確認した。

実Taskの最終Diffは、認証MigrationのPR #223を含む最新develop `5024fb839a462b884f8d8a9ac84153f97106401a`へ追従した後、このEvidenceを含めて新規4役へ渡す。その対象識別子、個別結果とDraft PR追跡はIssue／PRへ記録し、合成Caseのpassを流用しない。
