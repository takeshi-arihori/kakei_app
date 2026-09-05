# 開発・リリース運用

## 正本と階層

```text
Private GitHub Project → Epic Issue → Task Issue → Branch → プルリクエスト
```

- [正本入口](../governance/README.md)で指定された固定Commitを読む。Notionは読み書きしない。Issueを要件/DC、Private Projectを進捗/Sprint、Repositoryを仕様/設計/ADRの正本とする。
- Proposed／Accepted／Rejected／Superseded ADRは[docs/adr](../adr/README.md)で管理し、Owner承認と実施証拠をIssueへ記録する。
- Epic、Task、ADRの起票・状態管理はGitHubだけで行う。
- Pull Requestは1つのTaskを検証可能な差分として届ける。

未移行・未確定の判断に依存する作業は[設計Gate](../product/design-gates.md)を満たすまでReadyにしない。管理先の切替を業務Decisionの承認と取り違えない。

## Epic起票ルール

Epicは1つの成果または能力を表し、複数の独立Taskを束ねる。単一の1〜2日作業はEpicにしない。

必須:

- Title: 利用者・業務・技術の成果が分かる動詞形
- Project
- Phase、Area、Priority
- Requirement: なぜ必要で、何が成立するか
- Done Criteria: Epic全体を閉じられる観測可能な条件
- Decision Check、Related ADR
- Status

Epicを作る前に、既存Epicとの重複、MVP内外、依存するDecision、対象Bounded Contextを確認する。`Decision Check` Propertyを`未確認`／`方針変更なし`／`方針変更あり`から設定し、根拠を本文へ記録する。`方針変更あり`または不明なら`Related ADR`へ既存ADRを関連付けるかADR Proposalを起票する。3日を超える成果や複数の独立成果をTaskへ分解する。

## Task起票ルール

Taskは1人が原則1〜2日で完了できる、独立して検証可能な1 Deliverableとする。2時間未満の密接した作業は関連Taskへまとめ、3日以上または複数Deliverableは分割する。

必須Property:

- Task、Status、Type、Project、Epic
- Priority、Area、Milestone
- Requirement、Done Criteria
- Estimate Days、Dependencies
- Decision Check、Related ADR
- PR URL、Notes

Taskの起票・Requirement変更時は`Decision Check` Propertyを`未確認`／`方針変更なし`／`方針変更あり`から設定し、根拠を本文またはNotesへ記録する。`方針変更あり`または不明なら、`Related ADR`へ関連するADRを設定し、Proposedの場合は判断待ちであることを明示する。

良いRequirement:

- 現在のProblemと期待する振る舞いを業務語彙で示す。
- 実装手段だけでなく、利用者またはSystemに必要な結果を示す。
- 対象外と制約を必要に応じて明示する。

良いDone Criteria:

- 正常、境界、権限、失敗、競合、再試行の必要条件を観測可能にする。
- Test、Schema、文書、運用の完了条件を含める。
- 「実装する」「適切に動く」のような自己参照表現だけにしない。

## Ready判定

次が揃うまでReadyへ移さない。

- RequirementとDone Criteriaが具体的で矛盾しない。
- Project、Epic、Priority、Area、Type、Milestone、Estimateがある。
- Dependenciesが完了しているか、着手を妨げない状態である。
- 関連する要求、要件、画面、DDD、ER、Architecture、Security、GitHub ADRへTraceできる。
- Bounded Context、Aggregate、Data Owner、権限、Test方針が判断できる。
- 未決事項はClarificationまたはADRとして分離されている。
- `Decision Check`が空欄または`未確認`ではない。`方針変更あり`の場合は`Related ADR`が設定され、すべてProject OwnerによりAcceptedとなり、TaskがそのDecisionへ整合している。Proposed ADRに依存するTaskはReadyへ移さない。Rejectedの場合は現行DecisionへRequirementとDone Criteriaを戻し、Decision Checkをやり直す。
- 1〜2日、1 Deliverableの粒度である。

