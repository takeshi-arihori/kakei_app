# 検証・独立評価・Draft PR

## 検証と独立Evaluator

[testing.md](../../../../docs/engineering/testing.md)の検証Commandに従い、実行Code等に影響する場合はpackage.jsonに存在するlint、typecheck、test、buildを実行する。文書・Skillだけなら同書の代替検証を使う。変更に必要なSchema・Migration・生成コード検査を追加する。失敗を無視せず、変更起因、既存、環境を区別する。

今回のTask所有FileだけをStageし、Base SHAを固定する。`git diff --cached --binary --full-index <base-sha>`のSHA-256とFile一覧を記録する。新しい`task_evaluator` SubagentへTask URL、Requirement、Done Criteria、Project Field、設計範囲、Decision、Base SHA、Stage済み差分、checksum、File一覧、検証結果、文書、Security、Rollback、既知Riskを渡す。

同じEvaluatorを再利用しない。`findings`と`missingEvidence`が空のpassだけを合格とする。failは親Agentが修正・再検証し、新しいEvaluatorへ再依頼する。blockedは証拠と影響を利用者へ報告する。

## Commit、Draft PR、追跡更新

Evaluator pass後に限り、次を行う。[保存と公開Gate](../../../../docs/engineering/delivery-workflow.md#githubでの保存と公開gate)に従い、公開する本文・添付ごとに機械検査と手動Reviewを完了する。必要な現行非公開情報はOwnerのPrivate保管先決定まで公開しない。

1. Stage済み差分へ無関係な変更や機密情報がないことを再確認する。
2. Conventional CommitsでCommitする。
3. BaseからCommitまでのpatch checksumとFile一覧がEvaluator承認時と一致することを確認する。
4. Task BranchをoriginへPushする。
5. 同TaskのOpen PRがなければ`develop`向けDraft PRを作る。既存PRがあれば更新する。
6. PRにTask URL、Requirement、Done Criteria、変更、検証、文書・Schema・Migration・Security・運用・Rollback、未実施事項、残Riskを記録する。
7. PRのURL、Head SHA、Base、Draft、Files、本文を再取得する。
8. IssueへPR URLと検証結果を記録し、Project StatusをReviewへ移して再取得する。

この実装依頼の完了点はDraft PRとReview状態である。PR Ready化・Mergeは別途明示依頼がある場合だけ行う。旧Notion URLやSource Notion IDは既存データの識別子としてのみ保持し、アクセス、更新、同期に使わない。

## 完了報告

Task・Epic・仕様・ADR、満たしたDone Criteria、主要File、TDDまたは代替検証、全検証結果、Security、残Risk、Branch、Commit、Draft PR、IssueとProject Statusを報告する。
