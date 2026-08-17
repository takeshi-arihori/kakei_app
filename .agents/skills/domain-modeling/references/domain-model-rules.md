# Domain Model Rules

## Concept Classification

Conceptを実装Patternへ早期変換しない。

最初に次を確認する。

- 業務上の名称と意味
- Identityの有無
- 値としての等価性
- Lifecycle
- Business Rule
- Relationship
- Ownership

その後、必要に応じてEntity、Value Object、Domain Service、Aggregate候補へ分類する。

## Entity Candidate

次を満たす場合にEntity候補とする。

- Lifecycleを通じて同一性を追跡する必要がある
- Attributeが変わっても同じ業務概念として扱う
- 状態変更に業務上の意味がある

ID Columnが存在することだけを理由にEntityにしない。

## Value Object Candidate

次を満たす場合にValue Object候補とする。

- Identityではなく値で比較する
- 値にDomain上の名前・制約がある
- Immutableとして扱える
- Valid Stateだけを生成できる

Primitive Wrapperを増やすこと自体を目的にしない。

## Aggregate Candidate

Aggregateは同一TransactionでInvariantを守る必要がある最小境界として検討する。

検討前に次のEvidenceを必要とする。

- Invariant
- Consistency Requirement
- Lifecycle
- Concurrent Update Rule
- Failure / Retry Rule

Evidenceが不足している場合は`Aggregate Candidate`までに留める。

## Bounded Context Candidate

次を境界候補のSignalとする。

- 同一語の意味が変わる
- Business Capabilityが異なる
- Ruleの所有者が異なる
- Modelの変更理由が異なる
- Data Ownershipが異なる

Microserviceへ分けたい、Frameworkが違う、Tableを分けたいという理由だけではBounded Contextを作らない。

## Business Rule Placement

Rule候補を次へ分類する。

- Aggregate内Invariant
- Aggregate間Policy
- Application Use CaseのCoordination
- Authorization Rule
- Read Model / Reporting Rule
- Presentation Rule

分類不能なRuleは無理に配置せず、Open Questionとして残す。

## Relationship

Relationshipごとに次を記録する。

- Direction
- Multiplicity
- Ownership
- Required / Optional
- Lifecycle Dependency

多重度は抽象的に決めず、具体例で検証する。

## Lifecycle

重要Conceptについて次を確認する。

- Creation
- State Transition
- Cancellation
- Restoration
- Archival
- Deletion

状態遷移を説明できない場合、EntityやAggregateの理解は未完成とする。
