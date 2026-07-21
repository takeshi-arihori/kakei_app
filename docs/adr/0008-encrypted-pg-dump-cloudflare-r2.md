# ADR-0008: 暗号化pg_dumpをCloudflare R2へ保存

- Status: Accepted
- Date: 2026-07-11
- Area: Operations
- Related Notion Task: なし（移行済みNotion ADRを参照）
- Legacy Source: https://app.notion.com/p/39a06467984f819ca73fcb407ba8db58

## Context

Neon Freeの6時間PITRに加え、30日履歴と復元訓練を可能にする。

## Decision

- Neon PITRを6時間利用する。
- 毎晩全体pg_dumpを取得し、Upload前に認証付き暗号化する。
- DEKをCloud KMSで暗号化する。
- private R2へ保存し、30日Lifecycleを設定する。
- 月1回、別環境でRestore Drillを実施する。

## Alternatives

- PITRのみ: 6時間を超える誤操作へ弱い。
- 非暗号化Object Storage: 金融データの保護要件を満たさない。

## Consequences

- 低コストで長期復元点を得るが、Restore Drillと削除台帳再適用が必要になる。

## Implementation

- Backup Job失敗Alert、Checksum、RPO／RTO計測、Deletion Ledger再適用をRunbook化する。

## Review Trigger

- Backup保持期間、RPO／RTO、NeonのPITR条件が変更された場合。
