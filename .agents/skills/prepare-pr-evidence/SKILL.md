---
name: prepare-pr-evidence
description: PRの視覚証跡を求められたとき、差分からUI screenshot・Mermaid PDF・不要を選び、安全に生成・検査する。一般Code Reviewには使わない。
---

# PR Review Evidence

Pull RequestのReviewerがDone Criteriaを確認するために必要な、最小限の視覚証跡を準備する。証跡の数や見栄えを成果にせず、差分の意味、公開安全性、再現条件、未確認Riskを明らかにする。

## 正本と権限を確認する

- Task Issue、Pull Requestのbase／head／diff／Done Criteria、Repositoryの検証手順を確認する。
- Mermaid図を扱う場合、正式な図は[Mermaid図のAccepted ADR](../../../docs/adr/mermaid-diagram-source-of-truth.md)と[図の管理ルール](../../../docs/engineering/diagram-governance.md)に従う。
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

## 選択後に読む

- **不要**: 選択理由とTest・文章Review等の適切な証拠を報告して完了する。生成用資料は読まない。
- **UI screenshot**: [UI撮影条件](references/ui-capture.md)を読む。
- **Mermaid PDF**: [PDF生成条件](references/mermaid-pdf.md)を読む。
- **両方**: 上記2つを読む。

Artifactを生成する場合は、生成前に[公開Security Gate・目視Review・保持・Cleanup](references/artifact-review.md)を読む。合成Fixture、機密情報の生成前後検査、全Page／画像の目視確認、作成物だけのCleanupは必須。生成成功だけで検証済みとしない。利用者へ渡す成果物は同Referenceに従って永続保存し、削除済みPathを成果物として案内しない。

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

Skill自体を変更・評価するときは[Forward Cases](test/forward-cases.md)を使う。
