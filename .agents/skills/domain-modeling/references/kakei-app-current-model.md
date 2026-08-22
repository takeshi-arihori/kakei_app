# 家計アプリ 現行モデリング引き継ぎ

最終更新: 2026-08-19

このFileは、セッションを跨いでモデリングを再開するための探索入口である。要求・業務知識・設計判断の正本はNotion、最新判断は利用者の明示指示である。作業開始時にNotionを読み、差分があればこのFileも更新する。

## 参照するNotion

- [Requirement・Scope](https://app.notion.com/p/3a906467984f8180a7f3e4220eeaa47a)
- [業務内容・業務ルール](https://app.notion.com/p/3a906467984f8015b763fe95859ea6ec)
- [用語定義](https://app.notion.com/p/3a906467984f818b8a84d0b559cb6676)
- [ユーザージャーニー・ユースケース](https://app.notion.com/p/3a906467984f817a9a5ac19b4be025bd)
- [ドメイン設計](https://app.notion.com/p/3a906467984f80728058c839a403e6f0)
- [Accepted Product Decision: 家計履歴アーカイブへサービス方針を変更する](https://app.notion.com/p/3aa06467984f81169fdcc7d5e19c5b02)
- [未確定事項・Documentation Conflict](https://app.notion.com/p/3a906467984f814ba736c627901ead38)

## Confirmed Decisions

### Householdと金額

- 共有家計のMemberはTさんとYさんの2人だけとする。
- 精算残高は `実支払額 - 本来負担額`。
- 残高が負のMemberがPayer、正のMemberがPayee。2人の合計は常に0円。
- 金額はJPYの1円単位整数。アプリ内では送金せず、外部で支払う。

### Settlement CaseとRequest Snapshot

- Archive境界は日時ではなく、申請時に明示選択した取引集合である。
- 同一時刻の取引でも、Snapshotに含まれる取引とActiveのまま残る取引が存在できる。
- Settlement Case IDは却下・再申請を通して維持する追跡単位。
- Settlement Request Snapshotは、対象取引集合、各人の残高、精算方向、精算額を申請時点で固定した不変の版。
- 申請中のGroup Aへ取引を追加しない。Case開始後の新規取引はGroup Bへ追加する。
- 却下理由は必須。却下版Snapshotは変更・削除しない。
- 再申請は同じCaseに新版Snapshotを関連付ける。
- 業務用語のSettlement Request Snapshotと、Event Sourcingの技術的Snapshotを区別する。

### Requester・Payer・Payee

- RequesterはCaseを開始したMemberで、Payer／Payeeとは別のRole。
- RequesterはPayerにもPayeeにもなり得る。
- Payer開始: 外部支払 → 支払完了申告 → Payee受取確認 → Archive。
- Payee開始: 支払請求 → Payerが外部支払 → 支払完了申告 → Payee受取確認 → Archive。
- PayerのPayment ReportとPayeeのReceipt Confirmationが揃った時点でだけArchiveが成立する。
- Archiveは月別に閲覧可能で、編集不可。

## Diagram Convention

- 対象File: `docs/modering/kakei_app.drawio`
- 利用者は基本的に既存Fileへの上書きを希望している。
- Pageは1つだけにする。
- SUDOの4図を、上から `System Context`、`Use Case Model`、`Domain Model`、`Object Examples` の横長Sectionとして上下に区切る。
- System、Use Case、Domain、Objectを同じPageへ記載する。
- Use Case図を省略しない。
- Confirmedのみを確定表現で描き、未確定事項は本文または検討メモで管理する。

## Modeling Method

- [DDD×仕様駆動で回す高品質開発のプロセス設計（slide 24）](https://speakerdeck.com/littlehands/dddxshi-yang-qu-dong-dehui-sugao-pin-zhi-kai-fa-nopurosesushe-ji?slide=24) のsudoモデリングを参考にする。
- S: Actor、対象System、外部System、主要Interactionを確認する。
- U: Actorが達成したいGoalをUse Caseとして確認する。
- D: 概念、関係、多重度、Rule、Constraintを抽象化する。
- O: 具体値を持つ正常・境界・不正・競合例でDを反証する。
- DとOを往復し、具体例を作れない概念は理解不足としてOpen Questionへ戻す。
- Lifecycleや分岐が複雑な場合だけ、状態遷移図、業務フロー図、シーケンス図を補助的に使う。

## Open Questions

次回は一度に確定せず、具体例を置いて順番に深掘りする。

1. 申請取消を許すか。誰が、どの状態まで可能か。
2. Archive後の取消・再開・訂正を許すか。許す場合、元Archiveを不変のままどう関連付けるか。
3. 精算残高0円の取引群をArchiveする手続き。
4. 部分支払を許すか。複数回支払と受取確認をどう扱うか。
5. Snapshot作成後に元取引が訂正された場合の差額をGroup Bへどう表現するか。
6. 同時申請、同一取引の二重選択、支払申告と却下の競合をどう防ぐか。
7. 月別閲覧に使う月は、取引月・申請月・Archive成立月のどれか。
8. 審査上の「承認」と、Payeeの「受取確認」を別Actionとして維持するか。

## Known Conflict

- `docs/engineering/domain-design.md`には共有家計最大4人、日時境界など従来Ruleが残っている。
- Notionの2026-08-19更新節とRepository文書を実装前にAccepted ADR／Taskへ整合させる。
- Conflictを実装で吸収しない。
