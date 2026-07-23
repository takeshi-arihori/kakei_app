---
name: prepare-notion-work
description: 家計アプリのNotion Epic・Taskを作成、分割、レビュー、改善し、必須項目、1〜2日の粒度、依存関係、受入条件、状態遷移、Ready判定を整える。Epicの計画、チケット起票・改善、実装可能性のレビューを依頼されたときに使用する。Ready済みTaskの実装には使用せず、implement-notion-taskを使用する。
---

# Notion作業項目の準備

要求された成果を、別の開発者やAIが要件を推測せず実装できる、追跡可能なNotion作業項目へ変換する。

## プロジェクトルールを読む

`docs/engineering/delivery-workflow.md`と`docs/engineering/README.md`を読む。要求の変更種別に従って、DDD、Frontend、Data、Security、Test、運用の関連文書と`docs/adr`のAccepted ADRを読む。非公開のプロジェクト情報にはNotion接続を使い、Web検索で代用しない。

## 操作を選ぶ

- 成果が複数の独立して検証可能なTaskにまたがる場合は、Epicを作成または改善する。
- 1人が1〜2日で1つの検証可能な成果を届けられる場合は、Taskを作成または改善する。
- 分析、レビュー、計画だけを求められた場合は、書き込まずに準備状況を評価する。
- 作成または編集を依頼された場合だけNotionを変更する。書き込み直前に対象ページとデータベース構造を再取得する。

## 参照元を集める

1. 指定されたProject、Epic、Task、仕様ページを取得する。
2. URLがない場合は、1回につき1つの具体的な語句でNotionを検索する。
3. 複数の候補が残る場合は、対象を勝手に決めず利用者へ確認する。
4. 親Project、関連Epic、要件、`docs/adr`の承認済みADR、関連設計ページを辿る。
5. 曖昧な点ごとに次を記録する。
   - 現在の曖昧な記述
   - 確認したい質問
   - 実装への影響
   - 安全な暫定判断が可能な場合の作業上の仮定

製品、ドメイン、セキュリティ、データ、アーキテクチャの判断を暗黙に補完しない。

## 要求を現状へ対応付ける

EpicやTaskを設計する前に、ソフトウェア要求を利用者またはSystemの成果、制約、対象外へ分解する。Notionの要求・仕様とRepositoryの文書・既存コードを確認し、次を根拠付きで整理する。

- 現在成立している振る舞いと不足している振る舞い
- 対象Bounded Context、Data Owner、AggregateまたはUse Case、Layer
- 画面、GraphQL、Data、Security、運用、Test、文書への影響
- Accepted ADRとの整合性と、新しいDecisionまたはADR Proposalの要否

コードの見た目だけで要求や作業項目を考案しない。確認したNotion URL、Repository文書、コードPathを、後続の評価で再確認できる証拠として保持する。

## 既存EpicとTaskを検索する

要求の中心となる業務語彙、期待成果、関連するBounded Contextを、1回につき1つの具体的な語句でNotion検索する。候補EpicのRequirement、Done Criteria、構成Task、Statusを取得し、重複または包含関係を比較する。

- 既存Epicが要求を包含する場合は、そのEpicへTaskを追加または既存Taskを改善する。
- 要求が1つの1〜2日Taskで完了する場合は、新しいEpicを作らない。
- 複数の独立成果が必要で、既存Epicに属さない場合だけ新しいEpicを設計する。
- 複数候補から一意に選べない場合は、作成せずに候補、差異、影響を示して利用者へ確認する。

## Epicを設計する

次を必須とする。

- 成果が分かる動詞形のタイトル
- Project、Phase、Area、Priority、Status
- なぜ必要で、何が成立するかを説明するRequirement
- Epic全体を完了できる観測可能なDone Criteria
- 明示的な順序または依存関係を持つ構成Task

1つの小さなTaskにすぎないEpicは作らず、Taskへ変更する。既存Epicとの重複とMVP範囲内かを確認する。

