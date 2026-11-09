# Engineering Loop

この文書は、要求の検証から設計、GitHub作業項目化、Issue単位の実装、独立Review、Draft PRまでをつなぐEngineering Loopの正本である。

具体的な言語、DB、Framework、ORM、API Protocol、Runtime、Cloud Service、Coding Rule、Test Commandはこの文書やSkillへ固定せず、[開発ガイド](README.md)から変更範囲に対応する`docs/`を読む。

## 責務分離

```text
AGENTS.md
   │ 入口・Gate・Routing
   ▼
Engineering Loop
   │ 状態遷移・成果物・戻り先
   ▼
.agents/skills
   │ 作業Workflow・Routing
   ▼
docs/
   └─ Project固有・技術固有の正本ルール
```

詳細は[Skillガバナンス](skill-governance.md)に従う。

## 全体像

```text
要求
 │
 ▼
D0 要求検証
 │
 ▼
D1 要件化
 │
 ▼
D2 調査・設計（設計判断がある場合）
 │
 ▼
D3 Planning Review（起動条件に該当する場合）
 │
 ▼
D4 Epic / Task名 / Dependency / PR順序
 │
 ▼
Backlog Task
 │
 ▼
I0 Task着手（調査1回・詳細記入・Ready判定）
 │
 ▼
I1 Red Test ──▶ I2 Implementation ──▶ I3 Green / Refactor
                                      │
                                      ▼
                                I4 Self Review
                                      │
                         Finding ──────┘
                                      │ Pass
                                      ▼
                          I5 Independent Reviewers
                             │                │
                         fail│                │全員pass
                             ▼                ▼
                       修正・再検証       I6 Draft PR
                             │
                             └────▶ failしたRoleが修正差分を再評価
```

未決Decisionや正本Conflictが結果を左右する場合は、その判断に依存する経路だけを停止する。依存しない調査・整理・検証は継続する。

## 同じ確認を繰り返さない

| 確認 | 行う場所 | 回数 |
| --- | --- | --- |
| 既存Epic／Taskとの重複 | D0 | 要求ごとに1回 |
| Epicの目的、Task一覧、Dependencies | D4 | Epicごとに1回。Taskの追加・取り下げ時に更新し、Task Close時はチェックボックスだけ更新 |
| Taskの現状調査 | I0の`pre-investigation` | Taskごとに1回 |
| Taskの詳細記入とReady判定 | I0 | Taskごとに1回 |
| 独立Planning評価 | D3 | 起動条件に該当する場合だけ |
| 保存結果 | 保存直後の再取得と比較 | 保存ごとに1回。Evaluatorは使わない |

設計判断を含まない単一Taskは、D0の重複確認とTask Issueの作成（Task名、Dependencies、依存するDecision）だけを行い、D1〜D4を省略してI0へ進む。I0で設計判断が必要と分かった場合はD2へ戻る。

# 設計フェーズ

## D0. 要求を検証する

**目的**: 利用者が提示した解決策をそのまま要件化せず、Problemと期待成果が現状に対して妥当か確認する。

入力:
- 利用者の要求
- GitHub上の既存Requirement、Epic、Task、Accepted ADR
- Repositoryの現行仕様と必要な既存Code／Test

実施:
1. Problem、期待成果、制約、対象外を分離する。
2. 現在すでに成立していること、成立していないこと、重複要求をEvidence付きで確認する。
3. 解決手段が先に指定されていても、Accepted DecisionとRequirementに照らして再評価する。
4. 未決事項はConfirmed扱いせず、Open Question、Conflict、Decision候補として分離する。

出力:
- 検証済みProblemとGoal
- 現状Evidence
- 要件化すべきGap
- 対象外
- Open Question／Conflict／Decision候補

Gate:
- Problemまたは期待成果自体が不明ならD1で推測して埋めない。
- 既存Taskと同一成果なら新規作業項目を増やさない。

## D1. 要件化する

**目的**: 実装手段ではなく、観測可能な成果へ変換する。

実施:
- 目的、期待成果、制約、対象外を整理する。
- 非機能・Security・Data・Operations等は関連docsに要求がある場合だけ適用する。

出力:
- 目的と期待成果
- Scope／Out of scope

