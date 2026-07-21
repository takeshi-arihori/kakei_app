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
- Money、日付、端数、Split、Household人数／Owner、削除・復元、精算上限を対象にする。
- 時刻、ID、乱数を外から渡し、Testを実時間や実行順に依存させない。

### イベントソーシング

```text
Given: 過去Event列
実行: Command
期待: 新しく発生するEvent列 または Domain Error
```

- 最終StateだけでなくEvent Type、Version、非機密Payloadを確認する。
- Event全再生とSnapshot＋残Event再生が同じStateになることを確認する。
- expectedVersion競合、同一Command再送、旧Schema Upcast、破損Event／Snapshotを検証する。

### プロパティベース／パラメータ化テスト

- 任意の妥当な金額・人数でSplit合計がExpense額と一致する。
- 端数割当が決められた優先順に従う。
- Pairwise Debtの相殺結果が入力順に依存しない。
- Event Replayの結果がSnapshot有無に依存しない。

### 結合テスト

- Testcontainers等の実PostgreSQLでPrisma Migration、Repository、Event Storeを検証する。
- Event append、同期Projection、OutboxのAtomicityを障害Caseも含めて確認する。
- Idempotency、Row Lock／Version、Worker重複配送、Retry、隔離、Rebuild再開を確認する。
- Firestore／KMSはEmulatorまたは分離環境でAdapter Contractを検証する。

### GraphQL API

- 認証、CSRF、CORS、Owner／Member認可、Household IDOR
- Input Validation、Error Code、Field Error、Correlation ID
- Cursor Pagination、Filter、Sort、Depth／Complexity／件数制限
- DataLoaderによるN+1防止
- Schema差分と破壊的変更

### フロントエンド／E2E

- Component Testは表示、入力、Keyboard、Accessibilityを検証する。
- Storybookは状態とInteractionを独立して確認する。
- Playwrightは登録、世帯・招待、口座、取引、割勘、精算、削除・復元など主要経路へ限定する。
- E2EだけでDomain Ruleの全分岐を検証しない。

### 運用テスト

- Backup暗号化、Restore、Deletion Ledger再適用
- Crypto-shredding後の復号失敗
- Projection Rebuild、Outbox復旧
- Migration Job、Revision Rollback

## テスト品質

- 実装詳細より、業務Rule、契約、障害境界を検証する。
- 1 Testの失敗理由を明確にし、無関係な多数のAssertionを詰め込まない。
- Test名はGiven／When／Thenまたは期待する業務結果を表す。
- 実在する個人情報・金融情報をTest Dataへ使わない。
- Flaky TestをRetryで隠さない。隔離する場合はOwner、理由、解消期限を記録する。
- Mockは境界を置き換えるために使い、Mock呼出し回数だけでDomainの正しさを証明しない。

## 網羅率

- Global line／branchは初期目標80%。
- Money、SplitCalculator、Transaction／Settlement Aggregate、認可PolicyはCritical Branch 100%を目標とする。
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
- 関連文書、図、ADR、Runbookが更新されている。

## 参照元

- [11 テスト・品質保証](https://app.notion.com/p/39a06467984f819e8dc7d6f57e50ae8a)
- [06 ドメインモデル・集約・UML](https://app.notion.com/p/39a06467984f81b3b495f6ee2126fac5)
- [09 セキュリティ・プライバシー・監査設計](https://app.notion.com/p/39a06467984f8146bd2ccadf82529e6a)
