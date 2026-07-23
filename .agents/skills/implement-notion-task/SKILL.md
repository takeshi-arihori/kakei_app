---
name: implement-notion-task
description: 家計アプリのReady済みNotion Taskを、仕様確認、TDD、検証、自己レビュー、PR前の文書更新まで一貫して実装する。利用者がReady Taskを指定または選択し、実装、修正、変更、構築を依頼したときに使用する。Bounded Contextの所有権、DDDとFrontendの境界、変更影響分析、Red・Green・Refactor、Notionへの追跡可能性を必須とする。新しい作業項目の考案や起票には使用せず、prepare-notion-workを使用する。
---

# Notion Taskの実装

Ready済みTaskを1件だけ実装し、コード、テスト、契約、図、運用文書の整合性を保つ。

## プロジェクトルールを読む

`docs/engineering/README.md`と`docs/engineering/delivery-workflow.md`を読む。READMEの変更対応表から、今回の変更に必要なガイドだけを追加で読む。編集する各Pathに最も近い`AGENTS.md`に従う。

非公開の仕様にはNotion接続を使い、Notionの取得をWeb検索やモデルの記憶で代用しない。

## Taskを特定する

1. 指定されたNotion Task URLを取得する。
2. URLがない場合は、一致するTaskを検索する。複数の候補が残る場合は利用者に選択を求める。
3. 親EpicとProject、関連仕様、`docs/adr`の承認済みADR、関連設計ページを取得する。
4. Status、Requirement、Done Criteria、Dependencies、Estimate、Area、Type、Milestone、PR URLを抽出する。

Inboxまたは要件整理中のTaskを実装しない。Readyでない場合は不足しているReady条件を報告し、利用者が改善を望む場合は`$prepare-notion-work`を使う。ほかのStatusから進める場合は、未解決の判断を迂回しないことを確認し、例外的な進め方について利用者の明示確認を得る。

## Task専用Branchを準備する

Ready Taskの実装依頼には、Task専用Branchの作成または再利用、Commit、Push、Draft PR作成または更新を標準工程として含める。利用者がLocalのみまたはPR不要を明示した場合だけ公開工程を省略する。既存Branchの使用指定はBranch作成だけを省略し、Commit以降の公開工程は省略しない。

コードを変更する前に、現在のBranch、作業Tree、Remote、`develop`との差分、同じTaskの既存BranchとPRを確認する。

- 同じTask専用Branchにいる場合は、新しいBranchを重複作成せず継続する。
- 別Branchにいるが、同じTask IDを持つLocal Branchがある場合は、Branchの所有者、Base、差分、作業Treeを確認する。今回の継続作業で、作業TreeがCleanまたは安全に切替可能だと確認できる場合は、そのLocal Branchへ切り替える。未Push、複数候補、所有者不明、競合する差分がある場合は、新しいBranchを作らず利用者へ確認する。
- 別Branchにいるが、同じTask IDまたはNotion Task URLを持つOpen PRがある場合は、PRのHead Branch、Base、Remote、作業Treeを確認する。作業TreeがCleanで、Headが同じRepositoryにあり、Baseが`develop`なら、そのRemote Branchを取得して追跡するLocal Branchへ切り替え、既存PRを継続する。
- 同じTaskのRemote BranchだけがありOpen PRがない場合は、Branchの所有者と差分を確認する。今回の継続作業だと確認できる場合だけ追跡Branchへ切り替える。ClosedまたはMerged PR、所有者不明のBranch、複数候補がある場合は勝手に再利用せず利用者へ確認する。
- `develop`、既定Branch、別TaskのBranchにいる場合は、最新の`origin/develop`を基点に1 Task／1 Branchを作成する。
- Branch名は`delivery-workflow.md`のType、Notion Task ID、短い説明と、実行環境が要求するPrefixに従う。
- 未Commitの変更がある場合は、今回のTaskに属するか確認する。無関係または所有者不明の変更を移動、破棄、Commitせず、分離方法を利用者へ確認する。
- 同じTaskのOpen PRを継続する場合は、そのPRを更新対象として記録し、新しいPRを作成しない。

