# 招待コードの清掃・削除・Restore運用設計

Knowledge State: **Accepted（運用設計。実装・本番Capabilityの実証は別Gate）**。[ADR](../adr/invitation-code-lifecycle-and-protected-storage.md)と[設計契約R5](../security/invitation-code-lifecycle.md#r5-保持削除復旧公開)に対応する。[認証の既存Runbook](authentication-retention-restore.md)と[GMの保護・保持ADR](../adr/snapshot-revision-security-and-retention.md)を緩和しない。

## 清掃

1. 正常epoch/鍵Stateの下で、最早のexpiresAt/terminalAt/Actor disabledAtをdueAtとし、Record MACを検証して小Batchを選ぶ。コード利用はBatchを待たず期限/状態を拒否する。
2. 発行/取消/消費と同じActor→Session（必要時）→コードのLock順を使う。候補を先にSKIP LOCKEDで固定してからActorを取りに戻らない。hint取得後Actorをlockし、その後コードをSKIP LOCKED/CAS再検証する。
3. dueAtから24時間以内にコード行と全Record MAC鍵世代を除去する。DB削除前に外部のdurable scope/ticketへ対象を登録し、DB削除、全世代破棄/closure、0-rowの順で確認する。原秘密値/鍵Materialは票/Logへ含めない。
4. commitや鍵破棄の応答喪失は同ticket/operationを再照合する。途中失敗で完了件数を増やさず、復元した行と同scopeの残鍵を再除去する。Audit/GM operation結果はコード清掃へ巻き込まない。
5. oldest due/deadline、pending破棄票、固定障害Codeを監視する。24時間未達、MAC不整合、鍵inventory/epoch異常は受付封鎖と通知を必要とし、単なるLock skipを期限遵守と扱わない。監視配信/封鎖実体が未確認なら成功を主張しない。

Scheduler頻度/Batch量/再試行間隔/Operator権限/通知配信の具体値は本番運用Taskで設計し、未設定のまま本番接続しない。通知へcode/Digest/proof/直接Actor ID/Group ID/Provider内部参照/自由文例外を含めない。

## Actor無効化・削除

Actor排他Lockのdisabledにより、全コードを利用不能にする。既存認証削除Prepared/Ledger/Witnessとscope inventoryへrecipient-codeの全Record MAC世代を追加し、DB行削除・鍵破棄・0-rowを同削除operationへ束縛する。コードごとのMAC鍵はDB Backupと別管理する。

Actorの過去業務参照、GM Invitation/成功operationは既存GMの保持Ruleに従い残す。認証SchemaからGM Tableを直接cascadeしない。Google再登録による新Actorは旧コード/過去Group権限を継承しない。退会受付と未完了支払/Owner責務の判断は既存未決Gateに残る。

## Backup Restore

認証だけの部分Restoreで、コード消費とGM Invitation/operationの共通commitを巻き戻して整合を保ったとは主張できない。

1. DBを戻す前にDB外のrun fenceでTraffic・認証/GM/保守Writer・別Restoreを閉じ、進行中leaseをdrainする。DB内active flagだけを信用しない。
2. 信頼済みcatalog/Manifestから35日以内の整合した全Context復旧点を選び、Schema/epoch/鍵State/Checkpointの真正性を確認する。片側Schemaだけ・未来/35日超・不明な復旧点は拒否する。
3. 認証とGMの独立Ledger/Witnessを最新headで検証し、削除Prepared/Complete、GMの削除/保持整合を再適用する。古いprefixやfork、不足Evidenceでは隔離を維持する。
4. 復旧した全recipient-code行を、状態/期限に関係なく破棄する。消費済み行をIssuedへ戻さず、旧コードを再Hashして救済しない。Record破損/MAC鍵破棄済みでも「検証できないから残す」としない。信頼済みscope inventoryに束縛して全MAC鍵世代/0-rowを確認する。これは既存全Attempt/Session破棄に追加する手順。
5. DB Backupと独立した外部制御へ新epochを所有run/revision CASで公開し、旧epoch Writerをfenceする。発行/検索/消費は現行epochに一致する場合だけ受け付ける。epoch/MAC鍵をBackupから戻さない。
6. GMの保持Invitation/operation/locator/鍵世代の整合を検査する。コード消費の成否を新しいInvitation作成/取消で補償しない。共通commit済み結果の保持/rollbackを既存Checkpointで証明できない場合は、本設計だけを根拠に開通せず本番復旧設計Taskへ戻す。
7. 新Checkpoint/Witness、削除/全コード破棄証拠、現在epoch/鍵/Writer fence、旧コードのHTTP拒否、新コード発行から本人受諾までを確認してから開通する。開通応答喪失/監視故障は同runで再閉鎖し、不明状態を成功扱いしない。

新epochだけで既存Invitation/operationの一貫性を証明したとは扱わない。API全体と外部Providerの同時侵害、全DB整合rollbackをMACで防げると主張しない。Restore訓練と実配置のEvidenceなしにProduction wiringを許可しない。

## 受入Evidenceと停止条件

| 対象 | 必要なEvidence |
| --- | --- |
| B4内部実装 | 2接続の清掃/消費/再発行、全世代破棄失敗、Actor無効化、期限等値、commit応答喪失の実PG検証 |
| scope inventory/鍵Provider | Record MAC全世代とburn/廃棄世代、ticket再開、closure真正性、DB外保持とIAM |
| 外部fence/epoch | 所有run/revision CAS、Writer drain、DB巻戻しで開通しないこと、旧epoch拒否 |
| Backup/GM整合 | 物理Backup/Manifest真正性、35日window、全Contextの同復旧点、認証/GM LedgerとWitness、operation/Invitation整合 |
| 公開経路 | CSRF/Origin/Rate、secret非保存/no-store、旧code拒否、新発行・Invitation作成・本人受諾の実HTTP/Browser |
| 監視 | overdue/pending/破損/epoch不一致の実配信と封鎖、秘密/直接IDの非収集 |

本Taskは採用済みの運用設計の文書化であり、上表を実行済みとは扱わない。B4の合成Provider成功も本番Capabilityの証拠ではない。既知の期限未達、外部票不足、MAC/鍵不整合、未知Schema、旧Writer共存、片側復旧のいずれかがあれば成功/開通を停止する。
