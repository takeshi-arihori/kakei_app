---
name: api-design
description: 確認済みUse Caseを、RepositoryのAPI docsに従って外部公開契約、Input／Output、Error、認証認可境界、互換性へ写像する。
---

# API Design

確認済みのApplication／Domain契約を外部公開境界へ写像する。Skill自身はAPI Protocol、Schema方式、Framework、生成Toolを固定しない。

## 最初に読む

- GitHub TaskのRequirement／Done Criteria
- `pre-investigation`および必要な設計Skillの成果
- [Engineering Loop](../../../docs/engineering/engineering-loop.md)
- [Skillガバナンス](../../../docs/engineering/skill-governance.md)
- [開発ガイド](../../../docs/engineering/README.md)
- [API設計の正本入口](../../../docs/api/README.md)
- Security／Backend／Testing等、変更範囲に必要なdocs
- 関連Accepted ADR

採用中のProtocol、Schema、Source of Truth、命名、Pagination、Error表現、生成方式等は上記docsから取得する。

## 実施

1. 公開するUse CaseとActorをRequirementへTraceする。
2. Repository docsの現行方式に従い、公開Operationと責務を定義する。
3. Input、Output、Failure／Error、Validation境界を整理する。
4. AuthenticationとApplication Authorizationの境界を確認する。
5. Resource access、情報非開示、再試行、冪等性、競合等、対象Riskに必要な公開契約を整理する。
6. Paging、Filter、Sort、件数・計算量等の非機能条件が必要なら関連docsに従って定義する。
7. 互換性を分類し、必要なMigration／Deprecation／RollbackまたはForward-fixを整理する。
8. 必要なTest、生成物、公開文書の更新を`testing`へ渡す。

公開境界の都合だけでDomain RuleやPersistence構造を新規確定しない。

## 出力

- 対象Use Caseと公開契約
- Input／Output／Failure
- 認証・認可境界
- 互換性分類と移行方針
- 非機能・Security上の契約
- Test／検証項目
- 更新するAPI docs／Schema等の正本
- Open Question／Conflict／ADR要否

## 停止条件

現行API方式、契約の正本、認証認可方式、Context間公開契約等についてAccepted Decisionの変更が必要なら、RepositoryのDecision Gateに従って依存作業を停止する。

## 完了条件

- 公開契約がRequirementとApplication Use CaseへTraceできる。
- 具体方式がRepository docsの現行Decisionと一致する。
- 互換性・移行・検証方法が明示されている。
- Skill本文の技術仮定ではなくdocsを根拠に設計している。