`develop`へ直接CommitまたはPushしない。Branch作成、Remote同期、認証に失敗した場合は、証拠と必要な利用者操作を報告して停止する。

## 変更範囲を確定する

Taskを次へ対応付ける。

- Bounded ContextとData Owner
- Aggregate、Entity、Value Object、Domain Service、Application Use Case
- GraphQL QueryまたはMutationと生成するFrontend Operation
- 画面とFrontend Feature
- 永続化、Event、Projection、Outbox、Migration、Security、Audit、Runbookへの影響

事実、推論、提案を分ける。欠けている判断によって振る舞い、セキュリティ、データ互換性、Aggregate境界、公開契約が変わる場合は、実装を止めて確認する。

編集前に現在のコード、テスト、package.jsonのScript、依存Version、作業ツリーの変更を確認する。無関係な利用者の変更を保持する。本番依存関係の追加、破壊的Migration、破壊的Schema変更の前に確認を得る。

## 最小で一貫した変更を計画する

- 1つのTaskを1つの実装範囲に保つ。
- 変更予定のFileとLayerを明示する。
- 最初に失敗させるTestと、Done Criteriaに必要な正常、境界、認可、失敗、競合、再試行のCaseを定義する。
- PR前に更新すべきNotion文書とRepository文書を特定する。
- 採用済み判断を維持する。代替案は提案として分離し、プロジェクトルールが求める場合は`docs/adr`へのADR追加を必須とする。

## TDDを実行する

Red → Green → Refactorを繰り返す。

1. 1つの振る舞いを表すTestを追加する。
2. 意図した理由で失敗することを実行して確認する。
3. Testを通す最小の本番コードを実装する。
4. 対象Testを実行する。
5. Testを成功させたままRefactorする。
6. Done Criteriaを満たすまで次のCaseへ進む。

Bugでは、先に失敗する再現Testを追加する。機械的な変更で先行Testに価値がない場合は、理由を記載し、決定的な代替検証を選ぶ。

業務ルールはDomain Model、Use Caseの調整と認可はApplication、外部AdapterはInfrastructure、通信形式の変換はPresentationへ置く。Frontendの業務計算は入力支援に限定し、APIを正本とする。

## PR前に文書を更新する

Taskを完了扱いにする前に、次を行う。

1. 変更された要件や業務理解をNotionへ反映する。
2. 採用済みアーキテクチャ判断を変える前に`docs/adr`へ新しいADRを追加し、旧ADRをSupersededへ更新する。
3. 影響を受けるMermaid図、DDD・UML、ER、画面遷移、セキュリティ設計、RunbookをNotionで更新する。
4. GraphQL Schema、Operation型、Migration Note、開発ガイド、運用手順などRepository内の契約を更新する。
5. すべてのDone Criteriaをコード、テスト、文書へ再対応付けする。

正本の文書が古いと判明している状態でPR準備完了と報告しない。Notionへの書き込みが依頼範囲外または利用不能な場合は、必要な更新内容をPR準備の阻害事項として具体的に報告する。

## 検証する

開発中は対象を絞った検証を行い、最後にpackage.jsonに存在する関連Scriptを実行する。

- lint
- typecheck
- 単体テスト
- 影響がある場合の結合テストまたはE2Eテスト
- build
- 影響がある場合のGraphQL Schema、Event Schema、Migration、生成コードの検査

失敗した検証を無視しない。変更による失敗、既存の失敗、環境による失敗を証拠とともに切り分ける。最終差分を、範囲、Layer、Security、暗黙のデータ変更、Test不足、古い文書、無関係な変更の観点で自己レビューする。

## 独立Evaluator Loopを実行する

最終検証と自己レビュー後、各評価Cycleで新しい`task_evaluator` Subagentを1つ起動する。同じEvaluator Threadを再利用しない。親Agentだけがコードと文書を変更し、Evaluatorには実装させない。

