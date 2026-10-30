# 招待コードのLifecycle・保存・原子的消費の設計

Knowledge State: **Accepted（詳細設計。実装・個別Ready・Production有効化は別Gate）**。[ADR](../adr/invitation-code-lifecycle-and-protected-storage.md)と[設計Task #233](https://github.com/takeshi-arihori/kakei_app/issues/233)に対応する。2026-10-27のOwner明示回答「はいお願いします。」を承認証跡とする。本文は採用済み設計の契約であり、実装済みや本番利用可能とは意味しない。

## 要求・調査・責務

基準: `3b2f148b2c5483db825d5dab1cab8090370d8ee7`、2026-10-27の初回調査基準。Proposal PR #234はdevelop `72bc0d2f250fd079706677daedd9840fb100448c`へ統合済みで、その後のOwner承認を本追補で同期する。#233のScope 1〜5をR1 Lifecycle、R2本人束縛、R3一回消費/再送、R4保存/原子性、R5保持/復旧/公開境界としてTraceする。

| Evidence | 成立済み/Gapと判断 |
| --- | --- |
| ADR #203 / #52 / #36 | 登録済み本人のコード共有、Owner入力、本人受諾、Invitationの7日/版/人数/原子性/再送はAccepted。コード詳細は初回調査時に未決で、本Accepted設計が補完する |
| GroupCommandService inviteParticipant / acceptInvitationとspec | trusted Actorからの作成/本人受諾とGroup内原子性の内部契約。コード発行/検索/消費は存在しない |
| PostgresGroupRepository commit / GroupAccessPolicy | 自前接続・BEGIN/COMMIT。認証leaseへ自動参加しない。既存Groupの版/Owner/CASとoperation namespaceを再利用するがTransaction ownerを分離する必要 |
| AuthenticationStore withSession / TransactionScopes | caller Actor→Sessionを既にlockし、ScopeのObject identity/受付期間/失敗/確定本文を制御。追加宛先Actorの後付けlockや別接続の業務保存は不可 |
| A2 / 認証保守のPort・実PG integration | Actor MAC/用途別Digest/同一Scope/監査/清掃/Restoreの基礎はある。新コードRecord・共同lease・GM enlist・旧コードの復活防止は新設計/未実装 |

既存ActorSubjectは本人性参照のVO、GroupはOwner/在籍/人数/Invitationを所有するAggregate、InvitationはGroup配下の本人宛てRecord、Participantは在籍のEntity。新CodeSecretは技術入力値、RecipientCodeRecordは共有認証技術の状態Recordとし、独立した業務Aggregate/ContextやEvent Sourcingを追加しない。発行/取消は本人credentialの管理、Invitation作成/受諾はGMの業務操作へ分ける。

Domainはpg/暗号/Sessionに依存しない。GM Applicationが既存Groupの純粋判断と公開Portを調整し、共有認証ApplicationはGMをimportしない。接続/鍵/Scope参加はInfrastructureとCompositionが組み立てる。GMからauthentication SchemaをSQL参照したり、共有認証StoreがInvitation payload/Roleを保存したりしない。新しいコードPolicyを既存Invitationの7日Ruleへ混ぜない。

## R1 Lifecycle

コードは32-byte CSPRNGをpaddingなしBase64urlへEncodeした43文字。ASCIIの大小文字を区別し、decode後32-byteかつ再Encode完全一致を検査する。padding、空白/trim、大小変換、Unicode、非canonical末尾bitを拒否する。例の実秘密値や固定した共有Tokenを文書/Fixtureへ置かない。

TTLは発行判断点のUTC milliseconds + 600,000ms。期限が等しい/過去なら無効。時刻はLock待機後のServer Clockを使い、DB transaction開始時刻を流用しない。Client時刻や表示Timerは認可根拠にしない。期限は延長せず、状態だけの確認でも延長しない。

| 状態/操作 | 遷移・結果 |
| --- | --- |
| 本人が発行/再発行 | 有効Session/active Actorで、旧IssuedをReplaced、新RecordをIssued。旧コードを復活させず新コードを一度だけ返す |
| Issuedを本人が取消 | Revoked。別Actorの操作は拒否 |
| Issuedでnow ≥ expiresAt | 論理Expired。Batchが未実行でも利用不可。清掃の起算はexpiresAt |
| IssuedをOwnerが正常消費 | Consumed。Pending Invitation作成と一つのcommit |
| Consumed/Replaced/Revoked/Expiredを再利用 | 新しいInvitationを作らない。同じ成功operationの再照会だけはR3の例外 |
| Actor disabled/削除Preparedの既存fence | 直ちに新規発行/消費不可。Actor復活/再登録で旧コードを引き継がない |
| logout/Session期限 | 以後の管理操作は新Sessionが必要。コード自体はActorに束縛し、発行元Sessionだけの失効では止めない |
| Backup Restore | 全コード破棄、新epoch。旧コードは再ログイン後も無効 |

ActorあたりIssued行は最大一つ。期限超過Issuedも新規発行時に終端化する。再発行は旧行の失効、新行、Auditを一つのcommitとし、失敗時は旧コードを有効なまま残す（既に自然期限/Actor無効なら別）。複数端末発行はActor排他Lockで直列化し、後の発行だけが有効となる。

表示する秘密値は発行commit確認後の一回だけ。取得/状態確認はcodeId・状態・期限だけを返し、再表示しない。発行結果不明は同じ秘密値を復元せず、状態確認後に本人が明示再発行する。自動HTTP retry、Tab復帰や画面mountで再発行しない。二端末の成功Responseは後の再発行で古くなり得るため、画面はcodeId照合と状態確認を必要とする。UIの具体実装は後続。

取消入力は本人のcodeId（秘密値ではない）。保有者照合後、既に終端/清掃済みならAlreadyInactiveとして冪等に扱い、他人のcodeIdとの違いを外部へ漏らさない。取消/再発行で作成済みInvitationを取り消さない。Invitation取消は現在Group Ownerの別Command。

## R2 本人性・作成の契約

初回発行と管理の本人Actorは有効Sessionからのみ得る。HTTPのActorId/targetSubject/Role自己申告、メール/Google Profileを信用しない。コードにGroup/Participant権限を持たせない。

コードからの作成入力はcode、groupId、expectedGroupVersion、operationId。コードから得た宛先はServer内でのみ使い、別のtargetSubject入力を受け付けない。最小結果はgroupId/invitationId/versionで、Actor ID・連絡先・登録有無・Profileを返さない。独立したコード→Actor検索/preview APIを作らない。

| 契約ID | 分類/Concern | 条件・失敗時 |
| --- | --- | --- |
| IC-PRE-1 | PRE / Trust | callerの有効Session・active Actor。違反はUnauthenticated、業務変更なし |
| IC-PRE-2 | PRE / Input | canonical code/ID・正の期待版・operationId。形式不正で検索/業務書込をしない |
| IC-PRE-3 | PRE / Authorization | 新規作成は同判断点の現在OwnerかつActive Group、期待版一致。権限外/不在Groupは存在非開示。Closing/Archivedも拒否 |
| IC-PRE-4 | PRE / Credential | 宛先active、MAC/epoch/検索束縛が正しいIssued、now < expiry。違反はgeneric UnavailableToActor |
| IC-PRE-5 | PRE / Domain | 自己招待/宛先のActive重複なし、Active人数<4。違反時コードを消費せずInvitationも作らない |
| IC-POST-1 | POST / Application | Consumed、7日Pending Invitation、Invitation履歴、Group/Policy版、operation結果/Auditを一度だけ共通commit |
| IC-INV-1 | INV / Accepted業務 | InvitationはParticipant/枠ではない。受諾のみが新Participant/joinOrder/在籍履歴を作る（ADR #52） |
| IC-INV-2 | INV / 採用技術 | ActorあたりIssued最大一つ、一コードにつき新Invitation最大一つ |
| IC-FAIL-1 | FAIL / Atomicity | 形式/業務拒否/確実rollbackではコード/Invitation/Group/operation不変。許可された拒否Audit/Session idle更新は業務状態と区別 |
| IC-FAIL-2 | FAIL / Infrastructure | MAC/鍵/SQL/監査/Scope不正は汎用unavailable、固定Code Alert、部分確定なし。commit応答喪失だけは確定済みの可能性を保持 |
| IC-POST-2 | POST / Replay | 同じcaller Actor/operation/内容の成功再送は保存済み最小結果のみ返す。異内容Mismatch、別Actorは取得不可 |

IC-PRE-1/3/5、IC-INV-1と既存再送意味はAccepted ADR由来、コード詳細/新Port/保護表現は本Accepted ADR由来。新規作成と成功再送では適用条件を区別する。正しい成功再送には現在Owner/宛先active/コード有効/現在Group版を要求しないが、caller自身の現在有効Sessionと元Actor一致は必要。

コード横取りは本人受諾を代替しない。Ownerに見せるのは自分の作成結果だけで、宛先の登録状態をErrorや応答項目の違いで開示しない。宛先本人のPending一覧/受諾は自分宛てのInvitationだけを安全に読み、実Groupを確認する別API/UI設計に残す。

## R3 再送と秘密値非保存

GMのActor内・全Command/全Group共通operation namespaceを維持し、コード用の別operation locatorを作らない。新Command名は論理名CreateInvitationFromRecipientCodeとし、既存InviteParticipant入力とは異なるfingerprintとして区別する。

新fingerprintはcanonical TLVのaction/version、groupId、expectedGroupVersion、codeRequestProofKeyVersion、codeRequestProof。proofはGM専用の独立256-bit Keyで、purpose `gm-recipient-code-request/v1` とcanonical decoded 32-byte codeからHMAC-SHA-256を作る。raw codeをJSON fingerprint/成功結果/operation Envelopeへ入れない。codeId/targetActorは新規作成時の認証済み内部factsとして必要最小限を保護結果へ束縛し、外部Responseへ出さない。

保存済みoperationがある場合は、その保護Recordにあるproof鍵世代で要求codeのproofを再計算し、定数時間比較する。現在のproof鍵世代で既存fingerprintを作り直して誤Mismatchにしない。検索用authコードDigestと再送proofのKey/Purposeを共有しない。proof鍵は参照するGM operationが0件かつ関連Backupの35日window終了まで読取保持し、コード清掃/ActorのIdentity鍵破棄に巻き込まない。

コードが期限切れ/取消/清掃済みでも同じ成功結果を得られる。Group削除後はADR #55/#85に従いlocator/結果も削除される。結果を復活させず、旧コードも失効/epoch不一致で新規消費できない。失敗結果は成功operationとして保存しない。版/入力を変える再実行は新operationIdを使う。

COMMIT送信前の確認済みrollbackと結果不明を区別する。COMMIT送信後の障害はunavailableを返し接続を破棄、同operationを再照会する。新operationでの自動再作成・コード自動再発行・DB結果を推測した補償は行わない。

## R4 保存Inventory・鍵・原子性

以下は**採用済みのMigrationの論理設計**。設計Task #233ではSQLを追加/適用せず、後続[#237](https://github.com/takeshi-arihori/kakei_app/issues/237)の[version 8とInventory/適用手順](../../apps/api/migrations/authentication/README.md)でコードRecordと認証側鍵用途Metadataを追加する。既存PostgreSQL 17/raw pg/番号付き追加Migrationを使い、他Store/ORMを追加しない。GM保存/Audit・実lease・清掃/Restore・公開接続の実装や本番保証をSchema追加で完了扱いにしない。

| Record / Owner | 平文許可・認証 | 保存しないもの / 制約 |
| --- | --- | --- |
| authentication.recipient_code / 共有認証技術 | CSPRNG UUIDv4 codeId、recipientActorId FK、recordVersion、epoch、作成/expiry、status/terminalAt、検索keyVersion+32-byte Digest、MAC keyVersion+32-byte MAC | raw code、Google Identity/Profile、Session原値、Group/Invitation FKなし。Actorと時刻のDB内Linkabilityは本Decisionで許容する残Risk |
| authentication.key_state拡張 / 共有認証技術 | code検索/Record MACの用途別世代制御、epoch。既存世代は変更せず拡張検証 | 鍵Materialなし。旧Writer/旧Restoreが新種別をskipできるまま開通しない |
| GM operationの保護Record / GM | 既存Envelope Metadataのみ平文 | 新fingerprint/proof世代・codeId/宛先内部factsはGroup Envelope内。raw codeなし、別の平文Actor索引追加なし |
| 認証Audit / 共有認証技術 | 固定action/decision/reason、Server event/request ID、UTC、用途別Actor/コード仮名、Audit世代 | 直接ID、code/Digest/proof、IP/UA、SQL例外、Profileなし |
| GM Audit / GM | ADR #55の既存用途分離とrequest fingerprint | 認証AuditをGM Auditの代替にしない。同じleaseで両方durable保存 |

コード索引はpurpose `auth-recipient-code-lookup/v1` と32-byte codeのcanonical TLVを独立256-bit KeyでHMAC-SHA-256。検索はsearchable全世代、missはRecord MAC鍵取得/Group復号を行わない（認証本人判定は別）。複数codeIdにhitしたら選択せずunavailable+Alert。新規コードは全検索世代との衝突を確認し、CSPRNG異常/Unique衝突は全rollbackし利用者へ成功を返さない。

MACは独立したRecord別256-bit Key、purpose `auth-recipient-code-state/v1`。auth canonical TLV規則を使い、version付き順序を app/purpose/codeId/recipientActorId/recordVersion/epoch/lookupKeyVersion/lookupDigest/createdAt/expiresAt/status/terminalAt/macKeyVersion と固定する。既存A2 TLV/Envelope/Golden vectorを変更せず、新kind/versionのvectorを追加する。全Field・32-byte長・時刻safe integer・正の版・状態/terminal関係・固定600,000ms差を検証し、未知field/status/schemaを拒否。Actor/別Record/期限/世代/Digest/状態の差替えはMAC不一致。非秘密の最小MetadataのみなのでコードRecordにAEADは使わず、GCM Nonceも新設しない。Group operationは既存AEAD/Nonce契約を維持する。

検索原値を保持しないためコード検索鍵は再Hashしない。Writerは認証key-state共有Lock、切替は同じ行の排他Lock。新コードはcurrent世代のみ、旧世代はread-only、全保持コード行0件とBackup window終了後に退役する。MAC鍵のrotationでは、保持するRecordを旧鍵で検証して新世代で再MACし、当該Recordの読取に必要な旧世代を移行/Backup検証Windowまで保持する。ただしRecordが終端/期限切れ/Actor無効化による清掃対象になった場合は、R5の24時間以内の全Record MAC鍵世代破棄を優先し、Backupの読取保持を理由に延長しない。破棄済みRecordを含むRestoreではMACの再検証や旧鍵の復活を要求せず、信頼済みscope inventory/ticketへ束縛して行と全世代を除去する。検索用HMAC鍵とGM再送proof鍵はRecord MAC鍵とは別用途であり、それぞれの参照/保持条件に従う。認証済みの旧Record差戻し（状態/版を含む）やDB全体rollbackはMACだけで検知できず、DB侵害下の一回限りをMAC単独で保証しない。外部epoch/Restore隔離と運用監視を必須とする。

制約: PK codeId、FK recipientActorIdは既存Actorの物理保持に従い削除cascadeを付けない、Unique(lookupKeyVersion,digest)、Unique(recipientActorId) WHERE status=Issued、cleanup due索引、status/terminalAtとTTL/版/byte長のCHECK。Expiredは時刻由来でありPartial Uniqueのpredicateにnow()を使わない。発行時はActor排他Lock下で旧Issuedを終端化してからinsertする。制約はMAC/本人認可の代替ではない。

### TransactionとPortの契約

論理Port名は実装Taskで既存命名に合わせるが、次の能力/責務を本設計の契約とする。

- RecipientCodeSessionPort（共有認証Application契約）: 発行/取消/コード使用の入力からcaller Sessionと宛先hintを得て、必要Actorを先に並べてleaseを開始する。Callbackにはtrusted caller/recipient facts、opaqueな消費handle、既存AuthenticationTransactionScope相当だけを渡す。GM型/Domainをimportしない。
- RegisteredRecipientInvitationService（GM Application）: GM-owned Port経由で既存Group判断、operation照合、Invitation commit計画を調整する。本人対応/鍵処理をDomainへ混ぜない。
- EnlistedGroupRepository / GroupAuditWriter（GM Infrastructure）: 同じregistryのquery限定参加能力とscopeでGM-owned Tableだけを操作する。Poolを取得せずBEGIN/COMMIT/ROLLBACK/releaseを呼べない。既存stateWriter/operation codecを再利用し、standalone GroupRepositoryも同じ保存kernelへ委譲して重複を防ぐ。
- Lease owner（共有認証Infrastructure）: PoolClient/commit/rollbackを唯一所有し、消費handleのObject identity/一回受付、GM commit証跡handleとcodeId/recipient/operationの束縛、Audit成功、未await/握り潰しSQL失敗、確定Response handleのScope所有を検証してcommitする。Groupの業務内容はopaqueな参加者発行証跡として扱う。

consume handleだけを呼んでGM書込を省略したcallback、GM別scope/別接続、成功planと異なるcodeId/宛先、失敗planからの消費、二重consumeをcommit不可とする。証跡handleはCompositionで登録したGM参加Adapterの非公開registryが発行し、利用者入力や通常DTOから偽造できない。同じpoolを渡すだけではenlistの証拠にならない。

成功再送のpreflightは既存withSessionのcaller-only leaseでGM共通operationを検索し、保存fingerprint/proofを検証する。この分岐はコード行/宛先Actorを一切読まず、失効/清掃/破損したコードRecordへ依存しない。miss時は内部NoReplayだけをserializeしてそのleaseを終了し、業務変更なしの新しい専用leaseへ進む。preflightと新規処理は二つのTransactionだが、コード消費とInvitation作成は後者だけで一つのcommitである。専用leaseでもoperationを再照合し、preflight後に並行成功が成立した場合を収束させる。両leaseの間でSessionが失効すれば再認証を要求する。

既存withSessionの中で後から宛先Actorをlockしない。専用leaseを入口にし、既存AuthenticationStore public動作を暗黙変更しない。Groupから認証Tableへの直参照と共有StoreからGM SQLへの依存は追加しない。

### Lock順と判断点

新規作成の複合処理で順序を **認証key-state → GM locator/proof key-state → Actor UUID昇順 → caller Session → codeId昇順 → Group ID昇順 → GM結果/locator → Audit** とする。状態行は共有Lock、rotation/Restoreだけ排他。発行/取消/コード清掃は本人Actorを最初からFOR UPDATE、コード使用はcaller/recipientをFOR SHARE、Actor無効化は既存どおりFOR UPDATE。SessionはFOR UPDATE、コードと変更GroupはFOR UPDATE。

GM-onlyの既存CommandはGM key-state→Groupの部分順序を守る。Group Lockを取ってから認証Actor/Sessionへ戻るAdapterを作らない。通常withSession/Logout/認証清掃/鍵更新も既存Actor→Sessionの順序を維持し、参加により逆順を生まないことを受入検証する。

1. current epoch/用途別key-stateを固定し、Session/コード候補を非locking lookupする。候補のActorはhintであり認可根拠ではない。追加で必要なGM key-stateはActorより先に取得する。
2. 重複を除いたcaller/recipientのActorをUUID昇順でlockしActor MACを検証、caller Sessionをlock/検証。再lookupしてActor参照がhintと変わったら追加Actorを後付けlockせず、unavailableで全rollbackする。
3. 同一scopeでGM共通operationを先に検索する。hitは保存されたActor/action/Group/版/proofを検証し、成功再送なら最小結果を返す。この分岐では宛先の有効性・コード行/MAC/期限を要求しない。Group結果の読取/削除と必要Lockを揃える。
4. missなら現在Actor/Session、コード行をLock後に検証し、GroupをLockし現在Owner/Active/版/人数/重複をDomainで判断する。権限外はmembership indexによる存在非開示とGroup decrypt 0を維持する。コード/宛先不正と権限外を外部へ区別しない。
5. 全blocking Lock取得後にClockを再取得し、期限等値/ActorとSession状態/expectedVersionを再検証する。InvitationのcreatedAt/7日期限もこの判断点から算出する。GM保存計画・コードConsumed/MAC・operation/索引・両Audit・Session idle更新を同一scopeへstageする。
6. 新規作成ではserialize前にClock/期限を最終確認し、Callback受付をseal、証跡とpending query/失敗を確認、共通commit後だけ固定本文を送る。Google/メール/HTTP等の外部通信・利用者待機をTransaction中に行わない。B3はLock/statement/Transactionのtimeoutとキャンセルを設定可能な上限で検証し、待機打切りも全rollback/unavailableとする。具体運用値とProvider応答上限は本番Gateで検証する。

同operationの並行insert敗者はUnique制約の失敗を含め全rollbackする。確実rollback後に新Transactionで元operationを照会するだけとし、見つかればreplay/Mismatch、不在ならConflict/unavailable。新規業務処理の自動再実行はしない。失効/コードmissで拒否する前にも同scopeのoperationを再照合し、既に確定した成功再送を期限/清掃理由で誤拒否しない。

発行/取消/無効化が先にActor/コードを確定すれば後続消費は拒否し、消費が先ならInvitationは残り、その後のコード取消はAlreadyInactiveとなる。別Groupの競合でも同コード行Lockで一件だけ消費する。Owner譲渡/人数変化/Closing/受諾は同じGroup版/Policy Lockで裁定し、Conflictでコードだけを使わない。

拒否時は業務writeをstageする前に判定し、拒否Auditだけをcommitできる。業務write開始後のエラー/終端再検証失敗は全rollbackし、必要な拒否Auditを独立した拒否記録経路で残す。失敗Auditが成功したことを部分業務commitと混同しない。Audit失敗では許可/拒否の詳細を返さずunavailableとする。

## R5 保持・削除・復旧・公開

無効時点はConsumed/Replaced/RevokedのterminalAtまたはexpiresAtの早い方。Actor disabledならdisabledAtも含めた最早時点。24時間以内にコード行と全Record MAC鍵世代の除去を証跡化する。秘密値は最初から保持しない。MAC鍵を先に破棄して通常清掃のRecord検証を不能にしない。DB削除と外部鍵破棄の間はdurable ticketで再試行し、0-rowだけで完了としない。

Actor削除の対象inventoryへ全recipient-code Record/鍵を追加し、既存認証削除Prepared/Checkpoint/Witness/全世代closureに参加させる。GMの既存Invitation/過去Actor参照/operation結果をAuthenticationのcascadeで削除しない。disabled宛先の新規消費/受諾接続は必ず現在のActor状態を検証する。過去業務参照と退会受付のDecisionは既存Gateに残す。

Restoreは[運用設計](../operations/invitation-code-retention-restore.md)に従い、全コード/全MAC鍵世代を列挙して破棄し、新epochをDB外で公開する。認証Schemaだけの復旧/全Session破棄だけでGroupの成功operationやInvitationを巻き戻せると判断しない。全Contextで同じ整合した復旧点、既存GM削除Ledger/Checkpoint、認証Ledgerと独立Witnessを検証し、不足時はTrafficを閉じたままにする。

後続HTTPは同一Origin/有効Session/変更CSRF/厳格入力/総量上限/共有Rateを必要とする。コードをURL/履歴/referrer/Analytics/Console/例外/Log/端末の永続Storageへ置かない。発行/入力Responseはno-store、画面で秘密値を消去し、コピーは明示操作だけ。一般のAccount/コード列挙やcode→Profile照会を提供しない。

公開APIのPath/Schema/数値Rate/HTTP status、Groupの存在非開示と処理時間差の検証、Pending一覧のread policy、Proxy/Ingressは後続Taskで確定する。その契約/実Security証拠が揃うまで内部PortをHTTPへwireしない。既存4認証HTTP APIの仕様変更やProduction有効化を本設計に含めない。

## Threat / Verification matrix

実装Trace追補: [#239](https://github.com/takeshi-arihori/kakei_app/issues/239)は[専用Session lease/Scope契約](../../apps/api/src/shared/infrastructure/authentication/postgres/README.md#239-コード専用session-lease)を提供する。V02/V07/V13/V15のActor先行Lock、Session/コード参照再照合、最終期限、opaque消費/保存証跡/確定Response、未await/握り潰し/受付終了拒否、実PG2接続/rollback/commit不明/timeout/cancelを対象とする。登録GM準備/業務保存/コード消費Writerの正例は合成参加者であり、実GM Adapterとコード消費/Invitation/両Auditの業務atomicityは#242/#243で実証する。発行/取消Store本文は下記#240の追補に示す。#241のApplication契約は下記追補に示す。実GM保存/消費#242/#243、清掃/Restore#244/#245、公開契約#246と本番Gateは残る。

実装Trace: [#236](https://github.com/takeshi-arihori/kakei_app/issues/236)は[共有認証Application README](../../apps/api/src/shared/application/authentication/README.md)の入力値・最小Record構造検証・純粋Policy・内部Port/opaque型だけを対象とする。V01/V02/V03/V07/V11のPolicy/型の検証を、以下の実PG/暗号/HTTP/復旧の受入計画と区別する。実Session lease/registryは#239、原子的なGM統合は#243で実証する。

実装Trace追補: [#238](https://github.com/takeshi-arihori/kakei_app/issues/238)は[暗号README](../../apps/api/src/shared/infrastructure/authentication/README.md#招待コード専用暗号238)の認証3用途とGM-owned再送proof、Canonical TLV/独立参照vector、用途別Provider/全世代inventory/closure契約を提供する。V09/V10/V11の暗号・型・旧proof世代・非同期CopyのUnit範囲を対象とし、DB検索/世代切替/GM保存/両Audit原子性/清掃/Restore/公開経路の実証は後続Taskに残る。既存A2/Group形式は変更しない。

すべて**後続の受入計画**。本Taskの文書検証を実DB/暗号/Browser実証と扱わない。契約IDからTestを導出し、合成Actor/秘密値だけをその場で生成する。

| ID / Trace | Scenario | 期待結果 | Level / 後続担当 |
| --- | --- | --- | --- |
| V01 R1/PRE-2,4 | canonical43文字、大小、末尾bit、padding/空白/Unicode | 正規形だけを受理、形式不正でStore非呼出し | Unit / B1,B5 |
| V02 R1/PRE-4 | TTL直前/等値/後、Lock待機で期限越え | 直前のみ許可、等値/後は業務変更なし | Unit+2接続PG / B1,B3 |
| V03 R1/INV-2 | 二端末同時発行、発行応答喪失 | Issued一つ、旧コード失効、原値復元/自動再発行なし | PG+Browser / B3,B5 |
| V04 R2/PRE-1,3 | 別本人取消、未認証/他Group/非Owner/自己招待 | 存在非開示、業務変更なし。非在籍Group decrypt 0 | Unit+PG+HTTP / B1,B3,B5 |
| V05 R2/PRE-5 | 4人在籍/宛先既存在籍、Left宛先 | 4人/Active重複拒否、Leftは新Invitation可、コード先行消費なし | Domain+PG / B1,B3 |
| V06 R3/POST-1,INV-2 | 別Group/別Ownerが同じcodeを2接続で消費 | 新Invitation最大一つ、敗者に部分履歴/版/locatorなし | 2接続PG / B3 |
| V07 R1/FAIL-1 | 再発行/取消/Actor無効化と消費 | Lock先行順に拒否or一度の共通commit。作成済みInvitationはコード取消で消えない | 2接続PG / B3 |
| V08 R2/PRE-3,5 | Owner譲渡/Closing/人数/受諾と同時作成 | 同判断点のOwner/版/人数、Conflictでコード未消費 | 2接続PG / B3 |
| V09 R4/FAIL-2 | 全MAC field/別Actor/別row/epoch/digest/版差替え | generic unavailable/Alert、状態不変、未知形式拒否 | Golden vector+PG / B2,B3 |
| V10 R4/FAIL-2 | lookup/MAC/proof key世代切替、複数hit/鍵喪失 | 一件解決、複数hit拒否、旧成功再送は保存proof世代で検証 | Unit+2接続PG / B2,B3 |
| V11 R3/POST-2 | 同Actor/operation同内容、1field違い、別Actor、他Command | 同結果orMismatch/拒否、秘密値再保存なし、共通namespace | Unit+PG / B1,B3 |
| V12 R3/POST-2 | コード期限/取消/行清掃/Record破損後、Owner喪失後の成功再送 | 有効caller Sessionで最小保存結果、現在Group読取権を付与しない | PG / B3,B4 |
| V13 R4/FAIL-1,2 | 各write/監査/MACの故障、serialize失敗 | 全rollback、許可結果なし。拒否Auditの故障もfail closed | 故障注入PG / B3 |
| V14 R3/FAIL-2 | COMMIT前/送信後/応答喪失、locator Unique敗者 | unknownを失敗確定にせず同operation照合、二重作成なし | 故障注入PG / B3 |
| V15 R4/FAIL-2 | 偽Scope/他接続/終了後/未await/SQL握り潰し、偽/二重消費証跡 | 共通commit不可。別BEGIN/COMMIT権限なし | Unit+PG / B3 |
| V16 R5/FAIL-2 | 清掃24h、鍵破棄中断/全世代/Actor削除 | 最早due、証跡付き同operation再試行、過去GM参照維持 | PG+Provider契約 / B4 |
| V17 R5/INV-2 | 消費前BackupへRestore/期限内旧code、新Session | 全旧code拒否、新epoch発行、既存GM整合未証明なら隔離 | PG+復旧訓練 / B4,Production |
| V18 R5/FAIL-2 | 35日超/fork/stale Ledger/片側復旧/清掃skip | Traffic閉鎖、成功扱いなし | Provider契約+復旧訓練 / B4,Production |
| V19 R5/PRE-1〜5 | CSRF/Origin/Rate/入力上限/列挙/URL漏出/応答時間差 | 入口拒否/同等Error/秘密値Logなし、Rate値の実効性 | HTTP+Browser / B5 |
| V20 R2/INV-1 | 宛先が別Group/別本人のInvitationを受諾 | 元の7日/本人/空き枠/版/新Participant/再送契約を維持 | PG+Browser / B5 |

## 後続DeliverableとReady

下記B番号は本設計内の候補IDで、正式Issue番号ではない。Estimateは設計確定後に実作業範囲から行う。

| 候補 | 単一Deliverable | 必須前提 / 並行 |
| --- | --- | --- |
| B1 | コードPolicy/入力VOとGM新Commandの内部契約/fake検証 | 本ADRのOwner Acceptedと文書merge。B2と並行可 |
| B2 | recipient-code Schema追加MigrationとMAC/Digest/proof鍵Port/形式 | Accepted Inventory。必要ならSchemaと暗号部品へさらに分割、各1成果で起票 |
| B3 | 専用認証lease+GM共通Scope commit/両Audit/再送の実PG検証 | B1/B2 merge。lease/enlistとStore保存が独立検証可能ならTaskを分割 |
| B4 | 清掃/Actor削除inventory/全コードRestore失効の永続契約 | B3 merge、既存認証保守の拡張を実PG検証 |
| B5 | 公開API/共有Rate設計→発行/入力・本人Pending/受諾API→画面/E2E | B3/B4 mergeと公開契約/CSRF/Rate/存在非開示Decision。複数の独立Taskへ分割、#92/#90へTrace |

承認同期のdevelop統合後は、各先行merge後の最新developから通常PR、Stack不要。B1/B2だけ設計上は並行可。前提merge後は対象Policy/暗号vector/Migration/2接続/再送/削除Restoreの影響Testを再実行してから後続Readyを評価する。#233自身も承認同期のdevelop統合・完了条件確認前にDoneへ移さず、後続実装は個別Ready評価する。Provider/外部Ledger/Witness/物理Backup/退会業務/Deploymentの既存Production GateはB5完成でも残る。

## 文書同期・検証限界・Owner Decision

更新: 本仕様、Accepted ADR/一覧、design-gates、Backendの設計参照、運用設計。Schema inventoryは本設計の表であり、実ER/SQL/Migration/OpenAPI/GraphQL/正式業務図は実装/公開設計時に同期する。Accepted業務Concept/図を未実装のコード機能で書き換えない。Skill/AGENTS/既存暗号形式/依存Packageは変更不要。

使用Skill: prepare-github-work/pre-investigation/domain-design/specification-contract/database-change、文書検証のtesting、Self Reviewのcode-review。domain-modelingは既存の業務境界を維持して新業務概念を発見する要求がないため省略。api-designはB5、implementationはProduction差分なし、stacked-pr-deliveryはStackなし、prepare-pr-evidenceは視覚証跡要求なしのため省略。

Ownerは2026-10-27、提示済みADR案Aの7点（10分/一Actor一つ/再表示なし/logoutでは維持/認証技術所有/共通commit/MACと再送proof/清掃24h/復旧時全破棄）を採用した。具体ProviderやHTTP Rate数値、実装Ready・Production有効化まで承認済みとは扱わない。

外部根拠（2026-10-27確認）: [OWASPの一回使用Token指針](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)は乱数・十分な長さ・安全な保存・本人束縛・使用後無効化を確認する参考であり、Password Resetを本アプリの招待と同じUse Caseとは扱わない。[PostgreSQL 17 Lock](https://www.postgresql.org/docs/17/explicit-locking.html)と[Isolation](https://www.postgresql.org/docs/17/transaction-iso.html)をLock待機/順序/READ COMMITTEDの技術根拠とした。TTLや保存所有、MAC形式/共通Portの具体設計はProjectの採用Decisionである。

### #240 コード管理の実装Trace

[管理Store/lease](../../apps/api/src/shared/infrastructure/authentication/postgres/README.md#240-コードの発行取消状態確認)と[Migration9 Inventory](../../apps/api/migrations/authentication/README.md#version-9-コード管理監査240)が、R1/R4とV01〜V04/V07/V09/V10/V13/V14の発行・再発行・取消・状態確認部分を実装する。管理は本人Actor排他、読取は共有Lock/idle非更新。全searchable世代の衝突/複数hitを拒否し、旧Issued終端化・新Issued・コード用途監査・Session更新を共通commitする。状態確認は最小Metadataだけで、原値のserialize/永続化/復元を行わない。COMMIT結果不明ではunavailableとし、自動再発行を行わない。拒否Auditは部分業務commitを許さず、失敗後の独立した本人読取leaseで固定denyだけを記録する。結果不明のdenyは元の業務失敗確定を意味しない。

[明示Record鍵発行契約](../../apps/api/src/shared/infrastructure/authentication/README.md#コードrecord鍵の明示発行240)は新Recordの独立鍵生成と、旧Record再MAC時の同一Descriptor既存鍵確認を分ける。DB rollback後も孤立Scopeを有限期限の全世代inventoryへ残し、清掃/closure/Restoreへ引き継ぐ。合成Providerの実PG検証では具体Providerのdurability・全世代破棄・Backup/Restoreを保証しない。GM消費/Invitation/両Context Auditの業務原子性は#242/#243、清掃/Restoreは#244/#245、公開契約とUIは#246以降のまま。

### #241 GM Application契約の実装Trace

[RegisteredRecipientInvitationServiceと参加Port](../../apps/api/src/group-management/application/README.md)が、B1とV04/V05/V08/V11/V12/V20の内部Application部分を実装する。Client入力と有効leaseのfactsを分け、既存Group判断で7日Pendingを計画し、同scopeのstage/証跡/consumeを調整する。新fingerprintはGM canonical TLVのaction/version・Group・期待版・独立proof世代/値に束縛し、原コードを文字列fingerprint/保護operation/結果へ残さない。caller-only replayと新規lease内の再照合は保存proof世代を使い、現在Owner/宛先/code行に依存しない。

入力Copy、未知申告拒否、Domain拒否/版/人数/本人受諾/譲渡/Left再参加、異Actor/action/Group/版/codeのMismatch、preflight後の並行成功、応答喪失後の明示再送、Port障害と本文非漏出をfakeで検証する。独立TLV vectorと既存GM回帰も確認する。fakeの本人性・scope/証跡・commitは実認証/SQL/競合/原子的消費の実証ではなく、実Adapterと既存codec相互対応/共通namespace/decrypt0は#242、両Contextの共通業務commitは#243のEvidenceが必要。Domain Rule/公開API/Schema/Runtimeは変更せず、清掃/Restore/Production Gateを維持する。


### #242: GM保存と成功再送の認証Scope参加

[GM保存Adapter/共通kernel/同Scope Audit](../../apps/api/src/group-management/infrastructure/postgres/README.md)と[Migration10 Inventory](../../apps/api/migrations/group-management/README.md#version-10-招待コードからのgm保存参加242)が、B3とV08/V10〜V15のGM保存部分を実装する。prepareでGM locator/proof key-stateをActor前に固定し、借用queryだけで認可Group/Policy/Invitation履歴/保護operation/共通locator/GM Auditをstageして実registryへattestする。standaloneは同kernelへ委譲し、Unique敗者の全rollback後の照会を維持する。新旧payload/actionは同じnamespaceで相互Mismatchにし、既存Envelope/AADを変更しない。

実PGでは、コード行なし・現在Owner喪失・current proof鍵未設定でも保存proof世代で再送し、非在籍decrypt0、各write/Audit障害の全rollback、偽計画/他Scope本文/未await/SQL握り潰し拒否、同Actor/op別Group競合、key-state rotation/timeoutとGroup CASの2接続裁定、結果不明後の明示照会を確認する。proof参照は保護結果内に保持し、破損をskipして0件としない。0件でも関連Backup35日closureが必須で、Adapterに破棄能力を持たせない。GM Auditは直接IDなし・Group削除cascadeなし・独立用途/要求semanticに束縛する。

この検証の認証ownerとコード消費Writerは合成であり、実Session本人性、実コード消費とInvitation/両Context Auditの業務atomicityを実証しない。#243の最終統合、#244/#245の清掃/Restore、#246以降の公開契約と既存Production Gateを維持する。Audit成功Writerの追加は、汎用Snapshot Audit/拒否記録/90日清掃や具体Provider運用の完成を意味しない。


#242の境界補強: 新規業務write前の`beginPlan`がscope/handle/code/宛先/operation/本文を一回受付し、GM DMLをその計画だけへ限定する。保存後のattestも同じoperation/本文を再照合する。caller-only Scopeでstageし非SQL障害を握り潰すケースを実PGでRedにし、受付前拒否/Scope失敗記録と未完成計画の全rollbackを確認した。これはAcceptedの部分確定禁止を実装へ写像した技術的受付であり、新しい業務InvariantやData Ownerの変更ではない。認証owner用query、共有認証からGM SQL/Domainをimportしない境界、#243以降のGateは維持する。
