---
name: prepare-github-work
description: 家計アプリのGitHub Epic・Taskを作成、分割、レビュー、改善し、Decision Check、ADR、1〜2日の粒度、依存関係、Done Criteria、Ready判定を整える。Ready済みTaskの実装にはimplement-github-taskを使用する。
---

# GitHub作業項目の準備

要求を、別の開発者やAIが推測せず実装できるGitHub作業項目へ変換する。Notionは読み書きしない。

## 正本と参照元を確認する

1. `docs/governance/README.md`、`docs/engineering/README.md`、`docs/engineering/delivery-workflow.md`を読む。
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

## 独立Planning Evaluator Loop

親AgentだけがGitHubを更新する。書き込み前に新しい`work_planning_evaluator` Subagentへproposalを渡し、pass後に書き込む。書き込み後はIssue、Project Field、Status、URLを再取得し、別の新しいEvaluatorへpersisted評価を依頼する。同じEvaluatorを再利用しない。

ReviewInputには元要求、対象外、参照URLと固定Commit、現状とGap、検索結果、重複比較、全Property、Requirement、Done Criteria、依存関係、Ready判定、Decision Check、ADR、未決事項を含める。さらに、公開可否の分類結果、未分類0件、機械検査と手動Review、公開しなかった情報、Private保管先待ちの有無を証拠として必須にする。`findings`と`missingEvidence`が空のpassだけを合格とする。failは修正して新しいEvaluatorで再評価し、blockedは証拠と影響を利用者へ報告する。

## 結果を報告する

ProjectとEpic、作成・更新したIssue、Ready判定、未解決事項、GitHub URL、Project Fieldの永続化結果、Evaluator結果を報告する。
