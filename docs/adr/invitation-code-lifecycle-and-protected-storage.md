# 招待コードのLifecycle・保護保存・原子的消費

- Status: **Proposed**。Owner承認は未取得。コード/保存の実装Readyではない。
- Proposed Date: 2026-10-27（Asia/Tokyo）
- Decision Owner: Project Owner
- Decision / Design Task: [#233](https://github.com/takeshi-arihori/kakei_app/issues/233)
- Epic: [#202](https://github.com/takeshi-arihori/kakei_app/issues/202)
- Decision Check: 方針変更あり
- Supplements / proposed partial amendments: [登録済み宛先への招待](google-login-and-registered-recipient-invitation.md)の未決詳細を補完。[A2](authentication-protected-storage.md)の認証技術Record/Lock/清掃/Restore対象、[Group operation契約](group-operation-locator-and-group-id-contract.md)の新Command fingerprint検証を拡張する提案。既存ADR本文/Statusは変更しない。
- 詳細: [設計・操作契約・検証表](../security/invitation-code-lifecycle.md)、[運用案](../operations/invitation-code-retention-restore.md)

## Problem / Context

登録済みの宛先本人がコードを共有し、現在OwnerがPending Invitationを作る経路はADR #203で採用済みだが、コード自体の期限/失効/保存/競合は未決である。Invitationの7日期限からコードTTLを導けない。

最新develop `3b2f148b2c5483db825d5dab1cab8090370d8ee7`を確認した。既存Group Commandはtrusted targetSubjectを直接受け、Group Repositoryは自分でBEGINする。認証のwithSessionは既にcaller Actor/Sessionをlockするため、その後に宛先Actorを追加lockすると既存Actor昇順に反し得る。両方を既存のまま順番に呼ぶ実装では原子的消費を満たさない。

## Decision proposal A

以下はすべてOwnerへ提示する**案**であり、Confirmedな実装Ruleではない。

1. コードは32-byte CSPRNG秘密値のcanonical Base64url（paddingなし43文字）とし、有効期限は発行判断点から**10分**、延長なし。期限等値は無効。短い数字PINやURLリンクにしない。
2. 本人ActorあたりIssued recordは一つ。本人の明示的な発行/再発行は旧Issuedを失効させ、新秘密値を一度だけ返す。再表示/秘密値の成功再送復元は提供しない。取消は当該本人だけ。Session logout/idle満了だけではコードを失効させず、Actor無効化・Restoreでは無効化する。
3. 共有技術境界が認証Schema内のrecipient-code Recordを所有する。コードはInvitationでも新しい業務Aggregateでもない。Group Managementは引き続きInvitation/Participant/業務履歴/Group operationを所有し、認証Tableを直接読まない。
4. 原コードは一切永続化せず用途別HMAC検索値だけ保存する。明示した最小MetadataはRecord別MACで全体を認証する。Groupの成功再送に必要な入力証明は別のGM専用HMACをGroup保護Envelope内へ保存し、コード行やTTLに依存せず検証する。既存Group/認証の鍵・形式を流用しない。
5. コードを消費してInvitationを作る新Commandでは、caller/宛先Actorを先にUUID昇順でlockできる専用認証leaseを用意する。GMはquery限定の同一Scopeへenlistし、コード消費・Invitation/履歴・Group版/Policy版・共通operation locator/結果・必要Audit・Session更新・確定Responseを一つのPostgreSQL Transactionで確定する。
6. コード消費はInvitation作成時の一度だけ。別Group/Ownerが同時に使っても成功は最大一件。新Participantを作るのは従来どおり宛先本人のAcceptInvitationであり、7日期限・枠予約なし・Owner譲渡後Pending継続を変更しない。
7. コード無効化/期限から**24時間以内**にコード行と全Record MAC鍵世代を清掃する。認証Auditは既存の90日、GM成功再送結果は既存Groupの業務保持/削除に従う。最大35日のBackup復旧では全コードを破棄し、新epochで発行し直す。既存Invitationの取消や重複作成で復旧を代替しない。

## Alternatives

| 選択肢 | 利点 | 制約/採否案 |
| --- | --- | --- |
| A: 10分・一つ・再発行で置換・不可逆検索値 | 共有時間を絞り、古いコードを本人が止められる。漏出/再送の保存を最小化 | コピー共有が必要。紛失/応答喪失は再発行。本案 |
| 24時間/複数有効コード | 非同期の共有が容易 | 漏出/悪用可能期間と管理対象を増やすため初期案では不採用 |
| 6桁PIN | 手入力が容易 | 推測耐性をRate limitへ大きく依存し、短命でも全体攻撃面を増やすため不採用 |
| 原コードの暗号化保存/再表示 | 端末移動や応答喪失から復元できる | 復号権限と秘密値の再送保存が増えるため不採用 |
| コードをGroupに事前束縛 | 横取りを狭められる | 宛先がOwnerのGroupを事前指定する新Product経路を必要とし、ADR #203の現経路とは別Decision |
| コードを先に消費、Invitationを別commit | 既存Storeをそのまま使える | 片側だけ成功するため不採用。補償や非同期配送では一回限りの共通確定を代替しない |
| logoutで本人の全コードを失効 | 端末離脱と失効を連動できる | 別端末のlogoutで共有済みコードが止まる。本人取消/Actor無効化を失効手段とする本案とは異なる |

10分/一つ/24時間という値はProjectのUX・保護方針の提案であり、OWASP等が指定した値ではない。

## Consequences / Residual risk

コードを知る第三者が自分のGroupのOwnerとして先に使う妨害は、コード所持だけを宛先指定に使う経路の残Riskである。参加権限や本人認証にはならず、宛先が実際のGroupを見て受諾する。登録者検索/プロフィール照会APIを新設しない。共有相手の確認、コード漏出時の本人取消と再発行、後続画面でのGroup確認を必要とする。

DB内のランダムActor参照・コード件数/時刻・状態、同一コードの検索一致は見える。HMAC/MAC/AEADはDB全体rollbackやAPIとProviderの同時侵害を防がない。外部epoch/fence、Ledger/Witness、鍵Providerの独立運用は既存Production Gateに残る。

## Implementation / Approval gate

本TaskはD2のProposal文書だけ。調査と案の作成を許可した「続きを実装してください」を、未提示だった10分や保存所有等へのOwner承認と扱わない。#233はBacklog / Blocked Yesを維持し、Ownerの明示Decision、必要なReview、文書統合と個別Ready評価前にコード/SQL/公開APIを追加しない。

独立ReviewはProposed文書の完全性/安全性を評価し、採用そのものを承認しない。Ownerへ本案を提示し、明示判断を#233に記録してからADR Status、仕様、Epic/Taskを同期する。PR Ready化/Merge、本番有効化、後続Task一括Readyは別。

[後続候補の依存表](../security/invitation-code-lifecycle.md#後続deliverableとready)は候補であり、正式Issueは設計確定後のPlanning評価で作る。未Merge Codeに依存せずStackなし。

## Rollback / Review trigger / Owner decision

現時点はData変更なし。Proposalが不採用なら文書案を取り下げ、Accepted ADRを維持する。将来の適用済みDataは追加Migration/Forward-fixで扱い、古い秘密値・epoch・破棄鍵を復活させない。

TTL、発行数、logout連動、表示/再送、Data Owner、Record保護、Lock/共通commit、入力証明鍵の保持、Actor削除、Restore、公開経路/Rate limitの変更は再Review対象。Owner Decision: **未取得**（2026-10-27）。
