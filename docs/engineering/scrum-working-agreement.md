# Scrum Working Agreement

[Private Project #9](https://github.com/users/takeshi-arihori/projects/9) / [Board構築Task #18](https://github.com/takeshi-arihori/kakei_app/issues/18) / [Owner承認ADR #17](https://github.com/takeshi-arihori/kakei_app/issues/17)

## 正本と公開範囲

ProjectはPrivate、RepositoryはPublicを維持する。現在はScrum pilotであり、正本切替の実施記録と固定Commitへの入口はADR #17に置く。Notionは読み書きしない。Issueは要件と完了条件、Projectは進捗とSprint、Repositoryは仕様・設計・運用文書を担当する。

Public Issue/PRへ入力する前に、本文・画像・添付・リンク先の公開可否を機械検査と手動Reviewで確認する。Secret、個人情報、実在金融情報、内部Security情報、要編集・未分類の情報を公開しない。Private Project内のIssueも、所属RepositoryがPublicなら公開される。必要な現行非公開情報はOwnerがPrivate保管先を決めるまで扱わない。旧Source Notion ID/URLは出典識別のみで、アクセスや同期には使わない。

## Sprintと見積もり

- Sprintは2週間。Sprint 1開始候補は2026-09-07、Sprint 2は09-21、Sprint 3は10-05（Asia/Tokyo）。正式開始とSprint GoalはPlanningでOwnerが確定する。
- Sprint GoalはProjectのStatus updateへ1文で記録し、対象Issueを関連付ける。初期候補は「安全なScrum運用とGitHubからの作業再開を確認できるようにする」。
- Story Pointsは相対的な規模・複雑さ・不確実性で、1、2、3、5、8だけを使う。8は分割を検討する。Number Fieldに入力制約はないためPlanningで値を確認する。
- Estimateは人日、原則1〜2日。Story Pointsへ自動換算しない。親Epicと子Taskを二重集計せず、SprintのSPはTaskだけを集計する。
- In ProgressのWIP上限は1。Blockedも1件に数える。中断理由と解消条件をIssueに書き、新規着手前に既存作業を完了するか、OwnerがBacklogへ戻す判断を記録する。

## Definition of Ready

Requirement、観測可能なDone Criteria、Owner、親Epic、Project、Area、Phase、Priority、Milestone、Estimate、Dependencies、Decision Check、Related ADRを揃える。該当しない項目は理由を書く。1〜2日で単一成果を検証でき、依存作業は完了または非阻害の根拠があること。

方針変更あり・不明ならOwnerがAcceptedにしたADRへ追跡できること。未確定のBounded Context、Data Owner、Aggregate、認可などを推測しない。公開Gateと独立Planning Evaluatorのproposal/persisted評価を通す。

## Definition of Done

Done Criteria、関連lint/typecheck/test/build、必要な権限・失敗・競合・再試行検証、Security Review、文書更新、独立Evaluatorを満たす。未実行検証には理由と残リスクを記録する。必要なPRは受入完了を要し、Draft PRの準備だけならReviewに留める。PR URL、検証証拠、DecisionへのリンクをIssueに保存する。

## 状態とView

Backlog → Ready → In Progress → Review → Done。状態を飛ばす場合はIssueへ理由を記録する。
旧Inbox・要件整理中はBacklog、旧DoingはIn Progress、旧Ready/Review/Doneは同名へ対応する。

| View | Layout | Filter / Group |
| --- | --- | --- |
| Product Backlog | Table | `status:Backlog,Ready` |
| Current Sprint | Table | `sprint:@current` |
| Next Sprint | Table | `sprint:@next` |
| Sprint Board | Board | `sprint:@current`、Column by Status |
| Epic Roadmap | Roadmap | `work-type:Epic` |
| ADR Review | Table | `work-type:ADR` |

Sprint開始前はCurrent SprintとSprint Boardが空でも正常。Sprintの範囲は日付ベースなので、Planning時にAsia/Tokyoの業務日と表示日付を確認する。MilestoneはGitHub Repositoryのnative Milestoneを使い、IssueのMilestoneを設定する。Phaseは現行のDesign/Validation、Work TypeはEpic/Task/ADR、BlockedはNo/Yes。

## イベントと繰越

Planningは30分を目安にGoal、優先度、Ready、容量、SPを確認する。日次5分でGoalへの進捗、Blocked、WIPを確認する。Reviewは20分で成果と検証証拠を確認し、Retrospectiveは15分で改善を1件選び次Sprintへ反映する。

未完了Itemは自動繰越しない。残作業、依存、優先度、次Sprint Goalを再評価し、再選択した場合だけSprintを変更する。元Sprintと繰越理由はIssueへ残す。未完了に部分SPを計上しない。

## Automationと試験範囲

Issue/PR追加→Backlog、Issue Close→Done、PR Merge→Doneを設定する。Draft Itemは標準Workflowの対象選択肢にないため、作成時にBacklogを明示設定し再取得する。

完了Issue/PRは`is:closed updated:<@today-14d`で14日以上の確認期間を残してArchiveする。更新があれば保持期間は延びる。Draftや未完了Itemは手動Review後にArchiveする。

GitHub初期設定のAuto-add sub-issues、Auto-close issue、Pull request linked to issueはOwner承認により無効にする。意図しない取り込み・Issue Close・Status変更を防ぐため、再開時も設定を確認する。

Close/Mergeと14日経過の発火試験はこのpilotでは未実施とし、設定の再取得と区別して記録する。試験のためにPRをMergeしない。

## 再開・重複防止・Rollback

1. 作成前に同名Project、Field、View、Issue URL、旧Source IDを既存Itemと照合する。新規Issueの識別子はGitHub URLで、Source Notion IDを捏造しない。
2. API応答不明時は、再取得して外部の成功状態を確認するまで同じMutationを再送しない。同じSource IDが複数なら作業を止め、1件へ解決する。
3. 429/secondary rate limitはRetry-Afterを優先し、なければ1秒・2秒・4秒の指数backoffで最大3回。上限後は停止し再開条件をIssueへ残す。権限エラーを再試行で回避しない。
4. Privateなsynthetic draftでField編集とArchive/restoreを検証する。復元後にSource IDと値が保存され、重複がないことを確認する。最後はArchiveして試験Itemを通常Viewから外す。
5. 匿名のHTTPアクセスでProjectが404または認証要求、公開Issue/PRが200で公開確認済み内容だけを含むことを確認する。ログイン中の画面だけで匿名可否を判断しない。

pilot中止時はItemをArchiveし、ProjectをClose、Draft PRをCloseする。正本切替後は原則forward-fix、重大な欠損・Security事故のみOwner判断でGitHubの既知の正常版へ戻す。Notionへの復帰は行わない。
