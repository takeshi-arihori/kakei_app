# 認証の暗号境界

[Task #215](https://github.com/takeshi-arihori/kakei_app/issues/215)／[Accepted A2](../../../../../../docs/security/authentication-protected-storage.md)に従うAPI内部部品。Google SDK検証Adapterとは別に、認証行の完全性と用途別検索値を扱う。DB保存・HTTP・ログイン画面・本番鍵Providerの完成を意味しない。

## 責務と利用

Portと保存型は`shared/application/authentication`、具体暗号はこのDirectoryに置く。業務ContextやGroup IDを追加せず、既存Group／Settlement Codec・形式・vectorを変更しない。新Package／本番依存の追加はない。

- `canonical-authentication.ts`: 厳格UTF-8、UUIDv4、safe integer、Base64URL、Canonical TLVと全行MetadataのRow Binding。
- `authentication-payload.ts`: version付き最小JSON、duplicate／未知／欠落Field拒否、選択行と全Copy照合。
- `authentication-record-codec.ts`: AES-256-GCM、Provider割当とRotation要求、選択行からAAD再構成。
- `authentication-digests.ts`: HMAC-SHA-256、独立用途・世代・epochの検証、32-byte値の`timingSafeEqual`。
- `google-id-token-verifier.ts`: 既存Google SDK検証。Actor登録・Session発行・今回の暗号処理を所有しない。

Storeは選択した行を`seal({ row, secrets })`／`open({ row, envelope })`へ渡す。NonceとDEK世代はCallerが指定できない。形式不正は鍵割当前に拒否する。Codecは現在時刻・有効epoch・Actor認可を判断せず、StoreがLock下で判断する。Metadata更新は版を上げて新Nonceで再Sealする。

## 保存形式

Envelopeは`header`／`nonce`／`ciphertext`／`authenticationTag`のみ。HeaderはA2の10項目（envelopeVersion、algorithmId、app、owner、recordKind、keyScopeId、logicalRecordId、schemaVersion、keyVersion、recordVersion）。Versionは1、AES-256-GCM、appはkakei_app、ownerはauthentication。AADを保存入力として受け取らず、全Headerと選択行を検証して再構成する。Headerだけを期待値にして復号しない。

AADはtag 1〜10のHeaderと、tag 11のbinary Row Binding。Row BindingはA2記載順に全平文Metadataを含む。IdentityはActor別Scope、Attempt／SessionはRecord別Scope。nullable terminalAtだけabsenceを許可する。TLVはtag／presence／uint32 BE長／内容。未知・重複・欠落・逆順・余分byte、不正UTF-8、空Field、制御文字、非Canonical UUID・数値・秘密値を拒否する。文字列をtrim・Unicode正規化しない。

PayloadはUTF-8 JSONで、`payloadVersion: 1`と`row`（recordKindを含む全Metadata Copy）を持つ。Identityはissuer／subject、Attemptはnonce／csrf、Sessionはcsrfだけを追加する。Cookie DigestのCopyはcanonical unpadded Base64URLで32-byteを表現する。nonce／CSRFもcanonical Base64URLの32-byte値。Cookie原値、Token、email、Profileを保存しない。

Parserはroot／rowだけのObjectを受理し、escape表記を含むduplicate Key、未知・欠落Field、配列、余分なJSON、BOM、不正UTF-8、孤立surrogateを拒否する。JSONの数値はsafe integerを検証し、TLVにはcanonical十進で書く。復号後、全Metadata Copyを選択行と照合する。await前に入力をCopyし、Row／秘密値／Envelopeの後続変更を認証対象へ反映しない。

## 鍵と用途

認証DEK、Group DEK、用途別HMAC鍵・出力は異なるBrand。HMAC鍵はRuntimeにもpurposeを持ち、PortはIdentity検索、Attempt Cookie、Session Cookie、Audit Actor／Attempt／Session、Deleted Actor、Actor状態MACごとに分ける。Provider結果のpurpose・世代・epochを照合する。Cookieのepoch以外はepoch=null。

HMAC用途・入力順はA2の固定表どおり。Actor状態MACは本人性・版・state・作成日時・nullable無効化日時を束縛する。Identity DEK破棄後も独立鍵で検証する。秘密値・保存MACは固定32-byteをNode標準の定数時間比較で照合し、形式不正を一致にしない。Timing benchmarkによる定数時間性の実証を主張せず、採用primitiveと呼出し境界を確認する。

Providerは各Namespaceへ独立ランダム256-bit鍵を供給する。同じ鍵にpurpose文字列だけを加えた構成はこの契約を満たさない。`createAuthenticationDigests`には必要用途のPortを注入できるが、省略した用途の呼出しはunavailable。検索可能世代の列挙・Alias再導出と照合・世代移行・SQL一意性は後続Storeが所有する。外部削除Ledgerの本文MAC・chain・最新attestation検証は#217の`authentication-ledger-evidence.ts`が所有する。具体Checkpoint／Witness Providerは本番Gate。

## Nonceと障害

DEKはIdentityでActor別、Attempt／SessionでRecord別、kindごとに独立する。Providerはkind＋Scope＋keyVersionごとに12-byte Nonceと正のSeal countを原子的・durableに単調割当し、外側DB rollbackや暗号化後故障でもburnする。Global Root＋Actor IDによる再導出、乱数Nonceだけに任せる方式を使わない。

2^31回目からRotationを要求し、2^32回目の暗号化は実行しない。Counter後退・喪失・Restore・旧読取世代は新規Sealを拒否し、独立した新DEK世代へ切替える。旧世代はProviderが許可する読取だけに使い、Destroyedは永久拒否する。Codec内のメモリCounterでdurabilityを代替しない。Rotation要求が失敗した場合もSealを成功させない。

形式・差替え・認証・鍵障害は同じ`AuthenticationCryptoUnavailable`（status=unavailable）。Alertは固定operation／Codeだけで、ID・鍵・Payload・Provider例外を含めない。Alert故障は汎用失敗を置換しない。CopyしたDEKは操作終了時にzero化するが、JavaScript heapやcrypto内部Copyの完全消去は保証しない。

## 検証と限界

| 契約 | Evidence |
| --- | --- |
| Canonical表現 | 固定TLV、UTF-8／tag／presence／長さ／UUID／整数／Base64URL／未知Field、状態・期限整合 |
| Payload | 全Metadata Copy、duplicate・escape重複・未知／欠落・不正secret、正しいTagを持つ不正Payloadの拒否 |
| Envelope | 3kindの固定vector、全Header／全Row Field、Nonce／Ciphertext／Tag各byte差替え、別Scope／kind／epoch、鍵不在・廃棄 |
| 用途分離 | 8用途のPython参照HMAC vector、Port／Brand型検査、世代・epoch・用途不一致、独立状態MAC |
| Provider契約 | rollback burn、並行Nonce、Provider再生成、2^31／2^32境界、Counter後退／喪失、旧世代拒否・新世代切替 |
| 非同期の境界 | Seal／Open中のCaller変更、Rotation中のProvider Buffer変更、Provider／Rotation／Alert故障 |

`test/authentication-golden-vectors.json`は公開用の既知合成鍵`00..1f`とNonce`00..0b`による固定vector。TLV／JSONはProduction Moduleを読まない独立Python参照計算、AES primitiveはNode標準で生成した。全3kindのAAD／Payload／Ciphertext／Tagを固定する。HMAC vectorもPython標準hmac／hashlibによる参照値。実鍵・Token・PIIではない。

`test/authentication-crypto-fixtures.ts`のRegistryは合成Provider instanceの外に割当を保持する契約Fake。後退／喪失TestはProviderの判定を注入してCodecの拒否・封鎖要求を確認する。Process crash、disk、別Failure domain、実Providerの後退検出・線形化・durability・全世代破棄・Restore耐性を実証していない。具体Provider／IAM／本番Compositionは引き続きProduction Gate。DB保存・Audit・競合は[#216のStore境界](postgres/README.md)、清掃・Restoreは[保守契約](../../../../../../docs/security/authentication-maintenance.md)と#217の専用Adapter、HTTPは#218、Google画面は#219で検証する。

APIのUnit Testと型検査、依存方向、既存Group／Settlement vectorを含む回帰、root `pnpm check`で検証する。今回DB／HTTP／UI変更がないため、新DB結合／Browser／実Google手動のEvidenceはこの暗号部品の検証として追加しない。

## 認証保守の証跡境界

`authentication-ledger-evidence.ts`は専用256-bit HMAC、application／用途／namespace付きCanonical TLV、SHA256 chain、全page連続性、freshな両latest head／attestation、Prepared→Complete版とManifest hash所属を検証する。検証済みhead／intentは所有registryに登録し、構造だけの証拠を受理しない。retired MAC鍵は検証専用で新規appendを拒否する。全鍵破棄／外部fenceの保証は専用Port提供者が所有し、Test-only合成実装をProductionへimportしない。詳細と未実装本番Capabilityは[保守契約](../../../../../../docs/security/authentication-maintenance.md)と[Runbook](../../../../../../docs/operations/authentication-retention-restore.md)を参照する。

## 招待コード専用暗号（#238）

[Accepted R3〜R5](../../../../../../docs/security/invitation-code-lifecycle.md)に従い、`recipient-code-crypto.ts`が検索・コード別状態MAC・Audit仮名を所有する。Port/Brandは`shared/application/authentication/recipient-code-crypto-ports.ts`、GMの証明Portは`group-management/application/recipient-code-request-proof.ts`、Node Adapterは同Contextの`infrastructure/recipient-code-request-proof.ts`。共有認証からGMへ依存しない。既存A2/Group Envelope・vector・Purpose集合を変更しない。

| 用途 | ProviderのScope / epoch | Canonical TLV入力（記載順） |
| --- | --- | --- |
| `auth-recipient-code-lookup/v1` | authentication / null | app / purpose / canonical decoded 32-byte code |
| `auth-recipient-code-state/v1` | codeId UUIDv4 / null | app / purpose / codeId / recipientActorId / recordVersion / Record epoch / lookupKeyVersion / binary lookupDigest / createdAt / expiresAt / status / nullable terminalAt / macKeyVersion |
| `auth-audit-recipient-code/v1` | authentication / null | app / purpose / codeId |
| `gm-recipient-code-request/v1` | group-management / null | app / purpose / canonical decoded 32-byte code |

appは`kakei_app`。各Fieldはtag 1開始・記載順、presence 0/1、uint32 BE長、UTF-8またはbinary。absenceは状態MACのterminalAtだけ。状態MAC形式は`canonical-recipient-code.ts`でencode/decodeし、全Metadataの構造、TTL600000ms、UUIDv4、正のsafe integer、非負のUTC milliseconds、ASCII鍵世代1〜255文字、負のzero拒否を検査する。未知/欠落/余剰/重複/逆順tag、UTF-8不正、空Field、非Canonical数値は拒否する。自己MACは入力に含めず、Epochの現在有効性・時刻/Actor/Session認可は後続lease/Policyが判断する。

各用途は独立ランダム256-bit鍵を使い、状態MACはさらにcodeId別。Providerの返却purpose/version/epoch/scope/32-byteを照合する。同じMaterialへ用途文字列だけを追加して鍵を共用したり、IDから再導出したりしない。Import関数はCopy/形式検証であり、Materialの独立乱数性を検証した証拠ではない。コードRecordにAEAD/Nonceを追加しない。Lookup/Audit出力は用途/世代/Scope付きWrapperと既存用途別Byte Brand、GM proofには別のGM-owned鍵/値Brandを使う。保存Byte列を再構成するAdapterも選択した用途/世代/Scopeを検証し、構造だけで認証済みと扱わない。

`recordMac`はMAC自身を除いたMetadataを受け、`verifyRecord`は保存MAC付き行全体を検証する。MAC不一致・形式/鍵障害は固定`RecipientCodeUnavailable`と固定分類Alert、入力/ID/鍵/元例外を含めない。Lookupの正規値不一致だけはfalse、GM proofの正規入力不一致だけはfalseとし、後続Use Caseが存在非開示/Mismatchへ写像する。GMは新規proofの`create`だけに選択current世代を渡し、`verify`には保存proofだけを渡す。保存世代で計算し、現在世代の指定/コード行/認証鍵を要求しない。GM operationの既存Envelopeへ証明と世代を保存する接続は#242。

鍵取得前にCallerのMetadata/入力/保存Byte列を同期Copyし、Provider返却MaterialもCopyして操作終了時にzero化する。Providerの元Bufferや返却値へ依存を残さない。比較は固定32-byteを検証した上でNode `timingSafeEqual`を使う。通知失敗を汎用失敗へ置換せず、JavaScript heap/crypto内部Copyの完全消去や経路全体の時間差非開示は保証しない。Node primitiveの根拠は[公式Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptotimingsafeequala-b)。

### 鍵寿命の分離

- Record別MACの通常rotationは旧MACを検証して再MACし、必要な旧世代を読取保持する。ただし最早の終端/期限/Actor無効化+24hまでの**全世代破棄をBackup読取保持より優先**する。
- `recipient-code-key-lifecycle.ts`のinventory/closure PortはreadKeyとは別能力。全current/旧/廃棄済み世代と認証済みInventory版、同operationの永久Scope封鎖、全世代破棄、closure真正性/所属の照合を要求する。証拠参照の文字列だけでは完了にしない。#244/#245がdurable ticket/DB削除/0-row/復旧時の信頼済みInventory照合へ接続する。
- Lookup鍵は全参照0件かつ関連Backupの35日window終了後に退役する。GM proof鍵は参照するGM operationが0件かつ同Backup window終了まで保持し、コード行/Record MAC鍵清掃やActor Identity鍵破棄に巻き込まない。Audit仮名鍵の保持は参照Auditの既存90日保持/Backupと整合させ、Record清掃へ混在させない。

本TaskはProviderの読取/保守契約とNode暗号部品だけ。具体Provider・全世代の外部durability/永久封鎖/closure真正性・24h運用・35日Backup・Session lease・SQL/Audit原子性・清掃/Restore・公開経路・本番Compositionを実証したとは扱わない。

### 検証

`test/generate-recipient-code-vectors.py`はProduction TypeScriptを参照せず、Python標準hmac/hashlib/structで公開合成鍵・decoded byte列から5つのTLV/HMAC vectorを計算する。`test/recipient-code-golden-vectors.json`はlookup/issued/consumed/audit/proofを固定し、原コードの43文字表現はFixtureへ保存しない。再計算はこのDirectoryから `python3 test/generate-recipient-code-vectors.py`。既存A2/Group vectorを上書きしない。

Unit Testは全MAC Fieldの差替え、別Record/用途/Scope、鍵不在/廃棄/例外/誤Descriptor、型の誤用、旧proof世代、Caller変更、固定長比較の境界、通知失敗を確認する。Lifecycle Portは契約だけで、合成Providerの成功を本番鍵破棄の証拠としない。DB/HTTP/UI変更がないため新PG/Browser検証は行わず、既存暗号/Architecture/API全体とroot checkを回帰する。

## コードRecord鍵の明示発行（#240）

`RecipientCodeStateKeyAllocationPort.allocate`は読取`RecipientCodeKeyPort`と別能力である。codeId/現行MAC世代ごとに独立256bit鍵をProviderが生成し、DB外の全世代inventoryへ登録してから、codeId/keyVersion/expiresAt/createdの固定Ackだけを返す。StoreはDescriptorを完全照合し、秘密Materialを受け取らない。`readKey`で未知Scopeを暗黙生成しない。

新Recordではcreated=trueを必須とする。旧Recordを現行世代で再MACする際、同一Descriptorの鍵が既にある場合だけcreated=falseで再確認し、既存Materialを変えない。これにより鍵確保後のDB rollbackから本人が明示再発行しても、旧Recordの鍵を上書きしない。Descriptor不一致、破棄済みScope/世代、全世代closure済みScopeはunavailable。発行結果不明からProvider鍵やコード原値を復元しない。

Provider割当はDB rollbackで消えない。新コードの保存失敗/結果不明で孤立したScopeもexpiryを持つinventoryに保持し、終端/期限/Actor無効化の最早時点+24h以内の全世代破棄へ含める。旧Record再MACでも期限を延長しない。#244/#245のdurable ticket/closure/Restore照合と具体Providerのdurability・上限・監視が未実証であり、合成Mapの成功では本番を有効化しない。コード監査鍵はlookup/状態MAC/Actor監査と独立し、既存認証Audit共通世代ラベルに対応する`auth-audit-recipient-code/v1`のauthentication Scopeを使う。
