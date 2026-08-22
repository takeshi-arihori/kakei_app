# Output Contract

Domain Modelingの成果は、別の人間またはAIが「何が確定し、何が未確定か」を再現できる形で出力する。

## 1. Problem / Scope

- Problem
- Observable Success / Problem-solving Criterion
- Target User / Actor
- In Scope
- Out of Scope
- Constraints

## 2. System Context

| Element | Type | Responsibility / Interaction | Evidence |
| --- | --- | --- | --- |

## 3. Use Cases

| Use Case | Actor | Goal | Trigger | Success Outcome | Boundary / Failure |
| --- | --- | --- | --- | --- | --- |

## 4. Concrete Examples / Object Model

各Exampleについて次を示す。

- Scenario
- Objects and concrete values
- Relationships
- Expected Rule
- Expected Outcome
- Knowledge State

## 5. Domain Concepts / Domain Model

| Concept | Meaning | Identity / Value | Lifecycle | Relationships | State |
| --- | --- | --- | --- | --- | --- |

既存実装または運用実績を確認した場合だけ、次も追加する。

| Model Element / Rule ID | Implementation / Operation Evidence | Alignment | Feedback | Knowledge State |
| --- | --- | --- | --- | --- |

`Alignment`は`Aligned`、`Partial`、`Missing`、`Conflict`のいずれかとする。Codeの存在だけでDomain上の正しさをConfirmedにせず、この成果物から実装変更へ自動進行しない。

## 6. Business Rules / Invariants

| Rule ID | Rule | Applies To | Evidence | State | Counterexample / Boundary |
| --- | --- | --- | --- | --- | --- |

Rule IDは`RULE-001`のように一時識別子を付けて議論を追跡可能にする。正式なRepository IDやNotion IDを勝手に発行しない。

## 7. Ubiquitous Language

| Japanese | English | Definition | Context | Avoided Terms | Example |
| --- | --- | --- | --- | --- | --- |

## 8. Decisions

Confirmedな判断だけを記載する。

- Decision
- Evidence / Source
- Affected Model

## 9. Proposed / Assumptions

Confirmedと混ぜない。

| Item | Type | Reason | Validation Needed |
| --- | --- | --- | --- |

Typeは`Proposed`または`Assumption`。

## 10. Open Questions / Conflicts

| ID | Type | Question / Conflict | Impact | Required Decision / Evidence |
| --- | --- | --- | --- | --- |

Typeは`Open Question`または`Conflict`。

## 11. Next Modeling Step

次に必要な行動を1〜3件に絞る。

例:

- Domain ExpertへRuleを確認する
- Object Exampleを追加する
- Bounded Context候補を比較する
- ADR Proposalが必要かDecision Checkする

Technical DesignやImplementationへ自動的に進めない。
