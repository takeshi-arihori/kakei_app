# Diagram Governance Contract

Domain Modelingの文章DecisionとMermaid Diagramの責務境界を定義する。

## Canonical Flow

```text
GitHub Issue / Repository ADR / Domain Expert
        ↓
Validated Domain Model
        ↓
Project Owner Approval
        ↓
docs/diagrams/<name>.mermaid.md
```

文章のAccepted Decision、Business Rule、Invariantが正本である。Mermaid DiagramはそれらをReviewできる形で可視化する。DiagramからDomain Concept、Aggregate、Bounded Contextを推測してDecisionを確定しない。

## draw.io Input Boundary

draw.ioはProject Ownerが意図、仮説、希望する方向を表現する検討用入力であり、正本ではない。

- AIはdraw.ioファイルを作成、更新、削除、整形しない。
- draw.ioを変更するToolを使用しない。
- Project Ownerが対象を明示して参照を依頼した場合だけ読み取り専用で確認する。
- Mermaidと自動同期しない。
- 既存要素を、その存在だけでConfirmedへ昇格しない。

入力内容は次に分類する。

- `Confirmed`: Accepted DecisionまたはOwnerの明示承認と一致する。
- `Proposed`: 方向性は示されているが採用未確定。Owner承認まで正本へ反映しない。
- `Open Question`: 意味、関係、境界、制約が不足している。Issueへ記録する。
- `Conflict`: Repository正本と矛盾する。影響と必要なDecisionを報告し、対象を変更しない。

## Mermaid Output

- Pathは`docs/diagrams/<kebab-case-name>.mermaid.md`とする。
- `Status`、`Source of Truth`、`Related`、`Last Confirmed`を記載する。
- Mermaidは`mermaid`言語指定のFenced Code Blockへ記載する。
- ConfirmedなConcept、Relationship、Multiplicity、Constraintだけを含める。
- CanonicalなUbiquitous Languageを使う。
- Node IDを安定させ、意味のない差分を避ける。
- Secret、PII、実在金融情報、内部Security情報を含めない。

## Update Flow

1. 対象Issue、ADR、仕様、既存Mermaidを読む。
2. 変更を`Confirmed`、`Proposed`、`Open Question`、`Conflict`へ分類する。
3. Proposedの採用が必要ならProject Ownerの明示承認を待つ。
4. 承認根拠をIssueまたはADRへ記録する。
5. Confirmedな差分だけをMermaid Markdownへ反映する。
6. Link、Fenced Code Block、基本構文、文章Decisionとの整合を検証する。
7. Pull Requestで文章と図を一緒にReviewする。

ConflictまたはOpen Questionが図の意味を左右する場合、その部分の更新を止める。Domain Modelingの他のConfirmedな成果は破棄しない。
