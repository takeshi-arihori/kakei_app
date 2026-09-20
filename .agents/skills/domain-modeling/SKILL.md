---
name: domain-modeling
description: 家計アプリの業務要求からドメインモデルを整理・レビューする。DBやUIからの型設計には使わない。
---

# Domain Modeling

対象Problem、Actor、Use Caseを起点に、具体例とモデルを往復して業務理解を検証する。依頼された範囲のモデル、根拠、未決事項、次に必要な判断までを成果とする。

## 根拠と境界

- 家計アプリのモデルを扱うときは[現行モデル](../../../docs/product/current-model.md)と[設計Gate](../../../docs/product/design-gates.md)の対象箇所を確認する。GitHubの取得先や固定Commitは[正本入口](../../../docs/governance/README.md)で確認する。Notionは読み書きしない。
- Rule、Term、Boundaryに根拠とKnowledge State（`Confirmed`、`Proposed`、`Assumption`、`Open Question`、`Conflict`）を付ける。提案や仮定を暗黙にConfirmedへ昇格させない。
- DB、Prisma、GraphQL、UI、Frameworkは業務Ruleの根拠にしない。既存実装は現行動作の証拠としてモデルとの対応・乖離を記録する。このSkillからCode変更へ自動進行しない。
- AggregateはInvariant、変更単位、同時更新、Lifecycle、整合性要求を確認してから候補を検討する。技術都合や親子関係だけで確定しない。
- 正常例に加え、対象Ruleを反証できる境界・失敗・競合等の具体例を使う。同じ語がContextで異なる意味を持つ場合は分ける。

## 作業に応じて読む

全資料の事前読込は不要。今回の判断に必要な資料だけを読む。

| 作業 | 参照 |
| --- | --- |
| 新しいモデル全体の整理 | [進め方と成果の観点](references/modeling-workflow.md)、[出力形式](references/output-contract.md) |
| 抽象化・モデルの妥当性・実装との乖離のレビュー | [モデリング原則](references/modeling-principles.md) |
| System Context／Use Case／Object／Domainの各視点を整理 | [SUDOの観点](references/sudo-modeling.md) |
| 業務知識の不足を質問で解消 | [Interview Guide](references/interview-guide.md) |
| Concept・Rule・Invariant・境界の検証 | [Domain Model Rules](references/domain-model-rules.md) |
| 個別Use Case／CommandをPRE・POST・INV・FAILとTestへ構造化 | [Specification Contract](../specification-contract/SKILL.md) |
| 正式Mermaid図の作成・更新、明示されたdraw.io入力の参照 | 作業前に[Diagram Governance](references/diagram-governance.md) |

局所レビューは対象の結論、根拠、具体例、未決事項に絞る。全体モデルの11項目を毎回再作成しない。

## 判断待ちと完了

根拠不足、正本間Conflict、重要語の意味不明、Invariant未確定、ScopeまたはAccepted ADRの変更がある場合は、その判断の確定と依存する実装・正本反映を止める。影響と必要な判断を示し、依存しない整理・反例の検討・提案は続ける。

図の意味を左右するConflict／Open Questionや未承認Proposedは正式Mermaidへ反映しない。図は文章のAccepted Decisionを根拠とし、既に承認された内容を再承認待ちにしない。draw.ioはOwnerが対象を明示した場合だけ読み取り専用とし、作成・変更・削除・整形・自動同期を行わない。

成果には確認できた事項と提案・未決事項を区別し、根拠と次の判断を添える。設計を確定できない部分があっても、完了した分析を報告する。