StatusはBacklog → Ready → In Progress → Review → Done。飛ばす場合はIssueへ理由を記録する。In ProgressはBlockedを含め原則1件に限定する。

## Branch・Commit

- 機能追加: `codex/feat-issue-number-short-description`
- 不具合修正: `codex/fix-issue-number-short-description`
- 保守作業: `codex/chore-issue-number-short-description`
- `develop`を統合Branchとし、Pull Requestを経由する。
- `develop`への直接Pushと`main` Branchの作成・Pushを禁止する。
- Conventional Commitsを使う。例: `feat(group-expense): add split allocation command`
- Commitはレビュー可能な論理単位にし、Refactorと無関係な整形を混ぜない。
- Secret、個人情報、生成された大容量成果物をCommitしない。

## PR前の文書更新

文書はPR後の後片付けではなく実装の一部である。実装完了後、PR作成前に次の順で整合させる。

1. 変更された業務理解・要求・DecisionをIssueとRepository文書へ反映する。
2. 仕様、設計、運用文書ごとに`方針変更: なし／あり`を確認する。`あり`または不明ならGitHubへADR Proposalを起票し、Project OwnerがAcceptedを明示するまで関連実装を進めない。Rejectedの場合は変更案を取り下げ、現行Decisionとの整合を再確認する。
3. RepositoryのMermaid図、ER、画面遷移、Runbookを必要範囲で更新する。
4. Repo内の実装契約、Schema、Migration Note、Operation手順を更新する。
5. TaskのDone Criteriaと文書差分を再確認する。
6. PR TemplateのDocument Impactを記入する。

GitHub変更が権限・承認待ちの場合は、古い仕様のままPRを作らず、Blockerと必要な更新を明示する。

### 変更影響対応表

| 変更 | PR前に確認・更新する文書 |
| --- | --- |
| Requirement／MVP範囲 | 要求整理、要件定義、Epic／Task |
| Domain Rule／Aggregate | DDD、UML、State／Sequence、Unit Test |
| Domain／Integration Event | UML、Event Schema、互換性、採用時のUpcaster／Projection／Rebuild |
| GraphQL | 要件、生成Schema、Operation、Error、移行方針 |
| Prisma／Migration／Index | ER図、Migration、Expand／Contract、Rollback／Forward-fix |
| 画面／Navigation／Form | 画面一覧・遷移、UX/UI、Accessibility、Story／E2E |
| 認証／認可／機密／削除 | Security、ADR、Threat、Audit、Runbook |
| Outbox／Worker／運用 | Architecture、Metric／Alert、Retry、Runbook |
| Cloud／依存Service | ADR、Architecture／配置図、IAM、Cost、Runbook |

文書更新不要と判断した場合も、PRへ対象文書と理由を記載する。

## プルリクエスト

- Draftで開始してよいが、GitHub Taskを必ずLinkする。
- 変更内容より先に、何のRequirement／Done Criteriaを満たすかを示す。
- Test結果は実行Commandと結果を記載する。
- Migration、GraphQL、Event、Security、Privacy、Operations、Rollbackへの影響を明示する。
- 差分が1 Taskの境界を越えたら、TaskとPRを分割する。
- DoneはDone Criteria、CI、文書、GitHub／PR Linkの反映完了後とする。

## ADR

