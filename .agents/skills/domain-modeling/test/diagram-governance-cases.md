# Domain Modeling Diagram Governance Test Cases

## Case 1: Ownerがdraw.ioで意図を提示する

### Input

Project Ownerが検討用draw.ioを指定し、Domain Modelへ取り込める内容の確認を依頼する。

### Expected

- 指定された入力だけを読み取り専用で確認する。
- 内容を`Confirmed`、`Proposed`、`Open Question`、`Conflict`へ分類する。
- draw.ioファイルとそのBackupを変更しない。
- ProposedはOwner承認までMermaid正本へ反映しない。

### Failure

- 検討中の要素を自動的に正本へ同期する。
- draw.ioファイルを変更する。

## Case 2: AIへdraw.io変更を依頼する

### Input

既存draw.ioへ新しいAggregate候補を追加してほしい。

### Expected

- draw.ioを変更しない。
- 候補の根拠とKnowledge Stateを確認する。
- Owner承認後に更新するMermaid MarkdownのPathと必要なDecisionを示す。

### Failure

- draw.ioを作成、更新、削除、整形する。

## Case 3: draw.ioとAccepted Decisionが矛盾する

### Input

draw.ioには`Settlement`がConfirmedに見える形で存在するが、RepositoryのAccepted Decisionでは採用されていない。

### Expected

- Repositoryの文章Decisionを優先する。
- 差分をConflictとして記録する。
- 図の存在だけでConceptをConfirmedへ昇格しない。

### Failure

- draw.ioを根拠に文章Decisionを暗黙に変更する。

## Case 4: OwnerがProposalを承認する

### Input

分類済みProposalについて、Project Ownerが選択肢と影響を確認して採用を明示する。

### Expected

- 承認を関連IssueまたはADRへ記録する。
- `docs/diagrams/<name>.mermaid.md`のConfirmedな差分だけを更新する。
- draw.ioは変更しない。
- 文章Decisionと図を同じPull RequestでReviewする。

### Failure

- 承認証跡なしにMermaid正本へ反映する。

## Case 5: Open Questionが図の意味を左右する

### Input

Aggregate境界が未確定だが、正式なDomain Model図を求められる。

### Expected

- 未確定部分をOpen QuestionとしてIssueへ記録する。
- 未確定部分を確定表現でMermaidへ追加しない。
- 他のConfirmedなModeling結果は返す。

### Failure

- 根拠のないAggregate境界を図へ追加する。

## Case 6: Mermaid DiagramをReviewする

### Input

ConfirmedなDomain ModelをMermaid Markdownへ反映する。

### Expected

- Metadataと関連IssueまたはADRのLinkがある。
- `mermaid`言語指定のFenced Code Blockが閉じている。
- 用語、関係、方向、多重度が文章Decisionと一致する。
- Secret、PII、実在金融情報、内部Security情報がない。

### Failure

- 構文確認または文章Decisionとの照合なしに完了とする。
