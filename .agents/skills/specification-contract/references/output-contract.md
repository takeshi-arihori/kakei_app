# Output Contract

対象Use Case／Commandごとに、次の構成を必要な範囲で出力する。空のSectionを埋めるためにRuleを推測しない。

## 1. Context

| Item | Value | Evidence | Knowledge State |
| --- | --- | --- | --- |
| Requirement / User Goal |  |  |  |
| Actor |  |  |  |
| Trigger |  |  |  |
| Success Outcome |  |  |  |

## 2. Contract

IDは成果内で一意な一時識別子とする。正式なIssue IDやADR IDを勝手に発行しない。

- `PRE-001`: Precondition
- `POST-001`: successful Postcondition
- `INV-001`: Invariant
- `FAIL-001`: Failure／Rejection contract

### Preconditions

| ID | Condition | Concern / Layer | Evidence | Knowledge State |
| --- | --- | --- | --- | --- |

### Postconditions

| ID | Guaranteed Outcome | Observable By | Evidence | Knowledge State |
| --- | --- | --- | --- | --- |

### Invariants

| ID | Rule | Applies To | Evidence | Knowledge State |
| --- | --- | --- | --- | --- |

### Failure / Rejection

| ID | Trigger / Related Contract | Result | State Guarantee | Evidence | Knowledge State |
| --- | --- | --- | --- | --- | --- |

`State Guarantee`には少なくとも業務状態の変更有無を記載する。部分反映、履歴、再試行、外部副作用を保証する場合は、それぞれの根拠を示す。

## 3. Application / Trust Boundary Notes

Domain Contractと混同しやすいActor確立、入力形式、Port、Transaction、外部Service、Audit等だけを記載する。技術実装を業務Invariantとして再掲しない。

| ID | Responsibility | Boundary / Owner | Related Contract | Evidence / State |
| --- | --- | --- | --- | --- |

## 4. Traceability

| Contract ID | Requirement / Rule Source | Evidence | Test Scenario | Knowledge State |
| --- | --- | --- | --- | --- |

すべての`Confirmed`な`PRE`、`POST`、`INV`、`FAIL`を少なくとも1つのTest ScenarioへTraceする。未確定条件はTest候補にできるが、確定した期待結果として扱わない。

## 5. Test Scenarios

Scenario IDは`TS-NOM-001`、`TS-BOUND-001`、`TS-REJECT-001`、`TS-CONC-001`、`TS-RETRY-001`のように種類を示す。

| Scenario ID | Type | Given | When | Then | Contract IDs |
| --- | --- | --- | --- | --- | --- |

最低限、対象に関係する次の種類を確認する。

- 正常: `PRE`を満たすと`POST`が成立し`INV`が維持される
- 境界: 値、人数、状態遷移等の境界で契約が維持される
- 拒否: `PRE`違反で対応する`FAIL`となり、禁止された状態変更がない
- 競合: 同時操作時の勝敗、再読込、部分反映の有無
- 再試行: 応答喪失や同一要求で二重反映しない等、Requirementで必要な保証

不要な種類は理由を記載し、Requirementにない競合・再試行方式を発明しない。

## 6. Open Questions / Conflicts and Stop

| ID | State | Question / Conflict | Affected Contracts | Stop Target | Required Evidence / Decision |
| --- | --- | --- | --- | --- | --- |

`Open Question`または`Conflict`がある場合、依存するImplementation、Task Ready、正本反映のどれを止めるかを具体化する。依存しない契約整理やTest候補は分けて継続できる。

## 7. Review Checklist

- Actor、Trigger、Success Outcomeの根拠がある
- 各ConditionがPRE／POST／INV／FAILの時点に合う
- Authorization、Validation、Application、Domain、DB Constraintを混同していない
- すべてのPRE違反に拒否結果と業務状態保証がある
- POSTがINVを破らず、正常・境界・拒否TestへTraceできる
- 競合・再試行の必要性を確認し、不要または未決ならそう記録した
- Knowledge StateとEvidenceが全条件にあり、暗黙昇格がない
- 未確定事項の影響、停止対象、必要な判断がある
