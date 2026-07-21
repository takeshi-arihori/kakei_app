---
name: prepare-notion-work
description: 家計アプリのNotion Epic・Taskを作成、分割、レビュー、改善し、必須項目、1〜2日の粒度、依存関係、受入条件、状態遷移、Ready判定を整える。Epicの計画、チケット起票・改善、実装可能性のレビューを依頼されたときに使用する。Ready済みTaskの実装には使用せず、implement-notion-taskを使用する。
---

# Notion作業項目の準備

要求された成果を、別の開発者やAIが要件を推測せず実装できる、追跡可能なNotion作業項目へ変換する。

## プロジェクトルールを読む

`docs/engineering/delivery-workflow.md`を読む。依頼が実装範囲へ影響する場合は`docs/engineering/README.md`も読む。非公開のプロジェクト情報にはNotion接続を使い、Web検索で代用しない。

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

## 結果を報告する

次を報告する。

- 選択したProjectとEpic
- 提案または更新した作業項目
- 根拠付きのReadyまたは未Ready判定
- 未解決の質問と実装への影響
- 作成または更新したNotion URL