評価前に今回のTaskに属するFileだけをStageし、Taskに必要な未Stage・未追跡Fileが残っていないことと、Indexに無関係な変更がないことを確認する。比較対象のBase SHAを固定し、`git diff --cached --binary --full-index <base-sha>`のChecksumと変更File一覧を、Evaluatorが承認する差分の識別子として記録する。

Evaluatorへ次のReviewInputを渡す。

- Task URL、Requirement、Done Criteria
- 対象Bounded Context、Layer、Data Owner
- 比較対象BranchとBase SHA、Stage済みの累積差分、Patch Checksum、変更File一覧、作業Treeの状態
- 実行したCommand、その結果、未実行の検証と理由
- Notion、ADR、Repository文書、Schema、図、Runbookの更新結果
- 既知のRisk、未確認事項、利用者が承認した例外

EvaluatorのJSON応答を次のように扱う。

- `fail`: 指摘の根拠を確認し、親Agentが必要な修正を行う。影響する検証と最終Checkを再実行し、新しいEvaluatorで再評価する。
- `blocked`: 仕様矛盾、権限不足、破壊的変更、新しい本番依存関係、外部Service障害、証拠不足などの阻害事項を、証拠、影響、選択肢とともに利用者へ報告してLoopを停止する。
- `pass`: すべてのDone Criteriaがコード、Test、文書へTraceでき、必要なCheckが成功し、`findings`と`missingEvidence`が空の場合だけ完了報告へ進む。

進捗や仕様を複製するJSON Fileは作らず、Notionを正本とする。同じTaskの途中でModel、Tool、Sandbox、Approval、作業Directoryを不用意に変更しない。変更が必要な場合は理由と検証への影響を記録する。

## Draft PRまで公開する

Evaluatorが`pass`を返した後だけ、次を行う。

1. Stage済み差分と作業Treeを再確認し、Secret、個人情報、生成物、無関係な変更が含まれないことを確認する。
2. Conventional Commitsでレビュー可能な論理単位をCommitする。
3. Task所有Fileの未Commit差分がないことを確認し、固定したBase SHAからLocal Commitまでの`git diff --binary --full-index`のChecksumと変更File一覧が、Evaluator承認時の値と一致することを確認する。Commit Hook、Stage漏れ、追加変更による不一致があればPushせず、最終検証と新しいEvaluator Cycleへ戻る。
4. Task専用Branchを`origin`へPushし、追跡Branchを設定する。
5. 同じTaskのOpen PRがない場合だけ、`develop`向けDraft PRを作成する。既存Open PRを継続する場合は、そのPRのTitleと本文を現在の実装へ更新する。PR本文へNotion Task URL、RequirementとDone Criteria、変更範囲、Test結果、文書・Schema・Migration・Security・Operations・Rollbackへの影響、未実行Checkと残Riskを記載する。
6. PRのURL、Head SHA、Base、Draft状態、変更File、Title、本文を再取得する。Local CommitとHead SHAが一致し、本文の必須項目と正しいNotion Task URLが永続化されていることを確認する。
7. Notion TaskのPR URLを更新し、PR準備が完了した場合だけStatusをReviewへ進める。Pageを再取得して永続化を確認する。

Commit、Push、PR作成、Notion更新のいずれかが失敗した場合は完了扱いにせず、成功済みの外部状態、失敗した操作、再開方法を報告する。PRをReady化、Merge、`develop`へ直接Pushしない。

## 完了報告を行う

次を報告する。

- Task、Epic、参照仕様のLink
- 実装したRequirementとDone Criteria
- 変更したLayerと主要File
- Red・Green・Refactorの実行結果
- 文書とSchemaの更新
- 実行したCommandと結果
- 残るRiskまたは阻害事項
- Branch、Commit、Draft PR、Notion PR URLとStatusの確認結果

利用者がReady Taskの実装を明示依頼した場合、このSkillのWorkflowにはTask専用BranchからDraft PRとNotion追跡情報の更新までを含む。それ以外の分析、レビュー、診断依頼では外部状態を変更しない。
