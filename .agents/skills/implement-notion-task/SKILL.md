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
3. 親EpicとProject、関連仕様、承認済みADR、関連設計ページを取得する。
4. Status、Requirement、Done Criteria、Dependencies、Estimate、Area、Type、Milestone、PR URLを抽出する。

Inboxまたは要件整理中のTaskを実装しない。Readyでない場合は不足しているReady条件を報告し、利用者が改善を望む場合は`$prepare-notion-work`を使う。ほかのStatusから進める場合は、未解決の判断を迂回しないことを確認し、例外的な進め方について利用者の明示確認を得る。

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
- 採用済み判断を維持する。代替案は提案として分離し、プロジェクトルールが求める場合はADRを必須とする。

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
2. 採用済みアーキテクチャ判断を変える前にADRを作成または更新する。
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

## 完了報告を行う

次を報告する。

- Task、Epic、参照仕様のLink
- 実装したRequirementとDone Criteria
- 変更したLayerと主要File
- Red・Green・Refactorの実行結果
- 文書とSchemaの更新
- 実行したCommandと結果
- 残るRiskまたは阻害事項
- PRの準備状況

依頼にそのWorkflowが含まれる場合だけNotionのStatusやURLを更新する。利用者から依頼されていないPRを作成しない。
