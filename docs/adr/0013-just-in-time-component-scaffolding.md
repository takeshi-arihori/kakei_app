# ADR-0013: Component／Package DirectoryをTask着手時に作成する

- Status: Accepted
- Date: 2026-07-21
- Area: Architecture
- Related Notion Task: https://app.notion.com/p/3a206467984f81bdbc52df979595b835
- Amends: ADR-0007のComponent／Package Directory作成時期

## Context

ADR-0007はWeb、API、Worker、共有Packageを1つのpnpm Workspaceで管理する目標構成を定めた。一方、責務、Runtime、所有者、最初の利用者が未確定な空Directoryを先行作成すると、実装済みComponentと将来計画の区別がつかず、不要なScaffoldと文書の不整合を生む。

## Decision

- Repositoryの実Directoryは実装済みComponent／Packageだけを表す。
- `apps/worker`はOutbox／Projection WorkerのTaskがReadyとなり着手するときに、責務とRuntimeを確認して作成する。
- `packages/*`は2つ以上の実Consumerまたは明確な契約所有者が生じたTaskで、最小単位を作成する。
- 空DirectoryやPlaceholderだけを将来構成のためにCommitしない。
- `pnpm-workspace.yaml`の`apps/*`／`packages/*` globは、将来追加を受け入れる設定として先行定義してよい。
- 現在の実体は`apps/web`と`apps/api`であり、`apps/worker`と`packages/*`は未作成とする。

## Alternatives

- 目標Directoryをすべて先行作成する: 構成を可視化できるが、実装済みと計画中の区別が曖昧になり、空Scaffoldの保守が発生する。
- Worker処理を`apps/api`へ仮置きする: Directoryは増えないが、Deploy／Retry／監視境界が曖昧になるため採用しない。
- Workerを直ちにGoで作成する: 実測要件がなく、ADR-0012の段階的判断に反するため採用しない。

## Consequences

- Repository treeが現在の実装状態を正確に表す。
- 将来構成はNotion TaskとArchitecture文書で管理し、Directoryだけを先行させない。
- Worker Task着手時にはTypeScript継続かGo分離かを、ADR-0012の計測条件に従って確認する。
- 共有Packageの抽出判断は重複や契約境界が現れてから行うため、早すぎる共通化を避けられる。

## Implementation

- READMEと開発ルールに、現在の実体と未作成Directoryを明記する。
- NotionのDirectory図は目標構成と明示し、現在状態を併記する。
- Worker／共有PackageのTaskへ、作成前提と依存関係を記録する。
- 空の`apps/worker`または`packages/*`を検出した場合は、そのTaskと最初のConsumerを確認する。

## Review Trigger

- Worker Scaffold TaskがReadyになる場合。
- 共有Packageを必要とするConsumerが2つ以上になった場合。
- Repository分割またはDeploy単位の変更を検討する場合。
