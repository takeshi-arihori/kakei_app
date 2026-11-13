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

#278の採用設計（#282で証跡Port、`recoveryPointId`、P1〜P3、`evidenceDigest`への束縛を実装。受理版は6のままで、コード破棄と受理版の拡張は未実装）: 上の手順2／3／6／7の全Context整合は、[ADR #278](../adr/restore-consistency-evidence-and-recipient-code-participation.md)（2026-11-12 Accepted）の契約で実装する。全Context共通の`recoveryPointId`、証跡Port（P1は削除再適用の前、P2はrecovery appendの前、P3は`activate`の前）、`evidenceDigest`への束縛、Manifestの受理版`{6, 11}`と構成確認、Restoreのコードticket（`dueAt`はrunの最初のfence閉鎖UTCで固定）、Providerが知らないコード行での停止、コード表の0-rowを含む。GM側のRestore検証は、Epic #202ではなくProduction Gate側の別の設計Taskとする。実装は#245の後続Taskで、合成の証跡で検証する。上の手順と受入Evidenceは緩和しない。

## 受入Evidenceと停止条件

| 対象 | 必要なEvidence |
| --- | --- |
| B4内部実装 | 2接続の清掃/消費/再発行、全世代破棄失敗、Actor無効化、期限等値、commit応答喪失の実PG検証 |
| scope inventory/鍵Provider | Record MAC全世代とburn/廃棄世代、ticket再開、closure真正性、DB外保持とIAM |
| 外部fence/epoch | 所有run/revision CAS、Writer drain、DB巻戻しで開通しないこと、旧epoch拒否 |
| Backup/GM整合 | 物理Backup/Manifest真正性、35日window、全Contextの同復旧点、認証/GM LedgerとWitness、operation/Invitation整合 |
| 公開経路 | CSRF/Origin/Rate、secret非保存/no-store、旧code拒否、新発行・Invitation作成・本人受諾の実HTTP/Browser |
| 監視 | overdue/pending/破損/epoch不一致の実配信と封鎖、秘密/直接IDの非収集 |

