---
name: database-change
description: Data OwnerとDomain/Application契約を前提に、Table・Migration・Index・Constraint・Data移行・Rollbackを安全に設計する。
---

# Database Change

Persistence変更を業務Ruleの正本にせず、確認済みのData Owner、Domain設計、Application契約をDBへ写像する。

## 入力

- GitHub TaskのRequirement／Done Criteria
- `pre-investigation`、必要なら`domain-design`の成果
- [設計Gate](../../../docs/product/design-gates.md)
- [Backend開発ルール](../../../docs/engineering/backend.md)
- [ドメイン設計ルール](../../../docs/engineering/domain-design.md)
- [テスト方針](../../../docs/engineering/testing.md)
- 関連Accepted ADR
- 既存Migration、Schema、Repository Adapter、Integration Test

DB、Persistence方式、Data Ownerが未確定なら、既存DirectoryやMigrationの存在だけを根拠に採用済みとみなさない。

## 設計観点

- Table／Column／Key／ConstraintがどのConceptとRuleを永続化するか
- Aggregate／Transaction Boundaryと書込単位
- Unique、Foreign Key、Check Constraintの責務
- IndexのQuery Pattern、選択性、Write Cost
- Version／Optimistic Lock、競合、Idempotency
- Nullability、Default、既存Dataとの互換性
- Expand／Migrate／Contract、Backfill、Dual Read／Writeの要否
- Online Migration、Lock、長時間Transaction、Batchサイズ
- RollbackまたはForward-fix
- Backup、Restore、Retention、削除、再構築可能性

DB Constraintだけを根拠にDomain Invariantを新規確定しない。

## Migration Rule

- 破壊的Migrationは利用者の明示確認なしに実行しない。
- 既存Dataを壊す可能性がある変更はMigration手順と復旧方針を先に示す。
- Schema変更と対応するApplication／Repository／Test／文書を同じ変更で整合させる。
- 未採用のDBやORMを前提にScaffoldを追加しない。

## 出力

- Data OwnerとPersistence対象
- Schema差分と各変更の根拠
- Index／Constraint／Transaction／Concurrency方針
- Migration／Backfill手順
- RollbackまたはForward-fix
- Integration Test、競合、再試行、Migration Test
- Data保持・削除・Securityへの影響
- 更新する文書／図／Runbook
- Open Question／Conflict／ADR要否

## 停止条件

新しいDB、Persistence方式、Data Owner、Context間Storage共有、不可逆なData移行などADR必須のDecisionが未承認なら、そのDecisionに依存するSchema／Migrationを確定・実行しない。

## 完了条件

- Schema変更がDomain／Application上の必要性へTraceできる。
- 互換性、移行、競合、復旧、検証方法が説明できる。
- DB都合をDomain Ruleとして誤確定していない。
