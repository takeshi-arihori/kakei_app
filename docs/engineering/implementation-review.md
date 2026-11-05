# 実装の独立Review

[Engineering Loop](engineering-loop.md)のI5の契約。定義は`.claude/agents/`に置く。

## Role

| Role | 起動条件 | 確認すること |
| --- | --- | --- |
| `code-reviewer` | 常に | 正確性、責務分離、SOLID／DRY、適用されるDDD、依存方向、保守性、Accepted Design。Issue／Done Criteria、Accepted ADR／仕様との一致、未実装・過剰実装、未承認Decision、文書同期 |
| `test-reviewer` | 常に | Requirement／契約とTestの対応、正常・異常・境界・回帰、Test品質、実行結果、不足検証 |
| `security-reviewer` | 下記に該当するとき | 認証認可、入力検証、情報漏洩、Secret、暗号と鍵、永続Data、依存関係／Supply Chain、運用Security |

`security-reviewer`は、差分が次のいずれかに触れる場合に起動する。判断できない場合も起動する。

- 認証、認可、Session、招待等の権限境界
- 暗号、鍵、Secret
- Migration、永続Dataの構造や保持
- 公開API、外部入力の境界
- 依存関係の追加や更新
- CI、権限、運用設定、Agent定義、Skill、Hook、MCP設定
- Log、Error、Export、外部送信、公開文書、Evidence、Fixtureを通じて、個人情報、金融情報、Secretが外へ出る可能性がある変更

起動しない場合は、理由をReviewInputとPRへ記録する。`code-reviewer`は、その理由が起動条件と合うことを確認し、合わなければ`fail`とする。具体的な技術RuleはRepository docsとAccepted ADRから取得する。

`implement-github-task`が対象の固定、起動、結果の集計、GitHub Lifecycleを担当する。`feature-development`がScope内修正、Test／QA、Self Reviewを担当する。`code-review`はSelf Reviewであり、独立Reviewerの代替ではない。親だけがCode／文書／Git／GitHubを変更する。Reviewer同士の結果交換は禁止する。

## ReviewInput

親は各Reviewerへ次を渡す。Reviewerは書込みできないがRepositoryを読めるので、変更Fileの本文や適用docsは渡さず、自身で読ませる。

- `role`、`cycle`、`mode`（`full`または`incremental`）
- Task Issueの本文、Done Criteria、Dependenciesの状態。Reviewerはネットワークへ接続しないので、親が取得して渡す
- `baseCommit`、`diffId`、差分を保存した一時Fileのパス、変更行数（数え方は[Delivery Workflow](delivery-workflow.md)のPRサイズ）と目安を超えた場合の理由
- Test／QAのCommandと結果、Self Review、未実行の検証と理由、残Risk
- 起動しなかったRoleと理由

`diffId`はCommit、未追跡Fileを含めてStageしたgit tree、または未追跡Fileを含む変更一式のSHA-256とする。他のReviewerの結論は入力へ含めない。評価中に対象が変わった場合、その評価は無効にする。

## 個別結果

各Reviewerは次のJSONを返す。JSON不正、必須Fieldの欠落、想定Role／対象との不一致は合格扱いにしない。

```json
{
  "role": "code-reviewer",
  "cycle": 0,
  "baseCommit": "基準Commit",
  "diffId": "評価対象識別子",
  "result": "pass",
  "findings": [],
  "missingEvidence": [],
  "reviewedScope": ["実際に確認した範囲と非該当理由"],
  "unverified": [],
  "residualRisk": []
}
```

`result`は`pass | fail | blocked`。Findingは次のFieldを持つ。

```json
{
  "severity": "Major",
  "file": "Repository相対Pathまたはnull",
  "line": 1,
  "evidence": "確認済みの差分・再現結果",
  "requirement_or_doc_rule": "Issueの条件またはdocsの根拠",
  "minimum_fix": "当該Task Scope内の最小修正"
}
```

File／Lineが適用できないFindingでは両方を`null`とし、Evidenceで対象を特定する。SeverityはBlocker／Major／Minor。未確認事項・推測は`unverified`、必要だが不足する証拠は`missingEvidence`へ分ける。

Blocker／Majorまたは不足Evidenceが残る場合は`pass`にしない。ActionableなMinorは`fail`として親へ戻す。Scope外のDebtや好みだけの指摘はFindingにせず、必要なら`residualRisk`へ根拠とともに記録する。Owner Decision、未承認仕様、正本Conflict、重大Securityは`blocked`とする。

