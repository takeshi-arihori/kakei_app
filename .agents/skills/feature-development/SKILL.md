---
name: feature-development
description: 機能追加・変更・リファクタリングを対象に、影響範囲を判定して必要な設計・実装・検証・レビューSkillだけを組み合わせる統括Skill。
---

# Feature Development

機能変更を1つの巨大な手順で処理せず、変更内容に応じてProject-local Skillを選択し、成果物を次のSkillへ引き継ぐ。個別Skillのルール本文をここへ複製しない。

## 入力

- GitHub Taskまたは利用者が明示した変更要求
- 関連するRequirement、Done Criteria、Accepted ADR、Repository文書
- 既存Code・Test・Schema・Migration・運用手順

Ready済みGitHub TaskをBranch作成からDraft PRまで届ける場合は、外側のLifecycleを[implement-github-task](../implement-github-task/SKILL.md)に任せる。このSkillはGitHub StatusやPR作成そのものを責務にしない。

## 最初に行うこと

原則として[pre-investigation](../pre-investigation/SKILL.md)で、現状、影響範囲、未決Decision、変更種別を整理する。対象と影響範囲が既に十分に確定している小さな機械変更では省略できるが、省略理由を明示する。

調査結果から次のSkillを選択する。

| 変更内容 | 使用するSkill |
| --- | --- |
| Domain Rule、Entity、Value Object、Aggregate、Domain Service、Domain Event、Context境界 | [domain-design](../domain-design/SKILL.md) |
| GraphQL、HTTP、公開Input／Output、Error、認証・認可境界、互換性 | [api-design](../api-design/SKILL.md) |
| Table、Migration、Index、永続化制約、Data移行 | [database-change](../database-change/SKILL.md) |
| Production Codeの追加・変更 | [implementation](../implementation/SKILL.md) |
| Test設計、Red Test、検証、回帰確認 | [testing](../testing/SKILL.md) |
| 最終Diffの品質・要件整合Review | [code-review](../code-review/SKILL.md) |

必要なSkillだけを使う。すべてを毎回強制実行しない。

## 実行順序

基本形は次の通り。

```text
pre-investigation
       │
       ├── domain-design ──┐
       ├── api-design ─────┤
       └── database-change ┤
                           ▼
                     testing（Red）
                           │
                           ▼
                    implementation
                           │
                           ▼
                 testing（Green/回帰）
                           │
                           ▼
                      code-review
                           │
                    findingがあれば
                           └── implementation / testingへ戻る
```

設計Skill同士の順序は依存関係で決める。Domain RuleをAPIやDB都合から逆算しない。API契約とDB Schemaが両方変わる場合も、Data Owner、Domain Rule、Transaction Boundaryを先に確認する。

## 既存専門Skillとの関係

- 業務概念・Rule・Invariantの発見や検証は[domain-modeling](../domain-modeling/SKILL.md)を利用する。
- 個別Use CaseのPRE／POST／INV／FAILは[specification-contract](../specification-contract/SKILL.md)を利用する。
- SOLID／DRY／DDDと日本語JSDocの専門Reviewは[solid-ddd-pr-review](../solid-ddd-pr-review/SKILL.md)を利用する。
- 視覚証跡が必要な場合だけ[prepare-pr-evidence](../prepare-pr-evidence/SKILL.md)を利用する。

個別Skillからこの統括Skillを呼び戻さない。循環参照を作らず、統括Skillだけが全体順序を決める。

## 停止条件

Accepted ADRの変更、新しいBounded Context、DB／Cloud Service／Runtime、認証・認可方式、API Protocol／Schema正本、Context間連携など、RepositoryのADR必須条件に該当する未承認Decisionが必要になった場合は、そのDecisionに依存する設計・実装を止める。依存しない調査や整理は継続する。

## 完了条件

- 使用したSkillと省略したSkill、その理由を説明できる。
- Requirement／Done Criteriaから設計、Code、Test、Review結果までTraceできる。
- 変更に必要なRepository文書が同じ差分で更新されている。
- 未実施の検証、未決事項、残Riskが明示されている。
- `code-review`でBlocker／Majorが残っていない。
