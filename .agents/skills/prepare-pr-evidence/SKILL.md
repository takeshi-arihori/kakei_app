---
name: prepare-pr-evidence
description: Pull Requestの差分とDone Criteriaから、MermaidのPDF、UI screenshot、両方、または視覚証跡不要を選び、公開安全なFixture、目視Review、Cleanup、報告まで準備する。PRの視覚確認、Diagram PDF、画面証跡を依頼されたときに使用する。機能実装、PRの一般Code Review、draw.io編集だけには使用しない。
---

# PR Review Evidence

Pull RequestのReviewerがDone Criteriaを確認するために必要な、最小限の視覚証跡を準備する。証跡の数や見栄えを成果にせず、差分の意味、公開安全性、再現条件、未確認Riskを明らかにする。

## 正本と権限を確認する

- Task Issue、Pull Requestのbase／head／diff／Done Criteria、Repositoryの検証手順を確認する。
- 正式な図は[Mermaid図のAccepted ADR](../../../docs/adr/mermaid-diagram-source-of-truth.md)と[図の管理ルール](../../../docs/engineering/diagram-governance.md)に従う。
- draw.ioはProject Ownerの検討用入力である。AIは作成、変更、削除、整形、自動変換を行わない。Ownerが対象を明示した場合だけ読み取り専用で確認する。
- PR本文、Comment、GitHub添付など外部状態へ書き込むのは、利用者がその書き込みを明示的に依頼した場合だけとする。依頼がなければArtifactと追記案を準備して報告する。
- 既存PR本文を更新するときは全体を取得して既存内容を保持し、証跡Sectionだけを追加または更新する。

## 証跡種別を選ぶ

差分とDone Criteriaを次の基準で分類する。複数Artifactが同じ内容を証明する場合は最小の1つを選ぶ。

| 選択 | 使う条件 | 使わない条件 |
| --- | --- | --- |
| Mermaid renderのPDF | 正本Mermaid図の関係、境界、Sequence、複数Pageまたは印刷時の可読性をReviewerが確認する必要がある | Proposed／Open Questionだけの図、文章差分だけ、draw.ioしか根拠がない |
| UI screenshot | Layout、状態、表示文言、responsive、視覚的回帰など、Code/Test出力だけでは確認しにくいDone Criteriaがある。時間順が必要なら最小の連番Screenshotを使う | Backend、内部Refactor、非視覚的な設定、画面に影響しない文書変更 |
| 両方 | AcceptedなDiagram変更と、その内容を反映したUIの両方が独立したDone Criteriaである | 同じ事実の重複提示になる場合 |
| 不要 | Unit／integration test、Schema diff、Log、文章Reviewの方がDone Criteriaを直接証明する | 視覚結果そのものがRequirementの場合 |

選択結果には、対象Done Criteria、必要なArtifact、Scenario、対象外、判断理由を残す。視覚証跡が不要でも失敗ではない。

## 最小Scenarioを決める

Artifactごとに次を固定する。

- Trace先となるDone Criteria
- 開始状態、操作、期待する最終状態
- 正常、境界、失敗のうち、視覚的に差が出てReview価値がある最小集合
- Browser、Viewport、theme、locale、timezone
- 使用するFixtureと、Fixtureが合成Dataである根拠
- 描画完了条件と撮影対象

Desktopの標準候補は`1440x900`、mobileの標準候補は`390x844`とする。responsiveがDone Criteriaでなければ両方を機械的に作らない。RepositoryやTaskが別のViewportを指定する場合はそちらを優先し、実際に使った値を報告する。

UI撮影ではAnimationとCaret点滅を止め、`prefers-reduced-motion`を有効にする。Font、画像、対象Request、loading表示が完了し、Layoutが安定したことを待つ。任意の固定sleepだけを完了条件にしない。時刻、random値、IDはFixtureで固定し、OS全体、別Tab、通知、開発者用Tokenを写さない。

遷移前後は番号付きの最小Screenshot列で示す。focus順序、Animation、非同期更新など静止画で証明できない振る舞いは、操作Testを主証拠にする。動画またはTraceは時間的挙動そのものがDone Criteriaで、静止画とTestでは不足し、Taskが保存・保持を認める場合だけ選ぶ。Traceは内部Requestや認証Dataを含み得るため、公開Artifactの既定値にしない。

Mermaid PDFはRepository正本の`.mermaid.md`から生成し、関連するAccepted Decisionとmetadataを確認する。PDF化の都合でSource Mermaidの意味、Node、関係、文言を変更しない。Source commit SHA、Rendererとversion、Mermaid config、Font、Page size、orientation、scaleを記録する。

## 公開Security Gate

生成前と生成後の両方で確認する。

- Secret、Access Token、Cookie、Authorization header、秘密鍵
- PII、氏名、Email、住所、実在する利用者ID
- 実在金融情報、口座、決済情報、実際の家計・支出内容
- 内部Security情報、非公開URL、環境変数、Stack Trace、管理画面
- Browser chrome、ほかのTab、通知、local pathなど意図しない周辺情報

Fixtureは架空のActor、固定ID、架空の金額だけを使う。Repositoryの既存fixtureも公開可と自動判断せず、中身を確認する。

機密検出時は安全なFixtureと撮影範囲による再生成を第一選択とする。無関係な画面端のcropで証拠の意味が変わらない場合はcropを使える。Blur／Maskは、再生成できず、Secret・Credential・内部Security情報ではなく、非機密部分だけでDone Criteriaを証明できる場合の例外とする。派生Artifactのmetadataと隠しLayerを除去し、元Artifactを削除してから再Reviewする。

