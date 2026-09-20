# 未確定・未移行Gate

GitHubへの管理先変更は、業務設計の承認や旧情報の全件移行を意味しない。根拠が不足する機能TaskはProjectのBlocked=Yesとし、Issueに不足、影響、解消条件を記録する。Notionへアクセスして補わない。

## 採用済み方針と残る設計Gate

[ADR #24](../adr/shared-expense-domain-boundaries.md)は2026-09-06に案Aを条件付きAcceptedとした。3 Context（Group Management、Expense Recording、Settlement）、MVP Modular Monolith、State model＋必要な不変業務履歴、Command／Query責務分離を採用する。全面Event Sourcingと別Store／非同期Projectionは初期採用しない。

- Group Managementの最初のData Owner、Aggregate、Repository Port、内部Command認可は後続ADR #35／#36で条件付きAcceptedとなった。Category所属、他ContextのAggregate、Expense予約・競合のTransaction方式、Context間Portは未決。
- Invitation lifecycleと再参加Participant寿命はADR #52でAcceptedとなった。Invitation／冪等記録の保存保護、Retention、BackupのDecisionはADR #55でAccepted済みであり、S1〜S3と#42で実装・検証する。Persistence、本番本人性・認証・配送、Context間認可、Projectionの未決部分は必要な後続Decisionを経て確定する。
- 条件C1は2026-09-20に充足した。[保護・保持Decision](../adr/snapshot-revision-security-and-retention.md)のOwner Accepted、[正式Security Review pass](https://github.com/takeshi-arihori/kakei_app/issues/55#issuecomment-5748185586)、[PR #70](https://github.com/takeshi-arihori/kakei_app/pull/70)のdevelop統合（merge commit `d0546e46c614d4c081bb2adfd59da27cce9f70af`）を証拠とする。
- C1充足だけではPersistence TaskをReadyにしない。S0〜S3でArchive invariant、Schema／Migration、protected record codec、access policy／blind index契約を実装・検証し、その後に#42を個別Ready評価する。Key Provider、Audit Store、Retention／Backup Gateが揃うまで本番へwireしない。

[設計比較](../domain/shared-expense-design-boundaries.md)に残る候補を一括採用しない。条件に依存しない3 Contextの可視化や設計調査は、別TaskのReady評価を経て進められる。既存のHono／Next.js責務分離、JPY整数、機密平文禁止は維持する。

## 今回の移行範囲

現在の[業務モデル](current-model.md)は公開済みRepositoryの引き継ぎ記録を、取得済みの現行Scope/業務Ruleと照合して整理した。架空のActor・金額例を維持し、古い個人識別用の呼称、旧参照先、解消済み事項を未確定とする記述を除いた。業務判断の追加はしていない。

旧情報の分類は129対象中、公開可28・要編集77・非公開0・除外24・未分類0。取得不能だった非現行Source4件を別途除外すると133対象、除外28。必要な現行非公開情報は検出していない。この分類は全件移行や今後の公開を自動承認するものではない。

| 未移行範囲 | 現在の扱い・再開条件 |
| --- | --- |
| 旧Project/Epic/Taskの全履歴・Relations | 全件移行はしない。次に選択する成果をGitHub Issueへ明示し、依存とOwner承認を確認する |
| 旧ADR本文（14/20の関係要約以外） | 現行不変条件を維持。詳細に依存する変更はGitHub上でADRを整えてOwner承認を得る |
| 旧UX、画面、API、Security、運用仕様の詳細 | current-modelと既存公開Repoだけで確定しない。対象Taskに必要な仕様をGitHubへ整理し、未決Decisionを分離する |
| 要編集77件の旧本文・メタデータ | 公開へ生コピーしない。今回の一般運用文書とは区別する |
| 既存draw.ioのメタデータ・一部割合例の不整合 | Ownerの検討用入力として保持し、正本や新仕様の根拠にしない。AIは変更または自動変換せず、採用が明示された内容だけを関連IssueまたはADRと`docs/diagrams/*.mermaid.md`へ反映する |
| 旧Source404の4件 | 非現行の監査上の欠損。復元済みと主張しない。新しいDecisionの根拠にしない |

旧管理先の再構築待ちというDC-003/005は、今回のGitHub入口・Field検証で管理先の部分を置き換える。旧Taskの依存や業務上の未決をまとめて解消したことにはしない。

## 公開前Gate

公開対象ごとに機械検査と手動Reviewを行う。Secret、PII、実在金融情報、内部Security情報、未分類・要編集の内容を公開しない。必要な現行非公開情報が新たに見つかった場合はOwnerへPrivate保管先を確認する。新規仕様を一般論から捏造しない。

## Group Management初回境界

[設計分析](../domain/group-management-first-boundary.md)、[整合性境界Decision](../adr/group-management-consistency-boundary.md)、[認可Decision](../adr/group-management-command-authorization.md)、[招待・再参加Decision](../adr/group-invitation-and-rejoin.md)へ具体化した。2026-09-08にProject OwnerがADR #35／#36の案Aを条件付きAcceptedし、2026-09-13にADR #52の案AをAcceptedした。C1は2026-09-20に充足した。Archived後の不変条件はS0、保存SchemaはS1、protected record codecはS2、Context間Access PolicyはS3、Repository Integrationは#42で順に検証する。本番本人性・配送は未決であり、Production Key Provider／Audit Store／Retention Checkpoint／Backup／Deployment Gateは未実装である。
