---
name: database-change
description: 確認済みDomain／Application契約を、RepositoryのData／Persistence docsに従って安全なPersistence変更・移行・復旧へ写像する。
---

# Database Change

Persistence変更を業務Ruleの正本にせず、確認済みのData Ownership、Domain設計、Application契約を永続化へ写像する。Skill自身は特定のDB、Data Store、ORM、Migration Toolを固定しない。

## 最初に読む

- GitHub TaskのRequirement／Done Criteria
- `pre-investigation`、必要な設計Skillの成果
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [開発ガイド](../../../docs/engineering/README.md)
- Data／Backend／Domain／Testing／Operations等、変更範囲に必要なdocs
- 関連Accepted ADR
- 既存Persistence定義、Migration、Adapter、Integration Test

採用中のData Store、Schema方式、Migration Tool、命名、Constraint、Index、Transactionの具体RuleはdocsとAccepted Decisionから取得する。

## 実施

1. Data Owner、永続化対象、書込単位をRequirement／Domain設計へTraceする。
2. Persistence構造と制約の変更理由をConcept／Ruleへ対応付ける。
3. Query Pattern、整合性、Concurrency、Idempotency、性能Riskに応じて必要な設計を行う。
4. Nullability／Default／既存Data等、現行DataとのCompatibilityを確認する。
5. Data移行が必要なら段階、Backfill、切替、停止条件を整理する。
6. 破壊的変更または長時間／高Risk変更では関連docsが要求するRollback／Forward-fix、運用、Backup／Restore等を整理する。
7. Integration／Migration／Concurrency等、必要なTestを`testing`へ渡す。
8. Schema／Data／Runbook／図等の更新対象を整理する。

Persistence上の制約だけを根拠に、新しいDomain Invariantを確定しない。

## 出力

- Data OwnerとPersistence対象
- Persistence差分と根拠
- Constraint／Index／Transaction／Concurrency等、適用した設計結果
- Data移行／Backfill／切替手順
- RollbackまたはForward-fix
- Test／検証項目
- Data保持・削除・Security／Operationsへの影響
- 更新対象docs／図／Runbook
- Open Question／Conflict／ADR要否

## 停止条件

新しいData Store、Persistence方式、Data Ownership、Context間Storage共有、不可逆なData移行等についてRepositoryのDecision Gateに該当する未承認Decisionがある場合、そのDecisionに依存する変更を確定・実行しない。

## 完了条件

- Persistence変更がRequirementとDomain／Application上の必要性へTraceできる。
- 具体方式がRepository docsの現行Decisionと一致する。
- Compatibility、移行、競合、復旧、検証方法を説明できる。
- Skill本文の技術仮定ではなくdocsを根拠に設計している。
