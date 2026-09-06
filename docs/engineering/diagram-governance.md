# 図の管理ルール

## 正本と役割

設計図の正本は`docs/diagrams/<name>.mermaid.md`である。仕様、ADR、業務Rule、不変条件など文章のAccepted Decisionが図より優先する。図は文章を可視化するReview対象であり、図だけで新しいDecisionを確定しない。

draw.ioはProject Ownerが意図、仮説、希望する方向を表現するための検討用入力である。AIはdraw.ioファイルを作成、更新、削除、整形しない。draw.ioを扱うToolによる変更も行わない。Project Ownerが対象を明示して参照を依頼した場合だけ、読み取り専用で確認する。

## Knowledge State

入力から抽出した内容を次の状態へ分ける。

| State | 意味 | Mermaid正本への反映 |
| --- | --- | --- |
| Confirmed | RepositoryのAccepted Decisionまたは明示承認と一致する | 根拠Linkを付けて反映できる |
| Proposed | Project Ownerの意図または変更案だが、採用未確定 | Owner承認まで反映しない |
| Open Question | 意味、関係、境界、制約が確定していない | QuestionとしてIssueへ記録し、反映しない |

draw.ioとMermaidを自動同期しない。Project OwnerがProposedの採用を明示した後、関連IssueまたはADRを更新し、その根拠と同じPull RequestでMermaid正本を変更する。

## FileとMetadata

- Path: `docs/diagrams/<kebab-case-name>.mermaid.md`
- 1ファイルは1つのReview目的に絞る。
- Mermaidは`mermaid`言語指定のFenced Code Blockに記載する。
- 冒頭に`Status`、`Source of Truth`、`Related`、`Last Confirmed`を記載する。
- Confirmedな要素だけを図へ記載する。ProposedとOpen Questionは本文またはIssueで管理する。
- Node IDは安定させ、表示名の変更だけで不要な差分を増やさない。
- Secret、PII、実在金融情報、内部Security情報を図、Metadata、例へ含めない。

## Reviewと検証

Pull Requestでは次を確認する。

1. 図が関連Issue、ADR、仕様へTraceできる。
2. 文章Decisionと図の用語、境界、多重度、方向が一致する。
3. MermaidのFenced Code Blockが閉じ、基本構文が解析できる。
4. Repository内Linkが存在する。
5. ProposedまたはOpen Questionが確定表現で混入していない。
6. draw.ioファイルへの変更が差分にない。
7. 公開前Security Gateを通過している。

Conflictを見つけた場合はMermaidを暗黙に合わせず、Issueへ差分、影響、必要なDecisionを記録する。Owner判断が必要な変更はAcceptedになるまで正本へ反映しない。
