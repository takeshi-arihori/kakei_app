# 認証Dataの保護保存契約（A2）

Knowledge State: **Accepted（詳細保存設計）**。[A2 ADR](../adr/authentication-protected-storage.md)は2026-10-11のOwner会話承認「はい。」と独立Security Review passを根拠とする。PR #220のdevelop統合・先行Task merge・個別Ready評価までは依存実装に進まない。この仕様の実装状態は末尾のTraceで区別し、具体鍵Provider・本番運用のEvidenceを別Gateとして扱う。

## 1. 基準・要求・境界

- Base: `61ee0f95a6cf564a5dfbbdf15447e10b7e87b20c`。2026-10-11にGitHub developと一致、PR #211 Merged／Task #210 Closedを確認した。
- Requirement: [Epic #202](https://github.com/takeshi-arihori/kakei_app/issues/202)と[内部Lifecycle契約](google-authentication-lifecycle.md)のR1〜R6をdurable保存へ写像する。方式・5分／7日／24時間・削除24時間・Audit90日・Backup35日の方針は既存ADRの範囲を維持する。
- 実装境界: `AuthenticationStore`のbegin／readAttempt／complete／withSession／revokeをA4b #216のPostgreSQL Adapterへ接続する。暗号部品はA4a #215、清掃・削除・Restoreは#217、具体鍵ProviderはProduction Gate。Groupのprotected-recordはGroup-bound、用途別DigestもgroupId必須で、偽Group IDによる流用を禁止する。
- Domain要素: ActorはランダムUUIDv4の本人性参照。Identity、Attempt、Sessionは共有技術境界が所有し、Participant／Role／Invitation／精算履歴は保存しない。既存Google Verifierは変更不要。
- 配置: Portは`shared/application/authentication`、実装は`shared/infrastructure/authentication`。Domain→暗号、Application→pg／crypto、Groupから認証Tableへの直接依存を追加しない。新Package／業務Contextは作らない。
- Quality: Storeが一意性とTransactionを所有し、Codecが保護形式、Providerが鍵／Nonce、Audit writerが同じTransactionへの追記を所有する。CodecやVerifierにActor登録・Group認可を混ぜない。

## 2. 保存InventoryとQuery

認証専用`authentication` Schemaを追加する。以下の論理名はA3でTableへ写像する固定設計案。全行のIDはCSPRNG UUIDv4、版は正のsafe integer、UTCは非負safe integer millisecondsとし、PostgreSQL bigint→JS変換時に範囲を再検査する。

| Record | 平文許可 | 暗号Payload／保存しない値 | Query／制約 |
| --- | --- | --- | --- |
| actor | actorId、active／disabled、version、作成／無効化時刻、controlKeyVersion、32-byte状態MAC | Google情報・Profileなし | PK actorId。Group FKなし。無効化は終端。状態MACを認証判断前に検証 |
| google-identity | identityId、actorId FK、version、Envelope Metadata | 正規化issuer＋sub、ID／Actor／版の認証済みCopy | 1 ActorにGoogle Identity一つ。Aliasから選択後だけ復号 |
| identity-alias | purpose、digestKeyVersion、32-byte Digest、identityId FK | issuer／subなし | Unique(purpose,keyVersion,digest)、Unique(identityId,keyVersion) |
| login-attempt | attemptId、version、epoch、作成／expiresAt、状態、terminalAt、Cookie Digest世代と32-byte Digest、Envelope | Server期待nonce、Login CSRF、全平文MetadataのCopy。Cookie原値なし | Unique(keyVersion,digest)、期限／terminalAt清掃索引。TTL=300,000ms |
| session | sessionId、actorId FK、version、epoch、作成／absolute／idle、状態、terminalAt、Cookie Digest世代と32-byte Digest、Envelope | Session CSRF、全平文MetadataのCopy。Cookie原値なし | Unique(keyVersion,digest)、Actor失効／期限清掃索引。idle≤absolute、最長604,800,000ms |
| auth-audit | ランダムeventId／requestId、UTC、固定action／decision／reason、用途別仮名、auditKeyVersion | 直接ID、Identity、秘密値、Token、IP、UA、DB／SDK例外なし | eventId一意、UTC清掃索引。Login成功は一Attempt一成功の一意仮名 |
| key-state / epoch | singleton ID、世代集合／状態、世代版、epoch | 鍵Materialなし | Writer FOR SHARE／Rotation FOR UPDATE。未初期化では拒否 |

EnvelopeのMetadataは形式・algorithm・owner・kind・scopeId・recordId・schema／key／recordVersion、Nonce、Tag、Ciphertextに限定する。Ciphertext、GCM Nonce（Google期待nonceとは別）、Tagは秘密値の平文として扱わない。許可していない列、Log、Error、Backup manifest、診断Snapshotへ値を複製しない。認証DB内のActor FKと時刻のLinkabilityは許容する残RiskとしてReviewする。

Cookieを用途別Digestへ変換して候補行を検索し、missではData Key読取／復号を0回にする。Identityは検索可能な全世代Aliasを照合し、複数identityIdにhitしたら選択せず`unavailable`＋固定Code Alert。Session利用はIdentityを復号しない。nonce／CSRFは索引にせず、Cookieで選んだ行のAEAD検証後に固定32-byte値を定数時間比較する。

## 3. HMACとCanonical表現

検索値は32-byte HMAC-SHA-256。用途ごとに独立256-bit KeyをProviderが保持し、暗号鍵との型／Portを分離する。用途は`auth-google-identity/v1`、`auth-attempt-cookie/v1`、`auth-session-cookie/v1`。仮名は別Keyの`auth-audit-actor/v1`／`auth-audit-attempt/v1`／`auth-audit-session/v1`、削除照合はさらに別Keyの`auth-deleted-actor/v1`を使う。同じByte列や鍵を用途間で使わない。Actor状態改ざんを防ぐ`auth-actor-state/v1`のMAC Keyも別用途に分離する。MAC入力はapp／purpose／actorId／version／status／createdAt／disabledAtの順のCanonical TLVで、nullable disabledAtは唯一のabsence表現を許す。Actor Lock後にMACを確認し、状態更新とMAC更新を同じTransactionで確定する。世代更新中は旧状態MAC検証・新MAC書込を行い、全保持Actor移行とBackup参照Window終了前に旧Keyを廃棄しない。Identity DEK破棄後もdisabled状態MACを検証できる。

入力は用途も含むCanonical TLV。各Fieldは1-byte tag、1-byte presence（必須は01）、uint32 BE byte length、厳格UTF-8 byte列。tagは昇順、一回のみ。空、NUL／制御文字、不正UTF-8、前後空白、未知tag、余分byteを拒否する。UUIDは小文字canonical UUID、整数はleading zeroなしの非負ASCII十進、秘密値は43文字canonical unpadded Base64URLを検証して32-byteへ復号し、そのbyte列をTLVのbinary Fieldへ入れる。文字列正規化・trimを暗黙実行しない。

| Digest入力tag | Identity | Cookie | 仮名／削除照合 |
| --- | --- | --- | --- |
| 01 | app=`kakei_app` | 同左 | 同左 |
| 02 | purpose | purpose | purpose |
| 03 | 固定Provider=`google` | epoch UUID | actor／attempt／session UUID |
| 04 | issuer=`https://accounts.google.com` | 32-byte秘密値（binary） | 存在しない |
| 05 | Verifierのsub（case保持） | 存在しない | 存在しない |

Googleの二つの許容issuer表記は既存Verifierがcanonical issuerへ正規化済み。subをemailへ置換しない。Alias一致後は復号issuer／subを入力と完全比較し、HMAC衝突・不整合を二重Actor登録やIdentity統合で吸収しない。

## 4. 認証専用Envelope

Node標準cryptoのAES-256-GCM、256-bit Key、96-bit Nonce、128-bit Tag。CallerはNonceを指定できない。Group／Settlement Codecは変更せず、認証用HeaderとValidatorを追加する。共通化する場合もbyte符号化・AES primitiveだけに限定し、既存Golden vector不変を後続Testで確認する。

AAD tag 01〜0aは順に`envelopeVersion=1`、`algorithm=AES-256-GCM`、`app=kakei_app`、`owner=authentication`、`recordKind`、`keyScopeId`、`logicalRecordId`、`schemaVersion=1`、`keyVersion`、`recordVersion`。kindは`google-identity`／`login-attempt`／`session`。scopeはIdentityでactorId、AttemptでattemptId、SessionでsessionId。Group ID Fieldは存在しない。

AAD tag 0bは`rowBinding`のbinary TLV。google-identityではidentityId／actorId／version、AttemptではattemptId／version／epoch／createdAt／expiresAt／state／terminalAt／digestKeyVersion／cookieDigest、SessionではsessionId／actorId／version／epoch／createdAt／absoluteExpiresAt／idleExpiresAt／state／terminalAt／digestKeyVersion／cookieDigestを記載順のtag 01以降でEncodeする。nullable terminalAtだけabsence=00、length=0を許す。Digestはbinary32、他は上記canonical表現。期待AADは選択行から再構成し、暗号文に同梱されたHeaderだけを信頼しない。

Payloadはversion付き最小JSONで、許可Fieldのみ、duplicate Key／未知Fieldを拒否するParserを使う。文字列のUnicodeを勝手に正規化しない。復号後はPayloadのMetadata Copyと選択Rowの全Fieldを比較する。書込時はstate／期限／Digestを含むMetadata変更のたびに版を上げ、新Nonceで再Sealする。Identity Aliasは別行のため、hitしたAliasのHMACを復号Identityから再導出して一致を確認する。

別Actor／別Row／別kind／別epoch／期限・状態・索引の差替え、非Canonical AAD、破損Tag、Unknown／Destroyed Key、Payload不一致はすべて`unavailable`、固定CodeのみのAlert。期限や状態を改ざんして認証を延長できない。AEADだけでDB全体の旧Snapshot復元を防げるとは主張しない。

## 5. 鍵・NonceのLifecycle

| 用途 | Scope／更新と廃棄 |
| --- | --- |
| Identity DEK | actorId別の独立ランダムKey、全Versionを24時間以内の退会削除対象とする。Global RootからactorIdだけで再導出可能な方式は禁止 |
| Attempt DEK | attemptId別。Attempt削除と全Version破棄を再試行可能にする |
| Session DEK | sessionId別。Session削除と全Version破棄を再試行可能にする |
| Identity検索Key | 認証用グローバル用途別世代。Alias移行・一意性を検証して退役 |
| Cookie検索Key | Attempt／Sessionで別用途・epoch・世代。原値を保存せず期限までdual read、再Hashしない |
| Actor状態MAC Key | Identity DEKとは独立。保持Actorの状態・版に束縛し、全Actor移行とBackup参照Windowを確認して退役 |
| Audit仮名Key | actor／attempt／sessionで別用途。Data Key削除と連動せず、当該世代最終Audit90日＋Backup35日と参照0を確認して廃棄 |
| 削除Ledger MAC／照合Key | Data／Digest／Auditとは独立。未完了削除Intentと復旧可能Backupに必要な間は退役Keyでも検証可能にする |

ProviderはKey materialをDB・DB Backup・Logへ置かない。各scope＋kind＋keyVersionで96-bit Nonceの一意性とSeal countを、DB Transactionとは独立したdurable単調割当で保証する。rollbackした割当も再利用しない。2^31 SealでRotation要求、2^32到達前に拒否。Counter後退・喪失・Restoreを検知したら旧Keyで新規Sealを禁止し、独立した新KeyVersionへ切り替える。ランダムNonceだけに衝突回避を任せない。

Data Key Rotationはnew-write／old-read、Row CASで再Seal、全live Row移行／参照0と復旧可能Backupの扱いを確認してretire。退会ではBackupの自然失効を待たず全Identity DEKを破棄し、外部Key RegistryのDestroyed状態がBackup復元で戻らないことを要求する。Identityの旧Ciphertextを読む必要があるBackupの通常Rotationと、削除鍵の恒久拒否を区別する。

### Identity検索鍵更新中の一意性

1. key-stateをFOR UPDATE。新世代を追加し、旧＋新をsearchable、write-requiredにする。Writerは全required世代Aliasを同じTransactionで書く。切替以前の共有Lock Writerが完了してから公開する。
2. Login Writerはkey-state FOR SHAREをcommitまで保持し、全searchable世代のDigestを計算する。少なくとも旧世代は全既存Identityを覆うため、まだ新AliasがないIdentityも見つかる。0-hit時だけActor／Identity／全Aliasを挿入する。
3. Unique競合は敗者Transaction全体をrollbackし、上限3回の新Transactionで全世代を再照合する。Google検証は繰り返さず、Attempt等の期限・未消費・Actor状態を再検証する。上限到達／deadlock／serialization失敗は`unavailable`。敗者Actorだけを残さない。
4. Backfillもkey-state共有LockとIdentity／ActorのLockを取り、active Identityの復号から新Aliasを追加する。異Identity競合・復号失敗をskipせず移行停止する。disabled Actorへ新Aliasを作らない。
5. key-state排他Lock下で、全active Identityの新Alias、同本人の複数Identityなし、旧Writerなしを再検証してから旧世代をsearchableから外す。Backup Restoreで旧Schema／Aliasを戻す場合はTraffic開通前に現行世代へ再移行する。

世代集合・Key取得が部分成功なら登録しない。Globalな固定Unique Digestを別に追加しない。Key compromiseでは通常Rotationだけで安全復旧を主張せず、侵害範囲の封鎖・全該当Session失効・独立Reviewを行う。

Cookie検索は全searchable世代の候補を計算する。live Rowを覆う旧Keyを退役しない。Epoch内の旧Attemptは5分、Sessionは絶対期限7日以内で新規利用不能となるが、期限後24時間の清掃・参照0まで確認する。Restoreでは旧Attempt／Sessionを全破棄するためそれらのCookie検索Keyを復元して再利用しない。

## 6. Transaction・Lock・故障

全認証操作はREAD COMMITTEDと明示Row Lock・Unique制約・CASを組み合わせる。SELECT後UPDATEまで同じPoolClientを使う。PostgreSQL関数`now()`のTransaction開始時刻をlock取得後の現在時刻として流用せず、注入Clockを判断点で再取得する。期限等値は拒否。

Lock順は **key-state FOR SHARE → Actor（UUID昇順）FOR SHARE／無効化はFOR UPDATE → Session（UUID昇順）FOR UPDATE → Attempt（UUID昇順）FOR UPDATE → Identity／Alias → Audit insert**。Actorを知るための非locking lookupはhintのみ、Lock後にFK／Digest／版を再照合する。Alias移行もActorより先にIdentityをlockしない。新Actorは未公開の新規行として挿入する。Rotationはkey-state FOR UPDATEだけでWriterをfenceし、同順でBackfillする。

| 操作 | 同じTransactionで確定するもの |
| --- | --- |
| begin | 現在Session／Actor有効性を再確認。該当する旧未消費Attemptの失効、新Attempt、Audit。衝突は上書きせずrollback |
| readAttempt | Cookie／CSRF／版／期限／未消費を検証しnonce snapshotを作る。Auditがdurable commitしてからsnapshotを返し、Google通信前にLockを解放 |
| complete | Verifier成功後、現在Session／Actor、Attempt Cookie／CSRF／snapshot全Field／nonce／期限／未消費を再確認。Actor作成／再利用、Identity＋Alias、Session、Attempt消費、成功Auditを共通commit |
| withSession | Actor有効、epoch、Session状態／期限を確認。Callbackとactivityのidle=min(now+24h,absolute)更新、Auditを共通commit。inspectはidle不変 |
| revoke | 対象Sessionだけ失効＋Audit。Cookieなし／miss／期限切れ／失効済みは冪等成功。DB／鍵／Audit障害は成功にしない |
| disableActor | 外部PreparedのCheckpoint／Witness確認後、Actor排他Lockで新規発行／利用をfenceし、全Session失効、同じoperationのDB Prepared intent、Auditを共通commit。外部鍵破棄はcommit後の再試行Workflow |

有効Sessionのあるbegin／completeはalready-authenticatedで秘密値を返さない。同Attemptは最大1成功、異Attempt同IdentityはActor一つ・複数Session可。Lock待機後に5分期限／版／消費／Actor状態が変われば拒否する。Verifier拒否／障害ではcompleteを呼ばず、Actor／Session／消費状態不変。

withSessionの既存Callback引数は本人性だけであり、自動的に業務Repositoryと同Transactionになるわけではない。保存Adapter Taskでは、API内部のTransactionScope Port（PoolClientをApplication型へ露出しない）を追加し、Callback配下のRepositoryが同じ認証leaseのTransactionへenlistしたことを検証する。Scopeがない／別接続なら業務書込みを拒否する。業務Contextへの本番接続は後続。Session leaseはCallbackのcommit／Response serializationまで保持し、外部送信はcommit後にだけ行う。Callback内の外部副作用のrollbackは保証しない。

commit前故障は全rollback、Nonce割当だけはburnしたまま。Audit／鍵故障では許可結果を返さない。commit結果不明／commit後応答喪失は共通commit済みの可能性を残し`unavailable`。同Attemptの成功復元／Session秘密値のDB復元を行わず新Attemptから再開する。deadlock等の安全な再試行は確実rollback・Google検証有効・期限再確認の範囲だけで上限3回、外部副作用Callbackを自動再実行しない。

## 7. Audit

A4bのWriterはactor／attempt／sessionで独立した鍵Materialを使い、同じkey_state公開で3用途のwrite-requiredラベルを揃える。audit_key_versionはこの共通key-setラベル、用途別の列にも実参照世代を保存する。部分公開・不足・不一致はfail closedとする。3用途の更新はkey_state排他Lock下でまとめて公開し、具体Operator／Providerは本Taskへ追加しない。

認証Store内でserver-generated CSPRNG UUIDv4のeventId／requestIdを作る。Client requestIdをAuditの一意性や本人性に使わない。A1 Portに新HTTP入力を追加しない。HTTP側requestIdとの相関が必要な場合はA5で信頼Contextの契約を別設計する。

actionはbegin／read-attempt／complete／inspect／activity／logout／disable／purge、decisionはallow／deny、reasonは固定enum。Actor／Attempt／Sessionは用途別HMAC仮名のみ。存在しない対象は仮名nullとし、入力秘密値を仮名代わりに保存しない。Audit Key versionを記録し90日保持。成功LoginのAttempt仮名は世代更新で重複許可しないよう、Attempt消費CASを正本の一意性fenceとする。

Storeで評価した許可／拒否はAudit insert成功後にだけ返す。拒否のAuditは業務変更なしの同Transactionでcommitする。Audit失敗は汎用unavailable＋固定Code Alert。Application入口の形式不正／Verifier拒否はA1のStore非呼出し契約を維持し、記録が必要なら後続HTTP境界でdurable拒否Auditを行う。LogやAlertからAudit内容・Token・直接IDを漏らさない。requestIdは認証成功の再送Keyではない。

### A4bのScope・検索実装

[Store README](../../apps/api/src/shared/infrastructure/authentication/postgres/README.md)にTransaction所有能力と参加query能力を分離する。共有ApplicationにはScopeと確定本文handleだけを公開し、CallbackのTをAuthenticationSerializedValueへ制約する。openで同期Copy／serializationし、Callback直後にsealedとして操作受付を止めてもDB leaseは保持する。ownerは未完了query・失敗記録・handleのObject identityと所有Scopeを確認してからAudit／COMMITを実行し、Outcome後にclosedとする。同じ本文の別Scope handle、偽造、未await query、握り潰されたSQL／serialization失敗は共通commitしない。後続Transportはcommit後にvalue.bodyをそのまま送信する。

新Cookieの衝突は現行書込世代のUnique制約だけに依存せず、全searchable世代で確認する。既存Identityは全hitを同じIdentity／Actorへ解決し、復号値・hit Aliasを再照合して不足write-required Aliasを同Transactionで補完する。Alias Unique敗者だけを全rollback確認後に最大3Transactionで再照合し、Cookie／Session ID／Audit衝突やcommit結果不明を再試行しない。

## 8. 清掃・退会・Backup Restore

Attemptの削除起算はconsumed／replacedのterminalAt、未使用はexpiresAt。SessionはrevokedのterminalAtまたはmin(idle,absolute)の早い方。認証はその時点から無効、DB／全DEKの物理除去は24時間以内。AuditはoccurredAt+90日で期限、24時間以内にpurge。時刻／状態Metadataの整合を検証してからSKIP LOCKEDで小Batchを取得し、Session活動／消費／Logoutと同じLock・CASで清掃する。SKIP LOCKEDだけで期限遵守を主張せず、oldest overdueの監視と失敗再試行・Alertを本番条件とする。

DB Transactionと外部Key破棄は単一commitできない。削除は外部Ledger Prepared＋Checkpoint／Witness確認 → DBの無効化／全Session失効／同operation Prepared intentの共通commit → DB行／Alias削除 → 全KeyVersion Destroyed確認 → 0-row確認 → 外部LedgerへComplete＋Checkpoint／Witness確認の順で再試行する。外部PreparedはactorIdの削除仮名、ランダムoperation ID、UTC、対象Key参照を公開しないProvider管理参照、状態・版だけを持ち、最新headへconditional appendする。外部Preparedは受付済みで取り消さない削除意思を表し、DB側に行がなくてもRestore／Reconcilerは削除を続行する。外部Preparedが成功してDB commitに失敗しても同operationで再開し、Preparedが存在し得る結果不明では完了／受付失敗を断定しない。外部PreparedとWitness確認が取れなければDBの無効化・不可逆鍵破棄へ進まず、要求成功を返さない。DB無効化commit前には無効化完了を返さず、DB commit済みでも外部Preparedを欠く状態はQuarantine／重大Alertとする。復旧DBだけのPreparedを正本にせず、外部Prepared／Completeとその両Checkpoint headを必ず照合する。IntentはCompleteまで自然失効させない。Key削除だけ／0-rowだけを完了証拠にしない。DB行除去後にKey破棄失敗してもIntentから全Versionを追跡できる。24時間の未達は運用違反として通知・封鎖し成功扱いしない。

退会はActor disabled終端・全Session失効後、Identity／Alias／全Identity DEKを24時間以内に除去。Group過去参照用actorIdは既存業務保持方針まで残し、Google本人との対応を復元しない。削除後のGoogle再登録を恒久禁止するIdentity tombstoneは残さず、再登録時は新Actorとなり旧Group権限を継承しない。退会受付と未完了支払・Owner責務・過去閲覧権は別Owner Decision／Task、未解決の間は退会UIとProduction有効化をしない。

Restore手順は次の順を必須とする。

1. Traffic／認証Writerを閉じたQuarantineでBackupを選択。35日超は拒否。ManifestにはUTC、Schema／key-state版、epoch、Checkpoint sequence／hashを記録し、秘密値・復号Payloadは含めない。
2. ADR #55相当の独立Failure domainのCheckpointとWitnessをlinearizable latest readで取得し、chain／MAC／attestation／head一致、sequence≥manifestを検証。不足・古いprefix・fork・片側rollback・障害なら開通しない。認証LedgerはGroup Ledgerへ直接Table参照せず専用Namespace／Portを持つ。
3. 最新削除LedgerのPreparedとCompleteを適用してdisabled Actor／削除Identity・Alias・Keyを再除去、DBに存在しないPrepared intentも再構成して再開。Ledger照合はactorId用の用途別削除仮名で行い、Google sub／直接IDをLedgerへ保存しない。Ledgerは最終関連Backup失効＋Prepared intent完了まで保持し、Provider latest headを復旧DBで巻き戻さない。
4. 復旧DBのAttempt／Sessionをすべて削除し全DEKを破棄する。既存Cookieを全拒否する新epochを外部制御状態へconditional publishし、旧epoch Writerをfenceする。端末は再ログイン。Identity／Actorだけを削除証跡に整合させて維持する。
5. Nonceの旧割当Stateを信頼せず、保持Identityの新規Sealには新DEK世代を発行。旧Keyは必要な読取だけ、旧KeyのSealを禁止。現行Digest世代へAliasを再構築し、重複／参照／破損／期限清掃を検査する。
6. 新しいCheckpointを条件付きappendしWitness一致を確認、削除0-row・全Key破棄証拠、epoch／鍵State・再ログイン・清掃を検証してからTrafficを開く。Forward-fix以外の破壊的Downをしない。

全Session破棄でも削除Identity／鍵の復活対策は省略できない。DBだけを復元して開通するRunbookを禁止する。具体Provider／IAM／外部証跡の耐改ざん性・Job／Runbook訓練はProduction Gateであり、Fakeでの契約Test成功を実運用証明にしない。

## 9. 後続Taskと受入Evidence

| ID | 一つのDeliverable／必須検証 | 依存・Ready Gate |
| --- | --- | --- |
| [A2 #213](https://github.com/takeshi-arihori/kakei_app/issues/213) | ADR案＋本仕様＋正式Task分割。独立Security／Planning Review、Owner承認、文書の整合 | #210／PR #211統合済み。詳細設計承認済み、PR #220統合待ちでReview |
| [A3 #214](https://github.com/takeshi-arihori/kakei_app/issues/214) | 認証Schema／Migration。空DBと既存Group DB、Unique／FK／Check、適用済checksum不変、未初期化鍵State拒否、空DB限定Down | Accepted A2・独立Security pass・A2 merge |
| [A4a #215](https://github.com/takeshi-arihori/kakei_app/issues/215) | 認証Codec／用途別Digest／Key・Nonce Port。Canonical Golden vector、全Metadata差替え拒否、用途分離、nonce burn／上限／世代・破損、既存Group vector不変 | A3 merge。具体Cloud Provider／wiringなし |
| [A4b #216](https://github.com/takeshi-arihori/kakei_app/issues/216) | PostgreSQL AuthenticationStore＋同Transaction Audit／TransactionScope。2接続の同Attempt／同Identity／Rotation／disable／Logout競合、全insert故障、Audit／鍵故障、commit応答喪失、idle／期限等値 | A4a merge。単一FakeでSQL原子性を代替しない |
| [A4c #217](https://github.com/takeshi-arihori/kakei_app/issues/217) | 清掃／削除Intent／Restore隔離契約とAdapter境界。24時間起算、CAS競合、再試行、外部Prepared前後／DB無効化commit前後／行削除／鍵破棄／Complete各段の故障と旧Backup復旧、全KeyVersion／0-row、35日境界・全Session破棄・epoch／古いLedger拒否 | A4b merge。外部ProviderはPort代替の契約検証、本番Gate維持 |
| [A5 #218](https://github.com/takeshi-arihori/kakei_app/issues/218) | HTTP／Cookie／CSRF／Origin／公開Errorの実API。OpenAPI、Rate limit／Proxy／body／開発Compositionの設計とDI、秘密値非漏出 | A4c merge＋公開境界Decisionと個別Ready評価。未確定限度値をコードで決めない |
| [A6 #219](https://github.com/takeshi-arihori/kakei_app/issues/219) | Googleボタン／login状態／logout画面。日本語・keyboard・狭幅、実API E2E、SDK差替CIと実Google手動を区別 | A5 merge＋Google開発設定／Composition承認。招待UI・本番有効化は別 |

すべてEpic #202の子Task、Project #9、Owner takeshi-arihori、Priority High、Milestone MVP設計。A2以外は初期Backlog／Blocked Yes、後続のEstimateは初期目安、先行merge後に個別Ready評価する。通常PRで前提merge後の最新developをBaseとし、未Merge CodeへのStackなし。API → UIの順を維持する。Production Provider／退会業務／Deploymentはこの表の完成で解消しない。

## 10. 検証・文書影響・外部根拠

本差分は実行Codeなし。TDD／API test／DB／Browser E2Eを省略し、相対リンク、表・Status・Task Trace、禁止情報scan、diff check、Self Reviewと新しい独立Evaluatorで検証する。Schema／ER／OpenAPI／正式業務図／AGENTS／Skillは後続変更時に同期し、今回は変更不要。現行Lifecycle契約・作業提案・ADR一覧・design-gatesへ本案のTraceを追記する。

使用Skill: prepare-github-work、pre-investigation、database-change、code-review。domain-design／api-design／domain-modeling／implementation／testing／stacked-pr-deliveryは、今回は業務／公開契約／実行Code／Stackを変更しないため省略。後続では変更範囲に応じて使用する。

2026-10-11確認の外部根拠: [OWASP Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)の保存最小化・認証付き暗号・鍵分離、[OWASP Key Management](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html)の用途・Lifecycle・復旧管理、[PostgreSQL 17 Lock](https://www.postgresql.org/docs/17/explicit-locking.html)と[Isolation](https://www.postgresql.org/docs/17/transaction-iso.html)のRow Lock／Transactionを参照した。具体のAAD、鍵Scope、期限、Restore時全Session破棄は本Projectの設計案であり、公式指定ではない。

設計Review: 新しい独立Security Reviewer cycle2と保存前work_planning_evaluatorはいずれもpass、Finding／不足Evidenceなし。Ownerは2026-10-11に詳細設計へ「はい。」と承認した。設計承認・レビューは実DB／Provider実証を代替しない。[ADR承認証跡 #212](https://github.com/takeshi-arihori/kakei_app/issues/212)、[設計Task #213](https://github.com/takeshi-arihori/kakei_app/issues/213)を参照する。

## 11. A4a暗号部品の実装Trace

[Task #215](https://github.com/takeshi-arihori/kakei_app/issues/215)はA3 Schema #214と是正 #222のdevelop統合後、個別Ready評価を経て認証専用Port／Codec／HMACを追加する。配置・Payload・Provider境界と検証限界は[認証暗号README](../../apps/api/src/shared/infrastructure/authentication/README.md)へ対応づける。A2の方式・TTL・Inventory・保持・鍵Scopeを変更しない。

Payloadは`payloadVersion: 1`＋全平文Metadataの`row` Copyと、Identityのissuer／subject、Attemptのnonce／csrf、Sessionのcsrf。Cookie DigestのCopyはcanonical unpadded Base64URLの32-byte表現。未知・欠落・duplicate Fieldを拒否し、JSONの数値はsafe integerを検査する。Headerの形式・Scope・Record・版を選択行へ照合し、AADは選択行から毎回再構成する。AAD byte列をCaller指定の保存入力として受け取らない。現在時刻・有効epoch・Actor状態・Alias一意性は後続Storeが判断する。

HMACは8固定用途ごとに独立型／Port／Namespaceを持ち、Provider返却の用途・世代・epoch不一致を拒否する。外部Ledger本文MAC／chain／WitnessはA4cの責務として維持する。合成Providerのnonce burn・並行割当・閾値・後退封鎖・世代更新TestはProvider契約のEvidenceであり、外部Providerの耐障害永続性・本番有効化を証明しない。DB・HTTP・UI・実Googleの接続はA4aの完成に含めない。

## A4c実装Trace

#217は[認証保守契約](authentication-maintenance.md)に従い、期限Policy、清掃／削除／Restore Coordinator、認証専用Ledger HMAC／chain／opaque証跡検証、PostgreSQLのLock／CAS／原子Audit／隔離移行Adapterを実装する。既存Schema v5／v6とEnvelope／AADを維持する。実PostgreSQL17で競合・Crash Window・旧Backup差戻しを検証するが、外部Providerは合成Portである。具体鍵／Nonce／全世代破棄、独立Ledger／Witness、外部Traffic fence、Backup真正性、Scheduler／監視の実配置は[運用Runbook](../operations/authentication-retention-restore.md)の本番Gateとして残る。HTTP／画面は#218／#219であり、退会受付と本番Compositionを含めない。

## A5 HTTP予算とのInventory境界

[HTTP契約](authentication-http-boundary.md)により、独立Schema `authentication_http`へ共有Rateの単一Policyと期限付きcounterを追加する。A2の認証Record/Envelope/AAD/既存MAC用途/保持を変更せず、Rate専用HMAC `auth-http-rate-subject/v1`と独立した256-bit鍵を使う。Raw IPは保存せず、用途・Namespace・Windowに束縛した32-byte仮名を24h以内に除去する。鍵照合値とPolicy Metadata以外の自由文・識別子は追加しない。列・制約・IndexとForward-onlyは[Migration Inventory](../../apps/api/migrations/authentication/README.md#version-7-http専用の共有rate予算)を参照する。

Ownerが承認した[localhost使い捨て例外](../adr/authentication-http-and-development-boundary.md)では、開発鍵はprocess終了で失われ、既存の認証Data/Metadataがあれば再起動を拒否する。永続Providerのdurabilityを実装済みとしない。[専用Runbook](../operations/authentication-local-development.md)の明示resetだけが再開手順であり、本番や既存開発Dataへの例外拡張はない。
