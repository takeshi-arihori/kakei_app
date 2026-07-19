# ADR-0002: GCP＋Neon＋Cloudflareのインフラ構成

- Status: Accepted
- Date: 2026-07-11
- Area: Infra
- Related Notion Task: なし（移行済みNotion ADRを参照）
- Legacy Source: https://app.notion.com/p/39a06467984f810491f0c764bae85917

## Context

個人開発のMVPで固定費を抑えつつ、PostgreSQL、機密KV、KMS、Container実行基盤を用意する。

## Decision

- Next.js／NestJS／WorkerはCloud Run Singaporeで実行する。
- PostgreSQL／Event StoreはNeon AWS Singaporeを利用する。
- Sensitive KVはFirestore、Key ManagementはCloud KMSを利用する。
- EdgeはCloudflare DNS／CDN／WAFを利用する。
- 添付はMVP対象外とし、将来候補をR2とする。

## Alternatives

- DigitalOcean: 日本Regionがなく、Managed DB固定費とScale to Zeroの成熟度が要件に合わない。
- Cloud SQL: 初期固定費が予算に合いにくい。
- Cloudflare Workers KV: 結果整合性のため機密削除Storeに適さない。

## Consequences

- 低固定費を得る一方、Singapore遅延とCold Startを計測する必要がある。

## Implementation

- 日本からのLatencyとCold Startを分離計測する。

## Review Trigger

- 公開後にLatencyまたはCold StartがSLOを満たさない場合。
