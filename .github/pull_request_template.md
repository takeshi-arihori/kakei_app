## GitHub

- Task: <!-- 必須 -->
- Depends-On: <!-- 任意。依存PRがある場合は `#123` の形式で記載。複数ある場合は行を追加 -->
- 関連仕様／ADR: <!-- 影響がある場合は必須 -->

## 要件・完了条件

- <!-- このプルリクエストが満たす要件と受入条件を記載する -->

## 変更内容

-

## TDD・確認方法

- [ ] Red: 変更前に意図した理由で失敗するTestを確認した
- [ ] Green: 最小実装でTestを通した
- [ ] Refactor: TestをGreenに保って責務・命名・重複を改善した
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Integration／E2E（該当時）

実行結果・未実行理由:

## 変更規模

- 変更行数（生成物を除く）: <!-- 目安は約500行。数え方は docs/engineering/delivery-workflow.md のPRサイズ -->
- 超えた場合の理由: <!-- 超えていなければ削除 -->

## 独立Review

<!-- 要約だけを書く。生JSON、Cycleごとの全結果、再開手順の全文は載せない。項目は docs/engineering/implementation-review.md のEvidence -->

- Role／最終結果:
- 起動しなかったRoleと理由:
- 修正回数と修正したFinding:
- 実効read-onlyの確認:
- 未確認の点／残Risk:

## 文書への影響

- [ ] GitHub Requirement／Task
- [ ] ADR
- [ ] DDD／UML／Event Schema
- [ ] ER／Migration
- [ ] GraphQL Schema／Operation
- [ ] 画面遷移／UX・UI
- [ ] Security／Privacy／Audit
- [ ] Runbook／Monitoring
- [ ] Repo docs／AGENTS／skill
- [ ] 更新不要（理由を下へ記載）

更新内容または不要理由:

## 影響・Rollback

- 境界づけられたコンテキスト／集約:
- Migration／Data:
- GraphQL／Event Schema:
- セキュリティ／プライバシー:
- 運用／可観測性:
- 切り戻し／前進修正:
