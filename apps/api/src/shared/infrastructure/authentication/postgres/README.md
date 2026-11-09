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

## 明示列

認証Tableの読取りは`SELECT *`を使わず、`authentication-columns.ts`の明示列だけを読む。将来追加される秘密値・PIIの列を黙って読み込まず、列集合の完全一致を求める読取り（`readRecipientCode`等）が無関係な列で形式不正になって利用不能や封鎖へ倒れることも避ける。列を足す場合は読取関数とこの定数を同時に直す。`authentication-columns.spec.ts`が`SELECT *`の再混入を検査し、Integration Testが無関係な列の追加後も読取りが成功することを確認する。

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

`createRecipientCodeTransactionScopes(base)`は既存認証と同じ基礎registryを使う。Compositionだけが最初のlease前に`registerGroupParticipant({ prepare })`を一度呼び、その返却能力を信頼済みGM Adapterへ渡す。`prepare`はGM所有のkey-stateを同じquery限定能力で固定する登録Portで、共有認証はGM型・Table・SQLをimportしない。GMにはquery/操作追跡`run`/新規計画受付/attestだけを渡し、registryのopen/終了・Pool・commit能力や認証Writerを渡さない。`run`はSQL前のProvider待機を含む操作全体を同期登録し、未完了操作への重複受付を拒否する。入力Copyは遅延させず同期開始し、受付前の非SQL検証失敗もScopeへ不可逆に記録する。先行証跡/消費があっても未await/未完了/失敗は全rollbackを要求する。

`createPostgresRecipientCodeLeases({ pool, scopes, codec, digests, crypto, limits, consume })`が`RecipientCodeSessionLeasePort`を実装する。`withActor`は発行/取消保存用に本人Actorを最初からFOR UPDATEで固定する管理leaseであり、状態照会用のidle非更新入口ではない。発行/再発行/取消/状態照会のStore本文は後述の#240が所有する。`use`は次の順序を守る。

1. caller-only leaseで認証key-state→登録GM key-state→caller Actor→Sessionを固定し、GM共通operationを照合する。成功再送はコード行/宛先Actor/コードMAC鍵を読まず、GMが検証した保存結果handleを返す。missは内部NoReplay本文だけを確定して終了する。
2. 別の新規leaseで認証key-state→登録GM key-state→非locking Session/code hint→Actor UUID昇順FOR SHARE→Session FOR UPDATEの順で固定し、再lookupでFK/参照/epoch/検索束縛を照合する。追加Actorが必要なら後付けLockせずrollbackする。同じScopeでoperationを再照合して並行成功へ収束させてから、コードFOR UPDATEとMAC/lookup/公開読取世代/宛先active/期限を検証する。
3. GM Adapterは業務DMLより前に`beginPlan(scope, handle, binding)`で新規Scope/code/宛先/operation/同Scope本文を一度だけ固定する。caller-only Scope、偽handle、再受付は握り潰してもcommit不可にし、GM参加queryのDMLも受付済み計画だけへ限定する。認証ownerの管理/消費Writer用queryは変更しない。GMの新規判断/Group Lock/保存後、GM Adapterが`attest(scope, handle, {codeId, recipientActorId, operationId, value})`で証跡を一度だけ発行する。`value`は同Scopeが発行した最小Response handleであり、同じ本文の別Objectも認めない。登録Adapterは実際の成功計画・共通operation namespace・GM Auditを所有する。registryはGM SQLの業務意味を代替しない。
4. `scope.consume(handle, evidence)`が登録認証Writerを一回だけ呼ぶ。消費handle/証跡/コード/宛先/operation/Responseを非公開Object identityへ束縛し、証跡なし、別Scope/registry、二重消費、計画差替え、未受領/未完了操作、SQL/serialize失敗の握り潰し、受付終了後queryをcommit不可にする。Session/コード期限は全Lock後、serialize直前、保存後のcommit前に再確認し、Session idleと認証Auditも同一Transactionへ保存する。

