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

Ready済みGitHub TaskをBranch作成からDraft PRまで届ける場合、本SkillはGitHub Delivery Lifecycleの内側で利用される。GitHub Status、Branch、Commit、Push、PR作成そのものは本Skillの責務に含めない。

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
                           └── 適切な設計 / implementation / testingへ戻る
```

設計Skill同士の順序は依存関係で決める。Domain RuleをAPIやDB都合から逆算しない。API契約とDB Schemaが両方変わる場合も、Data Owner、Domain Rule、Transaction Boundaryを先に確認する。

## 専門Skillとの関係

統括Flowでは同じ専門Skillを重複実行しない。

- `domain-design`が、業務概念・Rule・Invariantの発見や再検証が必要な場合に[domain-modeling](../domain-modeling/SKILL.md)を利用する。
- `domain-design`が、個別Use CaseのPRE／POST／INV／FAILを構造化する場合に[specification-contract](../specification-contract/SKILL.md)を利用する。
- `code-review`が、JavaScript／TypeScriptの公開APIまたはSOLID／DRY／DDD／Context境界の確認が必要な場合に[solid-ddd-pr-review](../solid-ddd-pr-review/SKILL.md)を利用する。
- 視覚結果そのものがDone Criteriaである場合など、必要な場合だけ[prepare-pr-evidence](../prepare-pr-evidence/SKILL.md)を利用する。

利用者が専門Skillを単独指定した場合は、そのSkillだけを実行できる。個別Skillからこの統括Skillを呼び戻さない。循環参照を作らず、統括Skillだけが全体順序を決める。

## Routing例

| 依頼 | 選択例 |
| --- | --- |
| 調査だけ | `pre-investigation`で終了。Repository変更へ進まない |
| Domain設計だけ | `pre-investigation → domain-design → testing（必要な仕様・構造検証）→ code-review`。Production Codeがなければ`implementation`を省略 |
| DBだけの変更 | `pre-investigation → database-change → testing → implementation（必要な場合）→ testing → code-review` |
| API＋DB変更 | `pre-investigation → 必要ならdomain-design → api-design / database-change → testing → implementation → testing → code-review` |
| 文書・Skillだけ | 対象Skillの変更 → `testing`でLink／frontmatter／Routing等を検証 → `code-review`。Production Code用の`implementation`は省略可能 |

## 停止条件

Accepted ADRの変更、新しいBounded Context、DB／Cloud Service／Runtime、認証・認可方式、API Protocol／Schema正本、Context間連携など、RepositoryのADR必須条件に該当する未承認Decisionが必要になった場合は、そのDecisionに依存する設計・実装を止める。依存しない調査や整理は継続する。

## 完了条件

- 使用したSkillと省略したSkill、その理由を説明できる。
- Requirement／Done Criteriaから設計、Code、Test、Review結果までTraceできる。
- 変更に必要なRepository文書が同じ差分で更新されている。
- 未実施の検証、未決事項、残Riskが明示されている。
- `code-review`でBlocker／Majorが残っていない。
