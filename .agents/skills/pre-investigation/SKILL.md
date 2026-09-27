---
name: pre-investigation
description: 変更前にRepository正本とCodeを確認し、現状、Domain要素、Requirementとの差分、設計品質、影響範囲を変更せずに整理する。
---

# Pre Investigation

設計・実装を始める前に、現在のRequirementとAccepted Decisionに対して現行設計・実装がどうなっているかをEvidence付きで整理する。このSkill単独ではRepositoryを変更しない。

## 最初に読む

- 最新`develop`
- GitHub Task／Requirement／Done Criteria／Dependencies／Decision
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [開発ガイド](../../../docs/engineering/README.md)
- [正本入口](../../../docs/governance/README.md)から辿れる関連docs／Accepted ADR

具体的なArchitecture、言語、DB、Framework、API、Directory Ruleは関連docsから取得する。既存CodeやDirectoryの存在だけで採用Decisionを推測しない。

## 調査する

1. 現在の設計・実装・Test・公開契約・Persistence・運用境界を必要範囲で確認する。
2. 変更対象に関係するEntity、Value Object、Aggregate、Domain Service／Policy、Domain Event、Application Use Case／Port等を根拠付きで整理する。
3. Requirementに対して、成立済み、不足、矛盾、変更不要を分ける。
4. 関連docsが定めるSOLID、DRY、凝集度、責務分離、依存方向、Context境界を確認する。
5. Domain／公開契約／Persistence／Implementation／Test／Docs／Security／Operations等への影響を分類する。
6. 未決Decision、正本Conflict、Owner確認が必要な項目を分離する。

Skill自身が設計Ruleを再定義せず、評価根拠となるdocsを結果に添える。

## 出力

1. **基準**: develop SHA、Task、ADR、確認したdocs
2. **現状**: 設計・実装・Testの要約
3. **Domain要素**: 変更に関係する要素と根拠
4. **Gap**: Requirementとの不足・矛盾・変更不要箇所
5. **設計品質**: 適用したdocs Ruleと問題Evidence
6. **影響範囲**: 後続で扱う領域
7. **Skill選択**: 次に必要／省略できるSkillと理由
8. **停止事項**: ADR、Owner Decision、Conflict

## 終了条件

- 調査中にCodeや文書を変更していない。
- 事実、提案、未確定事項を区別している。
- 具体Ruleの根拠をSkill本文ではなくRepository docsへTraceできる。
- 次の設計・実装が推測ではなくEvidenceから開始できる。
