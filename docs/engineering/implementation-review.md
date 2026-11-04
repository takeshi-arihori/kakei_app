# 実装の4専門Review

[Issue #206](https://github.com/takeshi-arihori/kakei_app/issues/206)のI5契約。工程は[Engineering Loop](engineering-loop.md)に従う。Client上の実行定義は未配置で、配置先はOwner Decision待ちである。

## 責務と移行

I5は4つの独立判定を必須とする。互換用の第5Reviewerは設けない。D3の`work_planning_evaluator`は維持する。

| Role | 確認すること |
| --- | --- |
| `code_reviewer` | 正確性、責務分離、SOLID／DRY、適用されるDDD、依存方向、保守性、Accepted Design・Architecture |
| `test_reviewer` | Requirement／契約とTestのTrace、正常・異常・境界・回帰、Test品質、実行結果、不足検証 |
| `spec_reviewer` | Issue／Done Criteria、Accepted ADR／仕様、未実装・過剰実装、未承認Decision、文書同期 |
| `security_reviewer` | 差分に応じた認証認可、入力検証、情報漏洩、秘密情報、依存関係／Supply Chain、運用Security |

具体的な技術Ruleは対象のRepository docsとAccepted ADRから取得する。対象外の観点でもReviewerを省略せず、確認した根拠と非該当理由を記録する。未実施の検証を非該当へ置き換えない。

`implement-github-task`が入力固定、起動、原結果保存、集計、GitHub Lifecycleを担当する。`feature-development`がScope内修正、Test／QA、Self Reviewを担当する。`code-review`はSelf Reviewであり独立Reviewerの代替ではない。親だけがCode／文書／Git／GitHubを変更する。Reviewer同士の結果交換は禁止する。

## ReviewInput

親は次を内容付きで各子へ渡す。Tool隔離でFileやURLを取得できない子へPathだけを渡さない。

- Task Issue、Requirement／Done Criteria、Epic、Dependenciesと状態
- Base Commit、最新Diffの識別子、変更File一覧、Diffと必要な前後の文脈
- Accepted ADR、適用するRepository docs、設計と契約
- Test／QAのCommandと結果、Self Review、未実行検証と理由、残Risk
- Cycle番号、担当Role、実効権限と利用可能Toolを検証する方法

Diff識別子は親が固定した変更一式のSHA-256またはCommit等とし、未追跡Fileも含める。4役には同じ評価対象と共通Evidenceを渡す。他のReviewerの結論は入力へ含めない。評価中に対象が変わった場合は当該Cycleを無効にし、新しい対象で4役を起動する。

入力BundleはUTF-8で固定し、各FileのPath、Byte数、SHA-256、BEGIN／END区切りを持つ完全な本文を含める。親は起動前に一覧とHashを照合し、Patchに加えて変更Fileの本文・必要な変更前文脈を渡す。Context容量不足や切詰めを検出した場合は不足Evidenceとして停止する。本文を黙って要約して審査を継続しない。親が取得した一次資料の内容を評価対象とし、取得不能なURLだけへ依存しない。

## 個別結果

各子は次のJSONを返す。JSON不正、必須Fieldの欠落、想定Role／対象との不一致は合格扱いにしない。

```json
{
  "role": "code_reviewer",
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

Blocker／Majorまたは不足Evidenceが残る場合は`pass`にしない。ActionableなMinorは`fail`として親へ戻す。Scope外のDebtや好みだけの指摘はFindingにせず、必要なら`residualRisk`へ根拠とともに記録する。Owner Decision、未承認仕様、正本Conflict、重大Security、実効read-only不明は`blocked`とする。

## 実効read-only

Reviewerは書込み権限のない実行環境で動かす。Role定義のread-only指定だけでは十分でないため、使用Clientの実効権限とTool一覧を確認する。Shell、外部書込みTool等の書込み経路が残る、または確認できない場合は`blocked`とする。実GitHubへの書込みProbeは行わない。通常の親を恒久的にread-onlyへ変更しない。並列枠が不足する環境では4つの別Threadを逐次起動してよい。既定Model／Reasoningや並列上限はRepositoryへ固定しない。

## 自律修正とDraft PR Gate

初回評価をCycle 0とし、修正を最大3回だけ認める。評価は最大4回（0、1、2、3）。4回目の修正を開始しない。

| 状態 | 親の操作 |
| --- | --- |
| 同じ最新対象で4役すべて`pass`、Finding／不足Evidenceなし、実効read-only確認済み | 評価対象一致を確認してI6 Draft PRへ進む |
| いずれか`fail`、修正回数が3未満 | 原結果を保存してFindingを統合し、Task Scope内で最小修正する |
| 修正後 | 影響Test／QAとSelf Reviewを行い、最新Diffで4役すべてを新Threadで再実行する |
| Cycle 3でも`fail` | 原因、未解決Finding、再現／検証結果、残Riskを報告して停止する |
| いずれか`blocked`、重大Security、Owner Decision、Scope外拡張、未解消Blocker、read-only不明 | 依存Deliveryを停止し、解消条件を報告する |
| 結果欠落／不正、対象不一致、同じThreadの再利用 | 不足Evidenceとして停止し、合格扱いにしない |

重複Findingを統合しても元のReviewer、Evidence、個別JSONは保持する。親は未承認要件を推測して実装しない。仕様ConflictやOwner DecisionはPlanningへ戻す。停止理由を再ラベルしてCycle数をリセットしない。変更が必要なら根拠を残し、Ownerへ上限の変更を求める。

PR Ready化・Mergeは利用者の明示依頼が必要。Draft PR前に、評価済み対象とCommit／Pushする対象の一致を確認する。Hook、生成処理、Stage漏れ等で変更された場合も4役の新しいCycleへ戻す。

全員pass後に対象が変わった場合、次Cycleの`previousTargetInvalidated`へ変更・失効のEvidence参照を残す。変更前のpassも履歴へ保持し、次Cycleは同じ上限内の1回として数える。対象変更のない再実行、失効理由なしのpass履歴、blockedの未解消履歴は集計で受け入れない。

外部阻害の解消後に同じ対象・同じ修正回数で再開する場合、任意の`blockedHistory`配列へ停止時の4役原結果を`{ cycle, review, resolutionEvidence }`として残す。`review`は通常Cycleと同じ記録形式、`cycle`は再開する修正回数、`resolutionEvidence`は親が確認した解消根拠の参照とする。停止時は実際にblockedであり、再開対象とBase／Diffが一致し、停止時と再開時を通じ全Threadが新規であることを検証する。未解消のblockedを通常履歴から消して合格扱いにしない。対象を修正した場合は通常の修正Cycleへ数え、同じ対象での阻害解消として回数を迂回しない。

## 検証とEvidence

静的検証と実動検証を分ける。

- 文書Link／Skill frontmatter、技術Ruleの非重複を検証する。
- 安全な合成CaseでCode Defect、Test不足、仕様未実装、架空の秘密情報の漏洩を担当Roleが検出することを確認する。
- 親が合成Caseの実File／入力を修正してTestを実行し、新Threadの4役が同じ修正後対象へpassするLoopを最低1回記録する。
- 実Taskの最終Diffは合成Caseとは別に新しい4役で評価する。合成Caseのpassを実Taskへ流用しない。
- Repository QAは`pnpm check`。これはRole起動・権限・実動Loopの代替ではない。

公開EvidenceはClient／Version、Base／Diff、Role／親子Thread ID、Cycle、時系列、原結果、修正、検証結果、権限・Tool確認、Gate判断を必要最小限で記録する。個人設定、認証情報、Private Projectの生データ、Session全文、実在個人・金融情報を公開しない。GitHubへ保存した状態は再取得し、期待したIssue／PR追跡を確認する。

Planning段階では、現行roleで隔離方式の成立と設計・検証計画を確認する。新4役の起動・権限・E2Eは実装後の受入条件であり、未実装の成功をReady条件として先取りしない。実装後の未達条件はI5／Draft PRを止める。