基礎registryの所有者限定extension Hookは通常Scopeでは省略される。専用registryのquery/consumeとGM操作全体はthenableで結果の受領と完了も追跡し、完了が早かった未await操作を受付停止時に見逃さない。await/成功thenによる受領を追跡し、catch/finallyだけを付けた未await操作は受領とみなさない。未完了/失敗も常に拒否する。SQL追跡とGM操作追跡を分け、beginPlan/attestは自身を包む進行中操作を未完了SQLと誤認しない。seal後は新規SQLを拒否するため、rollback前のdrainは開始済みSQLだけを収束させ、未応答Providerを待たない。返却handleの所有確認と証跡の一致は別に行う。

`limits`はLock/statement/transactionの正のmillisecondsを要求し、PostgreSQL17のSET LOCAL相当とCallbackの実時間上限を設定する。AbortSignalまたはTransaction上限でCallbackが戻らない場合も受付をsealし接続を破棄する。切断時のPG Transaction abortにより途中DMLを残さず、遅延Callbackのqueryを拒否する。PGのerror Eventを持つPool/接続Wrapperは`on/removeListener`も転送し、queryがない間のtransaction_timeout/切断を所有者の中断へ接続する。破棄中のsocket errorも原因を公開せず受け止める。COMMIT送信後は確定済みの可能性を保持してunavailableとし、Callbackを自動再実行しない。接続取得自体の待機上限は注入Pool側の責務であり、本番Pool/Provider応答時間の保証は未実証。固定Alertだけを通知し、通知例外/SQL詳細/入力値を返さない。

専用`readRecipientCodeKeyState`と`readRecipientCodeManagementKeyState`、コード保守用の`readRecipientCodeMaintenanceKeyState`だけがSchema8のコード2用途を受理する。旧通常Writer/保守/Restoreの未知用途拒否は維持する。既存の認証清掃が使う`readAuthenticationCleanupKeyState`と、既存のActor削除が使う`readAuthenticationDeletionKeyState`だけはコード2用途を結果に含めず無視し、未知用途は拒否する（#259、#260、ADR D6）。`readAuthenticationDeletionKeyState`はコード用途の有無だけを返し、コード参加なしの構成を止める判断に使う。コード2用途を受理するReaderのうち`readRecipientCodeMaintenanceKeyState`だけが`quarantined`でも読め、利用受付の入口には使わない。呼出元はコードの内部清掃とActor削除参加が共有するAdapterだけで、通常入口とコードRuntimeへの未接続は`architecture-dependencies.spec.ts`で検査する。新しい鍵世代の初期化、旧Writer/Restoreとの公開切替、実GM Adapter、実コード消費/両Audit、清掃/Restore、HTTP/Dev/mainへの接続を今回の内部leaseで完成扱いにしない。

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

実GM消費/Invitation/両ContextのAuditは下記#243の内部統合で検証する。清掃/Restore/鍵退役は#244/#245、公開契約は#246以降。通常main/Dev/HTTPとProduction Gateは未接続のままとする。


#242の受付補強は、共有認証がGM SQL/Domainを解釈する追加ではない。新規業務write前のopaqueなhandle/計画/本文の一回照合と、保存後の同一binding照合を分ける。これによりcaller-only replay Scopeや非SQL障害の握り潰しから部分GM commitを作れない。実Session/コードWriterと実GMの最終業務統合は下記#243を参照する。


## #243 実コード消費と内部Composition

[内部Factory](../../../../recipient-invitation-runtime.ts)が、一つの基礎registry/専用registryへ実GM準備と保存Adapterを登録してから、実consumer/lease/管理Store/GM Applicationを接続する。共有認証はGMの型/SQLをimportせず、GMは認証Tableへ触れない。登録/接続/Transaction制御能力はFactory内だけに閉じる。通常main/Dev/公開Routeは変更しない。

`createPostgresRecipientCodeConsumer`はregistryがGM成功証跡を検証した後だけ呼ばれる。Lock/MAC検証済みRecordとcallerを同期固定し、先頭で共有Lockしたkey-stateを後付けLockなしで再取得する。epoch/読取世代/旧MACと純粋consume Policyを確認し、current MACへの必要なRecord鍵確保、Issued/版CAS、新MAC、`recipient-code-consume`成功Auditを同じ借用queryで保存する。AuditのActor仮名は行為者caller、コード仮名は独立用途であり、直接宛先/Group/Invitation/原値を監査へ入れない。置換/取消/消費の鍵確保と終端CASは`recipient-code-transition-writer`を共有し、PolicyとTransaction所有を混在させない。

