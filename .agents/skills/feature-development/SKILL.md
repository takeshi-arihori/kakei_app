---
name: feature-development
description: Readyな機能追加・変更・リファクタリングについて、Repository docsを読み、必要な調査・設計・TDD・実装・検証・Self Review Skillだけを組み合わせる統括Skill。
---

# Feature Development

Ready済みTaskの実作業を、[Engineering Loop](../../../docs/engineering/engineering-loop.md)の実装フェーズに従って進める。GitHub Status、Branch、Commit、Push、独立Evaluator、Draft PRは`implement-github-task`の責務とし、本Skillは実作業のRoutingと修正Loopを担当する。

## 最初に読む

- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [開発ガイド](../../../docs/engineering/README.md)
- TaskからTraceできるRequirement、Done Criteria、Accepted ADR、関連docs

特定の言語、DB、Framework、ORM、API Protocol、RuntimeをSkill本文から仮定しない。具体Ruleは変更範囲に対応するdocsから取得する。

## 入力

- Ready済みGitHub Task
- Requirement／Done Criteria
- Accepted Decision
- `pre-investigation`または同等の最新調査結果
- 関連docsと既存Code／Test

## Routing

原則として`pre-investigation`で現状、Gap、影響範囲を確認する。対象と影響範囲が既にEvidence付きで確定している小さな機械変更だけ、省略理由を記録して省略できる。

調査結果から必要なSkillだけを選ぶ。

| 変更の意味 | Skill |
| --- | --- |
| 業務Rule、Invariant、Domain要素、Context境界 | `domain-design` |
| 外部へ公開する契約、Input／Output、Error、認証認可境界、互換性 | `api-design` |
| Persistence構造、制約、移行、Index、Data変換 | `database-change` |
| Test／検証の設計・実行 | `testing` |
| Production変更 | `implementation` |
| 最終DiffのSelf Review | `code-review` |

変更種別の具体例や採用技術は[開発ガイド](../../../docs/engineering/README.md)と関連docsで解決する。

## 実行順序

```text
pre-investigation
       │
       ├─ 必要な設計Skill ──┐
       │                    ▼
       └──────────────▶ testing（Red／先行検証）
                              │
                              ▼
                       implementation
                              │
                              ▼
                    testing（Green／回帰）
                              │
                              ▼
                         code-review
                              │
                  Finding ────┘
                              │ Pass
                              ▼
               implement-github-taskへ返す
```

設計Skill同士の順序はDependencyで決める。外部契約やPersistence都合から業務Ruleを逆算しない。

## 専門Skill

- 業務Concept、Rule、Invariant、境界の発見・再検証が必要なら`domain-modeling`。
- 個別操作のPRE／POST／INV／FAILをTest可能にするなら`specification-contract`。
- DDD／SOLID／DRY等の専門Reviewが必要なら`solid-ddd-pr-review`。
- Done Criteriaとして視覚Evidence等が必要なら`prepare-pr-evidence`。

専門Skillも[Skillガバナンス](../../../docs/engineering/skill-governance.md)に従い、具体Project Ruleはdocsから読む。同じ専門Skillを形式的に重複実行しない。

## 修正Loop

`testing`または`code-review`でFindingが出たら原因へ戻す。

- Requirement／Domain Ruleの問題: `domain-design`、必要なら設計フェーズへ戻す
- 公開契約の問題: `api-design`
- Persistenceの問題: `database-change`
- 実装Defect: `implementation`
- Test／Evidence不足: `testing`
- ADR必須Decision: Owner Decisionまで依存作業を停止

修正後は影響する検証を再実行し、最新Diffを再Reviewする。

## 出力

`implement-github-task`へ次を返す。

- 実装・文書差分
- 使用／省略したSkillと理由
- Requirement／Done CriteriaへのTrace
- Test／検証結果
- Self Review結果
- 未実施検証と残Risk
- Open Question／Conflict／停止事項

## 完了条件

- TaskのDone CriteriaがTestまたは明示的検証へTraceできる。
- 関連docsと差分が同期している。
- 未承認Decisionを実装で確定していない。
- Self ReviewでBlocker／Major相当のFindingが残っていない。
- 独立Evaluatorへ渡せるEvidenceが揃っている。
