# Mermaid図をRepository正本とする

- Status: Accepted
- Decision Owner: Project Owner
- Accepted Date: 2026-09-06
- Related Decision: [GitHub Issue #13](https://github.com/takeshi-arihori/kakei_app/issues/13)
- Implementation Task: [GitHub Issue #22](https://github.com/takeshi-arihori/kakei_app/issues/22)

## Context

設計図を実装・仕様と同じPull Requestでレビューし、履歴と差分を追跡できる形にする必要がある。一方、Project Ownerは考えたい方向を自由に表現する検討用Toolとしてdraw.ioを使う。両者を自動同期すると、未承認の仮説が正本へ混入し、文章のDecisionと図の意味が食い違う可能性がある。

## Decision

- 正式な設計図は`docs/diagrams/<name>.mermaid.md`で管理し、Repositoryの文章Decisionと同じPull RequestでReviewする。
- 文章のAccepted Decision、業務Rule、不変条件が図より優先する。図が矛盾した場合は図を修正する。
- draw.ioはProject Ownerが意図、仮説、希望する方向を伝えるための検討用入力とする。正本ではない。
- AIはdraw.ioファイルを変更しない。Project Ownerが明示した場合に限り、内容を読み取り専用の参考情報として扱う。
- draw.ioとMermaidの自動同期は行わない。入力内容は`Confirmed`、`Proposed`、`Open Question`に分け、Project Ownerが採用を承認した後だけMermaid正本へ反映する。
- Mermaid図には正本Path、関連IssueまたはADR、Knowledge State、最終確認日を記載する。

## Alternatives

1. draw.ioを正本にする: 自由度は高いが、文章差分のReview、検索、自動検証が難しいため採用しない。
2. draw.ioからMermaidへ自動同期する: 二重管理を減らせるが、検討中の表現を承認済みDecisionとして取り込む危険があるため採用しない。
3. 図を正本にせず文章だけを管理する: 意味の一貫性は保てるが、関係や境界のReviewが難しくなるため採用しない。

## Consequences

- 図をPull Requestの差分としてReviewし、Markdown LinkとMermaid構文を機械検査できる。
- Project Ownerはdraw.ioを検討用Canvasとして引き続き利用できる。
- draw.ioの提案をMermaidへ反映する前に、意味の確認とOwner承認が必要になる。
- 既存draw.ioは移行対象にせず、その存在だけでDomain Decisionを確定しない。

## Rollback

このDecisionを戻す場合もAccepted ADRを直接書き換えない。新しいADRで正本形式、移行方法、履歴保持、Security Reviewを決め、Project Ownerの承認後に段階的に切り替える。それまではRepositoryのMermaid Markdownを正本として維持する。

## Review Trigger

- GitHub上でMermaid図をReviewまたは描画できなくなった場合
- 図の規模によりMarkdown差分で意味を確認できなくなった場合
- Project Ownerの検討用入力を安全に取り込めない事例が繰り返された場合
- 別形式への移行または自動生成が必要になった場合
