---
name: solid-ddd-pr-review
description: Code Reviewの専門観点として、対象DiffのSOLID、DRY、DDD、Context境界、日本語JSDocに関する実質的な問題を確認する。
---

# SOLID・DRY・DDD PRレビュー

対象Taskの具体的な差分を、SOLID、DRY、DDD、Context境界、日本語JSDocの観点でレビューする。GitHub上の要件、Accepted ADR、Repository内のArchitecture文書を正本として扱う。本Skillは再設計やPR Delivery全体を目的とせず、[code-review](../code-review/SKILL.md)から利用できる専門Reviewである。単独利用もできる。

## 入力

変更内容を理解するために必要な範囲のみを読む。

- GitHub Task、Done Criteria、依存Taskの状態、関連Epic。
- Accepted ADRおよび関連するRepositoryルール。
- Test・Documentationを含む、変更対象Fileの完全なDiff。
- 実在するPatternまたは重複を確認するために必要な既存の周辺Code。

Code、Directory名、Diagram、過去Issueだけを根拠に、未承認の意思決定を推測しない。未解決の意思決定が変更内容へ影響する場合はBlockerとして報告し、依存する範囲を明示する。

## レビュー観点

### DDD・境界

- 各振る舞いが、その責務を持つBounded ContextおよびLayerに属していることを確認する。
- Domain RuleとInvariantが、GraphQL、Persistence、Orchestration Codeではなく、適切なAggregate、Entity、Value Objectによって保証されていることを確認する。
- Aggregate Rootは、Aggregate境界を保護する追加責務を持つEntityとして扱う。重複するEntity Wrapperや同一Typeの二重配置を推奨しない。
- Child Entityは安定したIdentityとLifecycleによって識別する。SnapshotやData Shapeを名前だけでEntityと分類しない。
- Application Use CaseがOrchestration、Authorization、Transaction Boundary、Port呼び出しを担っていることを確認する。TransportとPersistenceの詳細はAdapter側に置く。
- Context間の連携が、別ContextのModelやStorageへの直接Accessではなく、合意済みのID、Port、または明示的なPublic Contractを通じて行われていることを確認する。
- ContextやLayerが存在するという理由だけで、Microservice化や新規Workspace Packageの追加を推奨しない。Accepted Modular Monolithと、実際の再利用・Ownership要件に基づいて評価する。

### SOLID・凝集度

- Moduleに複数の変更理由が存在する、またはUse Caseが無関係な振る舞いを抱えている場合、その具体的な理由を特定する。
- 抽象化を、実際のVariation、Ownership、Dependency Directionに照らして確認する。ClassごとのInterface作成や、将来を推測した過剰な拡張性提案を避ける。
- 実装側または利用側に実際の不整合がある場合、Liskov Substitution PrincipleとInterface Segregation Principleの観点を確認する。
- Layer境界を跨ぐDependency Inversionと、適切なComposition BoundaryでDependencyがInjectされているかを確認する。

### DRY

- 重複Logicが同じ意味、同じ変更理由、同じOwnershipを持つ場合のみ、重複として指摘する。
- 別Contextに属する、または独立して変更される可能性がある、見た目だけ類似したRuleは分離したままにする。
- 早すぎる共通Utility化や新規Package作成より、小さなLocal実装を優先する。

### 日本語JSDoc

- 新規または変更されたexport対象のClass、Function、Interface、Type、Constant、Public Method／Property、およびexportされたObject Type／Interface内のすべてのFieldには日本語JSDocを必須とする。Discriminated Resultの各Fieldも、その親TypeとあわせてDocumentする。
- JSDocでは、目的と、意味のあるConstraint、Failure Behavior、Security／Transaction上のSemanticsを説明する。自明なNameやTypeの言い換えは避ける。
- [coding standards](../../../docs/engineering/coding-standards.md)のTag Ruleを適用する。すべてのPublic API Parameterに一致する日本語の`@param`説明、非void戻り値に`@returns`、Document対象のExceptionに`@throws`を必須とする。引数なしSignatureでは`@param`を省略し、Constructor、`void`、`Promise<void>`、`never`では`@returns`を省略する。非同期APIではResolve後の値を`@returns`に記載する。Result UnionのFailureはExceptionとしてではなく`@returns`内で説明し、TypeScriptの型注釈と重複する記述を避ける。
- Tagが実際のSignatureとFailure Behaviorに一致していることを確認する。ParameterやReturn Tagが必要な場合、日本語の要約文だけでは対応済みとしない。Tag不足、誤ったParameter名、不正確なReturn／Exception説明を報告し、対象Scope内の不足はComment対応完了とする前に修正する。
- Privateな実装詳細や、すべての行を逐一説明するJSDocは不要とする。
- Public JSDocの不足、英語のみ、古い記述、誤解を招く記述はFindingとして報告する。

## Findingの閾値

Correctness、Changeability、Security、またはAccepted Architectureに実質的な影響を与える、Evidenceに基づく問題のみを報告する。個人的なNaming Preference、理論上の純粋性、将来の再利用を想定した推測、今回の変更と無関係な既存Debtを理由にBlockしない。

Severityは以下を使用する。

- **Blocker**: 確定済み要件／Accepted Decisionへの違反、重大なInvariantやSecurity Boundaryの破壊、または未承認の意思決定への依存がある。
- **Major**: Correctness Defectを引き起こす可能性が高い、重大なCoupling、Layer／Context Boundaryの破壊、またはCore Behaviorを安全に変更することを困難にする。
- **Minor**: 安全なReviewを妨げない、局所的なClarity、Cohesion、Duplication、JSDoc上の問題。

各Findingには、変更FileとLine、観測したBehavior、Project RuleまたはTask要件に照らして問題となる理由、最小限かつ有効な修正方法を含める。Diffによって新たに問題が発生した、または既存問題へ依存する場合を除き、未変更CodeをFinding対象にしない。

## Workflow

1. Taskと関連するAccepted Design Sourceを読む。
2. Full Diffを確認し、重要なDependencyについて必要に応じて周辺Codeまで追跡する。
3. 上記のReview観点で評価し、SeverityとFile／Line Evidenceを伴う具体的なFindingを記録する。
4. Findingがない場合は **Pass** とし、確認したReview観点を明記する。
5. BlockerまたはMajorがある場合は修正対象として返す。MinorはTask Scope内であれば修正し、Scope外であれば簡潔な理由とFollow-upの必要性を記録する。
6. 修正後は変更の影響を受けるVerificationを再実行し、更新後のDiffを再レビューする。
7. `code-review`から呼ばれた場合は結果を親Reviewへ返す。独立Task Evaluator、Draft PR作成、PR Ready化、Mergeは本Skillの責務に含めない。

## 出力

以下を返す。

- **Result**: `Pass` または `Needs changes`。
- **Findings**: Severity、File／Line、Issue、Projectに基づく理由、修正内容。問題がなければ`None`。
- **Reviewed scope**: 確認したTask／ADRおよび変更範囲。
- **Verification**: Review起因の修正後に再実行した確認内容。
- **Residual Minor items**: 理由とFollow-up。なければ`None`。
