# SUDO Modeling Guide

SUDOは、System Context / Use Case / Domain Model / Object Modelの4つの視点を使ってDomain理解を深める。

参考: [DDD×仕様駆動で回す高品質開発のプロセス設計（Speaker Deck、slide 24）](https://speakerdeck.com/littlehands/dddxshi-yang-qu-dong-dehui-sugao-pin-zhi-kai-fa-nopurosesushe-ji?slide=24)

このGuideでは、同資料の「最低限の4図」と「抽象と具体を往復する」という考え方を採用する。業務フロー図、状態遷移図、シーケンス図は、SUDOだけではLifecycleや分岐を検証しにくい場合に補助的に追加する。

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

Use Caseには2つの役割がある。

- ActorとGoalを言語化し、解決する問題を具体化する
- 今回扱うUse Caseを選び、Domain Model作成のScopeを区切る

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

初期のDiagramでは代表的なAttributeだけを示し、Business RuleとConstraintを適用先のConceptまたはRelationshipへ注記する。Ruleが多すぎるConceptは、責務の分割を再検討するSignalとして扱う。

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

既存実装または運用実績がある場合は、そこから得た発見もDomain Modelへ戻す。

```text
Use Case → Rough Domain Model ⇄ Object Example
                         ⇅
            Existing Implementation / Operation
```

最初のSessionでは完成図を目指さず、書き換えやすい粗い表現で参加者の異なる理解を可視化する。意味が安定してから正本用のDiagramや表へ清書する。

成果物の配置も固定しない。利用者が1ページを希望する場合は、S / U / D / Oを同じPage内で明確に区切る。縦方向へ順番に並べる指定は「横長のSectionで上下に区切る」、横方向へ並べる指定は「Columnで左右に区切る」と解釈し、曖昧な場合は既存Diagramと利用者の最新指示を優先する。

## Validation Questions

- このConceptの具体例を作れるか。
- このRelationshipのMultiplicityは具体例でも成立するか。
- Ruleに反例はないか。
- Invalid StateをModelが許していないか。
- Lifecycleの開始・変更・終了を説明できるか。
- ActorのGoalとModelのConceptがつながっているか。
- Technical ConceptがDomain Conceptへ混入していないか。
