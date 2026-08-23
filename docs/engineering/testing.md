# テストとTDD

## TDDサイクル

新しい振る舞いはRed → Green → Refactorで進める。

1. RequirementとDone Criteriaを観測可能な振る舞いへ分解する。
2. 正常、境界、権限、失敗、競合、再試行から最小の次のCaseを選ぶ。
3. そのCaseを表すTestを追加し、意図した理由で失敗することを確認する（Red）。
4. Testを通す最小のProduction Codeを実装する（Green）。
5. TestをGreenに保ちながら重複、命名、責務、依存方向を改善する（Refactor）。
6. 次のCaseへ進み、Done Criteriaを満たすまで繰り返す。

Bug Fixでは、再現Testを先に追加する。既存Testが誤った仕様を固定している場合は、Notion仕様を確認し、Testと実装を同じ変更で直す。

機械的なConfig、生成物、文言だけの変更で先行Testが価値を持たない場合は省略できる。その理由と代替検証をPRへ記載する。

## Testの責務

### ドメイン単体テスト

- DB、Hono、GraphQL、Prismaを使わず、業務Ruleを高速・決定的に検証する。
- Money、10%単位のSplit Allocation、最大剰余方式とTie-break、Group人数／Owner、Participant Balance、SettlementのLifecycleを対象にする。
- Snapshot Revisionの不変性、全必要承認者、Rejected後の訂正・再申請権限、Payment Attemptの差し戻し・再試行、Archive成立条件を検証する。
- 時刻、ID、乱数を外から渡し、Testを実時間や実行順に依存させない。

### Event Sourcingを採用する場合

Event Sourcingの適用対象は未確定である。Accepted ADRで対象が決まるまで、旧Transaction／Settlement Aggregateを前提とするTestを新規追加しない。

```text
Given: 過去Event列
実行: Command
期待: 新しく発生するEvent列 または Domain Error
```

- 最終StateだけでなくEvent Type、Version、非機密Payloadを確認する。
- Event全再生とSnapshot＋残Event再生が同じStateになることを確認する。
- expectedVersion競合、同一Command再送、旧Schema Upcast、破損Event／Snapshotを検証する。

### プロパティベース／パラメータ化テスト

- 任意の妥当なJPY金額・1〜4人・10%単位の割合で、負担額合計がGroup Expense額と一致する。
- 端数割当が最大剰余、実支払者、Group参加順の優先Ruleに従う。
- Participant BalanceのGroup合計が0円になる。
- 最少送金回数の候補が複数ある場合も、参加順のTie-breakで同じPayment Instructionを返す。
- Event Sourcingを採用した範囲だけ、Event Replayの結果が技術的Snapshotの有無に依存しないことを確認する。

### 結合テスト

- 採用済みのMigration、Repository、永続化Adapterを実PostgreSQLまたは合意した分離環境で検証する。
- Accepted ADRで採用した場合だけ、Event append、Projection、OutboxのAtomicityとRebuildを検証する。
- Idempotency、Version競合、同時承認、訂正と再申請の競合、Batch再実行、Retryを確認する。
- 未採用のPrisma、Firestore、KMS、Workerを前提にTest基盤を作らない。

### GraphQL API

- 認証、CSRF、CORS、Group Owner／Participant認可、Group IDOR
- Input Validation、Error Code、Field Error、Correlation ID
- Cursor Pagination、Filter、Sort、Depth／Complexity／件数制限
- DataLoaderによるN+1防止
- Schema差分と破壊的変更

### フロントエンド／E2E

- Component Testは表示、入力、Keyboard、Accessibilityを検証する。
- Storybookは状態とInteractionを独立して確認する。
- PlaywrightはGroup作成・招待、Group Expense登録、Settlement申請・承認、支払報告・受取確認、Archive参照など主要経路へ限定する。
- E2EだけでDomain Ruleの全分岐を検証しない。

### 運用テスト

- Group終了後のRetention Batch、部分失敗、冪等再実行
- Receipt画像のRetentionと、削除後も保持する確定済みItem情報
- Backup／Restoreと、採用済みProjectionがある場合のRebuild
- Migration Job、RollbackまたはForward-fix

## テスト品質

- 実装詳細より、業務Rule、契約、障害境界を検証する。
- 1 Testの失敗理由を明確にし、無関係な多数のAssertionを詰め込まない。
- Test名はGiven／When／Thenまたは期待する業務結果を表す。
- 実在する個人情報・金融情報をTest Dataへ使わない。
- Flaky TestをRetryで隠さない。隔離する場合はOwner、理由、解消期限を記録する。
- Mockは境界を置き換えるために使い、Mock呼出し回数だけでDomainの正しさを証明しない。

## 網羅率

- Global line／branchは初期目標80%。
- Money、Split Allocation、Participant Balance／Payment Instruction導出、Settlement Approval／Payment Attempt、認可PolicyはCritical Branch 100%を目標とする。
- Coverage数値をDone Criteriaの代替にしない。
- 生成Code、単純DTO、Migrationへ無意味なUnit Testを追加しない。

## 検証Command

変更したPackageのScriptを先に実行し、最後にRootから存在するCheckを実行する。

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

必要に応じて`pnpm test:e2e`、Integration、Schema差分、Migration検証を追加する。実行しないCheckは理由と残リスクをPRへ記載する。

## 完了条件

- RequirementとDone Criteriaの各項目がTestまたは明示的な検証へTraceできる。
- 新しいDomain RuleにUnit Testがある。
- 正常、境界、権限、失敗、競合、再試行を必要範囲で検証している。
- GraphQL、Event、Migrationの契約差分がレビューされている。
- LogやErrorに禁止Dataが含まれない。
- 関連するNotion文書、図、ADR、Runbookが更新されている。

## 参照元

- [テスト設計](https://app.notion.com/p/3a906467984f804eadc0e0622e2fcfc4)
- [ドメイン設計](https://app.notion.com/p/3a906467984f80728058c839a403e6f0)
- [セキュリティ設計](https://app.notion.com/p/3a906467984f80f9b9b6d8b52d8b0f7f)
- [未確定事項・Documentation Conflict](https://app.notion.com/p/3a906467984f814ba736c627901ead38)