Task単位のRequirement、Done Criteria、契約、Test観点はこの段階で書かず、I0で書く。I0では、必要なUse Caseを契約としてPrecondition／Postcondition／Invariant／FailureへTraceできる状態にし、正常・境界・権限・失敗・競合・再試行のうちRiskと成果に関係するDone Criteriaを定義する。

## D2. 調査・設計する

**目的**: 現行実装をEvidenceとして確認し、現在のRequirementに基づく設計を確定する。

設計判断がある場合に、その判断とEpicの分解に必要な範囲だけ調査する。Taskごとの詳細調査はI0へ残す。設計結果でTask構成が変わる場合は、設計Taskを先に完了させてから後続を分解する。

基本Flow:

```text
pre-investigation
      │
      ├─ domain-design
      ├─ api-design
      └─ database-change
```

すべてのSkillを形式的に実行せず、変更範囲に必要なものだけを選ぶ。具体設計ルールは各Skillではなく[開発ガイド](README.md)から対象docsを読む。

最低限確認すること:
- 現在の設計・実装・Test
- Entity／Value Object／Aggregate／Domain Service／Domain Event等、変更に関係するDomain要素
- Requirementとの不足・矛盾
- SOLID、DRY、凝集度、責務分離、依存方向
- 公開契約、Persistence、Security、Operations等への影響
- ADRまたはOwner Decisionの要否

出力:
- Accepted Designへ整合した設計結果
- TestへTraceできる契約
- 更新対象docs
- Open Question／Conflict／停止事項

## D3. 独立Planning Review

次のいずれかに該当する場合だけ、Epic／Taskを保存する前に、新しい`work-planning-evaluator`へD0〜D2のEvidence、Epicの目的と期待成果、設計、Task名の案、Dependencies、Decisionを渡す。

- Epic／Taskの分解、順序または内容が、Domain境界、Data Owner、認可、公開契約等の設計判断に依存する
- ADR ProposalまたはAccepted Decisionの変更を伴う
- Stacked PRを計画する
- Ownerが依頼した、または親Agentが該当するか判断できない

次の場面では起動しない。起動しなかった理由を完了報告へ1行で書く。

- 設計判断を含まないEpicや単一Task
- I0のTask詳細記入とReady判定
- 保存後の確認

確認観点:
- Problem、期待成果、制約、対象外が明確で、要求の妥当性を現状Evidenceと照合しているか
- Epicの目的が観測可能な成果へ落とせているか
- 現行仕様、既存Code、Test、Accepted ADRとのGapと影響範囲を調査しているか
- 既存Epic／Taskとの重複や包含関係を確認しているか
- Task名の粒度、Dependencies、実装順序、並列・順次・Stacked PRの判断とMerge順序が関連docsに整合するか
- 未決DecisionをClarificationまたはADRへ分離し、依存Taskに依存先を記録しているか

- `pass`: D4へ進む。
- `fail`: 親AgentがPlanningを修正し、新しいEvaluatorで再評価する。
- `blocked`: Owner Decision、権限、正本Conflict等を解消するまで依存作業を止める。

Evaluatorはread-onlyとし、GitHub更新は親Agentだけが行う。実効read-onlyの確認は[独立Review](implementation-review.md)の同名の節に従い、PRがない段階では結果と確認結果を対象IssueのCommentへ1行で記録する。

## D4. Epic・Task・PR順序へ分解する

[Delivery Workflow](delivery-workflow.md)に従ってEpicの目的、Task名、Dependenciesを決め、[PR依存関係Gate](pr-dependency-gate.md)に従ってDelivery順序を決める。Taskの詳細はここで書かない。保存後は[Delivery Workflow](delivery-workflow.md)の手順で再取得して比較する。

```text
Requirement
   │
   ▼
Epic（必要な場合）
   │
   ├─ Task A ──▶ PR A
   │      │
   │      └─dependency─▶ Task B ──▶ PR B
   │
   └─ Independent Task C ──▶ PR C
```

依存がないTaskは並行Deliveryできる。未Mergeの変更へCode上の依存があるTaskはStacked PR候補とし、Merge順序をDependency Graphから決める。

Taskは`Backlog`のまま保存し、着手時にI0へ進む。

# 実装フェーズ

## I0. Taskに着手する

`implement-github-task`を入口に、次を1回で行う。

