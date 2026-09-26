---
name: prepare-github-work
description: 家計アプリのGitHub Epic・Taskを作成・分割・レビューし、要件、依存関係、ADR、Ready判定を整える。
---

# GitHub作業項目の準備

要求を、別の開発者やAIが推測せず実装できるGitHub作業項目へ変換する。Notionは読み書きしない。

レビューのみなら、以下の起票・Property設定・Status変更は提案として扱い、GitHubへ書き込まない。作成・更新を依頼された場合だけ保存手順へ進む。

## Issueの記述言語

Issueのタイトル、本文、見出し、チェックリスト、Notesなど、人が読む自然言語は原則として日本語で記述する。

- Conventional Commit風のprefix（`feat(group):`、`docs(api):`など）、コード識別子、型名、API名、Package名、Branch名、SHA、URL、GitHub Projectの定義済みField値やStatus値は、正本の表記を維持する。
- 英語のログ、Error message、外部仕様からの引用は原文を保持してよいが、必要に応じて日本語の説明を添える。
- Issueを保存する前に、タイトルと本文に不要な英文の説明文・見出しが残っていないか確認し、日本語へ直す。
- 既存Issueを更新する場合も、新たに追加・修正する自然言語は同じ方針に従う。

## 正本と参照元を確認する

1. [delivery-workflow](../../../docs/engineering/delivery-workflow.md)の起票・Ready・ADR条件を確認する。GitHub取得先と固定Commitは[正本入口](../../../docs/governance/README.md)で確認し、仕様・設計は今回の成果に関係する箇所だけ読む。
2. 対象のGitHub Project、Epic Issue、Task Issue、関連Issue、Repositoryの仕様・設計・Accepted ADRを取得する。
3. `develop`に未反映の正本は、ガバナンス文書が示す固定Commit URLから読む。
4. Project内とRepository Issuesを業務語彙、期待成果、Bounded Contextで検索し、重複と包含関係を比較する。
5. 製品、Security、Data、Architectureの判断を暗黙に補わない。不足はClarification、調査Task、ADR Proposalへ分離する。

旧Notion URLやSource Notion IDは出典識別子としてのみ保持し、アクセス、同期、更新には使わない。

## 公開前Security Gate

Public RepositoryのIssue、PR、添付へ書き込む前に、対象情報を`公開可／要編集／非公開／除外`へ分類し、未分類を残さない。Secret、PII、実在金融情報、内部Security情報を機械検査と手動Reviewの両方で確認する。要編集、非公開、未分類の本文を公開せず、公開可と確認できた情報だけを最小限に記載する。

非公開のまま必要な現行情報を発見した場合は作成・更新を停止し、OwnerがPrivate Repository等の保管先を決めるまで進めない。Private Projectへ追加してもPublic Issueは非公開にならないことを前提にする。

## EpicとTaskを設計する

複数の独立成果にまたがる場合だけEpicを作る。単一の1〜2日、1 DeliverableはTaskにする。3日以上または複数Deliverableは分割し、密接した2時間未満の作業は隣接Taskへまとめる。

Issue本文にProblem、成果、制約、対象外、Requirement、観測可能なDone Criteria、Bounded Context、Data Owner、AggregateまたはUse Case、Layer、影響範囲、Dependencies、Related ADR、Decision Checkの根拠、PR URL、Notesを記録する。

ProjectにはWork Type、Phase、Area、Priority、Estimate、Decision Check、Blocked、Status、Sprintを設定する。MilestoneはRepositoryのnative Milestoneを使う。Issue本文とProject Fieldを再取得し、一致を確認する。

## Decision CheckとADR

起票またはRequirement変更ごとに`方針変更なし`か`方針変更あり`を判断し、根拠をIssueへ記録する。判定不能は`方針変更あり`として扱う。

Accepted ADR、新しいBounded Context、DB、Cloud Service、Runtime、Event Sourcing、認証・認可、Security・Privacy、API Protocol、Schema正本、Context間連携、不可逆または高コストな運用判断の変更はADRを必須とする。未決ならADR IssueとRepository ADR Proposalを作り、OwnerがAcceptedを明示するまで依存TaskをReadyにしない。RejectedならRequirementとDone Criteriaを現行Decisionへ戻す。

## Ready判定

次が揃う場合だけStatusをReadyへ移す。

- RequirementとDone Criteriaが具体的で矛盾しない。
- Epic、Work Type、Priority、Area、Milestone、Estimateが揃う。
- Dependenciesが完了済みか、着手を妨げない。
- Bounded Context、Data Owner、AggregateまたはUse Case、認可、Test方針が分かる。
- 未決事項が解消済みか別作業に分離されている。
- Decision Checkが確定し、必要なRelated ADRがすべてAcceptedである。
- 1〜2日、1 Deliverableである。

状態はBacklog → Ready → In Progress → Review → Doneとする。飛ばす場合はIssueへ理由を記録する。個人開発のIn Progressは原則1件に制限する。

## 完了まで進める

レビューのみの依頼では提案とReady判定を報告する。GitHubの作成・更新を依頼された場合は、書き込み前に[独立Planning評価と保存確認](references/delivery.md)を読み、proposal評価、保存、persisted評価まで完了する。親Agentだけが書き込み、初稿の提示だけで作業を終えない。
