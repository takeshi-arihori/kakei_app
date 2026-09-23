# Snapshot Revisionの保護と保持境界

- Status: Accepted
- Accepted: 2026-09-20
- Decision Owner: Project Owner
- Decision record: [GitHub ADR Issue #55](https://github.com/takeshi-arihori/kakei_app/issues/55)
- Activation evidence: [Formal Security Review](https://github.com/takeshi-arihori/kakei_app/issues/55#issuecomment-5748185586)、[PR #70](https://github.com/takeshi-arihori/kakei_app/pull/70)、merge commit `d0546e46c614d4c081bb2adfd59da27cce9f70af`
- Amends: [ADR #24](shared-expense-domain-boundaries.md#承認条件-c1-snapshot-revisionの保護と保存)
- Amended By: [Group終了の整合性と保持期限境界](group-close-consistency-and-retention-boundary.md)、[Group operation locatorとGroup IDの保存契約](group-operation-locator-and-group-id-contract.md)
- Related input: [GitHub Task #54](https://github.com/takeshi-arihori/kakei_app/issues/54)
- Persistence dependency: [GitHub Task #42](https://github.com/takeshi-arihori/kakei_app/issues/42)

## Context

Settlement Snapshot Revisionは選択Expense、Expense内容、Participant Balance、Payment Instruction候補、必要承認者を不変に保持する。一方、Event、Snapshot、Logへ機密平文を保存しない不変条件がある。Group ManagementのParticipant、Invitation、履歴、operation結果にも、認可、再送、保存、削除を両立する保護境界が必要である。

このADRはADR #24の条件C1を満たすため、最小平文、Context別暗号境界、Group内参照権限、拒否・Audit、保持・削除、Backup Restore、初回Group Persistenceの採用方式を決める。Cloud／KMS Provider、本番本人性、全ContextのPersistence、Retention Coordinator実装は後続Gateとする。

## Decision

### 1. Data OwnerとContext境界

- Settlement Snapshot RevisionのData OwnerはSettlementとする。Envelopeの`contextName`は`settlement`とする。
- Group、Participant、Invitation、Membership／Invitation履歴、operation結果のData OwnerはGroup Managementとする。Envelopeの`contextName`は`group-management`とする。
- KeyはGroupかつContext単位で分離し、各Contextが公開Portを通して扱う。Context間のTable直接参照、他Context Keyの利用、暗号化Payloadの複製を禁止する。
- Retention Control LedgerはGroup lifecycleを所有するGroup Managementの運用メタデータとする。新しいBounded Contextまたは他Contextの業務Dataにはしない。

### 2. Plaintext inventory

許可した項目以外を平文Column、Log、Fixture、Audit、技術Snapshotへ保存しない。

#### Settlement

平文を許可する項目:

- Randomな`groupId`、`settlementCaseId`、`snapshotRevisionId`
- `revisionOrdinal`
- schema、key、algorithm、envelope version
- Ciphertext、Nonce、Authentication Tag
- 技術的な作成Timestampと削除Partition Timestamp

Settlement Context Keyで暗号化する項目:

- 平文Indexとの一致検証に使う`groupId`、`settlementCaseId`、`snapshotRevisionId`、`revisionOrdinal`の認証済みCopy
- 選択Expense ID、金額、実支払者、Split Allocation、負担額
- Participant Balance、Payment Instruction候補、必要承認者
- Approval／RejectedのParticipant、判断、時刻、理由
- `previousSnapshotId`とその他の業務Payload

Receipt画像、OCR結果、直接連絡先、認証情報、Token、Key material、transport metadataを業務Snapshotへ含めない。初期Projectionは作らない。将来ProjectionもSettlement Data Owner、Settlement Context Key、同じRetention／Deletion Portへ従う。

#### Group Management

平文を許可する項目:

- Randomな`groupId`と、Envelopeの入替防止に必要なRandom logical record ID
- CAS用`aggregateVersion`、`accessPolicyVersion`
- schema、key、algorithm、envelope version
- Ciphertext、Nonce、Authentication Tag
- 技術的な作成・更新・削除Partition Timestamp
- 用途分離Keyで作ったMembership、Actor、operation locatorのDigestとrequest fingerprint
- `group_operation_locator`のRandom `groupId` FK

Group Management Context Keyで暗号化する項目:

- Groupの業務属性、Ownerと`ownerAtArchiveParticipantId`
- Participant IDとActorの対応、Status、在籍Interval、`joinOrder`
- Invitationの業務Payload、Membership／Invitation履歴
- operationの入力Fingerprint根拠、成功結果、業務Error結果
- Access policy claimsとその他の業務Payload

Key material、直接連絡先、認証Token、Invitation Tokenの平文、復号済みPayloadをDB、Backup、Log、Fixtureへ保存しない。Digestは用途を跨いで再利用しない。

### 3. Protected record envelope

Node.js標準`crypto`のAES-256-GCM、256-bit Key、128-bit Authentication Tagを採用する。CallerはNonceを指定できない。`ProtectedRecordKeyPort`がKey versionごとの一意な96-bit NonceとSeal countを原子的に割り当てる。

- 2^31回のSealでRotationを要求する。
- 2^32回へ到達する前にFail-closedで新規Sealを拒否する。
- RestoreまたはProviderのCounter regressionを検出した場合はSealを停止し、Rotationを要求する。
- Key materialをDB、Backup、Log、Fixtureへ置かない。
- Rotationは現行・旧versionのdual readを許可し、rewrap／rehash完了と参照Window終了後に旧versionを失効する。

#### Canonical AAD

区切り文字連結を使わず、Version付きCanonical TLVを使う。Field順は次のType tag順へ固定する。

| Tag | Field |
| --- | --- |
| `0x01` | `envelopeVersion` |
| `0x02` | `algorithmId` |
| `0x03` | `app` |
| `0x04` | `contextName` |
| `0x05` | `recordKind` |
| `0x06` | `groupId` |
| `0x07` | `logicalRecordId` |
| `0x08` | `schemaVersion` |
| `0x09` | `keyVersion` |
| `0x0a` | `aggregateVersion` |
| `0x0b` | `revisionOrdinal` |

各Fieldを`1-byte Type tag`、`1-byte Presence tag`（absent=`0x00`、present=`0x01`）、`uint32 big-endian byte length`、UTF-8 byte列としてEncodeする。Mutable recordは`aggregateVersion`をpresent、`revisionOrdinal`をabsentにする。Immutable Snapshot Revisionは逆にする。

Canonical representationは次へ限定する。

- absentはPresence=`0x00`、length=`0`、Payload byteなしの1表現だけを許可する。presentはPresence=`0x01`、lengthが実際のPayload byte数と一致し、空値を許可しない。
- `envelopeVersion`、`schemaVersion`、`aggregateVersion`、`revisionOrdinal`は0〜2^63-1のunsigned整数をleading zeroなしASCII decimalで表す。`0`だけは1 byteの`0x30`とする。
- `groupId`と`logicalRecordId`はlowercase hexadecimalとhyphenを使うcanonical UUID文字列表現だけを許可する。
- `algorithmId`、`app`、`contextName`、`recordKind`はVersionごとのASCII enumと完全一致させる。`keyVersion`は`[A-Za-z0-9._:-]+`に限定する。
- すべての文字列はwell-formed UTF-8でEncodeし、NUL、制御文字、前後空白、余分なbyteを拒否する。

Unknown、Duplicate、順序違反、必須Field欠落、Presence tag不正、非canonical値、長さ不一致、Nonce／Tag長不正を復号前に拒否する。Envelope version、algorithm、Context、record kind、ID、schema、key、version／ordinalの不一致、認証失敗、破損はgeneric `Unavailable`とし、部分反映せずAlertする。S2はabsent長不正、leading zero、UUID case違反、不正UTF-8、空値、余分なbyteを拒否するTestを持つ。

Mutable Group rowは平文CAS versionと認証済み`aggregateVersion`の一致を要求する。Immutable Snapshotは`caseId`、`revisionId`、`revisionOrdinal`のUnique制約と認証済みordinalを要求し、復号した認証済みCopyの`groupId`、`settlementCaseId`、`snapshotRevisionId`、`revisionOrdinal`を平文Indexと完全一致させる。`settlementCaseId`だけを別Caseへ書き換えた場合も`Unavailable`として拒否する。Ciphertextだけ、Headerだけ、Versionだけ、別Row／別ContextのEnvelopeを差し替えても受理しない。

#### Golden test vector

これは相互運用Test専用の公開Vectorで、本番Keyまたは実在Dataではない。

| Item | Value |
| --- | --- |
| Key hex | `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| Nonce hex | `000102030405060708090a0b` |
| AAD fields | `1`, `AES-256-GCM`, `kakei_app`, `group-management`, `group`, `00000000-0000-4000-8000-000000000001`, same logical ID, `1`, `test-key-v1`, aggregate version `1`, absent revision ordinal |
| AAD hex | `0101000000013102010000000b4145532d3235362d47434d0301000000096b616b65695f61707004010000001067726f75702d6d616e6167656d656e7405010000000567726f757006010000002430303030303030302d303030302d343030302d383030302d30303030303030303030303107010000002430303030303030302d303030302d343030302d383030302d3030303030303030303030310801000000013109010000000b746573742d6b65792d76310a0100000001310b0000000000` |
| Plaintext UTF-8 | `{"groupName":"Example","ownerParticipantId":"participant-1"}` |
| Ciphertext hex | `3c20b169aa90b255ec2cf2a98bcb3d15e2bbf7589559735e57108be06f3961c07579cd95dfa07cec3dc05dd7aaf7494a9a3003e42ab7cdae12a60864` |
| Tag hex | `0ae81bdd10551bea4d6e951f71e9963f` |

AEADは、Ciphertext、Header、平文Version、Rowの部分的な入替を検出する。攻撃者またはOperatorがDB全体を相互整合した旧時点へ戻す攻撃は、AEAD単体の保証外とし、Checkpoint／WitnessとBackup運用で扱う。

### 4. GroupAccessPolicyPortと参照権限

Settlement ApplicationはGroup Managementの公開`GroupAccessPolicyPort`を使い、Group ManagementのTableを直接参照しない。

Group Management内部の`group_actor_access_index`は、Random `groupId`と`group-actor-access-index/v1`用途専用のGroup Keyで作ったActor digestを検索Keyとする。index missではAccess PolicyまたはSnapshotの復号Portを1回も呼ばず、存在非開示で拒否する。index hit後も下表の関与Predicateと固定versionを検証する。

| Actor状態 | 許可範囲 |
| --- | --- |
| Active Groupのcurrent Owner | 保持中の全Snapshot Revision |
| Active Participant | requester、required approver、Payment payer／payee、または選択Expenseの実支払者／allocationが0より大きいParticipantとして関与するRevision |
| Left Participant | 自身の過去Participant IDがrequired approver、payer、payeeとなる離脱前由来のRevisionまたは未完了責務。その他の離脱後Revisionは拒否 |
| Rejoined Actor | 旧Participant IDと新Participant IDを独立評価し、一方の権限を他方のRecordへ拡張しない |
| 非在籍者 | 許可しない。Group／Snapshotの存在を開示しない |

Group Archive時に`ownerAtArchiveParticipantId`を固定し、Archive後のOwner変更を禁止する。Owner-at-archiveがArchive後のOwner参照範囲を持つ。

`GroupAccessPolicyPort`のCallbackは対象GroupのAccess Policy rowをPostgreSQL `SELECT ... FOR SHARE`でLockし、固定した`groupVersion`／`accessPolicyVersion`の下で、必要最小復号、関与判定、Security auditのdurable保存、Response payloadのSerializationまで行う。

Accessへ影響するCommandは同じGroup ID順のLock orderで`FOR UPDATE`を取得し、`accessPolicyVersion`を増加させる。Owner譲渡、Leave、Rejoin、Archive、Membership／Invitation変更は例示であり、列挙外のCommandもAccessへ影響するなら同じInvariantへ従う。

Lock timeout、Connection loss、Deadlock、Callback例外、Return直前のVersion不一致はFail-closedとし、Payloadを破棄してTransactionをRollbackし、generic `Unavailable`を返す。Clientは同じ`requestId`でRequest全体を再送する。競合時は、ReadがMutationより先に完了するか、Mutationが先に成立してReadが拒否／再試行となるかのどちらかだけを許可する。

### 5. Security audit

処理順は本人性確立、Group access判定、必要最小限のSnapshot復号、関与判定、Security auditのdurable保存、応答の順とする。Audit保存失敗時は許可・拒否のどちらもgeneric `Unavailable`とし、復号済みPayloadを返さず破棄してAlertする。

Auditへ保存するのは次に限り、90日保持する。

- `occurredAt`、`requestId`、action、decision、reason code、policy version
- Group単位で用途分離したActor／Group／Resource pseudonym
- Actor／Group／Resource pseudonym、action、policy versionと、結果を変えるrequest semanticをCanonical TLVへEncodeして用途分離Keyで作ったrequest fingerprint
- `auditKeyVersion`

Payload、直接ID、連絡先、Token、Data Keyを保存しない。Audit KeyはGroup／Settlement Data Keyと別Namespaceにし、Group削除時に破棄しない。Retired Audit Keyは、そのKeyで発行した全Recordの90日保持とBackup 35日が終了してから破棄する。

同じ`requestId`かつ同じfingerprintだけを再送として扱う。同じ`requestId`でActor、Group、Resource、action、policy versionまたはrequest semanticが変わればfingerprint mismatchとして拒否しAlertする。並行再送でもAuditを重複させない。各入力Fieldを1つずつ変更するcross-resource／cross-action replay TestをProduction Security Gateに含める。Durable Audit Store、Unique制約、故障注入、Key Rotation／Retention RunbookはProduction Security Gateの後続Taskとする。

### 6. Operation locator

`findOperation(actorSubject, operationId)`は、`group-operation-locator/v1`、Actor、operation IDをCanonical TLVでEncodeし、用途分離Keyed digestを作って検索する。許容するLinkabilityは同じActor＋同じoperation IDの完全一致再送と、関連するRandom Group IDだけとする。

`group_operation_locator`はRandomな`groupId` FKを持ち、Group Management所有Dataの削除時に`ON DELETE CASCADE`でlocatorと暗号化済みoperation結果を削除する。同一operation IDで異なるPayloadはfingerprint mismatchとして拒否する。索引missでは復号Portを呼ばない。

### 7. RetentionとContext間削除

Group Managementは不可逆なKey破棄前に、`groupId`、`deletionToken`、`deletionOperationId`、時刻、state、最小errorだけを持つPrepared intentをdurable commitする。PreparedはCompleteまで自動失効させず、失敗をAlertし同じoperation IDで再試行する。

各Contextは自Context Dataだけを公開済みの冪等Deletion Portで削除し、次へ束縛したCanonical Receiptを返す。

- `deletionToken`、`contextName`、`deletionOperationId`、`intentVersion`
- `dataAbsent = true`
- `allContextKeyVersionsDestroyed = true`
- `completedAt`、`receiptKeyVersion`

ReceiptはContext DBで対象Group rowが0件であることと、Key Portが全Key versionの`Destroyed`または`AlreadyDestroyed`を確認した後だけ発行する。`AlreadyDestroyed`だけでは完了証拠にしない。Context秘密KeyをCoordinatorへ渡さず、各Contextの`verifyDeletionReceipt` PortがCanonical Field、MAC、Key versionを検証して型付き`VerifiedReceipt`を返す。Unknown／失効Key、偽造、別Context、古いintent、Replay／Mismatchは拒否しAlertする。

Context receipt verification KeyはData Keyと別NamespaceでRotationする。対応する全未完了Intentがなく、かつそのKeyで検証すべきReceiptを含み得るBackup 35日Windowが終了するまでRetired Keyを保持する。Restore後も同じ条件を満たすまで失効させない。Rotation、Retirement、旧Backup Restoreで正当Receiptを再検証できることと、期限外／Unknown Keyを拒否することをProduction Retention Gateで検証する。

Required Context（Group Management、Expense Recording、Settlement）すべてについて同じintent versionのVerified Receiptが揃った後、Group Managementは1 TransactionでPreparedのGroup識別子とReceiptを除去し、`deletionToken`、`deletedAt`、`reason = retention_expired`、`jobRunId`、`outcome`だけのComplete Tombstoneへ置換する。

- Group業務DataはGroupを終了してArchiveした`archivedAt`から1暦年後の`deleteEligibleAt`で削除する。
- Complete Tombstoneは`deletedAt`から1年保持する。
- Security auditは90日保持する。
- Backupは最大35日保持し、35日を超えるBackupからのRestoreを禁止する。

`deletionToken`はGroup Management Security Infrastructureの`DeletedGroupTokenKeyPort`から、`deleted-group-token/v1`と`groupId`のCanonical TLVをHMACして作る。Tombstoneへkey versionは保存しない。Verifierは現行・Retired Key全候補で照合する。Retired Keyは最終Token発行からTombstone 1年＋Backup 35日を超え、参照可能なTombstone／Backupがないことを確認してから破棄する。

Settlementの`SettlementDeletionPort`はSettlement DB削除、全Settlement Key version破棄、0-row検証、Bound Receipt発行を所有する。Expense Recordingも同じ責務を自Contextの後続Decision／Taskで確定する。Group Managementから他ContextのTableを直接Cascadeしない。

### 8. Backup Restoreのanti-rollback

`RetentionCheckpointStore`はApplication DB Backupと別Failure domainに置き、Immutable append、Linearizable latest read、Previous sequence／hashへのConditional append、Provider attestationを必須Capabilityとする。

独立した`CheckpointWitnessStore`へ同じSequence／HashをAppend-only／WORMで記録する。両Storeの一致を確認して初めてAppend完了とし、片側だけの成功はPreparedのまま復旧対象にする。

Restoreでは両StoreのLatest head完全一致、MAC／Attestation／Hash chain、SequenceがBackup manifest以上であることを要求する。Stale prefix、Fork、片側Rollback、Mismatch、UnavailableはQuarantineとしてTrafficを開かない。Restoreは最新Ledger／Tombstoneを適用し、未完了Intentを再開してからTrafficを開く。必要Keyの欠損・破損でもTrafficを止め、削除を飛ばさない。

両Providerが共謀して同時RollbackするRisk、Provider／IAM選定はProduction Deployment Gateで別Reviewする。

### 9. Initial PostgreSQL persistence

初回GroupRepository Adapterに、既存Local／Test基盤のPostgreSQL 17、Repository管理のVersion付きSQL Migration、raw `pg`を採用する。本番Adapterからimportするため`pg`をruntime `dependencies`へ昇格し、`@types/pg`はdevDependenciesへ維持する。

- Version付きMigrationを正本とし、実PostgreSQLへ適用して検証する。
- 空または未適用環境だけDown／Dropを許容する。
- Data適用後はExpand／ContractとForward-fixを使う。
- Connection Pool、Timeout、Credential、Supply-chain AuditをProduction Gateで扱う。
- ORMは別Decisionなしに追加しない。

SQLiteはConcurrency／Deploymentの別経路を増やし、Fake-onlyは実保存を満たさないため採用しない。

## Threat test matrix

| Threat / Failure | Expected result | Primary evidence task |
| --- | --- | --- |
| Non-member access | 存在非開示で拒否し、decrypt呼出し0、業務状態変更なし | S3／#42 |
| Stale Membership、Owner transfer／Archive race | 固定version＋Row Lockで旧権限のResponseを返さない | S0／S3／#42 |
| Ciphertext／Header／Version swap | `Unavailable`、Alert、部分反映なし | S2／#42 |
| 別Row／別Context swap | Canonical AAD不一致で拒否 | S2 |
| `settlementCaseId`だけの差替え | 復号した認証済みCopyとの不一致で`Unavailable` | S2 |
| noncanonical TLV | absent長不正、leading zero、UUID case、不正UTF-8、空値、余分byteを復号前に拒否 | S2 |
| Nonce再利用、Seal count上限、Counter regression | Seal停止、Rotation要求、上限前Fail-closed | S2 |
| Operation replay／fingerprint mismatch | 同一再送だけ既存結果、Mismatch拒否 | S3／#42 |
| Concurrent CAS | 1件だけCommit、敗者Conflict、部分履歴なし | #42 |
| Commit後応答喪失 | 同一再送で保存済み結果を返し二重反映しない | #42 |
| Key loss／Envelope破損 | `Unavailable`、Alert、部分反映なし | S2／#42 |
| 偽造・古い・Replay Receipt | Context verifierが拒否しComplete化しない | Production Retention Gate |
| Receipt verification Keyの早期失効 | 未完了IntentとBackup Window終了前は失効を拒否し、Restore後もReceiptを検証可能 | Production Retention Gate |
| Partial deletion | Preparedを保持して同じoperation IDで再試行 | Production Retention Gate |
| Stale／Forked Checkpoint、Witness mismatch | Quarantine、Trafficを開かない | Production Retention Gate |
| 35日以内の旧Backup Restore | Ledger／Tombstone適用と未完了Intent再開後だけTraffic許可 | Production Retention Gate |
| 35日超のBackup Restore | 拒否 | Production Retention Gate |
| Audit failure | 許可・拒否ともFail-closed、Payloadを返さない | Production Security Gate |
| same requestの並行再試行 | Auditと業務反映を重複させない | Production Security Gate／#42 |
| 同じrequest IDの異なるfingerprint | 拒否してAlert | Production Security Gate／#42 |
| 同じrequest IDでResource／action／policyだけ変更 | fingerprint mismatchとして拒否してAlert | Production Security Gate |

## Implementation split and gates

即時実装対象を次へ分割する。

1. S0: [Group終了Decision](group-close-consistency-and-retention-boundary.md)に従うClose Intent、Context fence／Receipt、`Closing`／`Archived`、`ownerAtArchiveParticipantId`、`archivedAt`、`deleteEligibleAt`、取消、Archive後拒否のDomain／Application Invariant。
2. S1: PostgreSQL Schema、Version付きMigration、Plaintext inventory、runtime `pg`、Migration／production import検証。
3. S2: Canonical TLV、AES-256-GCM Envelope、Key／Nonce Port、用途分離、Rotation／破損Test。
4. S3: `GroupAccessPolicyPort`、Membership／operation blind index、Policy version、Lock transaction contract。
5. #42: PostgreSQL GroupRepositoryの`load`／`findOperation`／`commit`、Row Lock、2接続CAS、状態・履歴・operation結果・索引の原子性、故障・応答喪失Integration Test。

S0とS1とS2はこのADRのAccepted記録と独立Security Reviewを依存とする。S3はS0／S1／S2／#40／#57、#42はS0〜S3を依存とする。

S0のContext間終了契約とAsia/Tokyo基準1暦年後の境界はADR #73が追補する。2月29日は翌年2月28日へclampする。これは本ADRのContext別Data Owner、暗号境界、Retention CoordinatorのProduction Gateを緩和せず、実fence／Receipt配送・永続化・保護は後続Taskまで本番へwireしない。

Key Provider、Durable Audit Store、Retention Coordinator、全Context Deletion Port、Checkpoint／Witness、Backup Restore Runbook、Cloud／KMS Providerが揃うまで、#42のAdapterをApplication Composition Rootへimport／wireせず本番配置しない。Architecture／CI TestでこのGateを機械検査する。

## Rejected alternatives

- DB透明暗号化だけ: ApplicationのGroup内認可、技術Snapshot／Logへの複製禁止、用途分離、削除証明を満たさない。
- 不可逆TokenだけのSnapshot: 金額、配賦、Balance、Payment Instruction、必要承認者の不変な業務参照を満たさない。
- Active Participant全員へ全Snapshotを許可する単一Application Key案: 漏えい範囲、Context間Linkability、Key侵害時のBlast radiusが大きい。
- Backupの自然失効だけ: 削除Intent、Context完了証拠、Restore時の再削除を証明できない。
- SQLiteまたはFake-only: PostgreSQLのTransaction、CAS、Row Lock、2接続競合と同じ実保存契約を検証できない。
- ORM追加: 現段階で新しい依存とMigration正本を増やすため採用しない。

## Consequences

- C1の最小化、暗号化、Group内認可、保持・削除、Backup／Projection、平文禁止Conflictは本ADRで解消する。
- Context別Key、用途別Digest、Lock、Audit、Deletion receipt、Checkpointにより実装と運用の責務が増える。
- 暗号化PayloadはDB上の任意検索性を下げる。
- AEADだけではDB／Backup全体の整合したRollbackを検出できない。Checkpoint／WitnessとProvider運用が必要である。
- #42の検証完了と本番配置可能性を分ける。Production Security／Retention／Deployment Gateを満たすまで本番へwireしない。
- Provider、IAM、両Checkpoint Providerの共謀、Key侵害時のBlast radius、Nonce利用上限は残Riskとして後続Reviewする。

## Security review and activation

Authorから分離したReviewerがPlaintext inventory、Canonical Envelope、Golden vector、Access matrix、Lock一貫性、non-member decrypt 0、Key／Digest用途分離、Audit、Operation locator、Deletion receipt、Checkpoint／Witness、Backup Restore、PostgreSQL transaction、Migration、Task境界を確認する。

`findings=[]`かつ`missingEvidence=[]`のpassを[Issue #55](https://github.com/takeshi-arihori/kakei_app/issues/55)へ記録し、2026-09-20の[PR #70](https://github.com/takeshi-arihori/kakei_app/pull/70)によるdevelop統合をもってC1の充足証拠が揃った。C1充足はS0〜S3または#42の実装完了、本番配置可能性を意味しない。

## Rollback and review trigger

このDecisionを取り消す場合は新ADRでSupersedeし、依存TaskをBlockedへ戻す。Migration適用後はADR文書だけをrevertせず、Expand／ContractまたはForward-fixを使う。

次の場合はSecurity Reviewをやり直し、必要なら新ADRを起票する。

- Access matrix、Retention、Plaintext inventory、Projection、Context間連携が変わる
- Algorithm、AAD、Nonce、Key Provider、Rotation、Digest用途が変わる
- Backup、Checkpoint、Witness、Restore、Deletion receiptが変わる
- PostgreSQL major version、Migration正本、Runtime dependencyが変わる
- 本番本人性、Audit Store、Cloud／KMS、Production wiringを採用する

## 実装Task配分の更新（2026-09-23、Decision変更なし）

上記の#42単独担当・主証拠記載はAccepted時のDelivery計画として保持する。#42の個別Ready評価後、PostgreSQL v2 Schema／Migration／CIは[Task #42](https://github.com/takeshi-arihori/kakei_app/issues/42)、暗号化Groupとoperation結果の読取・non-member／locator miss時decrypt 0は[#94](https://github.com/takeshi-arihori/kakei_app/issues/94)、状態・履歴・索引のCAS保存は[#95](https://github.com/takeshi-arihori/kakei_app/issues/95)、operation locator／resultの原子的commit・再送・rotation lockは[#96](https://github.com/takeshi-arihori/kakei_app/issues/96)、固定policy versionとSQL row lockは[#97](https://github.com/takeshi-arihori/kakei_app/issues/97)が主証拠を出す。旧表中の#42一括証拠はこの配分で読み替える。C1とProduction Security／Retention／Deployment Gateの条件は変えない。