新規leaseのコードLock待機後に不在/終端/期限超過を拒否する前にも、同Scopeのoperationを再照合する。確実rollback/COMMIT結果不明からは、新しいcaller-only leaseで一回の照合だけを行う。保存済み同内容なら最小結果、miss/照合障害/回復時のSession失効なら元のunavailableを維持する。新規create/コード消費/再発行は自動再実行しない。COMMIT送信後は接続を破棄し、照会missだけで「確実に失敗」と断定しない。AbortSignalは内部createからleaseまで伝播する。

`recipient-invitation-atomicity.integration.spec.ts`は実Actor/Session/コードStore/lease/MAC/GM Application/保存kernel/両Auditを組む。別Owner/別Groupの同コード、同operation、再発行/取消の両順序、Actor無効化、Session失効、GroupのOwner譲渡/Closing/人数/受諾、locator Unique敗者、期限、各保存/暗号/監査/serialize障害、COMMIT前後/応答喪失、timeout/cancel、偽Scope/証跡/二重消費/完了済み未awaitを検証する。既存#239/#240/#242の独立Suiteは各境界の補助Evidenceとして保持する。

追加[Migration11](../../../../../migrations/authentication/README.md#version-11-コード消費監査243)はEnum/CHECKだけを拡張する。コードAuditは90日保持、Record鍵の終端後24h全世代closureとGM proofの参照0件+Backup35日保持を混同しない。具体Provider耐久性/鍵破棄、清掃/Restore、公開API/本番配置は未実証のまま。

## コードの清掃（#258、#259）

`createPostgresRecipientCodeCleanup({ pool, crypto, digests, clock, limits })`はコード専用の清掃DB境界で、[Use Case](../../../application/authentication/recipient-code-cleanup-service.ts)の`RecipientCodeCleanupDatabase`を実装する。既存の`postgres-authentication-cleanup`の`absent`へコードscopeを渡さない。

- Lock順はkey-state共有Lock→本人Actor `FOR UPDATE`→コード`FOR UPDATE SKIP LOCKED`（R4）。コードの次にActorへ戻らない。Actor行がなければ停止する。key-stateは`readRecipientCodeMaintenanceKeyState`で読むので、`quarantined`でも動き、`restoring`では止まる。
- `inspect`はActor MACと行のMACを検証した`disabledAt`と`terminalAt`だけを返す。形式不正・公開読取世代外・確定した不一致は`mismatch`、鍵障害は`unverifiable`で、どちらも値を起算に使わない。MAC不一致と鍵障害の区別にはコード暗号Portの`checkRecord`を使う。
- `remove`はLock後のClockで`dueAt`を再検証し、`record_version`のCASで行を除去する。同じcommitへ`purge` Audit（Actor仮名だけ）を保存する。行がなければ何も書かない。
- `dueHints`と`disabledHints`はLockしない候補で、判断の根拠にしない。`quarantine`は既存清掃と共有する`quarantineAuthenticationKeyState`を使う。
- `absent`はコード表だけを照合する。`actorAbsent`はActor削除のComplete前提で、Providerの知らない行も検出する（#260）。
- ActorとコードはSQLで列を明示して読む。将来の列を読み込まず、列の追加でコード行の厳密な形式検証を不一致（封鎖）へ倒さない。

各操作は別Transactionで、保守Portの呼出しをDB Lockの保持中に行わない。`recipient-code-cleanup.integration.spec.ts`が実PG17でLock順、SKIP LOCKED、期限境界、disabledAt、MAC不一致と封鎖、再発行・取消・消費との2接続競合、小Batch、孤立scope、列挙の停止、24時間未達、SQL・Audit・Provider障害、COMMIT応答喪失、部分世代、復元行、key-stateを検証する。Providerは合成で、実Providerの耐久性・破棄の証拠にしない。
