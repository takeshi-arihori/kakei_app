# 未確定・未移行Gate

GitHubへの管理先変更は、業務設計の承認や旧情報の全件移行を意味しない。根拠が不足する機能TaskはProjectのBlocked=Yesとし、Issueに不足、影響、解消条件を記録する。Notionへアクセスして補わない。

## 採用済み方針と残る設計Gate

[ADR #24](../adr/shared-expense-domain-boundaries.md)は2026-09-06に案Aを条件付きAcceptedとした。3 Context（Group Management、Expense Recording、Settlement）、MVP Modular Monolith、State model＋必要な不変業務履歴、Command／Query責務分離を採用する。全面Event Sourcingと別Store／非同期Projectionは初期採用しない。

- 個別Data Owner、Category所属、Aggregate境界、Expense予約・競合のTransaction方式、Port契約は未決。
- Persistence、認可、Retention、Backup、Projectionの詳細は必要な後続Decisionを経て確定する。
- 条件C1は未充足。Snapshot Revisionの最小保存項目、暗号化、Group内認可、保持・削除を文書化し、機密平文禁止とのConflictを解消、Security ADRのOwner承認と独立Security Reviewを得るまで依存Persistence実装はBacklog／Blocked YesでReady不可。
- 条件追跡の責任者はProject Owner、期限はPersistence TaskのReady前。証拠欄は[ADRの条件C1](../adr/shared-expense-domain-boundaries.md)に保持する。

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

[設計分析](../domain/group-management-first-boundary.md)、[整合性境界Proposal](../adr/group-management-consistency-boundary.md)、[認可Proposal](../adr/group-management-command-authorization.md)へ具体化した。すべての個別設計はProposedで、Owner Acceptedまでは依存Domain／Application実装をBacklog / Blocked Yesとする。招待、再参加、Archivedでの役割変更、Context間の認可競合、本番認証と保存方式は未決。C1は未充足、Persistence実装はBlockedを維持する。
