# 家計アプリ 開発ルール

## 正本と読み方

- 利用者の最新の明示指示を最優先する。
- Project、Epic、Task、仕様、設計、ADRの正本はNotionとする。
- 実装前に対象Task、関連仕様、NotionのAccepted ADR、既存コードを確認する。
- 詳細ルールの入口は[docs/engineering/README.md](docs/engineering/README.md)とする。必要な文書だけを読む。
- Notionとコードが矛盾する場合は実装で吸収せず、矛盾と影響を報告して解消する。

## プロジェクト構成

- `apps/web`: Next.jsフロントエンド
- `apps/api`: Hono＋GraphQL Yoga API
- `apps/worker`（未作成）: Projection・Outbox・保守JobのTaskへ着手するときに追加する
- `packages`（未作成）: 生成GraphQL契約またはBackend非依存基盤の最初の利用Taskへ着手するときに追加する
- `infra`: ローカル・クラウド環境
- `docs/engineering`: 実装時に使うルールとチェックリスト
- Package Managerはpnpmを使用し、TypeScript strict modeを維持する。

## アーキテクチャ不変条件

- Next.jsにDomain LogicやDB Accessを実装しない。業務API、認証、認可の正本はHono APIのApplication／Domainとする。
- Honoは薄いPresentation Adapterとし、Presentation → Application → Domainの依存方向を守る。
- InfrastructureはDomainまたはApplicationが定義したPortを実装する。
- Prisma Model、DTO、GraphQL Type、Domain Modelを同一型として共有しない。
- Contextを跨ぐ直接参照を避け、IDまたは明示的なPort・公開契約を使用する。
- Domain Event、Integration Event、Stored Event、Audit Log、Outbox Messageを区別する。
- Event、Snapshot、Logへ機密平文を保存しない。

現行Product Scopeと設計Gate:

- 業務Domainは1〜4人のGroupで行う共有割り勘に限定し、個人収支を扱わない。
- 現行の主要語はGroup、Participant、Group Expense、Split Allocation、Settlement Case、Snapshot Revision、Payment Instruction、Payment Attempt、Settlement Archiveとする。
- 個人用Household、Account、収入Transaction、日付境界Archive、単一Payer／Payeeを現行仕様として実装しない。
- Bounded Context、Aggregate、Data Owner、Event Sourcing／CQRS適用範囲は未確定である。Accepted ADRへ同期されるまで、旧Context一覧や旧Aggregate境界を採用済みDecisionとして扱わない。
- 未確定の設計判断に依存するTaskをReadyまたは実装へ進めない。

## 実装手順

1. 対象TaskのStatus、Requirement、Done Criteria、依存関係、Estimate、Decision Check、Related ADRを確認する。
2. 変更をBounded Context、Aggregate、画面、GraphQL、Data、Security、運用へ対応付ける。
3. Epic／Taskの起票・変更では`Decision Check` Propertyを設定し、文書変更でも`方針変更なし／あり`を判定する。`方針変更あり`または不明なら`Related ADR`を設定し、未決ならNotionへADR Proposalを起票する。Project OwnerがAcceptedを明示し、TaskがそのDecisionへ整合するまでReadyまたは実装へ進めない。Rejectedの場合は現行DecisionへRequirementとDone Criteriaを戻し、Decision Checkをやり直す。
4. 仕様の不足や矛盾を解消し、TaskがReadyであることを確認する。
5. 失敗するTestを先に作り、最小実装、Refactorの順で進める。
6. 実装と同じ変更内で関連するNotion文書、図、Schema、ADR、Runbookを更新する。
7. package.jsonに存在するlint、typecheck、test、buildを実行する。
8. Done Criteriaと差分を自己レビューしてからPR準備へ進む。

## 変更ルール

- 新しい本番依存関係を追加する前に確認を取る。
- MigrationやSchemaの破壊的変更を無断で行わない。
- Accepted ADR、新しいBounded Context、DB、Cloud Service、Runtime／配置構成、Event Sourcing対象、認証・認可・Security／Privacy方式、API Protocol／Schema正本、Context間連携、不可逆または高コストな運用判断を変える場合はNotion ADRを必須とする。
- 現行Decision内の局所実装や、容易に戻せる低影響の変更にはADRを作成しない。
- GraphQL、Event Schema、Migrationの変更には互換性・移行・RollbackまたはForward-fix計画を持たせる。
- 金額にfloating pointを使わない。MVPではJPYの1円単位整数として扱う。
- 内部TimestampはUTC、業務上の月次判定はAsia/Tokyoで行う。
- Secret、個人情報、実在する金融情報をコード、Fixture、Log、Commitへ含めない。
- コメントは処理の逐語説明ではなく、理由、制約、代替案を記す。

## Git・プルリクエスト

- Epic、Task、ADRの起票・状態管理はNotionだけで行う。
- `develop`を統合Branchとし、`develop`への直接Pushと`main` Branchの作成・Pushを禁止する。
- 1 Task／1 Branch／1 PRを基本とする。
- Conventional Commitsを使用し、Commitをレビュー可能な論理単位にする。
- PR本文へNotion Task URLを記載する。
- PR作成前に[delivery-workflow.md](docs/engineering/delivery-workflow.md)の文書影響確認を完了する。

## 完了条件

- 正常系だけでなく、境界値、権限、失敗、競合、再試行を検証する。
- 新しいDomain RuleにはDomain Unit Testがある。
- テスト失敗や未確認事項を無視して完了扱いにしない。
- 関連するNotion文書、Repo文書、Schema、Notion ADR、Runbookの更新要否が説明できる。
- 実行しなかった検証がある場合は、理由と残リスクを明示する。

## 詳細ルール

- DDD・値オブジェクト・Entity・Event Sourcing: [domain-design.md](docs/engineering/domain-design.md)
- Coding・単一責任: [coding-standards.md](docs/engineering/coding-standards.md)
- Frontend責務: [frontend.md](docs/engineering/frontend.md)
- TDD・品質保証: [testing.md](docs/engineering/testing.md)
- Epic／Task／Git／PR前文書更新: [delivery-workflow.md](docs/engineering/delivery-workflow.md)
- ADR・未確定事項: [08. 設計変更・意思決定](https://app.notion.com/p/3a906467984f810b8ac7d4d416cc5296)