## Taskを設計する

各Taskを、1〜2日で完了できる独立して検証可能な1つの成果にする。

- 3日を超える作業や複数の成果を含む作業は分割する。
- 2時間未満の密接した作業は隣接するTaskへまとめる。
- 利用者またはSystemの成果、制約、対象外、対象Bounded Contextを記載する。
- 正常、境界、認可、失敗、競合、再試行、Schema、文書、運用から必要な条件を、観測可能なDone Criteriaとして記載する。
- Type、Project、Epic、Priority、Area、Milestone、Estimate Days、Dependencies、Statusを設定する。
- PR URLは、実体が作成されるまで空欄にする。
- Notesは状態遷移の履歴、明示した仮定、ほかのPropertyで表せない情報だけに使う。

「実装する」「正しく動く」だけをRequirementやDone Criteriaにしない。

## Ready判定を行う

次をすべて満たす場合だけReadyへ移す、またはReadyを推奨する。

- RequirementとDone Criteriaが具体的で矛盾していない。
- Project、Epic、Type、Priority、Area、Milestone、1〜2日のEstimateが設定されている。
- Dependenciesが完了しているか、着手を妨げない状態である。
- 関連する要件、画面、DDD、データ設計、アーキテクチャ、セキュリティ設計、`docs/adr`の承認済みADRへ追跡できる。
- Bounded Context、Data Owner、AggregateまたはUse Case、認可、テスト方針を特定できる。
- 未決事項が解消済み、または確認・調査・ADRの作業として分離されている。

状態はInbox → 要件整理中 → Ready → Doing → Review → Doneを基本とする。状態を飛ばす場合はNotesへ理由を記録する。

## 独立Planning Evaluator Loopを実行する

親AgentだけがNotionを作成・更新する。各評価Cycleで新しい`work_planning_evaluator` Subagentを1つ起動し、同じEvaluator Threadを再利用しない。

書き込み前に、次のReviewInputを渡して提案を評価する。

- `phase: proposal`
- 元のソフトウェア要求、期待成果、制約、対象外
- 確認したNotion URL、Repository文書、コードPath、Accepted ADR
- 現状とGap、対象Bounded Context、Data Owner、AggregateまたはUse Case、影響範囲
- 既存Project／Epic／Taskの検索語、候補、重複比較、選択理由
- 作成または更新するEpicとTaskの全Property、Requirement、Done Criteria、依存関係、順序、Ready判定
- 未決事項、Working Assumption、Clarification／調査Task／ADR Proposalへの分離結果

EvaluatorのJSON応答を次のように扱う。

- `fail`: 親Agentが提案を修正し、必要な参照元と検索結果を再取得して、新しいEvaluatorで再評価する。
- `blocked`: 仕様矛盾、候補を一意に選べない状態、権限不足、利用者判断が必要なDecisionなどを、証拠、影響、選択肢とともに報告してLoopを停止する。
- `pass`: `findings`と`missingEvidence`が空の場合だけ、依頼されたNotion書き込みへ進む。分析またはレビューだけの依頼では書き込まず、評価済み提案を報告する。

Notionへ書き込む直前にDatabase構造と対象Pageを再取得する。書き込み後は作成・更新したPageをURLから再取得し、`phase: persisted`、実際のProperty、Relation、Status、本文、URLを含むReviewInputを新しいEvaluatorへ渡す。`fail`なら親AgentがNotionを修正して再取得・再評価し、`pass`になるまで反復する。

進捗や仕様を複製するJSON Fileは作らず、Notionを正本とする。無限に反復せず、利用者判断または外部状態の変更が必要な`blocked`では停止する。

## 結果を報告する

次を報告する。

- 選択したProjectとEpic
- 提案または更新した作業項目
- 根拠付きのReadyまたは未Ready判定
- 未解決の質問と実装への影響
- 作成または更新したNotion URL
