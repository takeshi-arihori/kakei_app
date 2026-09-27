# Domain Modeling Rule

この文書はDomain ModelingでConcept、Rule、Invariant、Boundaryを発見・検証するときの静的Ruleを定める。実行Workflowは`.agents/skills/domain-modeling`が担当する。

## 目的

Domain ModelingはSoftware Patternを先に当てはめる作業ではなく、対象Problemに必要な業務ConceptとRuleを理解し、変更に耐えられる共通言語を形成する活動とする。

Domain Modelは現実を網羅的に写すものではない。対象Problemを説明・検証・解決するために必要な側面を選択した抽象である。

## 具体例から始める

抽象概念だけで議論を進めない。

```text
具体例
  ↓
Object／事実
  ↓
Concept
  ↓
Rule／Invariant
  ↓
Model
  ↓
具体例・反例で再検証
```

説明できる具体例や反例がないModelはConfirmed扱いしない。

## Modelは仮説として扱う

Domain Modelは現時点の理解を表す仮説である。新しい事実が判明した場合はUse Case、具体例、Model、Ubiquitous Languageを同時に見直す。

初稿から清書せず、意味が安定するまでは変更可能なModelとして扱う。

## EvidenceとKnowledge State

Domain Ruleには根拠を持たせる。

優先順位:

1. 利用者の最新の明示指示
2. GitHubのCurrent／AcceptedなRequirement・Decision・仕様
3. Domain Expert等への確認結果
4. Repositoryに実装されている事実
5. Working Assumption

既存実装は「現在そう動く」Evidenceであり、それだけで「業務上正しい」ことを保証しない。

重要なRule、Boundary、TermはRepository Governanceが定めるKnowledge Stateで区別する。少なくともConfirmed、Proposed、Assumption、Open Question、Conflictを暗黙に混同しない。AIはStateを勝手に昇格させない。

## Technical ConcernをDomain Factにしない

Data Shape、公開契約、UI、Framework、Directory等の技術表現はDomain理解のEvidenceにはできるが、それ自体を業務Ruleの根拠にしない。

Modelと実装が異なる場合は、どちらかを機械的に正解とせず、Requirement／Accepted Decision／実運用Evidenceを確認する。

## Concept分類

Pattern名へ早期変換せず、最初に次を確認する。

- 業務上の名称と意味
- Identityの有無
- 値としての等価性
- Lifecycle
- Business Rule
- Relationship
- Ownership
- 変更理由

その後、必要に応じてEntity、Value Object、Aggregate、Domain Service／Policy等の候補へ分類する。

## Entity候補

次のようなEvidenceがある場合にEntity候補とする。

- Lifecycleを通じて同一性を追跡する必要がある
- Attributeが変わっても同じ業務概念として扱う
- 状態変更に業務上の意味がある

技術上の識別子が存在することだけを理由にEntityへしない。

## Value Object候補

次のようなEvidenceがある場合にValue Object候補とする。

- Identityではなく値で等価性を判断する
- 値にDomain上の名前・制約がある
- Immutableとして扱う意味がある
- Valid Stateを生成時に表現できる

Primitiveを包むこと自体を目的にしない。

## Aggregate候補

Aggregateは同一の整合性境界でInvariantを守る必要がある最小範囲として検討する。

候補化の前に少なくとも次を確認する。

- Invariant
- 変更単位
- Consistency Requirement
- Concurrent Update Rule
- Lifecycle
- Failure／Retry Rule

Evidenceが不足する場合はCandidateに留める。画面、Data構造、公開Operation等の技術単位だけを理由に確定しない。

## Bounded Context候補

次を境界候補のSignalとする。

- 同一語の意味が変わる
- Business Capabilityが異なる
- RuleのOwnerが異なる
- Modelの変更理由が異なる
- Data Ownershipが異なる

配置方式やFramework差だけを理由にContextを作らない。

## Rule Placement

Rule候補は、確認済み責務に応じてDomain内のInvariant／Policy、Application Coordination、Authorization、Read Model／Reporting、Presentation等へ分類する。

分類不能なRuleは無理に配置せず、Open Questionとして残す。具体的なLayer Ruleは[Backend Rule](backend.md)や関連Architecture docsを参照する。

## RelationshipとLifecycle

重要なRelationshipはDirection、Multiplicity、Ownership、Required／Optional、Lifecycle Dependencyを具体例で検証する。

重要ConceptはCreation、State Transition、Cancellation、Restoration、Archival、Deletion等、Requirementに関係するLifecycleを説明できる状態にする。

## Feedback Loop

既存Codeや運用実績がある場合はModelと双方向に照合する。

- ModelのTerm／Rule／Lifecycleがどこに表現されているか
- 実装・運用から得た反例や制約は何か
- 対応不明、分散、技術語へ置換されたRuleはないか

ModelとCodeの形を同一にすることではなく、業務上の意味と変更影響をTraceできることを目標とする。

## 完了判定

ModelをConfirmedへ進める前に、少なくとも次を説明できること。

- 対象Problem／Use Case
- Ubiquitous Language
- Rule／InvariantとEvidence
- ConceptのIdentity／Lifecycle／Ownership
- Boundary候補と根拠
- 具体例／反例
- Open Question／Conflict
- 後続Domain DesignまたはSpecification Contractへの入力
