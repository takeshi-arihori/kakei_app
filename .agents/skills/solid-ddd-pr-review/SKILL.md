---
name: solid-ddd-pr-review
description: Code Reviewの専門観点として、Repository docsが定めるDDD、SOLID、DRY、責務境界、依存方向等を対象Diffへ適用する。
---

# SOLID・DDD専門Review

対象TaskのDiffを、Repository docsが定める設計品質Ruleで専門Reviewする。Skill自身は特定のProgramming Language、Documentation形式、Framework、DB、API方式を固定しない。

## 最初に読む

- GitHub Task、Requirement、Done Criteria
- Accepted ADRと関連設計成果
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [開発ガイド](../../../docs/engineering/README.md)
- [Domain Design Rule](../../../docs/engineering/domain-design.md)
- [Coding Rule](../../../docs/engineering/coding-standards.md)
- 対象Layerに適用される追加docs
- Test／Documentationを含む対象Diff

具体的なPublic API Documentation、Naming、Layer、Directory、Dependency等のRuleは上記docsから取得する。

## Review Workflow

1. TaskとAccepted Designを確認する。
2. Full Diffを確認し、必要なDependencyだけ周辺Codeまで追跡する。
3. 対象変更に適用されるRepository Ruleを選ぶ。
4. DDD、SOLID、DRY、Cohesion、Ownership、Dependency Direction、Context Boundary等を、選んだRuleへ照合する。
5. 見た目の重複や理論上の純粋性だけでは指摘せず、実際の意味、変更理由、Ownership、Correctnessへの影響をEvidenceで示す。
6. Project固有のDocumentation Ruleが対象変更に適用される場合だけ、そのdocsに従って確認する。
7. FindingごとにSeverity、File／Line、観測事実、根拠docs、最小修正を示す。
8. 修正後は影響するVerificationを再実行し、最新Diffを再Reviewする。

## Review観点

詳細Ruleはdocsへ委譲し、このSkillでは問いだけを保持する。

- 振る舞いは正しいOwner／Context／Layerにあるか
- Invariantを保護すべき責務が外側へ漏れていないか
- Use CaseとDomain、Adapter等の責務が混在していないか
- Dependency DirectionはRepository Architectureに整合するか
- 1つのModule／Class／Function等に無関係な変更理由が集中していないか
- 抽象化は実在するVariation／Ownershipに基づくか
- 重複は意味・変更理由・Ownershipまで同一か
- 共有化によってContext境界を壊していないか
- 対象言語・公開APIにDocumentation Ruleがある場合、それを満たしているか

## Severity

- **Blocker**: Requirement／Accepted Decision違反、重大なInvariant／Security Boundary破壊、未承認Decisionへの依存
- **Major**: Correctnessや安全な変更を妨げる重大な責務・依存境界の破壊
- **Minor**: 局所的なClarity、Cohesion、Duplication、Documentation等の低Risk問題

## 出力

- **Result**: `Pass` または `Needs changes`
- **Findings**: Severity、File／Line、Issue、根拠docs、修正内容
- **Reviewed scope**: Task／Decision／Diff／適用docs
- **Verification**: Review起因修正後の再確認
- **Residual Minor items**: Scope外Follow-up

## 責務境界

本Skillは専門Reviewだけを行う。再設計の統括、独立`task_evaluator`、GitHub Delivery、PR Ready化、Mergeは担当しない。総合`code-review`から呼ばれた場合は結果を返す。
