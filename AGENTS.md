# 家計アプリ 開発ルール

## 正本と読み方

- 利用者の最新の明示指示を最優先する。
- Notionは読み書きしない。GitHub Issueを要件・完了条件、Private Projectを進捗・Sprint、Repositoryを仕様・設計・ADRの正本とする。
- GitHubの取得先や固定Commitを確認するときは[正本入口](docs/governance/README.md)を使う。
- 機能Taskの実装前に対象Task、関連仕様、GitHubのAccepted ADR、既存コードを確認する。
- 詳細ルールの入口は[docs/engineering/README.md](docs/engineering/README.md)とする。必要な文書だけを読む。
- GitHubとコードが矛盾する場合は実装で吸収せず、矛盾と影響を報告して解消する。

## プロジェクト構成

- `apps/web`: Next.jsフロントエンド
- `apps/api`: Hono＋GraphQL Yoga API
- `apps/worker`（未作成）: Projection・Outbox・保守JobのTaskへ着手するときに追加する
- `packages`（未作成）: 生成GraphQL契約またはBackend非依存基盤の最初の利用Taskへ着手するときに追加する
- `infra`: ローカル・クラウド環境
- `docs`: 「何が正しいか」を管理する静的な仕様・設計・規約
- `.agents/skills`: 「どう作業するか」を管理する再利用可能な手順
- Package Managerはpnpmを使用し、TypeScript strict modeを維持する。

## アーキテクチャ不変条件

- Next.jsにDomain LogicやDB Accessを実装しない。業務API、認証、認可の正本はHono APIのApplication／Domainとする。
- Honoは薄いPresentation Adapterとし、Presentation → Application → Domainの依存方向を守る。
- InfrastructureはDomainまたはApplicationが定義したPortを実装する。
- Prisma Model、DTO、GraphQL Type、Domain Modelを同一型として共有しない。
- Contextを跨ぐ直接参照を避け、IDまたは明示的なPort・公開契約を使用する。
- Domain Event、Integration Event、Stored Event、Audit Log、Outbox Messageを区別する。
- Event、Snapshot、Logへ機密平文を保存しない。
- 正式な設計図は`docs/diagrams/*.mermaid.md`で管理し、文章のAccepted Decisionを優先する。詳細は[図の管理ルール](docs/engineering/diagram-governance.md)に従う。
- draw.ioはProject Ownerの検討用入力とする。AIはdraw.ioファイルを作成、更新、削除、整形せず、変更を行うToolも使用しない。Ownerが明示した場合だけ読み取り専用で参照する。

現行Product Scopeと設計Gate:

- 業務Domainは1〜4人のGroupで行う共有割り勘に限定し、個人収支を扱わない。
- 現行の主要語はGroup、Participant、Group Expense、Split Allocation、Settlement Case、Snapshot Revision、Payment Instruction、Payment Attempt、Settlement Archiveとする。
- 個人用Household、Account、収入Transaction、日付境界Archive、単一Payer／Payeeを現行仕様として実装しない。
- 3 Context（Group Management、Expense Recording、Settlement）、MVP Modular Monolith、State model＋不変業務履歴、Command／Query責務分離を採用する。境界やPersistenceを扱う前に[設計Gate](docs/product/design-gates.md)と、そこから辿れる対象ADRを確認する。条件付き採用や未決事項を採用済みと解釈しない。C1は2026-09-20に充足したが、Persistence実装はS0〜S3と対象Task固有のReady条件が揃うまで進めない。
- 未確定の設計判断に依存するTaskをReadyまたは実装へ進めない。

## 作業の入口

GitHub Epic／Taskの起票・改善は`prepare-github-work`、Ready済みTaskをDraft PRまで届ける場合は`implement-github-task`を使う。`implement-github-task`はGitHub Lifecycleを担当し、実作業を`feature-development`へ委譲する。

機能変更の統括は`feature-development`を入口とし、変更内容に応じて必要なSkillだけを組み合わせる。

| 作業 | Skill |
| --- | --- |
| 現状・影響範囲・不足・SOLID／依存方向の事前調査 | `pre-investigation` |
| Domain Rule、Entity、Value Object、Aggregate、Domain Service、Domain Event | `domain-design` |
| GraphQL／HTTP契約、Input／Output、Error、認証認可境界、互換性 | `api-design` |
| Table、Migration、Index、Constraint、Data移行 | `database-change` |
| Production Code | `implementation` |
| TDD、Test設計、検証、回帰 | `testing` |
| 最終Diffの要件・設計・品質Review | `code-review` |

