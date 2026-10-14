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

Providerは各Namespaceへ独立ランダム256-bit鍵を供給する。同じ鍵にpurpose文字列だけを加えた構成はこの契約を満たさない。`createAuthenticationDigests`には必要用途のPortを注入できるが、省略した用途の呼出しはunavailable。検索可能世代の列挙・Alias再導出と照合・世代移行・SQL一意性は後続Storeが所有する。外部削除Ledgerの本文MAC・chain・Witnessは後続#217で扱う。

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

`test/authentication-crypto-fixtures.ts`のRegistryは合成Provider instanceの外に割当を保持する契約Fake。後退／喪失TestはProviderの判定を注入してCodecの拒否・封鎖要求を確認する。Process crash、disk、別Failure domain、実Providerの後退検出・線形化・durability・全世代破棄・Restore耐性を実証していない。具体Provider／IAM／本番Compositionは引き続きProduction Gate。DB保存・Audit・競合は#216、清掃・Restoreは#217、HTTPは#218、Google画面は#219で検証する。

APIのUnit Testと型検査、依存方向、既存Group／Settlement vectorを含む回帰、root `pnpm check`で検証する。今回DB／HTTP／UI変更がないため、新DB結合／Browser／実Google手動のEvidenceはこの暗号部品の検証として追加しない。
