# 開発・リリース運用

この文書はGitHub Epic／Task、Ready、Branch、Commit、Pull Request、ADR追跡の静的Ruleを定める。要求検証からDeliveryまでの状態遷移は[Engineering Loop](engineering-loop.md)、Skillとの責務分離は[Skillガバナンス](skill-governance.md)を正本とする。

## 正本と階層

```text
Private GitHub Project
        │
        ▼
    Epic Issue
        │
        ▼
    Task Issue
        │
        ▼
      Branch
        │
        ▼
  Pull Request
```

- Notionは読み書きしない。
- IssueをRequirement／Done Criteria、Private Projectを進捗、Repositoryを仕様・設計・ADRの正本とする。
- GitHubの取得先と固定Commitは[正本入口](../governance/README.md)で確認する。
- Pull Requestは1つのTaskを検証可能な差分として届ける。
- 未承認Decisionに依存するTaskをReadyへ進めない。

## Epic

Epicは1つの成果または能力を表し、複数の独立Taskを束ねる。単一の小さなDeliverableのためだけにEpicを作らない。

最低限記録する。

- Goal／Requirement
- Done Criteria
- Scope／Out of scope
- Project／Phase／Area／Priority
- Decision Check／Related ADR
- Status
- 子TaskとDependency

新規Epicを作る前に既存Epicとの重複・包含関係を確認する。

## Task

Taskは原則として1人が短期間で完了できる、独立して検証可能な1 Deliverableとする。複数の独立成果や長期作業は分割する。

最低限記録する。

- Requirement
- Done Criteria
- Scope／Out of scope
- Epic／Project／Priority／Area／Milestone／Estimate
- Dependencies
- Decision Check／Related ADR
- Test／Verification方針
- PR URL

Requirementは実装手段ではなく、利用者またはSystemに必要な結果を示す。Done Criteriaは観測可能な条件とする。

## Ready判定

次が揃うまでReadyへ移さない。

- RequirementとDone Criteriaが具体的で矛盾しない。
- 必要なProject Field、Epic、Priority、Area、Milestone、Estimateがある。
- Dependenciesが着手を妨げない状態である。
- 関連するRequirement、Domain、Architecture、Security、Data、Operations、Accepted ADRへTraceできる。
- 対象Context、Use Case、Ownership、権限、Test方針等、実装開始に必要な境界が判断できる。
- 未決事項が解消済みか、Clarification／ADR等へ分離されている。
- Decision Checkが確定し、必要なRelated ADRがAcceptedである。
- 1 Deliverableとしてレビュー可能な粒度である。

Statusは`Backlog → Ready → In Progress → Review → Done`を基本とする。飛ばす場合はIssueへ理由を記録する。

## Task DependencyとPR順序

DependenciesをTask本文／Projectへ記録し、実装開始前にDelivery順序を決める。

- 独立Task: 並行実装可能
- 前提TaskがMerge済み: 最新`develop`から後続Taskを開始
- 前提PRが未Mergeで、そのCode差分が後続実装に必要: Stacked PR候補

Stacked PRのBranch Base、PR Base、`Depends-On`、Merge順序、前提Merge後の再base／再検証は[PR依存関係Gate](pr-dependency-gate.md)に従う。

## Branch・Commit

通常のTask Branchは最新`develop`を基点とする。Stacked PRだけ[PR依存関係Gate](pr-dependency-gate.md)に従って直接依存Branchを基点にできる。

Branch名:

- 機能追加: `codex/feat-issue-number-short-description`
- 不具合修正: `codex/fix-issue-number-short-description`
- 保守作業: `codex/chore-issue-number-short-description`

Rule:

- `develop`を統合Branchとし、直接Pushしない。
- `main` Branchを作成・Pushしない。
- 1 Task／1 Branch／1 PRを基本とする。
- Conventional Commitsを使用する。
- 作業BranchのCommitはレビュー可能な論理単位にする。
- Refactorと無関係な整形を混ぜない。
- Secret、個人情報、公開不可情報、大容量生成物をCommitしない。
- `develop`向けPRはSquash mergeを使用し、統合後は1 PRを1 Commitとして扱う。作業Branch内のCommitを事前に1つへ潰す必要はない。

