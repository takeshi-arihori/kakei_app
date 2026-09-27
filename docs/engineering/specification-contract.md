# Specification Contract Rule

この文書は個別Use Case／Command／操作をPrecondition、Postcondition、Invariant、Failureへ整理し、RequirementからTestへTraceするための静的Ruleを定める。実行Workflowは`.agents/skills/specification-contract`が担当する。

## 入力と根拠

対象操作ごとに次を固定する。

- Requirement／User Goal／Actor／Trigger／Success Outcome
- Accepted ADR、Confirmed Domain Rule、用語定義
- 正常、境界、拒否、競合、再試行のうち対象Riskに関係する具体例
- 現行実装や技術制約を確認した場合は、業務根拠ではなくImplementation Evidenceとして分離する

各条件にEvidenceとKnowledge Stateを持たせる。Proposed、Assumption、Open Question、Conflictを既存Codeの存在や記述都合だけでConfirmedへ昇格させない。

## 契約4分類

### Precondition

操作開始時にActor、入力、対象状態が満たす必要のある条件。違反時の拒否と状態保証を対応するFailureへ記載する。

### Postcondition

操作成功後に必ず成立するDomain State、結果、外部から観測可能な効果。希望や実装手順ではなく検証可能な結果を書く。

### Invariant

操作前後を通じ、有効なDomain Stateで常に成立する業務Rule。単一操作だけの開始条件や技術制約だけをInvariantへ入れない。

### Failure／Rejection

Precondition違反、Domain拒否、競合、依存障害、再試行等で返す結果と、変化してよい状態・変化してはいけない状態を書く。「失敗する」だけで終えない。

Domain拒否では原則として業務状態を変更しない。技術的副作用は業務状態と分け、関連docsとRequirementに根拠がある場合だけ保証へ含める。

## Concernと責務を混同しない

条件候補を、少なくとも次の観点で分離する。

- Business Authorization
- Identity／Trust Boundary
- Input Validation
- Application Coordination
- Domain Invariant
- Persistence Constraint

同じ文が複数Concernを含む場合は分割する。技術形式上の制約と業務上の有効範囲を同じRuleとして扱わない。

具体的なLayer／Security／Persistence Ruleは[開発ガイド](README.md)から関連docsを読む。

## 分類手順

1. 条件が「開始前」「成功後」「常時」のどこで成立すべきか一つずつ確認する。
2. 一文に複数の時点・Concernがあれば分割する。
3. 各条件のEvidenceを確認し、技術実装だけが根拠なら業務契約から分離するか未確定Stateにする。
4. すべてのPreconditionへ違反時のFailureを対応させる。
5. 成功時のPostconditionがInvariantを維持することを確認する。
6. Requirementに必要な範囲で競合、再試行、二重反映、部分反映、結果喪失を検討する。
7. 未決条件を隠さず、Open Question／Conflictと影響範囲を記録する。

## Test Trace

各契約条件に安定したIDを付け、Done CriteriaとTest／VerificationへTraceする。

```text
Requirement
   ↓
Contract PRE / POST / INV / FAIL
   ↓
Test Scenario
   ↓
Verification Result
```

実際のTest Level、Tool、Commandは[Testing Rule](testing.md)を正本とする。

## 確定を止める条件

次のいずれかが結果を左右する場合、契約をConfirmedとして確定しない。

- Actor、Trigger、Success Outcome、拒否条件が不明
- Precondition違反またはFailure時の状態保証が不明
- PostconditionとInvariantが矛盾する
- 技術構造だけを根拠に業務RuleをConfirmedにしている
- Open Question／Conflictが操作結果、Invariant、Authorization、重要Dataを左右する
- Requirement／ADR／Domain RuleのConflictが未解消

停止時は、停止する実装・正本反映、依存しない継続作業、必要なOwner DecisionまたはDomain確認を明示する。

## 完了判定

- PRE／POST／INV／FAILがEvidence付きで整理されている。
- Failure時の状態保証がある。
- RequirementとDomain RuleへTraceできる。
- 未確定事項をConfirmedへ混ぜていない。
- Test Scenarioへ引き継げる。
