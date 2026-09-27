# PR依存関係Gate

Task／Pull Request間のDependencyを明示し、後続PRが前提変更より先に`develop`へ統合されることを防ぐ。

## 先にTask Dependencyを決める

PRの依存関係は実装後に考えるのではなく、Epic／Task分解時に決める。

```text
Task A ──前提──▶ Task B
  │                │
  ▼                ▼
 PR A ──Depends──▶ PR B
```

依存がないTaskは並行実装・並行PRにできる。Dependencyは「順番が好ましい」ではなく、後続成果が前提成果なしでは正しく成立・検証できない場合だけ設定する。

## Delivery方式を選ぶ

| 状態 | Delivery |
| --- | --- |
| Task同士が独立 | それぞれ`develop`からBranchを作り並行PR |
| 前提Taskがすでに`develop`へMerge済み | 後続Taskを最新`develop`から開始 |
| 前提PRが未Mergeだが後続Taskを進める必要があり、Code上も前提差分が必要 | Stacked PR |
| Requirement／Decisionだけに依存し、Code差分には依存しない | Accepted／Ready Gateを満たした後、通常PR。Stack不要 |

Stackを使うこと自体を目的にしない。独立可能なTaskを不要に直列化しない。

## Stacked PR

前提PRが未Mergeのまま、その差分上で後続Taskを実装する場合は次の形にする。

```text
develop
   │
   └─ branch-A ── PR A → develop
         │
         └─ branch-B ── PR B → branch-A
               │
               └─ branch-C ── PR C → branch-B
```

ルール:

1. 後続Branchは直接依存する前提BranchのHeadから作る。
2. 後続PRのBaseは直接依存する前提Branchにする。
3. PR本文へ論理Dependencyを`Depends-On: #<PR番号>`で記録する。
4. Reviewは各Taskの差分だけを確認できるよう、1 Task／1 PRを維持する。
5. MergeはDependency Graphの上流から行う。
6. 前提PRが`develop`へMergeされたら、直接後続PRを最新`develop`へrebase／updateし、Baseを`develop`へ変更する。
7. 再base後の差分と検証結果が変わっていないことを確認し、必要ならSelf Reviewと独立Evaluatorを再実行する。
8. さらに後続Stackがある場合、各Branchを新しい親Headへ順番に追従させる。

複数の独立前提を持つTaskは、可能なら前提PRを先にMergeしてから開始する。複雑な多親Stackを安易に作らない。

## PR本文

`develop`へ向かうPRに未完了／完了を問わず論理Dependencyがある場合、PR本文へ次を記載する。

```text
Depends-On: #108
```

複数Dependency:

```text
Depends-On: #108
Depends-On: #109
```

依存PRがない場合は記載しない。

Stack中に前提BranchをBaseとしているPRでも、依存関係のTraceabilityのため`Depends-On`を記載する。

## CI Gate

`.github/workflows/pr-dependency-gate.yml`は、`develop`へ統合するPR本文の`Depends-On`を検査する。

- すべての依存PRがMerged: `依存PR確認`成功
- 未Mergeの依存PR: 失敗
- 存在しない番号またはIssue番号: 失敗
- 自分自身のPR番号: 失敗
- PR本文変更時も再検証する

`develop`のRulesetでStatus Check `依存PR確認`をRequiredにする。Required化されていない場合、CI失敗だけではMergeを強制停止できない。

## Planningで残す情報

Task分解時に最低限次を記録する。

- Dependencies
- 実装順序
- 並行可能Task
- Stacked PRが必要か
- Stackの場合の直接Base
- 期待するMerge順序
- 前提Merge後に再実行する検証

`work_planning_evaluator`はこの情報とRequirementを照合し、不要な直列化、欠落Dependency、逆順Mergeがないか独立評価する。
