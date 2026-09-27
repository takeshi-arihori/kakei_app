---
name: stacked-pr-delivery
description: Planning済みのStacked PRをRepositoryのDependency Ruleに従って作成・同期・再検証する。gh-stackは利用可能時の優先Adapterとして扱う。
---

# Stacked PR Delivery

PlanningでStacked PRが必要と確定したTask群を、RepositoryのDependency Ruleを壊さずBranch／PRへ反映し、上流PR Merge後の追従まで管理する。

本SkillはStackの要否や静的Ruleを決めない。`prepare-github-work`で確定したDependency Graphを入力とし、Stacked PRの正しさはRepository docsを正本とする。特定のProgramming Language、DB、Framework、ORM、API方式を前提にしない。

## 適用条件

PlanningでStacked PRが必要と判定済みで、直接Base、Merge順序、前提Merge後の再検証方針を取得できる場合だけ使用する。

Stack要否が未決、Dependencyが不明、または独立Taskを単に順番に並べたいだけの場合は実行せず、`prepare-github-work`へ戻す。

## 最初に読む

- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [Delivery Workflow](../../../docs/engineering/delivery-workflow.md)
- [PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)
- [official gh-stack Adapter参照](references/official-gh-stack.md)
- 対象Task、Dependency Graph、Merge順序、既存PR

Branch、PR Base、Dependency表現、Merge順序、前提Merge後の追従、公開Gate等の静的Ruleは上記docsを正本とし、このSkillへ複製しない。

## 入力を固定する

作業前に次を記録する。

- 基準`develop` SHA
- Stack対象TaskとBranch／PRの対応計画
- Stackのbottom → top順序
- 各Taskの直接依存Task／PR／Branch
- 各PRの期待Base
- 現在Branch、作業Tree、Remote、既存PR
- 未Commit変更の所有者と対象Task

`gh-stack`は線形Stackを扱うため、1つのStackへ入れるのは1本のDependency Chainだけとする。Dependency Graphが分岐する場合は独立Branch／別Stackへ分け、どのChainへ属するかPlanningで決まっていなければ`blocked`にする。

## Adapterを選ぶ

`github/gh-stack`はRepository必須依存にせず、利用可能時の優先Adapterとする。公式SkillまたはCLIを利用できる場合は低Level操作をそちらへ委譲し、Repository固有のGateと検証だけ本Skillで行う。

確認例:

```bash
gh --version
gh auth status
gh stack --version
gh stack --help
```

- `gh stack`が利用可能: **gh-stack Adapter**を使う。
- Extension未導入／非対応環境: Repository docsに従う通常Git／GitHub操作へFallbackする。
- GitHubへの書込み権限自体がない: `blocked`。
- ExtensionのInstall／UpgradeはMachine固有変更なので、利用者の明示依頼なしに実行しない。
- 個人Path、Credential、Remote名等をRepositoryへ固定しない。

公式`github/gh-stack`が提供するAgent Skillを実行環境で利用できる場合は、CLI構文・exit code・recovery等のTool固有詳細をそのSkillへ委譲する。Repository内へ公式Skill本文を複製しない。

## gh-stack Adapter

Agentからは対話UIを避け、公式Skill／`gh stack <command> --help`で確認した非対話形式を使う。

代表Flow:

```text
Planning済みDependency Chainを固定
      │
      ▼
既存Stackを view --json で取得
      │
      ├─ 新規Chain: init / add
      └─ 既存Chain: checkout / sync / rebase
      │
      ▼
Task境界ごとに変更をCommit
      │
      ▼
submit --auto
      │
      ▼
Repository docsと実PRを照合
```

操作時の要点:

- Stack順序とBranch名はPlanning／Repository docsから取得し、Tool側の既定値で上書きしない。
- `gh stack view --json`を機械可読なStack状態の確認に使う。
- PR作成は非対話の`gh stack submit --auto`を基本とする。
- submit後は、gh-stackのStack情報だけを正しさの根拠にせず、`pr-dependency-gate.md`が要求するPR metadataと実際の差分を再取得して照合する。
- 下位Layerの変更、上流PR Merge、sync／rebase後は、Stack状態とTaskごとの差分を再取得する。

`gh-stack`固有のrebase conflict、local/remote divergence、Stacked PR非対応等は公式Toolのexit codeとrecoveryに従う。自動復旧で変更所有権が不明になる場合は推測して続行しない。

## Fallback Adapter

`gh-stack`を利用できなくても、[PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)の操作を通常Git／GitHub Toolで実行可能ならDeliveryを継続する。

FallbackではToolだけを置き換え、次の順序でOrchestrationする。

1. Planning済みChainと現在のBranch／PR実体を照合する。
2. `pr-dependency-gate.md`に従って必要なBranch／PR状態へ更新する。
3. 更新後のBranch ancestry、PR metadata、Task単位のDiffを再取得する。
4. 上流PR Merge後は同docsの追従手順をbottomから再適用する。
5. 再取得した実体がPlanningとdocsに一致するまで次のMerge対象へ進めない。

Fallbackは静的Ruleの代替ではなく、同じRuleを別Toolで実行するだけとする。

## PR作成前後の検証

各Layerについて、[Delivery Workflow](../../../docs/engineering/delivery-workflow.md)と[PR依存関係Gate](../../../docs/engineering/pr-dependency-gate.md)の要求項目を、Task／Branch／PR／Diffの実体へ照合する。

Stack操作前後でCommit ancestry、Base、またはPR Diffが変化した場合は、影響するVerificationを再実行する。Taskの評価対象Diffが変わった場合はSelf Reviewをやり直し、新しい`task_evaluator`で再評価する。Base metadataだけが変わりTask Diffが同一なら、Dependency／CI／差分同一性を再確認し、実施不要な検証は理由を記録する。

## 停止条件

次は自動で推測・破壊的解決せず`blocked`として報告する。

- Planningと実際のDependency／Branch ancestryが矛盾する。
- 1 Stackへ非線形Dependencyを押し込む必要がある。
- 未Commit変更またはCommitの所有Taskを特定できない。
- rebase conflictで正しい解決内容をRequirement／Codeから判断できない。
- local／remote Stackがdivergeし、どちらを正とするか判断できない。
- GitHub write権限がない。
- Toolが要求する対話的なreorder／rewriteしか安全な復旧方法がなく、利用者Decisionが必要である。

Tool未導入だけを理由に`blocked`にはせず、安全なFallbackが成立するかを先に確認する。

## 出力

- 使用Adapter: `gh-stack` / `fallback`
- 基準`develop` SHA
- Stackのbottom → top順序
- Task → Branch → PR → Baseの対応
- Dependency metadataの照合結果
- 実行したStack操作と結果
- 親PR Merge後の追従状態
- 再実行したVerification／Self Review／Evaluator
- 未実施検証と理由
- Conflict／blocked要因

## 完了条件

- Repository docsのStacked PR Ruleと実体が一致している。
- 各PRがPlanning済みTask境界へTraceできる。
- DependencyとMerge順序をGitHub上でTraceできる。
- 親Merge後の追従手順または実施結果が明確である。
- Diffが変わった場合の再検証が完了している。
- Tool固有RuleをRepositoryの静的Ruleとして二重管理していない。
