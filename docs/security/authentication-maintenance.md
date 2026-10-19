# 認証Dataの清掃・削除・復旧境界

[Task #217](https://github.com/takeshi-arihori/kakei_app/issues/217)の実装契約。[Accepted A2](authentication-protected-storage.md) §8を具体化する。Applicationは技術的なPolicy／Coordinator／Port、Infrastructureは認証専用の証跡検証とPostgreSQLのLock／CASを所有する。HTTP退会受付、未完了業務の判断、Group過去参照の削除、具体Cloud Provider、本番Compositionは含めない。

## 保持と清掃

非負safe整数のUTC millisecondsを注入Clockから取得する。AttemptはterminalならterminalAt、未使用ならexpiresAt。SessionはrevokedのterminalAtとidle／absolute期限の最小値。AuditはoccurredAt＋90日をdueAtとし、dueAt等値で清掃可能、dueAt＋24時間をdeadlineとする。等値からoverdueを通知する保守的判定を採る。加算overflowや状態不整合は拒否する。

小BatchのSQL候補はhintである。key_state FOR SHARE → Actor UUID順FOR SHARE SKIP LOCKED → Session UUID順FOR UPDATE SKIP LOCKED → Attempt UUID順FOR UPDATE SKIP LOCKED → Auditの順に取得し、FK／epoch／Metadata／MAC／AEADを検証後にClockを読み直す。最新版の期限判定、id＋versionのDELETE CAS、purge Auditを共通commitする。Lockが取れない行を完了件数へ含めない。SessionのActor候補はUUID順の小Pageとし、全候補がLock中ならsavepointまで戻して当該PageのLockを解放し次Pageへ進む。Session自体はRow Lock後のLIMITで小Batchを取得し、先頭のLock行で後続を飢餓させない。別の非SKIP検索から最古due／overdueを取得し、期限超過は固定監視Codeとquarantineへ接続する。

削除前にProviderへ全世代を追跡するdurable ticketをprepareする。prepare自体は鍵を破棄・封鎖しない。DB 0-row → 全世代destroy／証跡verify → 新Transactionの0-rowが揃って完了。commit応答喪失やDB行削除後の鍵障害では外部pending ticketから再開する。既知overdueは未完了票の列挙／scope照会／鍵破棄の前に封鎖し、途中障害で期限を跨いだ場合もcatchで再判定して封鎖を試みる。Identityを含む削除ticketを通常清掃へ流さない。通常認証が拒否するquarantined状態でも保守清掃を再開でき、restoring状態の清掃は復旧専用操作へ限定する。

## Actor削除の不可逆意思

1. Server生成operation ID、専用deleted-actor仮名／世代、UTC、opaque Provider管理参照を外部Preparedへconditional appendし、独立Checkpoint／Witness一致を検証する。
2. Actor FOR UPDATEで先行leaseをdrainする。Actor MAC、全SessionのAEADを検証し、Actor disabled、全Session revokedへの再Seal、同operation Prepared Intent、disable Auditを一つのcommitにする。
3. 無効化後に全Session scopeをdurable ticketへ追加し、Identity／Alias／Sessionを版付きCASで除去する。Actorはdisabled終端として保持する。
4. 現行・旧・burn済み未参照を含む全KeyVersionのDestroyedとclosure、DB 0-rowを照合する。
5. 外部Complete版2をconditional appendしWitness一致を確認し、DB IntentをcompleteへCASする。

Preparedは取消・自然失効しない。未完了Preparedの24時間未達が判明したら、ticket照会やDB disableの成否より先に認証受付を封鎖する。期限内に外部Completeへ達した操作の後日再照合は、新しい期限未達と数えず、現在のDestroyed／0-rowは再検証する。外部PreparedがありDBにIntentがない場合も同operationから再構成する。DBだけのIntent、同Actorに複数operation、仮名／参照／版不一致はquarantineする。Prepared前のticketだけが残る結果不明も自動受諾・取消せず隔離する。beginは新operationの発行前、resumeはDB無効化前に同Actor／operationの未完了票を照合する。孤児票があれば元operationを保持し、別の受付を作らない。再登録は新Actorとなり、旧Group権限を引き継がない。内部保守能力の入口であり、利用者の退会認可を代行しない。

LedgerにPrepared／Completeがあり、正常なProvider応答で対応ticketの欠落やoperation／参照／期限／Identity scope・仮名の不一致が確認された場合は、期限内でも隔離する。DB無効化後のticket不整合や行削除後のIdentity scope欠落でも鍵破棄へ進まない。封鎖確認後は固定Codeで通知し、監視失敗で封鎖済みの状態を取り消さない。封鎖自体の失敗・応答不明はunavailableとし、隔離完了を主張しない。Providerの読取例外は欠落の証明とせず、同operationで再照合する。

## 認証Ledger形式と検証

GroupのLedgerと別Namespace／独立鍵を使う。各entryはsequence、previousHash、record、macKeyVersion、32-byte MAC、SHA256 hash。専用鍵用途は`auth-deletion-ledger/v1`、現行鍵だけがappend可能、retired read-only鍵は既存chain検証だけに使用できる。必要な旧鍵を失った場合は隔離する。

Canonical bodyは既存認証TLV（1-byte ordinal、1-byte presence、4-byte big-endian length、UTF-8またはbinary）を使い、順序は次の通り。

- 共通: `kakei_app`、`auth-deletion-ledger/v1`、`authentication/v1`、sequence十進文字列、previousHash小文字hex、kind、operation UUIDv4、MAC keyVersion。
- actor-deletion末尾: actorDigestKeyVersion、32-byte actorDigest、preparedAt十進文字列、record version十進文字列、prepared／complete、opaque targetReference。
- recovery末尾: epoch UUIDv4、completedAt十進文字列、32-byte evidenceDigest。

MACは専用256-bit鍵のHMAC-SHA256、entry hashはTLV(`auth-checkpoint/v1`, body, MAC)のSHA256。全Fieldをstrict own data propertyでCopyし、未知Field・Getter・型・不正時刻／UUID／長さを拒否する。専用MACの自所有material Copyは使用後に消去する。既存Envelope／AADの形式は変更しない。

fresh challengeに束縛されたCheckpoint／Witnessのattestationを別Verifierで検証し、両latest headの完全一致を要求する。最大128 entryのpageを連続sequence／previousHashで全件検証し、Prepared版1→同一bindingのComplete版2以外を拒否する。Manifestのcheckpointはsequence下限だけでなくchain内hash所属を確認する。全page読了後に再度fresh latestを検証し、途中の変更も拒否する。appendはexpected headへのCAS後に自entry hashの所属とlatestを再検証する。検証済みhead／intentは所有WeakMapのopaque handleで、偽造・別registryを拒否する。

## Restoreと開通条件

OperatorがTrafficと他の認証／保守Writerを外部fenceで閉じてからBackupを戻す。復旧DBのactive flagを開通根拠にしない。Manifestは信頼済みBackup catalogから渡すMetadata契約であり、本Adapterは物理Backupの署名・真正性を検証するProviderではない。未来・不正・35日超を拒否し、35日等値は対象とする。

外部所有fence確認 → Manifestの全Metadata検査／key_state排他Lock／Writer drain／restoring CAS → 最新Ledger検証・適用と未完了削除再開 → 全Attempt／Sessionのdurable ticket登録・全行／全DEK除去 → 外部revision CASで新epoch公開・再確認 → 保持Identityの旧鍵Seal停止／独立新DEK・Nonce世代で再Seal → 全required Alias再構築、重複・破損・Actor MAC検査 → 最新head再検証 → recovery checkpoint条件付きappend／Witness一致 → DB active CAS → 同run／epoch／revision／headへの外部Traffic open CASの順とする。

削除再適用は真正なLedger binding下で行い、既にDestroyedのIdentityを復号必須にしない。保持Identityは復号・本人一意性を必須とする。未完了Actor票はProvider所有の固定snapshot cursorで全Pageを先行照合し、1,000件の先頭だけで打ち切らない。集合／版／inventoryの途中変更、別Provider cursor、重複operation、繰返cursor、空の中間Pageは拒否する。真の末尾だけnextCursor=nullとし、全件照合後に不可逆DB変更へ進む。全9用途の鍵Stateを検証し、公開されたLedger MAC書込世代とVerifierの現行世代も一致させる。新headが到着したら最大3回再適用し、収束しなければ隔離する。

移行completionは同じDB Adapter所有のfenceに結び付け、同TransactionのActor／Identity／Alias／鍵State／Intent／全Credentialの型付きTLV fingerprintを保持する。activateは所有completion、現在fingerprint、Credential 0-row、Prepared Intentなし、外部publicationの再検証を要求する。Auditは認証判断のfingerprintに含めない。復旧の各SQL操作は外部閉鎖をcommit前にも確認する。初回隔離はManifestのkey-state版と現DB版の完全一致を外部制御で確認し、固定Manifest／runへ進行版をDB外でdurable登録する。再試行の進行済み版はこの登録と公開epochへ照合し、単なる下限一致やrestoring flagだけで許可しない。中断・応答喪失で既発行epoch／Nonce／破棄を戻さず、同runのforward-fixで再検証する。openの応答喪失・開通後の監視失敗でも同runで外部を再閉鎖してverifyClosedし、DB封鎖と両方を確認した場合だけquarantinedを返す。どちらか未確認ならunavailableとする。

## Done CriteriaとEvidence

| 契約 | 検証 |
| --- | --- |
| C: UTC／24h／90d／35d、SKIPとCAS | retention-policy Unit、実PostgreSQL17の期限等値・活動／消費／Logout／Rotation両順序・oldest overdue |
| D: 原子無効化と不可逆削除 | 同commit／Audit rollback／全世代破棄、20 Crash Windowと旧Backup差戻し、管理票の欠落・不整合時の隔離と同operation再開、旧Cookie拒否、再登録新Actor |
| E: strict MAC／chain／最新証跡 | 独立golden vector、不正Namespace／Getter／fork／欠落／改竄／未知・退役MAC鍵／偽造handle、片側Witness障害 |
| R: 隔離と所有completion | 18 Restore Crash Window、35日±1ms、外部状態を戻さない再試行、偽造fence／completion欠落／DB変更拒否、重複Identity rollback |

`authentication-maintenance.integration.spec.ts`はPostgreSQL17、末尾_test、Schema不存在、共通advisory lockを要求し、Suite所有Schemaだけを作成・削除する。競合は異なるPIDとpg_blocking_pids、制御barrierで観測する。合成ProviderはDBとは別状態に保持するが、Process／disk耐久性や独立Failure domainの実証ではない。具体の未実装Capabilityと再試行手順は[運用Runbook](../operations/authentication-retention-restore.md)に従う。
