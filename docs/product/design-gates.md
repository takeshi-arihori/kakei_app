# 未確定・未移行Gate

GitHubへの管理先変更は、業務設計の承認や旧情報の全件移行を意味しない。根拠が不足する機能TaskはProjectのBlocked=Yesとし、Issueに不足、影響、解消条件を記録する。Notionへアクセスして補わない。

## 未確定の設計

- 共有割り勘ScopeでのBounded Context、Aggregate、Data Owner。
- Event Sourcing/CQRS、永続化、Projection、Context間連携。
- 現行Scopeに対応した上記DecisionのAccepted ADR。旧Transaction限定・日付境界ArchiveのProposalを採用済みとして扱わない。
- これらに依存するAPI/Schema/認可・運用詳細。既存のHono/Next.jsの責務分離、金額整数、秘密をEvent/Logへ保存しない等の不変条件は維持する。

[Issue #9](https://github.com/takeshi-arihori/kakei_app/issues/9)で[設計境界の比較](../domain/shared-expense-design-boundaries.md)と[Proposed ADR](../adr/shared-expense-domain-boundaries.md)を準備している。Project Ownerの明示DecisionでADRがAcceptedになるまで、候補を正式Mermaid図、Directory、Schema、Event、後続実装TaskのReady判定へ反映しない。

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