追加Worktreeを使う場合の保存先、Ignore、Codexのmanaged worktree toolとの使い分けは[Worktree運用](worktree-management.md)に従う。

## PR前の文書同期

文書はPR後の後片付けではなく実装の一部とする。

1. 変更されたRequirement／DecisionをGitHubとRepository正本へ反映する。
2. Accepted Decision変更の有無を確認し、必要ならADR Gateを先に解消する。
3. 変更範囲に対応する仕様、設計、図、Schema、Migration Note、Runbook等を同期する。
4. TaskのDone Criteriaと文書差分を再確認する。
5. PR TemplateのDocument Impactへ更新／不要理由を記録する。
6. [Engineering Loop](engineering-loop.md)のSelf Reviewと独立Evaluatorを完了する。

更新不要と判断した文書も、PRで理由を説明する。

## Pull Request

- Draftで開始してよい。
- GitHub Taskを必ずLinkする。
- 変更内容より先にRequirement／Done Criteriaを示す。
- 実行した検証Commandと結果を記載する。
- 文書、公開契約、Persistence、Security、Privacy、Operations、Rollback等の影響を、変更範囲に応じて記載する。
- Dependenciesがある場合は[PR依存関係Gate](pr-dependency-gate.md)に従ってBaseと`Depends-On`を設定する。
- 差分が1 Taskの境界を越えた場合はTask／PRを分割する。
- PR Ready化・Mergeは利用者の明示依頼がある場合だけ行う。

DoneはDone Criteria、必要なCI／Verification、文書同期、Issue／PR追跡が完了した後とする。

## ADR

ADR本文とStatusの正本は`docs/adr`とGitHubの承認証跡とする。異なる内容の二重正本を作らない。

- Epic／Task起票・Requirement変更・設計変更時にDecision Checkを行う。
- Accepted Decisionを変更する場合、またはRepository GovernanceがADR必須とする場合はProposalを作る。
- Proposed ADRに依存するTaskをReadyへ進めない。
- Accepted／Rejectedの確定にはProject Ownerの明示Decisionを必要とする。
- AI／実装者が明示承認なしにStatusを確定しない。
- Rejectedなら変更案を取り下げ、Requirement／Done Criteria／Decision Checkを現行Decisionへ戻して再評価する。
- Accepted ADRを履歴を消す形で上書きせず、変更時は新しいADRで履歴を残す。
- Decision確定後、関連仕様、Epic／Task、Repository docsを同期する。

ADR必須条件の詳細は[正本入口](../governance/README.md)を参照する。

## GitHubでの保存と公開Gate

Public RepositoryへIssue、PR、Comment、添付等を書き込む前に、公開対象を確認する。

- Secret、Credential、Token、内部Security情報を公開しない。
- PII、実在金融情報等、公開不要な情報を公開しない。
- 未分類または公開可否が不明な情報を推測で公開しない。
- 公開する本文・添付は必要最小限にする。
- Private保管が必要な情報の保存先が未決なら、公開せずOwner判断を待つ。

Project FieldがないRequirement、Done Criteria、Dependencies、Related ADR、PR URL等はIssue本文へ保存する。GitHubへ保存した後は再取得し、期待した状態が永続化されたことを確認する。

## AI運用

- 次に実装するTaskが未指定ならReady Taskを確認し、候補が複数なら勝手に選ばない。
- TaskがReadyでなければ実装せず、不足条件とReady化手順を示す。
- 利用者が対象を指定した文書・Skill整理は、その範囲で進める。
- 採用済み方針を暗黙変更せず、Confirmed／Proposal／Open Questionを区別する。
- Planningは`work_planning_evaluator`、実装後は`task_evaluator`のread-only独立評価を[Engineering Loop](engineering-loop.md)に従って行う。

## 参照

- [Engineering Loop](engineering-loop.md)
- [Skillガバナンス](skill-governance.md)
- [PR依存関係Gate](pr-dependency-gate.md)
- [開発ガイド](README.md)
- [正本入口／ADR Governance](../governance/README.md)
- [設計Gate](../product/design-gates.md)