専門Skillは単独でも利用できる。

- `domain-modeling`: 業務概念・Rule・Invariant・境界の発見／検証
- `specification-contract`: 個別Use CaseのPRE／POST／INV／FAILとTest Trace
- `solid-ddd-pr-review`: SOLID／DRY／DDD／日本語JSDocの専門Review
- `prepare-pr-evidence`: 必要時だけPRの視覚証跡を準備

旧Notion名のSkillは互換入口であり、Notionへ接続しない。個別Skillから`feature-development`を呼び戻さず、統括Skillだけが組合せと順序を決める。

利用者が対象を指定した文書・Skillの整理は、その範囲で進める。新しい機能Taskを選ぶ作業と混同しない。機能の着手条件、GitHub起票・変更のDecision Check、ADR承認は[delivery-workflow](docs/engineering/delivery-workflow.md)に従う。

変更の影響範囲に応じて必要な文書だけを読み、関連文書を同じ差分で整合させる。既に得た利用者の承認を繰り返し求めない。依頼された成果の作成、検証、変更起因の修正、再検証まで進める。未決Decisionがあれば依存する確定・実装を止め、影響と必要な判断を報告し、依存しない作業を続ける。

## 変更ルール

- 新しい本番依存関係を追加する前に確認を取る。
- MigrationやSchemaの破壊的変更を無断で行わない。
- Accepted ADR、新しいBounded Context、DB、Cloud Service、Runtime／配置構成、Event Sourcing対象、認証・認可・Security／Privacy方式、API Protocol／Schema正本、Context間連携、不可逆または高コストな運用判断を変える場合はGitHub ADRを必須とする。
- 現行Decision内の局所実装や、容易に戻せる低影響の変更にはADRを作成しない。
- GraphQL、Event Schema、Migrationの変更には互換性・移行・RollbackまたはForward-fix計画を持たせる。
- 金額にfloating pointを使わない。MVPではJPYの1円単位整数として扱う。
- 内部TimestampはUTC、業務上の月次判定はAsia/Tokyoで行う。
- Secret、個人情報、実在する金融情報をコード、Fixture、Log、Commitへ含めない。
- コメントは処理の逐語説明ではなく、理由、制約、代替案を記す。
- draw.ioとMermaidを自動同期しない。検討用入力は`Confirmed`、`Proposed`、`Open Question`へ分け、Ownerが採用を承認した後だけMermaid正本へ反映する。

## Git・プルリクエスト

- Epic、Task、ADRの起票・状態管理はGitHubだけで行う。
- `develop`を統合Branchとし、`develop`への直接Pushと`main` Branchの作成・Pushを禁止する。
- 1 Task／1 Branch／1 PRを基本とする。
- `develop`向けPRはSquash mergeで統合する。1 PRを1 Commitとし、最終CommitメッセージはConventional Commitsに従う。
- Conventional Commitsを使用し、Commitをレビュー可能な論理単位にする。
- PR本文へGitHub Task URLを記載する。
- PR作成前に[delivery-workflow.md](docs/engineering/delivery-workflow.md)の文書影響確認を完了する。

## 完了条件

- 使用したSkillと省略したSkill、その理由が説明できる。
- 変更に関係する正常、境界、権限、失敗、競合、再試行を必要範囲で検証する。
- 新しいDomain RuleにはDomain Unit Testがある。
- テスト失敗や未確認事項を無視して完了扱いにしない。
- `code-review`でBlocker／Majorが残っていない。
- 関連するIssue、Repository文書、Schema、ADR、Runbookの更新要否が説明できる。
- 実行しなかった検証がある場合は、理由と残リスクを明示する。

## 詳細ルール

- Backend責務・Layer・Directory配置: [backend.md](docs/engineering/backend.md)
- DDD・値オブジェクト・Entity・Event Sourcing: [domain-design.md](docs/engineering/domain-design.md)
- Coding・単一責任: [coding-standards.md](docs/engineering/coding-standards.md)
- Frontend責務: [frontend.md](docs/engineering/frontend.md)
- TDD・品質保証: [testing.md](docs/engineering/testing.md)
- Epic／Task／Git／PR前文書更新: [delivery-workflow.md](docs/engineering/delivery-workflow.md)
- 図の正本・draw.io検討用入力: [diagram-governance.md](docs/engineering/diagram-governance.md)
- ADR・未確定事項: [08. 設計変更・意思決定](docs/governance/README.md)
