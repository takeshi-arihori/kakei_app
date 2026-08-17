# Modeling Principles

## 目的

ドメインモデリングは、Software Patternを当てはめる作業ではなく、対象Domainの問題・概念・Ruleを理解し、変更に耐えられる共通言語を形成する活動とする。

## Concrete First, Abstract Later

抽象概念だけで議論を進めず、必ず具体例へ戻る。

- 具体例からObjectを確認する
- Object間の共通点からConceptを抽出する
- Concept間のRuleをDomain Modelへ表現する
- Modelを再度具体例へ適用して破綻しないか確認する

モデルを説明できる具体例が存在しない場合は、理解が十分ではない。

## Model is a Hypothesis

Domain Modelは確定仕様ではなく、現時点のDomain理解を表す仮説である。

新しい事実が判明した場合は、Use Case、Object Example、Domain Model、Ubiquitous Languageを同時に見直す。

## Domain Knowledge Must Have Evidence

Domain Ruleには根拠が必要である。

根拠の優先順位:

1. 利用者の最新の明示指示
2. NotionのCurrent / Accepted情報
3. Domain Expertへの確認結果
4. Repositoryに実装されている事実
5. Working Assumption

4は「現在そう実装されている」ことの証拠であり、「業務上正しい」ことの証拠ではない。

## Separate Knowledge States

すべての重要なRule・Boundary・Termを次のいずれかへ分類する。

| State | 意味 |
| --- | --- |
| Confirmed | 根拠があり、現時点で採用済み |
| Proposed | 検討案。採用前 |
| Assumption | 一時的な仮定 |
| Open Question | 情報不足で判断不能 |
| Conflict | 複数の正本が矛盾 |
| Deprecated | 廃止済み |
| Superseded | 新しい判断に置換済み |

AIはStateを暗黙に昇格させない。

## Ubiquitous Language

名称だけでなく意味を揃える。

同一語が複数Contextで異なる意味を持つ場合は、無理に統合せずContextごとのLanguageとして保持する。

## Technical Concerns Are Not Domain Facts

次はDomain Ruleの根拠にしない。

- DB Schema
- ORM Model
- API Schema
- UI Form
- Frameworkの制約
- Existing Directory Structure

これらとDomain Modelが一致する場合でも、Domain側の根拠を別途確認する。

## Aggregate is a Later Decision

AggregateはEntityの集合ではなく、同時に整合性を守る最小境界として検討する。

Aggregate候補を決める前に、最低限次を確認する。

- Invariant
- 変更単位
- 同時更新要件
- Lifecycle
- Transactional Consistencyの必要範囲

画面単位、Table単位、API Mutation単位を理由にAggregateを決めない。
