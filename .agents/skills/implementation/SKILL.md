---
name: implementation
description: 確定した設計・契約とRed Testを入力に、責務境界と依存方向を守ってProduction Codeを最小差分で実装する。
---

# Implementation

確定したRequirement、設計、契約、TestをCodeへ反映する。設計未確定事項を実装中に暗黙決定しない。

## 入力

- GitHub TaskのRequirement／Done Criteria
- `pre-investigation`の影響範囲
- 必要な`domain-design`／`api-design`／`database-change`の確定成果
- `testing`で作成したRed Testまたは既存の検証条件
- [Backend開発ルール](../../../docs/engineering/backend.md)
- [Frontend開発ルール](../../../docs/engineering/frontend.md)
- [コーディング規約](../../../docs/engineering/coding-standards.md)

## 実装原則

- Red Testを通す最小のProduction Codeから始める。
- Presentation、Application、Domain、Infrastructureの責務を混在させない。
- Domain Model、DTO、GraphQL Type、Persistence Modelを同一型として共有しない。
- Context間でEntity、Repository、Storageを直接参照しない。
- 実際のVariationやOwnership根拠がない抽象化、Interface、共通Packageを先行作成しない。
- 変更対象外の既存Moduleを配置ルールだけを理由に移動しない。
- Error、認可、競合、Retryを正常系の都合で省略しない。
- 新規・変更された公開TypeScript APIの日本語JSDocは[コーディング規約](../../../docs/engineering/coding-standards.md)に従う。
- 新しい本番依存関係、破壊的Migration、破壊的Schema変更は承認なしに追加しない。

## 設計変更を発見した場合

実装中にRequirementまたはAccepted Designでは決められない判断が必要になった場合、推測でCodeへ埋め込まない。

- Domain Rule／Aggregate等: `domain-design`へ戻す
- API契約: `api-design`へ戻す
- DB／Migration: `database-change`へ戻す
- ADR必須Decision: Owner Decisionまで依存実装を止める

## 文書同期

実装で確定済み設計の表現が変わる場合は、Repositoryの仕様、Schema、図、Migration Note、Runbook等を同じ差分で同期する。新しいDecisionを文書変更だけで採用済みにしない。

## 出力

- 変更したProduction Codeと関連文書
- 実装したRequirement／Done Criteria
- 依存方向・責務境界の説明
- `testing`で再検証すべきCase
- 実装中に発見したOpen Question／Conflict

## 完了条件

- 対象のRed TestをGreenにできる実装になっている。
- Scope外のRefactorや依存追加を混ぜていない。
- 未承認DecisionをCodeで既成事実化していない。
- 次の`testing`へ検証対象を引き継げる。
