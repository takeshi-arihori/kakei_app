# Snapshot Revisionの保護と保持境界

- Status: Proposed
- Decision Owner: Project Owner
- Related Decision: [ADR #24](shared-expense-domain-boundaries.md#承認条件-c1-snapshot-revisionの保護と保存)
- Decision record: [GitHub ADR Issue #55](https://github.com/takeshi-arihori/kakei_app/issues/55)
- Related Task: [GitHub Task #54](https://github.com/takeshi-arihori/kakei_app/issues/54)
- Persistence dependency: [GitHub Task #42](https://github.com/takeshi-arihori/kakei_app/issues/42)

## Context

ADR #24の条件C1は未充足である。Settlement Snapshot Revisionは選択Expense、Expense内容、Participant Balance、Payment Instruction候補、必要承認者を不変に保持する。一方、Event、Snapshot、Logへ機密平文を保存しない不変条件、Group内認可、Group終了時の保持・削除、Backup／Projectionへの削除伝播を保存実装より先に整合させる必要がある。

## Decision Proposal

### A. 最小業務Snapshotを保護し、認可後だけ参照可能にする

Snapshot Revisionの保存候補は、Settlement CaseとRevisionの識別子、作成時刻、選択Expense ID集合、各Expenseの金額・実支払者・割り勘率・負担額、Participant Balance、導出したPayment Instruction候補、必要承認者、各Settlement ApprovalのParticipant・承認／却下・決定時刻・却下理由、`previousSnapshotId`に限る。

Receipt画像、OCR結果、直接連絡先、認証情報、鍵、Token、transport metadataは業務Snapshotに含めない。技術Snapshot、Stored Event、Audit Logにも上記の業務Dataを複製しない。

保存時保護はアプリケーションのSecurity境界に置き、鍵責任は専用Portとして分離する。特定のProvider、algorithm、鍵素材、DBは選定しない。復号または復号相当の参照はGroup内認可の成功後に限定し、非在籍者へGroupやSnapshotの存在を開示しない。

| Actor状態 | Snapshot参照 | 拒否時の扱い |
| --- | --- | --- |
| 現役Participant | Owner Decisionで定める範囲だけ許可候補 | 許可範囲外なら存在を開示せず、業務Snapshot、認可状態、業務履歴を作成・更新しない |
| 脱退Participant | Owner Decisionで定める履歴参照だけ候補 | 拒否なら同上 |
| Group Owner | Owner Decisionで定める範囲だけ候補 | 拒否なら同上 |
| 非在籍者 | 許可しない | 存在を開示せず、業務Snapshot、認可状態、業務履歴を作成・更新しない |

Security auditの最小メタデータを残す必要性、内容、保持・削除は別のOwner Decisionと独立Security Reviewの対象とし、業務Snapshotへ混在させない。

Groupを終了してArchiveしたGroupの`archivedAt`から1暦年、Group業務Dataの`deleteEligibleAt`での削除、Deleted Group Tombstoneを`deletedAt`からさらに1年保持、各Batchの独立した冪等再試行というConfirmed Ruleを維持する。Snapshot Revisionと派生Backup／Projectionへの適用範囲と例外はOwner Decisionで固定する。

### Rejected alternatives

- DB透明暗号化だけでは、アプリケーションのGroup内認可、技術Snapshot／Logへの複製禁止、Backupの削除伝播を決められず、C1を満たさない。
- 業務Snapshotを不可逆Tokenだけで保存すると、金額、配賦、Balance、Payment Instruction、必要承認者の不変な参照を満たせず、C1を満たさない。

## Required Owner Decision

Project Ownerは案A、案Aの修正、または見送りを明示する。Acceptedする場合は、最小保存・禁止項目、保存時保護と鍵責任、鍵ローテーションと削除時の無効化に必要な後続Decision、現役／脱退／Owner／非在籍者の許可・拒否、拒否時に業務状態・履歴を残さない契約、Security auditの最小メタデータ、保持・削除とBackup／Projection、独立Security Reviewの証拠・Reviewer・再評価条件を具体化する。

## Consequences and Gate

ProposalのMerge、またはOwner AcceptedだけではC1は充足しない。独立Security Reviewが上記の証拠を確認するまでC1は未充足であり、#42はBacklog／Blocked Yesを維持する。本ProposalはDB、Cloud、KMS、鍵、Schema、Migration、Persistence Adapter、認証Provider、GraphQL、UIを実装または採用しない。

## Implementation Boundary

本Proposalは実装を含まない。Owner Accepted後に最小保存、保護Port、認可、保持・削除の後続TaskをReady評価できるが、独立Security Reviewの証拠が揃うまでC1と#42のBlockedは維持する。

## Rollback and Review Trigger

Proposed中はRejectedまたはCloseとして取り下げ、現行C1 Gateを維持できる。Accepted後の変更は新ADRで扱う。保持期限、Snapshot必須項目、参加者の参照権限、Backup／Projection、Security Reviewの証拠要件が変わるときに見直す。
