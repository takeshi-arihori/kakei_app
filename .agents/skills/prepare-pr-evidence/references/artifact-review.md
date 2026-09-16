# Artifactの安全性・目視検査・保持

生成前に保存先・Fixture・保持条件を決め、生成後に目視とCleanupを完了する。

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