Secret、認証情報、内部Security情報を検出した場合、または加工によって証拠の意味が変わる場合は公開を停止する。元の機密ArtifactをGitHubへUploadせず、検出種別、影響、再生成条件だけを報告する。Credentialの失効と影響調査はCredential OwnerまたはRepository Maintainerの責任であり、緊急性と必要な期限を直ちに報告する。AIは利用者の明示Authorizationなしに失効や外部Incident操作を行わない。

## 生成と目視Review

生成物は最初にTask専用の一時Directoryへ保存する。Repositoryへ保存する前に、画像は実寸、PDFは全Pageを表示して視覚確認できる形で確認する。生成担当のAIがToolで表示して確認した場合は`Reviewer: Codex visual inspection`と記録する。利用者またはPR ReviewerのAcceptanceとは区別し、本人が確認していないものをHuman reviewedと報告しない。

確認項目:

1. Done Criteriaの期待状態が読み取れる。
2. clipping、重なり、欠落、文字化け、loading、animation途中、空白Pageがない。
3. Diagramの用語、方向、関係が文章Decisionと一致する。
4. 同じ情報を示す重複Artifactがない。
5. Security Gateの対象が背景、metadata、URL、File名にもない。
6. Artifact名、Scenario、ViewportまたはPDF設定から再現条件を識別できる。

目視できなかったArtifactを`verified`と報告しない。生成Commandの成功だけで視覚品質をpassにしない。

## 保存先、Data Owner、Cleanup

生成前に保存先と保持期間を決める。

| Data | Owner | 保存・保持 | Cleanup責任 |
| --- | --- | --- | --- |
| 一時画像／PDF／動画／Trace | 実行者 | Task専用一時Directory。生成担当の検査終了まで | 実行者が成功・失敗の両方で削除 |
| Browser profile／Cookie／認証storage | 実行者 | 必要な実行中だけ。Artifactと同じ場所へ置かない | 実行者が終了時に削除。RepositoryやGitHubへ保存しない |
| Repository内Evidence | Repository Maintainer | Taskが明示的に要求し、sourceとしてReviewする場合だけCommit履歴で保持 | 後続PRで置換・削除し、参照切れを確認 |
| GitHub添付／PR本文Link | PR Author／Maintainer | 明示依頼と保持目的がある場合だけ | MaintainerがPR Close、置換、公開Risk発見時に削除・失効対応 |

Repository保存とGitHub添付を自動的に両方行わない。一時Artifactを利用者へ渡す必要がある場合は、最終報告前に明示した永続保存先へ移し、Owner、保持期限、削除責任を設定する。永続化しない場合は一時Artifactを最終報告前に削除し、削除済みPathを利用可能な成果物として案内せず、Artifact名、checksum、検査結果、Cleanup結果だけを報告する。

Cleanupはこの実行が作成したTask専用DirectoryとFileだけを対象とする。所有者不明のDirectory、Source、利用者の入力を再帰削除しない。認証Dataが混入した可能性がある場合は削除だけで安全とみなさず、Credential Ownerへ失効と影響確認を報告する。

## 失敗と再試行

- Appを起動できない、認証できない、Rendererが失敗する、期待状態へ到達できない場合は、成功したふりをせず停止点、試行内容、機密値を除いたError、未確認のDone Criteria、残Riskを記録する。
- 同じ条件の無制限再試行をしない。原因を変えられる場合だけ再試行し、外部書き込みや認証変更には元のAuthorization範囲を適用する。
- UIが不安定なら、固定sleepを増やす前にnetwork、font、animation、fixture、selector、hydrationの完了条件を調べる。
- 機密検出後は安全なFixtureで最初から再生成する。機密元Artifactを編集履歴や添付へ残さない。

## 報告する

次を利用者へ返す。

1. PR／Taskと対象Done Criteria
2. PDF、UI screenshot、両方、不要の選択と理由
3. Scenario、Fixture、ViewportまたはSource commit／Renderer versionを含むPDF render条件
4. 永続化した生成物のPath、または削除済み一時Artifactの名前とchecksum、視覚確認者、Review結果
5. Security Review結果
6. 保存先、Data Owner、保持期間、Cleanup結果
7. 失敗、未実施、残Risk
8. 明示依頼がある場合だけ、実施したPR更新とURL

実際の選択判断は[Forward Cases](test/forward-cases.md)で確認する。

## Impact Mapping

- Product Bounded Context／Aggregate／Domain Rule: 証跡から変更しない。
- Use Case: ReviewerがTaskの視覚的Done Criteriaを安全に確認する。
- Layer: Project-local development workflow。Application Runtime、API、DB、Schemaへ影響しない。
- Data Owner: 一時Artifactと認証状態は実行者、Repository EvidenceはMaintainer、GitHub添付はPR Author／Maintainer。
- Authorization: local生成と外部PR更新を分け、GitHub書き込みは明示依頼時だけ行う。
- Retention: 一時Artifactと認証状態は同じ実行でCleanupし、永続Evidenceは保存目的、保持期間、削除責任を記録する。
- Operations: 生成不能や目視不能を未実施として残し、CIまたは実装の成功へ読み替えない。

## Never Do

- 見栄えのためだけに証跡を増やす。
- draw.ioを変更、整形、Mermaidへ自動変換する。
- ProposedまたはOpen Questionを正式Mermaid正本へ反映する。
- 実在Dataや認証済みBrowserの周辺情報を公開Artifactへ含める。
- 生成成功だけで目視Review済みと報告する。
- 利用者の明示依頼なしにPR本文、Comment、添付を更新する。
- 既存PR本文を取得せず上書きする。
- Cleanup前に一時Artifactや認証状態を放置して完了とする。
