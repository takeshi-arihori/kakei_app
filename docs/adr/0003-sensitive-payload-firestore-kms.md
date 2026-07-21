# ADR-0003: 機密PayloadをFirestore＋Cloud KMSへ分離

- Status: Accepted
- Date: 2026-07-11
- Area: Security
- Related Notion Task: なし（移行済みNotion ADRを参照）
- Legacy Source: https://app.notion.com/p/39a06467984f81f09c15e3b0306e1479

## Context

Event Storeを物理削除しない設計と、利用者の完全削除要求を両立させる。

## Decision

- Event Storeへ削除対象の機密平文を保存しない。
- Firestoreへ暗号化Payloadを保存し、Cloud KMSでDEKをEnvelope Encryptionする。
- Eventにはランダムな参照Keyのみ保存する。
- 完全削除時に暗号文と鍵を破棄する。

## Alternatives

- Eventを物理削除: Stream整合性と監査性を損なう。
- Workers KV: 即時整合性要件に合わない。
- PostgreSQLだけ: BackupやEventからの消去が複雑になる。

## Consequences

- Crypto-shreddingが可能になるが、鍵、Backup、Projectionを含む削除Workflowが必要になる。

## Implementation

- Deletion Ledger、Snapshot／Read Model再構築、Restore後の再削除を実装する。

## Review Trigger

- 完全削除要件または利用するStorage／KMSが変更された場合。
