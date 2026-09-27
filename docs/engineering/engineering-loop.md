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
D2 調査・設計
 │
 ▼
D3 Planning Review
 │
 ▼
D4 Epic / Task / Dependency / PR順序
 │
 ▼
Ready Task
 │
 ▼
I0 Delivery開始
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
                          I5 Independent Evaluator
                             │                │
                         fail│                │pass
                             ▼                ▼
                       修正・再検証       I6 Draft PR
                             │
                             └────▶ 新しいEvaluator
```

未決Decisionや正本Conflictが結果を左右する場合は、その判断に依存する経路だけを停止する。依存しない調査・整理・検証は継続する。

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

**目的**: 実装手段ではなく、観測可能なRequirementとDone Criteriaへ変換する。

実施:
- Requirement、制約、対象外を整理する。
- 必要なUse Caseは契約としてPrecondition／Postcondition／Invariant／FailureへTraceできる状態にする。
- 正常・境界・権限・失敗・競合・再試行のうち、Riskと成果に関係するDone Criteriaを定義する。
- 非機能・Security・Data・Operations等は関連docsに要求がある場合だけ適用する。

出力:
- Requirement
- Done Criteria
- Scope／Out of scope
- 必要な契約・Test観点

## D2. 調査・設計する

**目的**: 現行実装をEvidenceとして確認し、現在のRequirementに基づく設計を確定する。

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

Epic／Taskを保存する前に、新しい`work_planning_evaluator`へD0〜D2のEvidence、Requirement、Done Criteria、設計、作業分解案、Dependencies、Decisionを渡す。

- `pass`: D4へ進む。
- `fail`: 親AgentがPlanningを修正し、新しいEvaluatorで再評価する。
- `blocked`: Owner Decision、権限、正本Conflict等を解消するまで依存作業を止める。

Evaluatorはread-onlyとし、GitHub更新は親Agentだけが行う。

## D4. Epic・Task・PR順序へ分解する

[Delivery Workflow](delivery-workflow.md)に従ってEpic／Taskを設計し、[PR依存関係Gate](pr-dependency-gate.md)に従ってDependency GraphとDelivery順序を決める。

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

TaskがRepositoryのReady条件を満たした時点で実装フェーズへ進む。

# 実装フェーズ

## I0. Deliveryを開始する

`implement-github-task`を入口に、対象Task、Requirement、Done Criteria、Dependencies、Accepted ADR、基準`develop`、作業Treeを確認する。

ReadyでないTaskは実装へ進めない。Task専用Branchを用意し、GitHub Lifecycleは`implement-github-task`、実際の変更Workflowは`feature-development`へ委譲する。

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

セルフレビューはI5の独立Evaluatorの代替ではない。

## I5. 独立Subagent Review

セルフレビューと最終検証後、**毎Cycle新しい`task_evaluator`**を起動する。

Reviewerへ渡すEvidence:
- Task URL、Requirement、Done Criteria
- 基準Commitと評価対象Diffの識別情報
- 変更File一覧
- Accepted Decisionと関連docs
- 実行した検証と結果
- 未実施検証と理由
- Self Review結果
- 既知Risk、例外、残事項

結果:

```text
pass ───────▶ I6 Draft PR

fail ───────▶ 親Agentが修正
                 │
                 ├─ 再検証
                 ├─ Self Review
                 └─ 新しいtask_evaluator

blocked ────▶ 依存する作業を停止
```

Evaluatorはread-onlyとし、修正を行わせない。同じEvaluator Threadへ修正版を再投入せず、独立性を保つため毎Cycle新しいEvaluatorを使用する。

## I6. Draft PR

Evaluatorが`pass`し、Findingと不足Evidenceが残っていない場合だけ、`implement-github-task`がCommit／Push／Draft PR／Issue追跡を完了する。

PR Ready化・Mergeは別の明示依頼として扱う。

# 完了条件

Engineering Loopを完了扱いにできるのは次を満たす場合だけである。

- Requirement／Done Criteria → Design → Test／Verification → Diff → ReviewをTraceできる。
- 使用したSkillと省略したSkill、その理由が説明できる。
- 関連docsが最終差分と同期している。
- 未承認Decisionを実装で確定していない。
- PR前セルフレビューの重大Findingが残っていない。
- 独立`task_evaluator`が最新評価対象に対して`pass`している。
- 未実施検証と残Riskが明示されている。
- Draft PRがTaskへTraceできる。
