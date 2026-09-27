# Stacked PR Delivery Tooling

Stacked PRの静的な正しさは[PR依存関係Gate](pr-dependency-gate.md)を正本とする。この文書はTool Integrationの境界だけを記録し、Branch Base、PR Base、Dependency表現、Merge順序等のRule本文を複製しない。

## gh-stackの位置付け

GitHub公式`github/gh-stack`は、Stacked PR Deliveryを補助するCLI／Agent Skillとして利用できる。

- CLI: `gh extension install github/gh-stack`
- Agent Skill: `gh skill install github/gh-stack`
- 公式Repository: https://github.com/github/gh-stack

本Repositoryでは`gh-stack`を必須依存にはしない。利用可能な環境では`.agents/skills/stacked-pr-delivery/`から優先Adapterとして利用し、利用できない場合は同じRepository Ruleを通常Git／GitHub Toolで実行する。

この方針により、Stacked PRの設計とDelivery RuleはToolから独立させ、`gh-stack`のVersionやCLI仕様変更をRepositoryの静的Rule変更へ波及させない。

## 責務

```text
prepare-github-work
  └─ Stack要否 / Dependency Graph / Merge順序をPlanning
          │
          ▼
implement-github-task
  └─ stacked-pr-delivery をRouting
          │
          ├─ gh-stack Adapter
          └─ Git / GitHub Fallback
          │
          ▼
pr-dependency-gate.md と実PRを照合
```

- `prepare-github-work`: Stackが必要かを決める。
- `stacked-pr-delivery`: Planning済みStackを実体化・同期・再検証する。
- `pr-dependency-gate.md`: Stackの静的Ruleを定める。
- `github/gh-stack`: Tool固有のCLI操作・Stack metadata・recoveryを提供する。

## Tool固有情報の扱い

Tool固有のflag、exit code、対話／非対話動作、recoveryは`stacked-pr-delivery`から公式Skill／CLI Helpを確認する。固定VersionやMachine固有Path、Credential、Remote設定をRepository Ruleとして持たない。

Issue #133の初回調査時点（2026-09-27）の最新Releaseは`v0.1.1`だが、実行時は現在のVersionと公式仕様を確認する。
