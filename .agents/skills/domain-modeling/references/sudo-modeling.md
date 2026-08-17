# SUDO Modeling Guide

SUDOは、System Context / Use Case / Domain Model / Object Modelの4つの視点を使ってDomain理解を深める。

## S: System Context

目的は、開発対象Systemと外部世界の境界を明確にすること。

整理するもの:

- Actor
- Target System
- External System
- Major Interaction
- System Boundary

入れないもの:

- Class
- DB Table
- Framework
- Infrastructure Detail

## U: Use Case

ActorがSystemを使って達成したいGoalを整理する。

Use Caseごとに次を持つ。

- Actor
- Goal
- Trigger
- Preconditions
- Main Success Outcome
- Boundary / Failure

画面名やEndpoint名をUse Caseとして扱わない。

## D: Domain Model

Domain上重要なConceptとRuleを抽象化する。

表現対象:

- Concept
- Representative Attribute
- Relationship
- Multiplicity
- Business Rule
- Constraint / Invariant Candidate
- Lifecycle

この段階ではMethod一覧や永続化詳細を中心にしない。

## O: Object Model

具体的な値を持ったExampleでDomain Modelを検証する。

例:

- 実在しない安全なサンプル名を使う
- 金額や日付を具体値にする
- RelationshipをInstance単位で示す
- 正常例だけでなく境界・不正・競合例も作る

## 順序は固定しない

S → Uの後、DとOは繰り返し往復する。

```text
System Context
    ↓
Use Case
    ↓
Object Example ⇄ Domain Model
                    ↓
             Ubiquitous Language
                    ↓
                Validation
```

`D → O`の一方向工程にはしない。

## Validation Questions

- このConceptの具体例を作れるか。
- このRelationshipのMultiplicityは具体例でも成立するか。
- Ruleに反例はないか。
- Invalid StateをModelが許していないか。
- Lifecycleの開始・変更・終了を説明できるか。
- ActorのGoalとModelのConceptがつながっているか。
- Technical ConceptがDomain Conceptへ混入していないか。