## 実効read-only

Reviewerの定義は`tools`を読取りToolだけに限定する。Shellや書込みToolを追加しない。`pnpm skill-governance:check`が定義の内容を検査する。

定義の内容だけでは実行時の権限を保証しないので、どのClientでも次を守る。

- 親は`.claude/agents/`の定義名を指定してReviewerを起動する。汎用Agentへ定義を読ませる方法で代替しない。
- Reviewerは利用可能なTool一覧を`reviewedScope`へ記録する。親は一覧が定義の`tools`と、呼出し元への結果返却専用Toolだけであることを確認し、結果をPRへ記録する。
- 定義を読み込めない場合、一覧にそれ以外のTool（特にShell、書込み、MCP）がある場合、確認できない場合は`blocked`とする。定義を追加した直後に読み込まれないSessionでは、新しいSessionで起動する。

## Review Cycle

初回評価をCycle 0とし、修正を最大3回だけ認める。4回目の修正を開始しない。

| Cycle | 対象Role | `mode` | 対象 |
| --- | --- | --- | --- |
| 初回 | 起動条件を満たすすべて | `full` | 評価対象の全差分 |
| 修正後の再評価 | `fail`または`blocked`を返したRole | `incremental` | そのRoleが前回確認した後の差分 |
| 最終確認 | 最新対象をまだ確認していないすべて | `incremental` | そのRoleが最後に`pass`した後の差分 |

最終確認で`fail`が出た場合は、修正1回として数える。修正が`security-reviewer`の起動条件に触れた場合は、それまで対象外でも`full`で起動する。

| 状態 | 親の操作 |
| --- | --- |
| 対象Roleすべてが最新対象を確認して`pass`、Finding／不足Evidenceなし | 評価対象の一致を確認してI6 Draft PRへ進む |
| いずれか`fail`、修正回数が3未満 | Findingを統合し、Task Scope内で最小修正し、影響Test／QAとSelf Reviewを行って再評価する |
| いずれか`fail`、修正回数が3 | 原因、未解決Finding、検証結果、残Riskを報告して停止する |
| いずれか`blocked`、Owner Decision、Scope外拡張 | 依存Deliveryを停止し、解消条件を報告する |
| 結果の欠落／不正、対象の不一致 | 不足Evidenceとして停止し、合格扱いにしない |

親は未承認要件を推測して実装しない。仕様ConflictやOwner DecisionはPlanningへ戻す。停止理由を再ラベルしてCycle数をリセットしない。上限を変える場合はOwnerへ求める。

PR Ready化・Mergeは利用者の明示依頼が必要。Draft PR前に、評価済み対象とCommit／Pushする対象の一致を確認する。Hook、生成処理、Stage漏れ等で変更された場合は最終確認へ戻る。

## Evidence

Repository QAは`pnpm check`であり、Reviewの実施を代替しない。

PR本文の「独立Review」には次だけを書く。最新の状態へ上書きし、Cycleごとに追記しない。

- 起動したRole、起動しなかったRoleと理由
- 修正回数と、Roleごとの最終結果
- 修正したFindingの要約（1件1行）
- 実効read-onlyの確認結果
- 未確認の点、残Risk

検証結果はPR本文の確認方法の節に書く。生JSON、Cycleごとの全結果、再開手順の全文は載せない（[Delivery Workflow](delivery-workflow.md)のIssue・PR本文）。

修正上限または`blocked`で停止した場合は、停止理由、解消条件、次の1手と、未解決FindingのSeverity、File、最小修正を1件1行で加える。

個人設定、認証情報、Session全文、実在個人・金融情報を公開しない。

## この形にした根拠

2026-10-28〜11-02のCodexログから取得できた6 Task、57件のReview結果で判断した。

- 一度`pass`した役を再評価した14回のうち、新たな`fail`は2回で、どちらも同じ1 Task（#242のCycle 3）だった。再評価を差分に絞り、最終確認を残す。
- 旧`spec_reviewer`は14回でMinor 1件だったので、担当を`code-reviewer`へ統合した。
- 旧`security_reviewer`は14回で指摘1件で、`code_reviewer`の指摘と同じ箇所だった。ただし対象は認証周辺に偏り、指摘がないことは安全の証明にならないので、条件付きで残す。
