# 認証PostgreSQL保存境界

[Task #216](https://github.com/takeshi-arihori/kakei_app/issues/216)と[Accepted A2](../../../../../../../docs/security/authentication-protected-storage.md)に従う認証Storeの5操作・同Transaction Audit・Callback lease。HTTP、業務Repositoryの本番接続、具体鍵Providerは含めない。#217の保守Adapterは下記の別能力として提供する。

## 責務と接続

`createPostgresAuthenticationStore({ pool, codec, digests, scopes })`へ実Poolと認証専用Portを注入する。`createAuthenticationTransactionScopes()`の所有能力はStoreにだけ渡し、参加Repositoryには`scopes.participants`だけを渡す。Applicationへpg型・SQL・接続・commit／release能力を渡さない。

| Module | 責務 |
| --- | --- |
| postgres-authentication-store | 5操作、認証判断、Lock順、Actor解決、Alias再試行 |
| authentication-transactions | 同一接続のBEGIN／COMMIT／ROLLBACK、結果不明と接続破棄 |
| authentication-transaction-scopes | 受付状態、同一接続への参加、失敗記録、本文handle所有検証 |
| authentication-key-state | 現行epochと全検索／必須書込世代の検証 |
| authentication-record-selection | 全世代検索、Cookie／Identityの複数hit拒否 |
| authentication-record-rows | bigint・Row／Envelope復元、insertと旧版CAS |
| authentication-audit | 固定Enum、用途別仮名、同一接続へのinsert |

既存Schema v5＋v6を使用し、Migrationを変更しない。Production認証からGroupのMigration Runnerへ依存しない。

## Lock・世代・再試行

READ COMMITTEDの同一接続で、key_state FOR SHARE → Actor UUID昇順FOR SHARE → Session UUID昇順FOR UPDATE → Attempt UUID昇順FOR UPDATE → Identity／Alias → Audit insertの順にlockする。無効化側はActor FOR UPDATE、Rotation公開はkey_state FOR UPDATE。非locking lookupはhintであり、Lock後にRecord ID・Actor FK・Digest・epoch・版を再確認する。更新済み版は最新暗号文と共に再検証し、completeはsnapshot全Fieldの一致も必須とする。判断時刻は必要なLockと暗号検証後の注入Clockから取得する。

active／rotatingだけを許可する。Identityは全searchableと全write-required世代を使い、旧AliasだけのActorも不足required Aliasを同Transactionで補完する。Actor状態MACは保存行の読取世代で検証する。Auditは独立3用途のMaterialと共通write-requiredラベルを使い、世代不足・部分公開を拒否する。新Cookieの衝突も全検索世代で検査し、旧世代の同値を再発行しない。

0-hitだけでActorを新規作成する。既存IdentityはLockと復号本人性の完全一致を確認し、異Identity多重hitを任意に選ばない。Alias Unique敗者だけが全rollback確認後に新Transactionで全世代・期限・未消費を再検証し、初回を含む最大3Transactionで終了する。Cookie／Session ID／Audit衝突、deadlock、serialization failure、rollback結果不明は再試行しない。VerifierやCallbackを再実行しない。

## Scopeと本文

Callbackは`(actor, scope) => Promise<AuthenticationSerializedValue>`。Scope.serialize(value)でJSON-safeな値を同期Copyし、lease内でJSON.stringifyを完了する。handleはnull prototype、own data propertyのbody:stringだけを持つfrozen Object。元Objectの後続変更は本文に反映しない。

Accessor／custom prototype／toJSON／関数／Symbol／BigInt／undefined／非有限数／循環／疎Arrayを拒否する。同じ本文でも別Scopeのhandle・偽造Object・未確定の任意値を受理しない。

1. open: Callbackの参加queryとserializeを受け付ける。
2. sealed: Callback直後に受付だけを止め、DB接続とActor／Session Lockを保持する。
3. 未完了query・受付中の失敗・handle所有を検査し、ownerだけがidle更新・Audit・commitを行う。
4. Outcome処理後にclosedとして接続を解放し、成功commit後だけ本文を返す。

参加queryは同じregistryのopen Scopeで単一SELECT／INSERT／UPDATE／DELETEだけを許可する。固定文とParameterを分け、コメント・文区切り・Transaction制御・QueryConfig Objectを受理しない。Tableを作成する[SELECT INTO](https://www.postgresql.org/docs/17/sql-selectinto.html)を防ぐため、SELECT文のINTO語もSQL実行前に保守的に拒否する。値はParameterへ分離し、参加Repositoryの固定SQLをReviewする。握り潰されたquery／serialization失敗もcommitを拒否し、未await queryは収束後にrollbackする。sealed／closed後はSQL／JSON評価前に拒否する。後続Transportはcommit後のresult.value.bodyをそのまま送信し、元Dataやhandleを再serializationしない。Callback内の外部副作用のrollbackを保証しない。

## Audit・Outcome・検証

許可・拒否とも固定action／decision／reasonと独立用途のHMAC仮名を保存する。不在対象はnull。eventId／requestIdはServer生成UUIDv4。Cookie・Token・Google本人性・直接ID・IP／UA・例外自由文を保存しない。Audit失敗は判断結果より優先してunavailableとする。

commit前障害は全rollbackを試みるが、ProviderのNonce割当はburnしたまま。COMMIT送信後の応答喪失は共通commit済みの可能性を残し、接続破棄・unavailableとして秘密値／本文を返さない。Session秘密値や同Attemptの成功をDBから復元しない。Alertは固定operation／Codeのみ。

`apps/api/test/authentication-store.integration.spec.ts`は末尾_testの実DBにv5＋v6を適用する。既存Suiteと同じadvisory lockで直列化し、Schema不存在を確認し、Suite所有Schemaだけを削除する。異なるbackend PIDとpg_blocking_pidsで同Attempt・同本人・Logout・Actor無効化・Rotation競合を観測する。合成参加TableのPIDとxminで書込み・idle・Auditの同一Transactionを確認する。SQL／鍵／Codec故障、期限等値・Lock待機中期限跨ぎ、再試行上限、世代混在、改竄、Scope逸脱、commit前rollbackと実COMMIT後応答喪失、秘密値非漏出も検証する。

テスト用無効化／Rotation Writerは競合を検証する合成実装であり、本番Workflowではない。具体Providerのdurability・独立Failure domain・IAM・全世代破棄・外部Ledger／Witness・Restore訓練、HTTP／Rate limit／実Google／Browserは別Evidenceが必要。削除／Restoreは#217の保守Adapter、HTTPは#218、Google画面は#219にTraceする。

## #217 清掃・削除・Restore

`postgres-authentication-cleanup`は共通期限PolicyとActor候補Pageの空Lock解放・次Page走査／Row Lock後LIMITの小Batch／SKIP LOCKED／版付きDELETE／purge Auditを所有する。`postgres-authentication-deletion`はActor排他Lock下のdisabled／全Session revoked／同Intent／Audit共通commit、scope inventory登録後のIdentity／Alias／Session除去、0-rowとIntent CASを所有する。`authentication-deletion-intents`は外部証跡との同operation／仮名／世代／参照照合を共有する。通常Storeのactive／rotating許可は広げず、清掃だけquarantinedも許可し、Restoreはrestoring専用に分離する。

`postgres-authentication-restore`は外部所有fenceの閉鎖確認とkey_state排他Lockを各Transactionへ要求する。初回Manifest版一致と、同runの隔離進行版のDB外durable記録を専用Portへ要求し、未登録版を拒否する。Coordinatorは未完了Actor票の固定snapshot全Page照合をDB削除より先に行い、既知の期限未達は鍵／disable障害に先行して封鎖する。真正な削除証跡から旧Backupの行を再除去し、全Credentialを破棄する。新epoch／全9用途の公開実体に合わせActor MAC／保持Identityの新DEK再Seal／全required Aliasを同Transactionで移行する。所有completionの型付きfingerprintと現DBをactivate時に再照合する。具体外部制御、物理Backupの真正性、Traffic開通自体はPortの責務で、SQL Adapterの成功だけで本番を開けない。

`authentication-maintenance.integration.spec.ts`はPostgreSQL17のSuite所有Schemaで実Lock／CAS／rollback／commit応答喪失、削除20段・Restore18段の故障と旧Backup復旧、35日境界、偽造fence・DB変更・重複Identityを検証する。外部鍵／Ledger／制御はDB巻戻しと独立した合成状態である。[保守仕様](../../../../../../../docs/security/authentication-maintenance.md)と[Runbook](../../../../../../../docs/operations/authentication-retention-restore.md)へTraceし、Schema／Migrationは変更しない。

## #239 コード専用Session lease

`createRecipientCodeTransactionScopes(base)`は既存認証と同じ基礎registryを使う。Compositionだけが最初のlease前に`registerGroupParticipant({ prepare })`を一度呼び、その返却能力を信頼済みGM Adapterへ渡す。`prepare`はGM所有のkey-stateを同じquery限定能力で固定する登録Portで、共有認証はGM型・Table・SQLをimportしない。GMにはquery/attestだけを渡し、registryのopen/終了・Pool・commit能力や認証Writerを渡さない。

`createPostgresRecipientCodeLeases({ pool, scopes, codec, digests, crypto, limits, consume })`が`RecipientCodeSessionLeasePort`を実装する。`withActor`は発行/取消保存用に本人Actorを最初からFOR UPDATEで固定する管理leaseであり、状態照会用のidle非更新入口ではない。発行/再発行/取消/状態照会のStore本文は後述の#240が所有する。`use`は次の順序を守る。

1. caller-only leaseで認証key-state→登録GM key-state→caller Actor→Sessionを固定し、GM共通operationを照合する。成功再送はコード行/宛先Actor/コードMAC鍵を読まず、GMが検証した保存結果handleを返す。missは内部NoReplay本文だけを確定して終了する。
2. 別の新規leaseで認証key-state→登録GM key-state→非locking Session/code hint→Actor UUID昇順FOR SHARE→Session FOR UPDATEの順で固定し、再lookupでFK/参照/epoch/検索束縛を照合する。追加Actorが必要なら後付けLockせずrollbackする。同じScopeでoperationを再照合して並行成功へ収束させてから、コードFOR UPDATEとMAC/lookup/公開読取世代/宛先active/期限を検証する。
3. GMの新規判断/Group Lock/保存後、GM Adapterが`attest(scope, handle, {codeId, recipientActorId, operationId, value})`で証跡を一度だけ発行する。`value`は同Scopeが発行した最小Response handleであり、同じ本文の別Objectも認めない。登録Adapterは実際の成功計画・共通operation namespace・GM Auditを所有する。registryはGM SQLの業務意味を代替しない。
4. `scope.consume(handle, evidence)`が登録認証Writerを一回だけ呼ぶ。消費handle/証跡/コード/宛先/operation/Responseを非公開Object identityへ束縛し、証跡なし、別Scope/registry、二重消費、計画差替え、未受領/未完了操作、SQL/serialize失敗の握り潰し、受付終了後queryをcommit不可にする。Session/コード期限は全Lock後、serialize直前、保存後のcommit前に再確認し、Session idleと認証Auditも同一Transactionへ保存する。

基礎registryの所有者限定extension Hookは通常Scopeでは省略される。専用registryのquery/consumeはthenableで結果の受領と完了も追跡し、完了が早かった未await操作を受付停止時に見逃さない。await/成功thenによる受領を追跡し、catch/finallyだけを付けた未await操作は受領とみなさない。未完了/失敗も常に拒否する。返却handleの所有確認と証跡の一致は別に行う。

`limits`はLock/statement/transactionの正のmillisecondsを要求し、PostgreSQL17のSET LOCAL相当とCallbackの実時間上限を設定する。AbortSignalまたはTransaction上限でCallbackが戻らない場合も受付をsealし接続を破棄する。切断時のPG Transaction abortにより途中DMLを残さず、遅延Callbackのqueryを拒否する。PGのerror Eventを持つPool/接続Wrapperは`on/removeListener`も転送し、queryがない間のtransaction_timeout/切断を所有者の中断へ接続する。破棄中のsocket errorも原因を公開せず受け止める。COMMIT送信後は確定済みの可能性を保持してunavailableとし、Callbackを自動再実行しない。接続取得自体の待機上限は注入Pool側の責務であり、本番Pool/Provider応答時間の保証は未実証。固定Alertだけを通知し、通知例外/SQL詳細/入力値を返さない。

専用`readRecipientCodeKeyState`だけがSchema8のコード2用途を受理する。旧通常Writer/保守/Restoreの未知用途拒否は維持する。新しい鍵世代の初期化、旧Writer/Restoreとの公開切替、実GM Adapter、実コード消費/両Audit、清掃/Restore、HTTP/Dev/mainへの接続を今回の内部leaseで完成扱いにしない。

`recipient-code-transaction-scopes.spec.ts`は偽証跡/参照差/二重消費/未await/別本文/受付終了を検証する。`recipient-code-leases.integration.spec.ts`は専用PG17のSuite所有Schemaで実Actor/Session/コードMAC/Lock/2接続競合/期限/SQL故障/rollback/COMMIT応答喪失/cancelを検証する。GM key-state/Table/業務保存、コード消費WriterとコードAuditはTest-onlyの合成参加者で、実GM保存は#242、コード消費とInvitation作成/両Auditの共通業務atomicityは#243のEvidenceが必要。公開契約・Provider・保守/復旧・Production Gateを解除しない。

## #240 コードの発行・取消・状態確認

`createPostgresRecipientCodeStore`は`issue/revoke/inspect`だけを実装する。本人Sessionから得たActorを使い、Client指定のActorを受け付けない。同じregistryのlease・query参加能力・guardをCompositionで渡す。Pool/BEGIN/COMMIT/releaseはlease ownerだけが所有する。管理Callbackは先頭で共有Lock済みのkey-stateを`readRecipientCodeManagementKeyState`で再取得し、後付けLockを取らない。新しいlookup/MACは唯一のwrite世代、旧Recordは公開read世代で検証する。

- 発行/再発行: Actor FOR UPDATE→Session FOR UPDATE→本人の旧IssuedをcodeId昇順FOR UPDATE。CSPRNG32byteと独立UUIDv4を生成し、全searchable lookup世代の衝突/複数hitを拒否する。Lock/検索後の判断点+600000msを固定し、旧IssuedのReplaced/CAS/現行MAC、新Issued、用途別コード監査、Session idleと認証監査を同commitする。旧コードが期限超過でも先に終端化する。鍵/SQL/監査/serialize/最終期限失敗は全rollbackする。
- 取消: 本人Actorを排他Lockし、codeIdと本人Actorの両方で対象を選ぶ。他人/不存在/清掃済みは同じAlreadyInactiveとコード仮名NULLの同じ監査形。本人の終端/期限等値もAlreadyInactive、有効IssuedだけRevoked/CAS/現行MAC。取消判断後の期限跨ぎも最終guardでrollbackする。GM/Invitationは参照・変更しない。
- 状態確認: `inspectActor`は本人Actor FOR SHARE→Session FOR UPDATEを検証するがidleを更新せず、GM準備を行わない。コードをUUID昇順FOR SHAREで固定し、Issued優先、なければcreatedAt/codeId降順の最新終端を選ぶ。MAC/epoch/世代/所有者を検証し、codeId/state/expiresAtだけを返す。不在はno-code。ExpiredはClockから導出し、期限は延長しない。

秘密値はDB/operation/確定serialize本文へ入れず、Callbackの一時候補だけで保持し、leaseのcommit確認後に一回返す。COMMIT送信後の障害は確定済みの可能性を残したunavailableで、復元・再発行・業務Callback retryを行わない。状態確認後の本人の明示再発行だけを許す。元Sessionのlogoutはコードを変更しない。

失敗時の業務Transactionは全rollback/結果不明とし、その後の別`inspectActor`で固定deny/restart-requiredと本人仮名だけを一度記録する。これは業務再試行や失敗確定の証明ではなく、応答を許可できなかった記録である。コード存在は照会せず、秘密値/候補codeIdを復元しない。拒否Auditも失敗すればunavailableのまま、固定Alertだけを通知する。認証拒否は既存leaseの拒否Auditへ委譲する。拒否監査の保存と部分業務commitを混同しない。

コード監査は[Migration9](../../../../../migrations/authentication/README.md#version-9-コード管理監査240)の固定actionと独立コード仮名を使う。Actor仮名とは独立鍵、Audit共通世代ラベルを用いる。codeId/lookup/state MAC/原値はAuditへ保存しない。旧認証actionでは従来列のINSERTを維持するため、Schema5/6の既存経路を変更しない。新鍵の明示発行と孤立Scopeの扱いは[暗号契約](../README.md#コードrecord鍵の明示発行240)に従う。

`recipient-code-management.integration.spec.ts`は実PG17の2端末/取消/Actor無効化競合、最小状態/idle非更新、全世代衝突/複数hit/旧MAC再書込、期限等値/改竄/鍵Ack/各DML/監査/COMMIT前後故障、raw非保存、同backend/xminを検証する。Providerは明示発行する合成Mapであり、耐久性・全世代破棄は未実証。具体Pool所有者はPool errorも受け止め、Error/Client全体をLogへ出さない。Test Poolはrelease(true)したClientへの遅延25P04だけを期待通知とし、その他のPool errorは検証失敗にする。

実GM消費/Invitation/両ContextのAuditは#242/#243、清掃/Restore/鍵退役は#244/#245、公開契約は#246以降。通常main/Dev/HTTPとProduction Gateは未接続のままとする。
