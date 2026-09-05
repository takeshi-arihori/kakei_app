---
name: domain-modeling
description: 家計アプリの要求・業務知識から、System Context、Use Case、Object、Domain Model、ユビキタス言語、業務ルール、不変条件、未確定事項を整理・検証する。ドメインモデリング、DDD設計の前段整理、モデルレビューを依頼されたときに使用する。DB Schema、GraphQL Type、UI、FrameworkからDomain Modelを逆算する用途には使用しない。
---

# Domain Modeling

ドメインエキスパートとAIが同じ問題・概念・具体例・業務ルールを参照しながら、問題解決に必要な側面を選び、理解を反復的に深める。

## 正本を確認する

Notionは読み書きしない。[正本入口](../../../docs/governance/README.md)から現在の固定Commit、GitHub Issue、Private Projectを確認する。

- [現行Product Scope・業務モデル](../../../docs/product/current-model.md)
- [未確定・未移行Gate](../../../docs/product/design-gates.md)
- RepositoryのAGENTS.md、docs/engineering/domain-design.md

実装は現行動作の証拠であり業務仕様の根拠ではない。GitHub上の現行仕様と実装が矛盾した場合はConflictとして解消する。必要な仕様が未移行なら推測せず対象作業をBlockedにする。

## モデリング原則

作業前に次を読む。

- [references/modeling-principles.md](references/modeling-principles.md)
- [references/sudo-modeling.md](references/sudo-modeling.md)
- [references/interview-guide.md](references/interview-guide.md)
- [references/domain-model-rules.md](references/domain-model-rules.md)
- [references/output-contract.md](references/output-contract.md)

Diagramの作成・更新を求められた場合は、モデリング完了後に次も読む。

- [references/drawio-integration.md](references/drawio-integration.md)

## Workflow

### 1. Problem / Scopeを理解する

EntityやAggregateを考える前に、次を整理する。

- 解決する問題
- 問題を持つ利用者・Actor
- Systemが提供する成果
- 問題を解決できたと判断する観測可能な結果
- 対象範囲と対象外
- 外部System
- 現時点の制約

不足している情報は推測で埋めず、`Open Question`へ記録する。

### 2. System Contextを作る

System、Actor、External System、主要Interaction、System Boundaryを整理する。

System ContextにはDB、Framework、Class、Tableを入れない。

### 3. Use Caseを整理する

Actorごとに、業務上のGoalを中心としてUse Caseを抽出する。

Use Caseは機能一覧ではなく、解決する問題を具体化し、今回のモデリング範囲を区切るために使う。Sessionでは対象Use Caseまたは対象範囲を明示し、際限なくConceptを広げない。

各Use Caseについて最低限次を整理する。

- Actor
- Goal
- Trigger
- Preconditions
- Success Outcome
- Failure / Boundary

画面一覧やAPI EndpointをそのままUse Caseとして扱わない。

### 4. 具体例を作る

現実的な値を使ったObject Exampleを作る。

最低限次を含める。

- Normal case
- Boundary case
- Invalid case
- Exceptional / Conflict case

抽象モデルを先に確定しない。具体例で説明できない概念は理解不足として扱う。

### 5. ObjectとDomain Modelを往復する

次を反復する。

`Concrete Example → Object Model → Domain Concept → Domain Model → Concrete Example`

Domain Modelでは次を整理する。

- Domain Concept
- 代表的Attribute
- Relationship
- Multiplicity
- Business Rule
- Constraint / Invariant候補
- Lifecycle

図や表には代表的なAttributeだけを載せ、Method一覧や永続化詳細を中心にしない。Business RuleとConstraintは、どのConceptまたはRelationshipへ適用されるか追跡できる形で結び付ける。

この段階でAggregate境界を確定しない。Invariantと整合性要求が十分に確認された後で候補として検討する。

### 6. Ubiquitous Languageを整える

重要語について次を記録する。

- 日本語Canonical Term
- English Term
- Definition
- Valid Context
- Synonym / Avoided Term
- Example

同じ言葉がContextごとに違う意味を持つ場合は、共通型へ統合しない。

### 7. RuleとInvariantを検証する