コード用の除去期限は`recipientCodeRetentionWindow`が計算し、`dueAt`を`expiresAt`・`terminalAt`・Actor側の時点の最早値、`deadline`をその24時間後とする。Actor側の時点は清掃がdisabledAt、Actor削除がpreparedAtである。下記の清掃入口（Actor側の時点はdisabledAt）と[Actor削除の別入口](#260-actor削除へのコード参加)（Actor側の時点はpreparedAt）が使う。key-stateの停止契約は[認証Runbook](authentication-retention-restore.md#招待コード拡張の採用設計未実装)に記載する。

本Taskは採用済みの運用設計の文書化であり、上表を実行済みとは扱わない。B4の合成Provider成功も本番Capabilityの証拠ではない。既知の期限未達、外部票不足、MAC/鍵不整合、未知Schema、旧Writer共存、片側復旧のいずれかがあれば成功/開通を停止する。

## #259 コード清掃の小Batchと封鎖

[内部入口](../../apps/api/src/shared/application/authentication/recipient-code-cleanup-service.ts)が上記「清掃」の1〜5を実装する。`run(limit)`は小Batch、`cleanOne`は同じ経路の1件入口で、#258の最小入口を拡張した。実PGと合成Providerで検証した。通常main/Dev/Production、Scheduler、公開Routeへは接続していない。

| 手順 | 実装の内容 |
| --- | --- |
| 候補 | 行の候補をLockせずに読んでから、Providerの固定snapshotを全Page読む。行は`allocate`の後にしか現れないので、この順なら未知行を誤検出しない。未完了ticket・行の候補・期限到達またはdisabled Actorの孤立scopeを、最早の期限から`limit`件まで処理する |
| 停止 | 列挙の完全性を保証できない、Providerが知らない期限到達行、行とProviderの束縛Actorの不一致、未完了ticketが列挙にない、ticketと列挙の全世代版の不一致では、何も進めず`unavailable`とする。ただし停止の前に、未完了ticketと行の候補（Lockしない未検証値。封鎖する方向にだけ使う）の`deadline`到達を確認して封鎖する |
| 起算 | `dueAt`はProviderの`expiresAt`、MAC検証済みの`terminalAt`、Actor Lock下でMAC検証した`disabledAt`の最早値。検証できない値では起算しない |
| Lock | key-state共有Lock→Actor `FOR UPDATE`→コード`SKIP LOCKED`。Lock中の行は待たずに`skipped`とし、完了を数えない。除去はLock後のClockで`dueAt`を再検証し、期限前なら削除しない |
| 順序 | ticket登録→行除去と`purge` Audit（同じcommit）→全世代closure→コード表の0-row→ticket完了。DB Lockの保持中に保守Portを呼ばない |
| 封鎖 | ticketや候補の`deadline`到達、Record MACまたはActor MACの確定した不一致では`key_state`を`quarantined`にし、固定Code（`OVERDUE`／`QUARANTINED`）を通知する。封鎖を確認できなければ成功も封鎖済みも返さない。封鎖はRestoreだけが解く |
| 鍵障害 | MAC鍵を取得できず照合できない場合は封鎖せず`UNAVAILABLE`を通知し、Providerが保持する期限で除去する。障害が期限後まで続くと`terminalAt`で起算できず、`deadline`はコードの有効期限（最大10分）分遅れる |
| 再開 | 中断は同じticketとoperationで再開し、二重ticket・二重closureを作らない。完了済みticketのscopeはProviderの`scopes`で解決するので、列挙が完了済みscopeを残すかに依存しない |
| 結果 | 件数を返すのは全対象を確認できた`complete`だけ。行の候補が`limit`件を超えた場合や未完了ticketが上限まで返った場合は残件として`pending`にする。`pending`は残件またはskip、`quarantined`は封鎖、`unavailable`は障害で、どれも件数を返さない。監視へは固定Codeと、期限到達のまま残した最早の対象の窓だけを渡す |

結果と通知はcodeIdや原因を含まない。`purge` AuditはActor仮名だけを持ち、コード仮名を持たない（Migrationなし）。行のない孤立scopeの除去ではAuditを書かない。Actor削除は下記の#260が扱う。合成Providerの成功を実IAM・破棄運用・Scheduler・通知配信の証拠にしない。

## #260 Actor削除へのコード参加

[内部入口](../../apps/api/src/shared/application/authentication/recipient-code-actor-deletion.ts)が[ADR](../adr/recipient-code-maintenance-key-inventory.md)のD2の別ticket方式を実装する。Ledger/Witnessの形式は変えず、削除operationへ束縛したコード専用ticketの全世代closureと0-rowを削除Completeの前提に加える。実PGと合成Providerで検証した。通常main/Dev/Production、Scheduler、公開Routeへは接続しない。

| 手順 | 実装の内容 |
| --- | --- |
| 順序 | 既存のticket→外部Preparedの後に、`allocate`封鎖→固定snapshot→コードticket登録→Actor/Session/Identityの無効化・除去→既存の鍵破棄→各コードの行除去と`purge` Audit→全世代closure→コード表の0-row→再snapshotの照合→外部Complete |
| 起算 | `dueAt`はProviderの`expiresAt`、MAC検証済みの`terminalAt`、`preparedAt`の最早値。Actorの`disabledAt`は使わない |
| 再開 | 同じoperationで封鎖（冪等）と列挙を再実行して不足分だけを登録する。二重ticketや、既に閉じた世代の再作成はしない |
| Complete前提 | `byOperation`の全ticketが完了していて、その全closureを今回の実行で検証済みで、再snapshotの全scopeが同じ全世代版のticketと一致し、Actorのコード行が0件であること。Providerの知らない行が残れば進まない |
| 採用 | 別operationの未完了ticketは採用し、採用をdurableに記録して窓を前倒しする。延長しない。closureは常に所有operationへ束縛し、完了済みticketは充足済みとして、所有operationのclosureと全世代を再検証する |
| 清掃との競合 | 清掃は未完了ticketを、所有者に関係なく所有operationのまま再開する（Proposal 2b）。清掃は独自の永続operationを持たないので採用を記録しない。清掃が削除所有のticketを完了した場合も、削除の再開が閉じた世代と0-rowを再検証する |
| 封鎖 | 削除または未完了コードticketの`deadline`到達、Record MACの確定した不一致では`key_state`を`quarantined`にする。完了済みticketの窓は未達の根拠にしない。除去とCompleteは続けるが、結果は`quarantined`で`OK`を通知しない。封鎖中の再開も同じで、再開で不一致を再観測できなくても成功と報告しない。コード1件の遅延でも認証全体が止まり、解除はRestoreだけが持つ |
| 停止 | 列挙の不完全、版不一致、Lock中の行、Provider/SQL/Audit障害、commit応答喪失、別Actorのticketでは外部Completeをappendせず`unavailable`とする |
| 構成の確認 | コード用途があるのにコード参加なしの構成、またはコード用途がないのにコード参加ありの構成はPrepared前に止まる。Prepared済みの再開で食い違った場合はCompleteしない |

GM Invitation・過去Actor参照・成功結果・proof鍵は対象外で、認証からGM Tableや他Contextの鍵を参照しない。Restore（#245）はコード専用Portで検証する。合成Providerの成功を実Providerの線形化・耐久性・IAMの証拠にしない。

## #240 管理Storeから保守へ引き継ぐInventory

[Migration9](../../apps/api/migrations/authentication/README.md#version-9-コード管理監査240)のコードAudit仮名は共有認証Auditの90日保持へ含め、独立コード監査鍵世代の参照/Backup windowを退役条件へ含める。lookup/状態MACと共有せず、直接codeIdや原コードを監査から復元しない。旧保守/Restore Readerのコード用途拒否は維持し、実際の清掃・復旧対応が完了する前に公開接続しない。

Record鍵の明示割当はDB rollbackで取り消せない。保存前/COMMIT結果不明/再MAC途中で孤立したcodeId/世代も、Providerの全世代inventoryへ期限を保持する。新Recordの再利用は拒否し、旧Recordの同一Descriptor既存鍵確認だけで再生成を避ける。孤立Scopeも期限/終端/Actor無効化の最早時点+24h以内に全世代closureへ含め、DB行が0件であることだけを鍵不存在/清掃完了の根拠にしない。#244/#245のdurable ticket/closure照合と具体Providerの訓練Evidenceは未実装/未実証であり、本番Gateを維持する。


## GM保存参加の実装Trace（#242）

[GM Adapter](../../apps/api/src/group-management/infrastructure/postgres/README.md)はproof current世代をGM-owned singletonへ置き、保存proof世代/値と内部bindingは既存Envelope内だけに保持する。保持結果の検証付き参照検査が0件でも鍵破棄の許可にはならず、関連Backup35日window closureが別途必須。破損/鍵喪失を未参照と扱わない。コード清掃/Actor削除へGM proof鍵を巻き込まず、鍵破棄能力をAdapterへ公開しない。

新GM Auditは独立GM/Group用途の仮名とrequest fingerprintだけを保存し、Group削除でcascadeしない。90日保持と関連Audit鍵/Backup35日windowを維持する。成功Auditの同Scope保存を実PGで確認したが、90日清掃/拒否Audit接続、具体Providerの保持/破棄/Backup、全Context Restoreと本番監視は既存Gateのまま。合成認証owner/コードWriterの成功を#243の実消費・両Context業務atomicityへ読み替えない。


## 内部共通commitからの診断・引継ぎ（#243）

[内部Factory](../../apps/api/src/recipient-invitation-runtime.ts)は実Session/コード消費/GM/両Auditを同じTransactionへ参加させる。`recipient-code-consume`の最小認証Auditは[Migration11](../../apps/api/migrations/authentication/README.md#version-11-コード消費監査243)で追加し、caller/コード用途仮名だけを90日保持する。Group削除やコード清掃へAuditをcascadeせず、GM Auditの独立用途を維持する。

- commit確認済み: 固定された最小本文だけを返す。元コード/宛先/秘密値を再serializationしない。
- commit前の障害: 全rollbackを試みる。確実rollback後もcreate/消費を再実行せず、caller-onlyで同operationを一度照合する。
- COMMIT送信後の切断/応答喪失: 結果不明として接続破棄。新Transactionの同operation照合で保存成功が確認できれば同じ本文を返す。miss/照会障害/回復時のSession失効は元のunavailableのままとし、失敗確定/再発行/取消補償/別operation作成へ変換しない。
- timeout/cancel/Scope不正: 受付を閉じ、開始済みSQLを収束または接続破棄でabortする。遅延Provider完了からSQLを追加しない。固定Alertだけを通知する。

コード終端の新MAC世代確保やGroupのNonce割当は外部Providerの副作用であり、DB rollbackで取り消したと扱わない。孤立Record鍵も#244/#245の全世代inventory/期限/closure対象へ含める。実PG・合成Providerでの内部atomicity検証から、24h清掃、鍵耐久性/破棄、35日物理Backup、全Context Restore、公開/本番運用の成功を推論しない。
