# Restoreの全Context整合証跡と招待コード参加の契約

- Status: **Accepted（設計。実装・個別Ready・Production有効化は別Gate）**
- Proposed Date: 2026-11-11（Asia/Tokyo）
- Accepted Date: 2026-11-12（Asia/Tokyo）
- Decision Owner: Project Owner（2026-11-12、会話承認。論点1〜8と副論点A・Bを推奨どおり採用）
- Decision / Design Task: [#278](https://github.com/takeshi-arihori/kakei_app/issues/278)。後続実装は[#245](https://github.com/takeshi-arihori/kakei_app/issues/245)（分割案は本書の末尾）
- Epic: [#202](https://github.com/takeshi-arihori/kakei_app/issues/202)
- Decision Check: 方針変更あり（RestoreのPort契約、Manifest、`evidenceDigest`の意味、Providerへの要求を決める）
- Supplements / Amends: 下の[既存Decisionとの関係](#既存decisionとの関係)に示す。既存ADRの本文とStatusは変更しない
- 基準: develop `bff5d7e`（2026-11-10）

## Problem / Context

Accepted設計は、Restoreで全招待コードを破棄し、全Contextの同じ復旧点とGMのLedger／Witness最新headを検証してから開通することを要求する（[運用設計](../operations/invitation-code-retention-restore.md)のBackup Restore 2／3／6／7、[設計契約R5](../security/invitation-code-lifecycle.md#r5-保持削除復旧公開)、V16〜V18）。一方、その検証を認証Restoreへ要求するPortの契約は、どのAccepted文書にもない。

現状の事実（2026-11-10の事前調査、基準`bff5d7e`）:

- `createAuthenticationRestoreService`の順序は、close → verifyClosed → 35日検査 → isolate → Ledger latest → Actor票照合 → 削除再適用 → Attempt／Session破棄 → `publishEpoch` → `migrateIdentity` → recovery append → `activate` → `open`。コードもGMも登場しない（`authentication-restore-service.ts`）。
- `AuthenticationBackupManifest`は認証専用（取得UTC、schemaVersion、key-state版、epoch、認証checkpoint）で、全Context復旧点の識別子を持たない。`isolate`は`schemaVersion !== 6`を拒否する（`postgres-authentication-restore.ts`）。現行の認証Schemaはversion 11である。
- 公開世代の用途は既存9種で固定され、`migrateIdentity`は`key_generation`を全削除して公開世代だけを再投入する。コード用途（`recipient-code-lookup`、`recipient-code-state-mac`）があると既存のRestoreは止まる。これは旧Restoreを止める停止契約として成立している。
- fingerprintと`activate`の0-row確認はAttempt／Sessionだけで、`recipient_code`を含まない。
- recovery checkpointの`evidenceDigest`は32-byteの固定長Fieldで、Ledgerの書式はこれを不透明なbyteとして保存する。再計算して検証する箇所はコード上に見つからなかった（Task I0で再確認する）。fixtureの`open`はrecovery entryの値との一致だけを確認する。
- Group Managementには、Restore／Checkpoint／Witness／Ledgerの実装がない。Expense RecordingとSettlementはDomainのみでPersistenceを持たない。
- 保守のPort（`RecipientCodeMaintenancePort`）の`blockActor`はActor単位で、解除契約を持たない。設計Proposalは、Restore時の`allocate`の扱いを#245へ残している。
- 認証（`shared`）はGroup Managementをimportできず、他Contextの鍵やTableも参照できない（`apps/api/src/architecture-dependencies.spec.ts`）。

このままでは、認証だけのRestoreで開通できるか、GM整合の検証を実装で推測して補うかのどちらかになる。後者は既存の採用判断（[鍵inventory ADR](recipient-code-maintenance-key-inventory.md) D2）と同種の判断を、Ownerを通さずCodeで確定することになるため、設計へ戻した。

## 範囲と前提

本ADRが決めるのは、合成入力で検証できる内部Portの契約と、不足時に隔離を維持する条件まで。次は変更せず、Production Gateへ残す。

- 物理Backupの真正性、信頼済みBackup catalogが全Context共通の復旧点IDを発行する能力。
- 実Ledger／Witness、実Provider、実際のDB外fence、復旧訓練（V17／V18の本番部分）。
- GM側のRestore検証の中身（保持Invitation／operation／locator／鍵世代をどう突き合わせるか）。これはGMのRestore設計Taskが決める。本ADRはGMが満たすべきPort契約だけを定める。

通常`main`／Dev／HTTP／Productionへは接続しない。合成入力の成功を本番Capabilityの証拠にしない。証跡Providerが注入されない構成は、開通せず隔離する。

## Decision（Accepted。2026-11-12にOwnerが推奨案を採用）

各論点は、推奨、代替案、理由、Trade-offの順に示す。論点1〜4は一組で、片方だけを採ると整合しない箇所がある（組合せは[論点の依存](#論点の依存と一括採否)）。

### 1. 全Context整合証跡Portの所有と形

**推奨（案1A）**: 認証側がconsumer Portを所有する。`shared/application/authentication`に`AuthenticationConsistencyEvidencePort`を置き、Restoreは次だけを受け取る。

- 不透明で検証済みの証跡handle。**発行するのは証跡Adapter側のregistry**（Compositionが組み立てる。`AuthenticationVerifiedHead`をLedger Adapterのregistryが発行するのと同じ作り）で、Restore Serviceは検証関数で、そのregistryが発行したhandleであること、`runId`、`recoveryPointId`、Ledger headに束縛されていること、まだ消費されていないことを確認し、確認と同時に消費する（単回使用）。偽造、別run、別registry、再利用を拒否する
- 証跡が覆う`recoveryPointId`（論点2）
- 検証済みContextの名前の集合（論点8）
- 32-byteの`consistencyDigest`。MAC等では認証されず、真正性は証跡Provider（GM側の検証実装とComposition）への信頼に依る。認証側が保証するのは、束縛と単回使用と、Ledgerへの記録までである

GM側のAdapterはCompositionが認証側Portへ橋渡しする。GM Applicationは自Contextの検証Portを持ち、認証はそれをimportしない。Portの入力は`runId`、`recoveryPointId`、検証済みLedger headの識別子（sequenceとhash）だけで、鍵、Invitation本文、Actor IDを渡さない。

| 代替 | 利点 | 不採用または劣後の理由 |
| --- | --- | --- |
| 1B: GMが公開Portを定義し、認証がimportする | GMの検証内容を型で表せる | `shared`がContextをimportすることになり、依存方向の機械検査に反する。共有側を変えるなら別のADRが要る |
| 1C: Compositionが「整合OK」の真偽値だけを渡す | 実装が最小 | 何を検証したか、どの復旧点か、再検証済みかを認証側が確認できない。真偽値は偽造と取違えを防げない |

Trade-off: 認証側がPortの形を決めるので、GMのRestore設計はこの形に合わせる。Contextが増えても認証側のPortは変えない（論点8）。

### 2. 復旧点の同一性を何へ束縛するか

**推奨（案2B）**: 信頼済みBackup catalogが全Contextで共通の`recoveryPointId`（UUIDv4）を発行し、`AuthenticationBackupManifest`へFieldとして追加する。GM側のcatalog entryも同じIDを持つ。証跡は、このIDと一致する復旧点について検証されたものだけを受理する。IDの欠落、不一致、複数一致は隔離する。

Fieldが必須なのは`schemaVersion`が11（コード用途を持つ構成）のManifestだけである。6のManifestには存在せず、あれば拒否する（6は、コード機能が未接続の間だけ証跡を要求しない。論点6）。ここで`schemaVersion`は、Manifestの「対応済みDB Schemaの版」であり、現行Codeは認証のMigration番号と対応づけて6を比較している（番号との対応はTask I0で再確認する）。Manifestのcodecは受理するField名を固定列挙しているので、Fieldの追加はManifest書式の変更である。Fieldの追加と、codecとPG AdapterのManifest検査での受理は、分割案のTask 1で行う。受理版を`{6, 11}`へ広げるのはTask 2である。Ledger／Witnessの書式は変えない。

| 代替 | 利点 | 不採用または劣後の理由 |
| --- | --- | --- |
| 2A: 認証Manifestをそのまま証跡検証へ渡し、GMが取得UTCやcheckpointから対応を推測する | Manifest変更なし | 時刻の近さで復旧点を対応づけることになり、別の日のBackupを取り違えても検知できない。復旧点の同一性を推測で補わない |
| 2C: 認証checkpointのhashをGMのcatalogへ複製する | ID追加なし | 認証のLedger headを他Contextの復旧点IDに流用することになり、Ledgerの意味を拡張する。認証のrollbackと他Contextのrollbackは別の事象である |

Trade-off: catalogが全Context共通のIDを発行できることが前提になる。これは物理Backupとcatalogの真正性に属し、本番Gateのままである。合成catalogでの成功をその証拠にしない。

### 3. 証跡を認証のrecovery checkpointと開通CASへ束縛するか

**推奨（案3B）**: 既存の`evidenceDigest`の覆う範囲を広げる。現在は認証の移行fingerprintのdigestだけを入れているところを、次を固定順序の長さ前置書式で結合したSHA-256にする。

1. 認証の移行fingerprint digest（現行。`migrateIdentity`が返す）
2. 論点7のコード破棄closureとコード表0-rowの検証結果のdigest
3. 証跡の`consistencyDigest`と`recoveryPointId`、検証済みContext名の集合

書式は次のbyte列である（TLVではなく、固定順序の長さ前置書式）。(a) 固定tag `restore-evidence/v1`のUTF-8（2-byte big-endian長の前置）、(b) 要素1の32-byte、(c) 要素2: 1-byteのpresence（0=不参加、1=参加）に、参加のときだけ32-byteのdigestが続く、(d) 要素3: 1-byteのpresenceに、参加のときだけ、32-byteの`consistencyDigest`、16-byteの`recoveryPointId`（UUIDの生byte）、2-byteのContext数、Context名をUTF-8のbyte順の昇順に並べて各名を2-byte長の前置で続ける。(e) 全体をSHA-256する。v6の例は、(a)(b)に、`00`（要素2）と`00`（要素3）の2 byteが続く。コード参加がない構成の要素2と、証跡が要求されない構成（v6）の要素3はpresence=0である。コード参加（Task 2）が入っても書式は変わらず、presenceとdigestが入るだけである。**v6のRestoreでも`evidenceDigest`の値は現行（fingerprint digestだけ）から変わる**ので、Task 1が既存のv6のgolden値と回帰Testの期待値を更新する。

`activate`が比較するのは、DB Adapterが保持する移行のfingerprint digest（要素1）であり、`evidenceDigest`とは別物として分離したままにする。`evidenceDigest`は`open`のCASがappend済みのrecovery entryと比較する。recovery checkpointをappendしても`open`に達していないentryは、開通の証拠ではない（開通はDBの`activate`と外部の`open`のCASが揃った場合だけ）。同runの再開で`publishEpoch`とappendが重複しないことは、現行Codeが`currentPublication`とLedger最新headで扱っているので、Task I0で再確認する。

`evidenceDigest`は同じ32-byteのままrecovery entryへappendされ、`open`のCASがそれと一致を確認する。よって**Ledger／Witnessの書式は変えず、既存ADRのReview Trigger（Ledger／Witness形式の変更）には該当しない**。Witnessが証明するのは、そのdigestが追加されたことまでである。コードのclosureやGMの整合そのものをLedger／Witnessが直接検証するわけではない。これは[鍵inventory ADR](recipient-code-maintenance-key-inventory.md) D2（別ticket方式）の解釈と同じ限界で、新しい限界ではない。

| 代替 | 利点 | 不採用または劣後の理由 |
| --- | --- | --- |
| 3A: 開通前の検査だけにして、digestへ含めない | 変更が最小 | 開通後に「どの証跡で開通したか」をLedgerから辿れない。証跡の取違えや使い回しを後から検出できない |
| 3C: Ledgerにコード側／GM側の項目を追加する（D2の(ii)に相当） | LedgerだけでClosureと整合を検証できる | **既存ADRのReview Trigger（Ledger／Witness形式の変更、Ledger／Witnessがコードclosureを直接検証する必要）に該当する。** 認証Ledger形式の変更とSecurity Reviewのやり直しを伴い、本Taskの範囲を超える。必要になった時点で別ADRにする |

Trade-off: `evidenceDigest`の中身の定義が変わるが、過去のrecovery entryを再計算で検証する箇所は見つかっていない（I0で再確認する）。見つかった場合は、旧entryを旧定義のまま読む互換規則をTaskで決める。

### 4. 検証時点と再検証

**推奨（案4B）**: 3回検証する（P1、P2、P3）。「GM head」とは、`recoveryPointId`に束縛された、GM側の検証対象状態のrevisionを指す。証跡が成立する前提として、P1から開通までの間、GM側のWriterが同じDB外のrun fenceで閉じられていることを要求し、閉じられていない場合は証跡Adapterが検証済み証跡を返さない（GMの変更が認証のfenceの外で進み得る構成を許さない）。

- **P1（削除再適用の前）**: Ledger latest検証とActor票照合の後、削除再適用の前に証跡Portを呼ぶ（下の順序表の手順4）。削除の再適用とコードの全世代破棄、epochの公開はいずれも戻せないので、整合が取れない復旧点ではその前に止める。
- **P2（recovery checkpointのappendの直前）**: `migrateIdentity`が認証のfingerprint digestを返した後、`evidenceDigest`を計算する前に、同じrunで再検証する。P1と`recoveryPointId`、Ledger head、`consistencyDigest`が一致することを確認し、P2の結果が`evidenceDigest`へ入る（論点3）。P1とP2の間にGM側のheadが進んでいれば、P1の証跡を使い回さず隔離する。
- **P3（recovery checkpointのappendの後、`activate`の前）**: 同じrunで再検証し、`consistencyDigest`、`recoveryPointId`、GM headがP2から不変であることを確認する。不一致なら開通せず、再閉鎖して隔離する。`open`のCASが比較するのは認証側のLedger entryのdigestだけなので、GM側の鮮度はP3とfence前提で担保する。P3から`open`までの窓は、GM側Writerのfenceが閉じている前提と、認証側のfence・DB封鎖に依る。
- **証跡の失効**: 時刻ではなく、`runId`と、証跡Adapterのregistryの発行世代への束縛で決める。別runのhandle、registryの再作成後のhandle、一度消費したhandleは拒否する。時計の出所に依存しない。P1、P2、P3はそれぞれ別のhandleを要求する（前の検証のhandleを使い回さない）。

証跡で止めるのは、P1では削除再適用とAttempt／Session／コード行の破棄、epochの公開と開通、P2・P3では開通である。P1が失敗した場合は、手順5へ進まずに隔離する。DBとTrafficは閉じたままで、破棄はP1が成立した後の再試行（既存の規則どおり同runの再試行を含む）で行う（削除意思はDB外のLedgerに残るので失われない）。破棄の中身は証跡によって変わらない。

#### Restoreの全体順序（推奨案）

| 順 | 操作 | 備考 |
| --- | --- | --- |
| 1 | `close`、`verifyClosed` | 既存。外部fenceのUTCを`dueAt`の起点にする（論点7） |
| 2 | 35日検査、構成確認、`isolate` | 構成確認は論点6。不可逆な操作の前に止める |
| 3 | Ledger latest、Actor票の全件照合 | 既存 |
| 4 | **P1**（整合証跡） | 不足、不一致は隔離。削除再適用と破棄へ進まず、epochを公開しない |
| 5 | 削除再適用、Attempt／Session破棄、コードticket登録・全世代破棄、再snapshot | コードは論点5、7。再snapshotが先と違えば隔離 |
| 6 | `publishEpoch`、`migrateIdentity` | 公開は戻せない。以降は同runのforward-fix |
| 7 | **P2**、`evidenceDigest`の計算 | P1と不一致、handleの失効は隔離 |
| 8 | Ledgerの最新head再確認、recovery checkpointのappend | headが進んでいれば、手順3へ戻る（既存の最大3回）。戻ったときはP1とP2も再実行する（epoch公開済みでも、不一致なら隔離する） |
| 9 | **P3**、`activate`（コード表0-rowを含む）、`open` | P3の不一致、`activate`や`open`の失敗は既存の再閉鎖規則に従う |

#### 失敗の種類と期待状態

V16〜V18の項目を、後続Taskの受入条件へ対応づける。

| 失敗 | 発生点 | 期待状態 | Task |
| --- | --- | --- | --- |
| 35日超、未来のBackup | 手順2 | 何も変更せず隔離。epochを公開しない | 既存、1の回帰 |
| stale／fork／片側Witness（認証Ledger） | 手順3 | 隔離。既存の検証 | 既存、1の回帰 |
| 証跡の不足、Context欠落、`recoveryPointId`の不一致、Port未注入 | P1 | 隔離。削除再適用、Attempt／Session破棄、コードticketの登録と破棄、epochの公開を行わない（不可逆な操作の前に隔離） | 1 |
| GM側のheadが進んだ、`consistencyDigest`または`recoveryPointId`の不一致、handleの失効 | P2 | 隔離。epoch公開済みで開通せず、recovery checkpointはappendしない。同runで再開できる | 1 |
| 同上（P2から変化した） | P3 | recovery entryはappend済みだが、`activate`と`open`を呼ばず再閉鎖して隔離する。append済みのentryは開通の証拠でない。再開時はP1〜P3を再実行する | 1 |
| 同runの再開で`dueAt`が変わらない。閉鎖済みで起算の記録がない（記録の喪失）場合は、初回として扱わず、起算し直さず隔離を維持する。別runは前倒しのみで採用する | 手順1、5 | `dueAt`と`deadline`は延びない | 2 |
| Restore所有（または採用した）ticketが`deadline`へ到達した | 手順5〜9 | `OVERDUE`を固定Codeで通知する。`quarantined`の根拠にしない。restoring中は既に受付を閉じているので、追加の封鎖はしない。開通は全closure、0-row、証跡が揃った場合に限る | 2 |
| 構成の不一致（論点6の表） | 手順2 | 不可逆な操作の前に隔離 | 2 |
| Manifestの`recoveryPointId`がv11で欠落、v6で存在、または証跡で複数一致 | 手順2、P1 | 不可逆な操作の前に隔離 | 1 |
| inventoryに束縛できないコード行、列挙の不完全、再snapshotの不一致 | 手順5 | 隔離（`unavailable`）。開通しない | 2 |
| コード表が0-rowでない、`activate`の失敗 | 手順9 | 開通せず、同runで再閉鎖して隔離 | 2 |
| `open`の応答喪失、開通後の監視失敗 | 手順9 | 既存の規則（同runで再閉鎖し、DB封鎖と両方を確認した場合だけ`quarantined`） | 既存、1・2の回帰 |
| 途中のcrash | 手順3〜9 | 同runで再開する。`pending`／`byOperation`／`scopes`で未完了のticketと全世代closureを再照合し、P1、P2、P3は再実行する。発行済みepoch、burn済みNonce、破棄済み鍵を戻さない | 1、2 |

| 代替 | 判断 |
| --- | --- |
| 4A: 破棄を証跡の成否に依らず先に行い、P1を破棄の後に置く | Proposal時点の案。2026-11-12の対処方針1で不採用とした。削除の再適用と全世代破棄は戻せないので、整合しない復旧点ではその前に止める。P1で止めても受付は閉じたままなので、旧コードは使えない |
| 4C: 開通直前の1回だけ | 劣後。整合しない復旧点でepochを公開してしまい、同runでのforward-fixしかできなくなる。P2だけでは開通前の取違えは防げるが、epochの無駄な消費は防げない |

Trade-off: Portの呼出しが3回（再開時はさらに）になり、証跡Providerの応答が遅い／失敗する場合は隔離になる。呼出しの失敗は証跡不足として扱い、成功扱いにしない。

### 5. Restore時の`allocate`封鎖

**推奨（案5A）**: 新しいProvider契約を足さず、DB外のrun fenceが閉鎖された後の列挙の完全性に依る。順序は、`close` → `verifyClosed` → 固定snapshotの列挙 → 破棄 → **再snapshot** → 一致確認 → 開通とする。再snapshotが先のsnapshotと異なる（scopeや全世代版が増えた）場合は、同じ`allocate`が漏れたものとして隔離する。`blockActor`はActor単位で解除契約がないため、Restoreでは使わない。

| 代替 | 利点 | 不採用または劣後の理由 |
| --- | --- | --- |
| 5B: Providerに「Restore中の全Actor`allocate`拒否」とその解除契約を追加する | fenceに依らずProvider側で止まる | 新しいProvider契約と、解除という戻せる状態を増やす。解除の誤りが旧epochの許可に繋がる。`allocate`を呼べるのは、fenceが閉鎖する認証Writerだけである |

Trade-off: fenceがWriterを実際にdrainしていることに依存する。これは既存のProduction Gate（DB外fence）の能力で、本ADRは新しい保証を足さない。Providerの完全列挙を保証できない場合は、[鍵inventory ADR](recipient-code-maintenance-key-inventory.md)のReview Trigger（D4／D5）に該当し、このRestoreも停止する。

### 6. Manifestのschema版、公開世代、構成確認

**推奨（案6A）**:

- **schema版**: `schemaVersion`の受理を、`{6, 11}`の明示allowlistにする（6=現行Restoreが受理する、コード導入前の版。11=コード表と消費Auditを含む現行）。認証のMigration番号は5〜9と11で、10は欠番である。7（HTTP rate）、8（コード表）、9（コードAudit）は中間版で、Restoreのfingerprint、0-row、停止契約を実PGで確かめたのは6と11だけなので、拒否する。新しいMigrationを足すたびにallowlistへ明示的に加える。許可していない版は、旧Restoreと同様にskipせず止める。
- **公開世代**: 構成がv11のとき、`AuthenticationRestoreGeneration.purpose`へ`recipient-code-lookup`と`recipient-code-state-mac`を加え、新しい現行世代を公開する。旧世代は退役させる（`migrateIdentity`が`key_generation`を全置換するため、公開に含めない用途は復旧後に消える）。
- **構成確認**: Manifestの版、復旧したDBのコード表の有無、コード用途の有無、Restoreのコード参加の有無が一致しない構成は、不可逆な操作の前に止める。#260の「構成の確認」と同じ考え方である。

  | Manifestの版 | コード表 | コード用途 | コード参加（Service設定） | コード機能の接続（Composition設定） | 結果 |
  | --- | --- | --- | --- | --- | --- |
  | 6 | なし | なし | なし | 未接続 | 受理（現行。証跡不要） |
  | 6 | 任意 | 任意 | 任意 | 接続済み | 隔離（接続後は6を受理しない） |
  | 6 | あり | 任意 | 任意 | 任意 | 隔離（版と表の不一致） |
  | 6 | なし | あり | 任意 | 任意 | 隔離 |
  | 11 | あり | あり | あり | 任意 | 受理（証跡必須。論点1〜4） |
  | 11 | あり | あり | なし | 任意 | 隔離（コードを破棄できない構成） |
  | 11 | なし、またはコード用途なし | 任意 | 任意 | 任意 | 隔離 |
  | 6、11以外 | 任意 | 任意 | 任意 | 任意 | 隔離（allowlist外） |
  | 上のどれにも一致しない | | | | | 隔離（既定） |

  表は上から最初に一致した行を採用する。どの行にも一致しなければ、既定の行として隔離する（例: 版6、コード表なし、コード用途なし、コード参加あり、未接続）。「コード機能の接続」は独立した設定値にせず、Compositionが**コード用途のPortを実際に組み立てるか**（コード用途の鍵世代の構成とコード参加のService設定）から導出する。つまり、Compositionが組み立てたのに「未接続」と判定される経路を作らない。「未接続」は既定値であり、唯一の免除条件でもある。コード機能を接続するTaskは、接続と同時に、証跡必須の最小版を6より大きくするか、v6をallowlistから外す。

  v6の「コード行」は、コード表の存在で検出する（v6のDBにコード表はない）。BackupのDBをその版のまま復旧するので、Restoreは版を上げず、復旧後の前進Migrationは通常の運用で適用する（本ADRの範囲外）。
- **整合証跡の要否（副論点A。2026-11-12に推奨どおり採用）**: 証跡の要否はManifestの版だけで決めない。Manifestは非秘密Metadataで、物理Backupの真正性が未証明の間は、運用者の選択（35日以内の古い版）で版を下げられるためである。Service設定の「証跡必須の最小版」（現在は11）と「コード機能の接続」（未接続／接続済み）で判定し、Manifestを下げても要求が下がらないようにする。推奨は、v6の免除を**コード機能が未接続の間だけの暫定**とすることである。コード機能を通常のmain／Dev／Productionへ接続するTaskのReady条件に、「v6をallowlistから外す、または証跡を必須にする」を置く（上の表の「接続済み」の行）。v6にはコード消費とGM Invitation作成の共通commitがなく、接続前は既存のRestoreの契約を変えないためである。免除を置かない案（v6でも常に証跡必須）は、GM側の証跡Providerが実在するまで、現行のRestoreが開通できなくなる。Ownerは、この暫定免除と失効条件を採用した。

| 代替 | 判断 |
| --- | --- |
| 6B: `schemaVersion >= 8`をすべて受理 | 通常のmain／Dev／Productionにコード機能が接続されていないので、中間版のBackupは実環境には存在しない見込みである（未確認）。それでも受理すると、検証していない版（8、9）のRestoreを許すことになる |
| 6C: 構成確認をせず、用途の有無で自動判定 | 版と用途の食い違い（downgrade、取違え）を検出できない |

Trade-off: 版を足すたびにRestoreのTestとallowlistの更新が要る。

### 7. Restore用ticket、起算、未知のコード行、0-row

**推奨（案7A）**:

- **所有operation**: Restoreのコードticketは`runId`を所有operationとする。1 ticket=1 codeId、未完了ticketは高々1つの規則（[鍵inventory ADR](recipient-code-maintenance-key-inventory.md) D3）を保つ。別operation（清掃、Actor削除）が所有する未完了ticketは採用して重複作成せず、採用はdurableに記録し、窓は前倒しだけで延長しない。closureは常に所有operationへ束縛する。再開は`pending`／`byOperation`／`scopes`で行う。
- **起算**: `dueAt`はRestoreのrunが**最初に**外部fenceを閉じたUTCとし、そのrunの開始時にdurableに記録した値で固定する。記録先は、DB Backupと独立した外部のrun所有状態（`AuthenticationRestoreControl`が`close(runId)`で所有するfence）とする。最初の`close`が閉鎖UTCを記録し、再開時はその記録を読み、`close`の再実行で上書きしない。Controlは、fenceの閉鎖と閉鎖UTCの記録を**単一のatomic操作**で行い、閉鎖UTCはControl側の信頼できる時刻源で採る（呼出し側の時刻を使わない）。「閉鎖済みで記録がない」状態は、初回ではなく記録の喪失として扱い、起算し直さず隔離する。これにより、初回のcloseと、記録を失った再開を区別できる。ticketの登録（手順5）はその後なので、ticketを持つ前から記録は存在する。記録が見つからない状態で再開した場合は、新しいUTCで起算し直さず、隔離を維持する。この能力（閉鎖UTCの記録と取得）をControlへ追加することは、Task 2の成果に含める。同runの再開や`close`の再実行で更新しない（再開のたびに再計算すると`deadline`を延ばせるため）。`deadline`はその24時間後とする。行自身の`expiresAt`／`terminalAt`は使わない。Backupは最大35日前の時点であり、行の期限は多くが過ぎている。行の期限で起算すると、Restoreが始まった瞬間にoverdue（`deadline`到達）と判定してしまう。Restoreは期限遵守の監視ではなく、復旧した全件の破棄である。D3の起算規則に、Restore固有の1行を足す補足になる。
- **再開と新しいrun**: 別run（失敗した前のrun）の未完了コードticketは、新しいrunが採用し、`dueAt`は前倒しだけで延長しない（前のrunの起点が早ければそれを維持する）。
- **deadline到達の扱い（副論点B。2026-11-12に推奨どおり採用）**: Restore所有のticketが`deadline`へ達した場合は、固定Code（`OVERDUE`）を通知し、`quarantined`の根拠にはしない。Restoreは封鎖を解く唯一の経路なので、Restore自身の遅延で封鎖すると、解除できない自己参照になるためである。代わりに、`deadline`の延長は上記のとおり起こらず、開通は全closure、0-row、整合証跡が揃った場合に限る。「遅延したRestoreを開通させず、新しいrunでも解消できない」状態は、`OVERDUE`の通知と運用判断（Production Gate）に委ねる。Ownerはこの扱いを推奨どおり採用した。設計上の帰結として、Restore所有（またはRestoreが採用した）ticketについては、restoring中に限り、24時間以内の鍵破棄を封鎖で強制しない（restoring中は受付を閉じているので旧コードは使えない）。清掃とActor削除が自ら進めるticketの24時間期限と封鎖契約は変えない。
- **未知のコード行**: restoreしたDBにコード行があり、Providerのinventory（`scopes`／`scopePage`）に対応scopeがない場合は、止める（`unavailable`、隔離を維持）。行を消して通すことも、検証できないまま残すこともしない。信頼済みinventoryに束縛できない行は、全世代の鍵の破棄を証明できない。inventoryに完了済みscopeが残る場合は、Providerの`scopes`で解決する（#259／#260と同じ）。
- **行のないscope**: Providerが知るscopeで、restoreしたDBに行がないものも、同じticketで全世代を破棄する（`allocate`後にrollbackされた孤立scopeを含む）。
- **0-row**: コード表の0-rowを、`activate`の前提（現行のAttempt／Session 0-rowと同じ）とfingerprintの対象へ加える。ticket完了の確認と、全closureの検証は、今回の実行で行う。

| 代替 | 判断 |
| --- | --- |
| 7B: 行の期限で起算する | 行の期限は多くが過ぎているので、Restoreが始まった瞬間にoverdueになる。不採用 |
| 7D: runの再開ごとにdueAtを更新する | `deadline`を繰り返し延ばせ、overdueの抜け道になる。不採用 |
| 7C: 未知の行をDBから消し、鍵は後で清掃する | R5「検証できないから残すとしない」には沿うが、信頼済みinventoryへの束縛なしに鍵の破棄を主張できない。DB行の削除だけでは完了にならない（0-rowだけを完了の根拠にしないというAccepted設計と矛盾する） |

Trade-off: 1件でもinventoryに束縛できない行があれば、Restoreが開通しない。実環境に旧形式のinventoryがあるか、完全列挙できるかは未確認であり、Production Gateで判断する。

### 8. 「全Context」の範囲と、後からの参加

**推奨（案8A）**: 本契約が必須とするContextは、Compositionが設定する**必須Context名の閉じた集合**で、現在は`group-management`だけである。証跡は、検証済みContext名の集合を返し、Restoreはそれが必須集合と完全に一致することを要求する（欠落も余分も拒否）。Expense RecordingとSettlementは現在Persistenceを持たず、復旧すべき状態がないので集合に入れない。いずれかがPersistenceを持つときは、そのPersistenceを有効にする前に必須集合へ加え、そのContextの証跡Adapterを用意することをGateとする。認証側のPortとServiceは変えない。

| 代替 | 判断 |
| --- | --- |
| 8B: GMだけを固定で要求 | 実装は最も小さいが、別ContextがPersistenceを持った時に、認証のPortとServiceを再び変える必要が出る。Contextの追加を黙って見落とす経路にもなる |
| 8C: 合成済みの1つの不透明な証跡だけを受ける | 認証側が、どのContextが検証されたかを確認できない（案1Cと同じ） |

Trade-off: 必須集合の設定が誤ると、Contextの欠落を検出できない。集合を`evidenceDigest`へ含めて、開通後も追跡できるようにする（論点3）。Persistenceを持つ新しいContextを加える作業は、Epic／Taskの分解で、そのContextのRestore参加を同じEpicのTaskとして必ず列挙する。

## 論点の依存と一括採否

- 論点1・2・3・4・8は、同じ証跡Portに関する一組である。1Aを採るなら2・8は同じ形に揃える。
- 論点6と7はコード参加の側で、1〜4と独立に採否できる。ただし6の「v11では証跡必須」は、1〜4の採用が前提になる。1〜4が不採用になった場合は、v11のRestoreを受理せず、v6だけを受理し続ける（コードを受理しない旧Restoreのまま）。
- 論点5は他と独立である。

## 既存Decisionとの関係

| 既存文書 | 関係 | 論点 | Review Trigger |
| --- | --- | --- | --- |
| [招待コードのLifecycle・保護保存・原子的消費](invitation-code-lifecycle-and-protected-storage.md)（#233） | **Supplements** Decision 7（復旧時の全コード破棄と新epoch）。「Restoreの変更は再Review対象」に該当 | 1〜8 | 該当 |
| [招待コード保守の鍵inventory](recipient-code-maintenance-key-inventory.md) | **Supplements** D2（Restoreはコード専用Portで検証）、D3（Restore固有のticket所有と起算）、D5（Restoreでの`allocate`）、D6（公開世代と`quarantined`→`active`） | 3、5、6、7 | 推奨案では「Ledger／Witnessがコードclosureを直接検証する必要」に該当しない（代替3Cは該当）。Providerの完全列挙を保証できない場合（5、7）は、停止（隔離）で扱うので、推奨案はTriggerの前提を変えない。「#245のRestore設計がD3と整合しない場合」は、7がD3の起算にRestore固有の規則を足すだけで、ticketの粒度、所有、採用、closure束縛はD3のとおりなので該当しない。「実環境に旧形式のdurable inventoryが存在すると判明した場合」は、存在の有無が未確認であり、Production Gateで判断する |
| [認証Dataの保護保存](authentication-protected-storage.md)（#212） | **Supplements** Decision 7（Checkpoint／Witness・削除Ledger・鍵Stateを検証する復旧）。「Restore変更時の新Decision・Security Review」に該当 | 2、3、4、6 | 該当 |
| [Snapshot Revisionの保護・保持](snapshot-revision-security-and-retention.md)（#55）8節 | Backup Restoreのanti-rollbackを変更しない。Backup／Checkpoint／Witness／Restoreの変更時のSecurity Reviewやり直しに該当 | 1、2、3 | 該当。Ledger／Witnessの書式は変えない |

既存ADRの本文とStatusは変更しない。Amendsに当たる既存ADRはない（既存の採用判断を覆す点がない。D3の起算にRestore固有の規則を足すのは補足である）。

## Consequences

- Restoreは、コード用途を持つ構成で、整合証跡が不足、不一致、失効、Context欠落、Portの未注入のいずれかであれば開通せず隔離する。これは既存の方針（不足時は隔離）の具体化である。
- 実GM Adapterが存在しない現状では、v11のRestoreは実環境で開通できない。これは意図した状態である。#245の後続Taskは合成の証跡で検証して完了とする。GM側のRestore検証は別の設計Taskとし、置き場所はEpic #202ではなくProduction Gate側（[ADR #55](snapshot-revision-security-and-retention.md)系のRetention／Restore）とする。Epic #202は、合成証跡での内部実装までで閉じる。
- 合成のcatalog、Provider、証跡の成功は、本番のCapabilityの証拠ではない。
- 残Risk: Ledger／Witnessはコードclosureと整合そのものを検証しない（D2の限界を継承）。証跡Providerが誤った「整合」を返す経路は、CompositionのregistryとGM側の検証の実装に依る。物理Backupとcatalogの真正性、全Provider同時rollbackは、既存のProduction Gateのままである。

## Implementation

本ADRは文書だけである。Code、SQL、公開APIは変更しない。承認同期では、次の採用済み文書へ「#278の採用設計（未実装）」として参照を追加した。現行実装の記述は書き換えていない。

- [運用設計](../operations/invitation-code-retention-restore.md)のBackup Restoreの手順2／3／4／6／7と受入Evidence表
- [設計契約R5](../security/invitation-code-lifecycle.md#r5-保持削除復旧公開)とV17／V18のTrace
- [認証Runbook](../operations/authentication-retention-restore.md)のManifest（schema v6）、公開世代、Restore手順、未実装Capability表
- [認証保守契約](../security/authentication-maintenance.md)のManifest、Restoreと開通条件、fingerprint
- [ADR一覧](README.md)のStatus

## #245の分割案（Planningへの入力）

#245は、独立成果が複数あり、2人日／5SPとPRの目安（約500行）を超える。近い前例は#260（3人日／8SP、約2,200行）である。次を推奨する。実際の起票、見積り、元の#245の`not planned`でのClose、Epic一覧への追加、GM側のRestore検証の設計Taskの起票は、Planningで行う。

| 順 | Task案 | 成果 | 依存 |
| --- | --- | --- | --- |
| 1 | task(auth): Restoreへ全Context整合証跡の要求を追加する | 証跡Port（発行はAdapter側のregistry）、`recoveryPointId`（ManifestのField、証跡との一致検査、ManifestのcodecとPG AdapterのManifest検査でのFieldの受理。v11で必須、v6では不在）、`evidenceDigest`の束縛（v6も値が変わるのでgoldenと回帰Testを更新）、P1／P2／P3、必須Context集合、不足／stale／fork／Context欠落での隔離。証跡の要否はManifestの版だけでなく、Service設定で判定する（論点6）。そのうちTask 1は「証跡必須の最小版」を、Task 2は「コード機能の接続」の導出と構成確認を入れる。**構成確認**（論点6の表）はTask 2で入れる。Task 1ではService設定の「証跡必須の最小版」と受理版だけで判定し、コード参加の有無は見ない。**Test入口**: ServiceのOptionとして受理版とallowlistを注入できるようにし、Task 1のTestはServiceレベルで、証跡Portの合成Adapterと、受理版11を注入したTest専用の構成（fakeのcontrol／ledger／database）で検証する。v11での`recoveryPointId`の必須・欠落・複数一致はこの構成で検証し、実PGでは「v6でFieldなしは受理、v6でFieldありは拒否」を検証する。実PG AdapterとCompositionの受理版は6のまま（Fieldの受理だけを入れる）で、既存のv6の実PG回帰を維持する。本番のallowlistには11を入れない | 本ADRのAccepted |
| 2 | task(auth): Restoreへ全招待コード破棄とコード用途の鍵状態を参加させる | 実PG Adapterとallowlistの受理schema版を`{6, 11}`へ広げ、公開世代のコード用途、構成確認（論点6の表）、Restore ticket／closure／0-row（`dueAt`の固定と、Controlへの閉鎖UTCの記録・取得能力、再開、別runの採用を含む）、`activate`とfingerprintの拡張。v11は証跡を必須にして受理する（Task 1の判定による）。実PGで、v6／v11の両方の回帰と、コード行のあるBackupの全破棄を検証する | 1 |

順序の理由: コード参加を先に入れると、「コードを受理するが整合証跡なしで開通できるRestore」が一時的にdevelopへ入る。証跡の要求を先に入れ、コードの受理を最初から証跡必須にして入れる。それぞれが単独で検証できる。見積りはTask起票時に再評価し、2が目安を超えるなら「ticket／closure／0-row」と「Manifest版／公開世代／構成確認」へ縦に分ける。

採用案による変更（採否前に示した参考。Ownerは推奨案を採用した）:

| 論点の採否 | 分割案への影響 |
| --- | --- |
| 1B（GMが公開Port） | GM側のPort定義を先行Taskにし、依存方向の検査の変更の要否をADRで決める。Task 1の前に1件増える |
| 2A（Manifest変更なし） | Task 1が小さくなるが、復旧点の取違えを検出できない。推奨しない |
| 3A／3C | 3A: Task 1が小さくなる（digest束縛なし）。3C: 認証Ledger書式の変更とSecurity Reviewのやり直しが先に必要で、別ADRとTaskが前に増える |
| 4C（開通直前の1回だけ） | Task 1が小さくなるが、epochの無駄な公開を防げない |
| 5B（Provider契約を追加） | Task 2の前に、Provider契約とその合成Providerの改修のTaskが1件増える |
| 6B（版を広く受理） | Task 2のTestの行列が増え、分割が必要になる可能性が高い |
| 7B／7C | 推奨しない（上記）。採る場合は別途ADRで、封鎖契約やR5との整合を決める |
| 8B（GM固定） | Task 1が少し小さくなる。別Contextの参加時にPortの変更が要る |
| 1〜4を不採用 | v11のRestoreは受理しない。Task 2は「v6の維持と、コード用途がある構成を明示的に拒否する」ことに縮み、コード破棄は別設計に戻る |

## Review Trigger

- Ledger／Witnessの形式を変える必要が生じた場合（案3C）。
- GM側のRestore検証の設計Task（Production Gate側）で、本ADRの証跡Port契約（論点1、2、4、8）と合わない点が見つかった場合。
- Providerの完全列挙を保証できない場合、またはfenceがWriterのdrainを保証できない場合（論点5、7）。
- Persistenceを持つContextが増える場合（論点8の必須集合）。
- 新しいMigrationで認証Schemaの版が進む場合（論点6のallowlist）。
- 本ADRの採用範囲を超えて、Restore、Manifest、`evidenceDigest`、公開世代、コードRecordの鍵用途を変更する必要が生じた場合。

## Owner Decision / History

- 2026-11-11: Proposedとして作成した。Ownerの採否は未取得。論点1〜8のそれぞれについて採否（推奨案か代替案か）を、[#278](https://github.com/takeshi-arihori/kakei_app/issues/278)に記録する。
- 論点1〜8に加え、Ownerの明示判断が要る副論点は2つ: 論点6のv6免除（コード機能が未接続の間だけの暫定とする失効条件）と、論点7のRestore所有ticketの`deadline`到達の扱い（`OVERDUE`通知とし、封鎖の根拠にしない）。
- Authorから分離したSecurity Reviewを採否の前提とし、[PR #279](https://github.com/takeshi-arihori/kakei_app/pull/279)の独立Review（code／test／security）はすべてpassした。PR #279はProposedのままdevelopへMergeされた。
- 2026-11-12: 親Agent（#245側のSession）の問い「ADR #278の推奨案（論点1〜8）を採用しますか？」と、同じ返信の本文で示した補足「論点とは別に採否が必要な副論点が2つあります。採用の際はこれらも推奨どおりでよいかをあわせて確認してください。」（副論点A: 整合証跡の要否をManifestの版だけでなくService設定の「証跡必須の最小版」でも判定する。副論点B: Restore所有のticketが期限に達した場合は`OVERDUE`を通知するが封鎖の根拠にはしない）に対し、Project Ownerが「採用する」と回答した。例外なしの回答なので、論点1〜8と副論点A・Bを推奨どおり採用したものとして記録する。副論点への言及はOwnerの文言自体にはない。同日、本ADRの作成Sessionでも採用の確認に「はい」と回答した。
- 同じく2026-11-12、Ownerは採用前に示した3点の対処方針に「推奨方法で進めて。」と回答した: P1の位置を順序表どおりに直す、`recoveryPointId`の担当をTask 1へ寄せる、GM側のRestore検証をProduction Gate側の別の設計Taskとする。本承認同期で反映した。対処1に伴い、論点4の「証跡で止めるもの」の文と代替4Aの行も同じ順序に揃えた。対処2に伴い、論点2のField追加の担当も分割案に揃えた。
- 親Agentによる会話承認の転記であり、Owner本人のGitHub上の承認操作を主張しない（[#233](https://github.com/takeshi-arihori/kakei_app/issues/233)の前例と同じ）。承認範囲は本ADRの設計まで。#245の分割・個別Ready、PRのReady化／Merge、Production有効化は含まない。
