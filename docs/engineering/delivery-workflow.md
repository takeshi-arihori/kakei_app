# 開発・リリース運用

## 正本と階層

```text
Notion Project → Notion Epic → Notion Task → Branch → プルリクエスト
```

- NotionをProject、Epic、Task、仕様、設計、進捗の正本とする。
- Accepted／Superseded ADRは`docs/adr`を正本とし、NotionはProposalと関連Taskの管理に限定する。
- EpicとTaskの起票・状態管理はNotionだけで行う。
- Pull Requestは1つのTaskを検証可能な差分として届ける。

## Epic起票ルール

Epicは1つの成果または能力を表し、複数の独立Taskを束ねる。単一の1〜2日作業はEpicにしない。

必須:

- Title: 利用者・業務・技術の成果が分かる動詞形
- Project
- Phase、Area、Priority
- Requirement: なぜ必要で、何が成立するか
- Done Criteria: Epic全体を閉じられる観測可能な条件
- Status

Epicを作る前に、既存Epicとの重複、MVP内外、依存するDecision、対象Bounded Contextを確認する。3日を超える成果や複数の独立成果をTaskへ分解する。

## Task起票ルール

Taskは1人が原則1〜2日で完了できる、独立して検証可能な1 Deliverableとする。2時間未満の密接した作業は関連Taskへまとめ、3日以上または複数Deliverableは分割する。

必須Property:

- Task、Status、Type、Project、Epic
- Priority、Area、Milestone
- Requirement、Done Criteria
- Estimate Days、Dependencies
- PR URL、Notes

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
- 関連する要求、要件、画面、DDD、ER、Architecture、Security、`docs/adr`へTraceできる。
- Bounded Context、Aggregate、Data Owner、権限、Test方針が判断できる。
- 未決事項はClarificationまたはADRとして分離されている。
- 1〜2日、1 Deliverableの粒度である。

StatusはInbox → 要件整理中 → Ready → Doing → Review → Doneを基本とする。飛ばす場合はNotesへ理由を記録する。Doingは原則1件に限定する。

## Branch・Commit

- 機能追加: `feature/notion-task-id-short-description`
- 不具合修正: `fix/notion-task-id-short-description`
- 保守作業: `chore/notion-task-id-short-description`
- `develop`を統合Branchとし、Pull Requestを経由する。
- `develop`への直接Pushと`main` Branchの作成・Pushを禁止する。
- Conventional Commitsを使う。例: `feat(transaction): add split allocation command`
- Commitはレビュー可能な論理単位にし、Refactorと無関係な整形を混ぜない。
- Secret、個人情報、生成された大容量成果物をCommitしない。

## PR前の文書更新

文書はPR後の後片付けではなく実装の一部である。実装完了後、PR作成前に次の順で整合させる。

1. 変更された業務理解・要求・DecisionをNotionへ反映する。
2. 採用済みDecisionを変える場合は`docs/adr`へ新しいADRを追加し、置き換えるADRをSupersededへ更新する。
3. NotionのMermaid図、ER、画面遷移、Runbookを必要範囲で更新する。
4. Repo内の実装契約、Schema、Migration Note、Operation手順を更新する。
5. TaskのDone Criteriaと文書差分を再確認する。
6. PR TemplateのDocument Impactを記入する。

Notion変更が権限・承認待ちの場合は、古い仕様のままPRを作らず、Blockerと必要な更新を明示する。

### 変更影響対応表

| 変更 | PR前に確認・更新する文書 |
| --- | --- |
| Requirement／MVP範囲 | 要求整理、要件定義、Epic／Task |
| Domain Rule／Aggregate | DDD、UML、State／Sequence、Unit Test |
| Domain／Integration Event | UML、Event Schema、Upcaster、Projection／Rebuild |
| GraphQL | 要件、生成Schema、Operation、Error、移行方針 |
| Prisma／Migration／Index | ER図、Migration、Expand／Contract、Rollback／Forward-fix |
| 画面／Navigation／Form | 画面一覧・遷移、UX/UI、Accessibility、Story／E2E |
| 認証／認可／機密／削除 | Security、ADR、Threat、Audit、Runbook |
| Outbox／Worker／運用 | Architecture、Metric／Alert、Retry、Runbook |
| Cloud／依存Service | ADR、Architecture／配置図、IAM、Cost、Runbook |

文書更新不要と判断した場合も、PRへ対象文書と理由を記載する。

## プルリクエスト

- Draftで開始してよいが、Notion Taskを必ずLinkする。
- 変更内容より先に、何のRequirement／Done Criteriaを満たすかを示す。
- Test結果は実行Commandと結果を記載する。
- Migration、GraphQL、Event、Security、Privacy、Operations、Rollbackへの影響を明示する。
- 差分が1 Taskの境界を越えたら、TaskとPRを分割する。
- DoneはDone Criteria、CI、文書、Notion／PR Linkの反映完了後とする。

## ADR

- Notionで判断候補と関連Taskを整理し、採用時に`docs/adr`へMarkdownを追加する。
- ADRにはContext、Decision、Alternatives、Consequences、Implementation、Review Triggerを記載する。
- Accepted ADRを直接書き換えて履歴を消さない。変更時は新しいADRを追加し、旧ADRをSupersededへ変更する。
- ADRの追加・置換は、その判断を採用する実装と同じPull Requestでレビューする。
- 詳細は[`docs/adr/README.md`](../adr/README.md)に従う。

## AI運用

- Taskが未指定なら、Ready Taskを検索し、候補が複数なら勝手に選ばない。
- TaskがReadyでなければ、実装せず不足項目とReady化手順を返す。
- NotionのStatus変更やPR作成など外部状態の変更は依頼範囲を確認して行う。
- 採用済み方針を暗黙に変更せず、Proposalと現行仕様を分ける。

## 参照元

- [10 開発ルール・Notion運用](https://app.notion.com/p/39a06467984f81ceadc7c3da95dfed68)
- [Projects](https://app.notion.com/p/c82d4f26f61740daa7aac6ea871851d7)
- [Epics](https://app.notion.com/p/455e474085f8467db95a42575f41073e)
- [Tasks／Kanban](https://app.notion.com/p/a0f48a55ef7b42e5a629a8e967a1739a)