1. 対象Task、親Epic、Dependencies、Accepted ADR、基準`develop`、作業Treeを確認する。
2. `pre-investigation`で現状とGapを調査する。同じ対象の調査が基準Commit付きでIssue、PR、docsにあり、その後に対象Pathの変更がなければ再利用する。変更があれば変更分だけ調査する。
3. Taskの詳細をIssue本文へ書く。すでに書かれている場合は不足分だけ補う。変更規模が目安を超えそうなら分割を検討する。
4. [Delivery Workflow](delivery-workflow.md)のReady判定を行う。
5. 保存結果を再取得して比較する。

Ready条件を満たさないTask、特に未承認Decisionに依存するTaskは実装へ進めず、`Backlog`のまま不足条件を報告する。

Task専用Branchを用意し、GitHub Lifecycleは`implement-github-task`、実際の変更Workflowは`feature-development`へ委譲する。調査結果も渡し、`feature-development`では調査をやり直さない。

## I1. TDDのRedを作る

`testing`を使い、Requirementまたは契約から次の最小の振る舞いを選ぶ。

1. 必要なTestまたは決定的な検証を先に作る。
2. 新しい振る舞いでは意図した理由で失敗することを確認する。
3. Redの理由を`implementation`へ引き継ぐ。

先行Testに意味がない変更種別は、関連docsが定める代替検証と理由を記録する。

## I2. 最小差分で実装する

`implementation`を使い、確定済みRequirement、Design、Contract、Red TestだけをProduction変更へ反映する。

実装中に新しい設計判断が必要になった場合、Codeで暗黙確定せずD2の適切な設計へ戻す。

Commitは[Delivery Workflow](delivery-workflow.md)に従い、レビュー可能な論理単位にする。作業BranchのCommit数を機械的に1つへ制限しない。

## I3. Green・Refactor・回帰

`testing`へ戻り、対象TestをGreenにして必要な回帰検証を実行する。Refactor後も同じ契約を満たすことを確認する。

Done Criteriaが残る場合はI1へ戻り、次の最小Caseを進める。

## I4. PR前セルフレビュー

`code-review`を使い、最終DiffをRequirement、Accepted Design、関連docs、Test結果に照らす。

必要な専門観点がある場合だけ専門Skillを呼ぶ。Blocker／Major相当のFindingがあれば、原因に応じてD2、I1、I2、I3へ戻す。

セルフレビューはI5の独立Reviewの代替ではない。

## I5. 独立Subagent Review

Self Reviewと最終検証後、`implement-github-task`が最新評価対象を固定し、`code-reviewer`、`test-reviewer`、条件に該当する場合は`security-reviewer`を、それぞれ別のSubagentで起動する。

入力／結果契約、実効read-only、修正上限、停止条件、Evidenceは[独立Review](implementation-review.md)を正本とする。

- 全員pass: 最新対象でFinding／不足Evidenceがないことを確認しI6へ進む。
- fail: 親がFindingを元Evidence付きで統合し、Scope内の最小修正、Test／QA、Self Reviewを行う。`fail`したRoleが修正差分を再評価し、最後に未確認のRoleが差分を確認する。
- blockedまたは上限到達: 依存Deliveryを停止し、原因・未解決Finding・再現／検証結果・残Riskを報告する。未承認DecisionやScope外要求はPlanningへ戻す。

Reviewerはread-onlyであり、親だけがCode／文書／GitHubを変更する。並列非対応時も別のSubagentで逐次実行し、他のReviewerの結論を入力へ混ぜない。

## I6. Draft PR

対象Roleすべてが最新対象を確認して`pass`し、Findingと不足Evidenceが残っていない場合だけ、`implement-github-task`がCommit／Push／Draft PR／Issue追跡を完了する。本文は[Delivery Workflow](delivery-workflow.md)のIssue・PR本文の節に従い、ログを載せない。

PR Ready化・Mergeは別の明示依頼として扱う。

# 完了条件

Engineering Loopを完了扱いにできるのは次を満たす場合だけである。

- Requirement／Done Criteria → Design → Test／Verification → Diff → ReviewをTraceできる。
- 使用したSkillと省略したSkill、その理由が説明できる。
- 関連docsが最終差分と同期している。
- 未承認Decisionを実装で確定していない。
- PR前セルフレビューの重大Findingが残っていない。
- 対象Reviewerすべてが最新評価対象を確認して`pass`している。
- 未実施検証と残Riskが明示されている。
- Draft PRがTaskへTraceできる。