- ADR本文とStatusの正本は[docs/adr](../adr/README.md)。Issueの承認証跡とリンクし、異なる内容の二重正本を作らない。
- Epic／Taskの起票・変更、仕様／設計／Runbookの変更、PR前の文書影響確認で、`方針変更: なし／あり`を必ず判定する。
- `あり`または不明の場合は、既存ADRで判断済みかを確認し、未決ならStatus `Proposed`のADRを起票してProjectと関連Taskを紐付ける。
- Accepted ADR、新しいBounded Context、DB、Cloud Service、Runtime／配置構成、Event Sourcing対象、認証・認可・Security／Privacy方式、API Protocol／Schema正本、Context間連携、不可逆または高コストな運用判断の変更はADRを必須とする。
- 現行Decision内の局所実装や、容易に戻せる低影響の変更にはADRを作成しない。
- ADRにはContext、Decision、Alternatives、Consequences、Implementation、Review Triggerを記載する。
- Epic／Taskでは`Decision Check`を判定の正本、`Related ADR`を採用DecisionへのRelationとし、根拠は本文またはNotesへ記録する。
- ADRのStatusをProposedからAccepted／Rejectedへ変更できるのは、Project Ownerが選択肢、Trade-off、影響を確認し、明示Decisionを記録した場合だけとする。AIや実装者は明示承認なしにStatusを確定しない。
- Proposed ADRは関連TaskのReady判定を阻害する。Acceptedの場合はTaskと文書を採用Decisionへ整合させる。Rejectedの場合は変更案を取り下げ、Requirement、Done Criteria、Decision Checkを現行Decisionへ戻して再評価する。
- Accepted ADRを直接書き換えて履歴を消さない。変更時は新しいADRを追加し、採用後に旧ADRをSupersededへ変更する。
- 完全に置換するADRだけ`Supersedes`／`Superseded By` Relationで接続する。一部修正は本文のAmends／Amended Byとして区別する。
- Review Trigger発生、`Next Review Date`到来、前提無効化を検知した場合は、根拠を関連Taskまたは運用文書へ記録して`Review Needed`を有効化する。レビュー結果を記録するまで解除しない。
- `Review Needed`は運用Signalであり、AIや実装者が根拠付きで設定できる。Decision変更は新しいADR、Status変更はProject Ownerの明示Decisionで行う。
- Decision確定後、関連する仕様、Epic／Task、Repository文書を同期し、参照元からGitHub ADR URLへTraceできるようにする。

## AI運用

- Taskが未指定なら、Ready Taskを検索し、候補が複数なら勝手に選ばない。
- TaskがReadyでなければ、実装せず不足項目とReady化手順を返す。
- GitHubのStatus変更やPR作成など外部状態の変更は、利用者が依頼した範囲で行う。
- 採用済み方針を暗黙に変更せず、Decision Check、Proposal、現行仕様を分ける。

## 参照元

- [開発ガバナンス](../governance/README.md)
- [07. 品質・デリバリー・運用](../governance/README.md)
- [08. 設計変更・意思決定](../governance/README.md)
- [ADR](../governance/README.md)
- [未確定事項・Documentation Conflict](../product/design-gates.md)

## GitHubでの保存と公開Gate

Project Fieldがない項目（Requirement/DC/Type/Dependencies/Related ADR/PR URL等）はIssue本文へ保存する。Work Type/Phase/Area/Priority/Estimate/Decision Check/Blocked/StatusはProjectにも設定し、再取得して要約との一致を確認する。MilestoneはRepositoryのnative Milestoneを使う。Source Notion ID/URLは旧出典がある場合だけ識別子として保持し、アクセスしない。

Issue・PR本文・添付は書き込み前に公開可否を機械/手動検査する。必要な現行非公開情報はOwnerのPrivate保管先決定まで停止する。Public IssueをPrivate Projectへ追加してもIssueは非公開にならない。

Task作成・更新はprepare-github-workで新しい独立Planning Evaluatorをproposalとpersistedに各1つ使用する。実装はimplement-github-taskで別の独立Evaluatorを使用する。fail修正後は新しいCycleで評価し、findings/missingEvidenceが空のpass後だけCommit/Push/Draft PRを行う。固定Base・Stage済みbinary full-index差分のSHA256と、Commit後の差分・ファイル一覧が一致しなければ再評価する。

Issueの状態はPR作成後Reviewとし、PR Ready化・Mergeは明示依頼がある場合だけ行う。独立レビューや公開Gateを単に管理先変更のために省略しない。
