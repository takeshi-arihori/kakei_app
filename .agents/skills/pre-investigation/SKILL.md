---
name: pre-investigation
description: 変更前に現行設計・実装・Domain要素・要件差分・SOLID・依存方向・影響範囲を調査し、変更せずに実装前提を整理する。
---

# Pre Investigation

設計・実装を始める前に、現在の正本とCodeを確認し、何を変える必要があるかをEvidence付きで整理する。このSkill単独ではRepositoryを変更しない。

既存技術・既存設計・既存Directoryを確定事項として扱わず、現在のRequirementとAccepted Decisionに照らして再評価する。既存Codeは現行動作のEvidenceであり、それだけを根拠に設計を正当化しない。

## 確認する正本

1. 着手時点の最新`develop`を確認する。
2. GitHub Task／Issue、Requirement、Done Criteria、Dependencies、Decision Check、Related ADRを読む。
3. [正本入口](../../../docs/governance/README.md)から関連するRepository文書、Accepted ADR、設計Gateを辿る。
4. 対象Code、Test、Schema、Migration、運用手順を必要な範囲で読む。
5. GitHub正本とCodeが矛盾する場合は、実装で吸収せずConflictとして記録する。

## 調査観点

### 現在の設計・実装

- Bounded Context、Data Owner、Use Case、Layer、公開契約、永続化境界
- 既存の正常・境界・権限・失敗・競合・再試行の挙動
- 既存Testが何を保証し、何を保証していないか

### Domain要素

変更対象に関係する次を確認する。

- Entity
- Value Object
- Aggregate／Aggregate Root
- Domain Service／Policy
- Domain Event
- Application Use Case／Port

Directory名やTable名だけで分類しない。判断根拠が不足する場合は未確定として扱う。

### 要件との差分

- 現行仕様で満たせていること
- 不足していること
- Requirementと実装の矛盾
- 未決Decisionに依存すること
- 変更しなくてよいこと

### 設計品質

- SOLID、凝集度、責務分離
- Presentation → Application → Domainの依存方向
- Infrastructureから内側のPortへの依存
- Context横断の直接参照
- 重複の意味とOwnership
- API／DB／Framework都合がDomain Ruleへ漏れていないか

## 出力

最低限、次を返す。

1. **基準**: 確認したdevelop SHA、Task、ADR、文書
2. **現状**: 設計・実装・Testの要約
3. **Domain要素**: Entity／VO／Aggregate／Service／Eventと根拠
4. **不足・矛盾**: Requirementとの差分、Conflict、Open Question
5. **SOLID／依存方向**: 問題の有無とEvidence
6. **影響範囲**: Domain／API／DB／Implementation／Test／Docs／Operations
7. **Skill選択**: 次に必要なSkillと省略できるSkill、その理由
8. **停止事項**: ADRやOwner Decisionが必要な項目

## 終了条件

- 調査中にCodeや文書を変更していない。
- 事実、提案、未確定事項を区別している。
- 次の設計・実装が推測ではなく、正本とEvidenceから開始できる。
