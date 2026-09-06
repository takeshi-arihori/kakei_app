# Project-local draw.io MCP（利用停止）

このDirectoryは過去の互換性と監査のために残している。家計アプリのAI作業では起動、登録、呼び出しを行わない。

正式な設計図はRepositoryの`docs/diagrams/*.mermaid.md`で管理する。draw.ioはProject Ownerが意図、仮説、希望する方向を表現する検討用入力であり、正本ではない。

## Rules

- AIはdraw.ioファイルを作成、更新、削除、整形しない。
- draw.ioを変更するToolを使用しない。
- Project Ownerが対象を明示して参照を依頼した場合だけ、入力を読み取り専用で確認する。
- draw.ioとMermaidを自動同期しない。
- 入力内容を`Confirmed`、`Proposed`、`Open Question`、`Conflict`へ分類する。
- `Proposed`はProject Ownerが採用を承認した後だけ、関連IssueまたはADRと同じPull RequestでMermaid正本へ反映する。

詳細は[図の管理ルール](../../docs/engineering/diagram-governance.md)と[Mermaid図をRepository正本とするADR](../../docs/adr/mermaid-diagram-source-of-truth.md)を参照する。

このDirectoryの実装を再利用、変更、削除する場合は、先にGitHub Taskで対象とRollbackを定義し、正本形式を変える場合は新しいADRについてProject Ownerの承認を得る。
