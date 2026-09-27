---
name: implementation
description: 確定したRequirement・Design・Contract・Red Testを入力に、Repository docsの実装Ruleを守ってProduction変更を最小差分で行う。
---

# Implementation

確定したRequirement、Design、Contract、TestをProduction変更へ反映する。Skill自身は特定のProgramming Language、Framework、Runtime、Library、Directory構成を固定しない。

## 最初に読む

- GitHub TaskのRequirement／Done Criteria
- `pre-investigation`の影響範囲
- 必要な設計Skillの確定成果
- `testing`のRed Testまたは先行検証条件
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [開発ガイド](../../../docs/engineering/README.md)
- 対象Layer／言語／Framework／Security／Coding等の関連docs

具体的なCoding Rule、Documentation Rule、Dependency Rule、Directory配置、Error表現、Tool Commandは関連docsを正本とする。

## 実施

1. 次にGreenへすべき最小Caseを確認する。
2. Accepted DesignとRepository docsが定める責務境界・依存方向を守り、最小のProduction変更を行う。
3. Scope外Refactor、将来予測だけの抽象化、未承認Dependency追加を混ぜない。
4. Error、Authorization、Concurrency、Retry等、対象Requirement／Riskに必要な失敗経路を省略しない。
5. 変更によりRepository docsの表現が変わる場合は同じ差分で同期する。
6. 実装中に新しいDesign Decisionが必要になった場合はCodeへ埋め込まず、原因に対応する設計へ戻す。

## 設計へ戻す条件

- Domain Rule／Invariant／責務境界が未確定
- 公開契約を新たに決める必要がある
- Persistence方式・Data Ownershipを新たに決める必要がある
- RepositoryのADR必須条件に該当する

依存しない実装は継続できるが、未承認Decisionに依存する部分は停止する。

## 出力

- Production変更と関連文書
- 実装したRequirement／Done Criteria
- 適用したRepository docs
- `testing`へ戻すCase
- 実装中に発見したOpen Question／Conflict

## 完了条件

- 対象Red Testまたは先行検証をGreenへ進められる実装になっている。
- Scope外変更を混ぜていない。
- 未承認DecisionをCodeで既成事実化していない。
- 具体技術のRuleをSkill本文ではなくdocsから適用している。
- `testing`へ検証対象を引き継げる。