各Ruleについて次を判定する。

- Confirmed: 正本または利用者確認済み
- Proposed: モデル上の提案
- Assumption: 作業を進めるための仮定
- Open Question: 判断に必要な情報不足
- Conflict: 正本同士が矛盾

`Proposed`や`Assumption`をConfirmedとして扱わない。

### 8. モデルを反証し、Feedbackを戻す

正常例だけでなく、境界・競合・取消・再試行・過去変更などの具体例をモデルへ当てる。

既存実装または運用実績がある場合は、Model上のTerm・Rule・Lifecycleがどこへ表現されているかを対応付ける。対応できない、複数箇所へ分散している、技術都合の形へ置換されている場合は、Modelまたは実装へのFeedbackとして記録する。

Repositoryは現行実装のEvidenceであり、Domain上の正しさの根拠ではない。既存実装へ合わせてModelを歪めず、このSkillの中でCode変更へ進まない。

最初から完成を目指さず、小さなScopeを短いCycleで`Model → Example / Existing Implementation → Discovery → Model`と往復する。初稿は素早く書き換えられる粗い表現でよく、意味が安定してから清書する。

次が起きたら前のPhaseへ戻る。

- 概念を具体例にできない
- Ruleが矛盾する
- 不可能状態を表現できる
- Lifecycleを説明できない
- 同じ語が複数意味を持つ
- Model Boundaryが技術都合だけで決められている

### 9. 出力する

[references/output-contract.md](references/output-contract.md) に従い、最低限次を返す。

1. Problem / Scope
2. System Context
3. Use Cases
4. Concrete Examples / Object Model
5. Domain Concepts / Domain Model（既存実装がある場合は対応・乖離も併記）
6. Business Rules / Invariants
7. Ubiquitous Language
8. Confirmed Decisions
9. Proposed / Assumptions
10. Open Questions / Conflicts
11. Next Modeling Step

### 10. Diagramを生成・更新する

UserがDiagramを求めている場合だけ、[references/drawio-integration.md](references/drawio-integration.md)へ従う。

1. Diagramの意味へ影響する`Conflict`または`Open Question`がないことを確認する。
2. Domain Modelからtyped Diagram Specificationを作る。
3. 利用可能なMCP Toolを確認する。
4. 新規作成は`drawio_create`、既存更新は先に`drawio_read`してから`drawio_update`を使う。
5. 最後に`drawio_validate`を実行する。
6. MCPが利用できない場合はDiagram Specificationまでを成果として返し、`.drawio`生成だけを未実施として報告する。

MCPへDomain判断を委譲しない。Diagram FileをDomainの正本として扱わない。

## Stop Conditions

次の場合は設計を確定せず停止し、利用者へ影響と必要な判断を示す。

- GitHubの現行仕様と実装が矛盾する
- Domain Ruleの根拠がない
- 重要語の意味が複数存在し、Contextを特定できない
- Aggregate候補のInvariantが不明
- 既存Accepted ADRを変更する必要がある
- 要求・Scopeの変更が必要になる

Diagramだけ停止する条件:

- Diagramの意味を左右する`Conflict`または`Open Question`が残っている
- 既存`.drawio`をMCPが安全に読めない
- draw.io MCPが利用できず、File生成が必要

Diagram停止条件は、Domain Modeling自体の結果を破棄する理由にはしない。

## Never Do

- Domain Ruleを「一般的だから」という理由で確定しない。
- UI FormのFieldをそのままValue ObjectやEntityへしない。
- DB Table、Prisma Model、GraphQL TypeをDomain Modelとして扱わない。
- Repository、Entity、AggregateなどDDD Patternを置くこと自体を目的にしない。
- FrameworkやPersistence都合でBounded Contextを決めない。
- 最初のモデルを最終仕様として固定しない。
- Userの明示確認なしにAccepted ADRを書き換えない。
- `.drawio`に存在するElementを根拠にDomain ConceptをConfirmedへ昇格しない。
- 既存Diagramを読まずに上書きしない。

## Diagram

Domain Modeling Skillは「何を描くか」を決め、draw.io MCPは「どう`.drawio`へ保存するか」を担当する。この境界を維持する。
