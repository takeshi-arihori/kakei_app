# 認証HTTP・Cookie・開発接続の契約（A5）

Knowledge State: Confirmed（2026-10-21 Owner承認の設計。独立評価・実装は別Gate）。根拠は[Issue #218](https://github.com/takeshi-arihori/kakei_app/issues/218)、[HTTP ADR](../adr/authentication-http-and-development-boundary.md)、[Accepted認証ADR](../adr/google-login-actor-session.md)、[内部Lifecycle](google-authentication-lifecycle.md)、[A2保存契約](authentication-protected-storage.md)。本書とOpenAPIを#218で同期し、HTTP/共有Rate/専用開発Compositionの実装・検証へTraceする。通常main/Production認証は未有効であり、最終4専門ReviewとDraft PRは別Gate。

## Requirementと責務

Browser操作をServer Attempt/Sessionへ接続する。変更されるのはTransport/CompositionとHTTP専用Rate counter。Actor/Google Identity/Attempt/Sessionの内部意味、TTL、原子的保存、Session lease、業務権限、A2の暗号形式を維持する。

`src/presentation/http/authentication/`がHTTP入力検査、Cookie、公開結果への変換を所有し、共有Applicationの認証ServiceとHTTP能力Portにだけ依存する。具体pg/crypto/SDK/環境設定はComposition/Infrastructureで解決する。Architecture Testの許可はこのPathと対応Portへ限定し、共通GraphQLや業務Presentationから任意の共有Infrastructureを読めるようにしない。

## Requestの前提

- H-PRE-1 / Trust / #218 DC1: Server設定のcanonical Originを固定する。Production契約はHTTPS origin、開発profileは文字通り`http://localhost:3000`。userinfo/path/query/fragment/空/null/wildcard/Originリストを設定値として許可しない。RequestのOriginも一つのcanonical文字列として完全一致させ、suffixや部分一致を使わない。POSTで欠落/null/重複/不一致なら403。RefererやForwardedで救済しない。
- H-PRE-2 / Transport / DC1: 全4操作で`X-Kakei-Request: 1`を要求する。GETはBrowserがOriginを送らない場合を許可するが、あれば完全一致を要求する。`Sec-Fetch-Site`があれば`same-origin`だけ許可し、欠落は独立した拒否理由にしない。credential付きCORSも認証preflight許可も追加しない。異Origin Scriptのcustom Header付きRequestはpreflightで拒否される。
- H-PRE-3 / Input / DC1: POSTは`application/json`、任意のcharset=utf-8だけを許可。identity以外のContent-Encodingを拒否。全Bodyはstreamを読みながら18,432 bytesで制限し、Content-Lengthの省略/偽装でも超過を拒否する。読取期限は5秒。GETはBodyを受け付けない。Header総量16KiB/最大64個はNode入口で制限する。認証路でこれらを満たさない開発入口を成功扱いしない。
- H-PRE-4 / Input / DC2: attempt/logoutはJSON Object `{}`だけ、loginは`{ credential: string }`だけ。未知Field、Actor/Role/expectedNonce、配列/null/重複JSON Fieldを拒否。Credentialは空不可、最大16,384 ASCII bytes、既存Verifierの検査を維持する。Cookie総量8KiB、選択Cookie名の重複・不正構文を400で拒否。秘密値は既存32-byte canonical Base64URL契約を使う。
- H-PRE-5 / Resource / DC1/DC3: Rate予約に必要な接続Peer情報はNode接続から作る内部Contextであり、Header/Bodyで受け取らない。Rate/Crypto/Storeなど必須Capability不足は503または起動拒否。Test hookを設定から呼べるようにしない。

GETでOriginが省略されることと、変更系POSTのOrigin必須を区別する。`X-Kakei-Request`は本人性やCSRF Tokenの代替ではない。RequestごとにServerがUUIDv4 requestIdを発行し、ClientのrequestIdを診断やAuditの正本に使わない。

## OperationとPostcondition

| Method / Path | 追加入力と成功 | 根拠／状態保証 |
| --- | --- | --- |
| POST /auth/google/attempt | `{}`、任意の旧Attempt/Session Cookie。201 `{ nonce, csrfToken, expiresAt }`＋新Attempt Cookie | H-POST-1 / AUTH-R1。A1.beginが保存成功した後だけCookie/本文を返す。有効Sessionがあれば409。古いAttemptを置換し、秘密値をURLへ出さない |
| POST /auth/google/login | Credential、Attempt Cookie、`X-CSRF-Token`。204、Session Cookie設定＋Attempt Cookie削除 | H-POST-2 / AUTH-R1/R2/R6。Service.completeが成功した後だけ発行。期待nonceはStore snapshot由来のみ。Actor/Identityを本文へ返さない |
| GET /auth/session | Session Cookie。200 `{ authenticated: true, csrfToken, expiresAt }`。無効なら401 envelope | H-POST-3 / AUTH-R3。Service.withAuthenticatedActorのinspect CallbackでScope.serializeした本文をcommit後にそのまま返す。Actor IDを公開せずidleを延長しない |
| POST /auth/logout | `{}`、Session Cookie、有効Sessionがある場合はSession束縛`X-CSRF-Token`。204、Session Cookie削除 | H-POST-4 / AUTH-R4。先にinspect leaseでCSRFを定数時間照合し、同じCookieだけをrevokeする。失効commit成功後だけCookieを消す。Cookieなし/不正形式/期限切れ/失効済みはOrigin等の検査後204 |

LogoutのCSRF照合と失効の間に他logoutが先行しても、同一Cookieの失効は冪等。新しいSessionの秘密値を再利用せず、別CookieのSessionは変更しない。inspect障害を「Cookieなし」とみなさない。有効SessionのCSRF不足/不一致は403、Cookieを残す。Cookie不正構文/重複は一般入力不正であり、冪等logoutの例外にしない。

2026-10-22 Owner追補承認により、A1が同じ`restart-required`で返すcanonicalなLogin CSRF不一致と試行の期限/消費済み/不在は、一律409へ変換する。欠落/形式不正CSRF Headerは403でServiceを呼ばない。内部結果を拡張して不一致理由を公開しない。再開始409ではAttemptだけを削除する。有効Session競合409ではCookieを変更しない。

## Cookie

| Profile | Attempt / Session名 | 固定属性 |
| --- | --- | --- |
| Production契約（起動は別Gate） | `__Host-kakei-auth-attempt` / `__Host-kakei-auth-session` | Secure; HttpOnly; SameSite=Lax; Path=/; Domainなし |
| localhost使い捨て開発 | `kakei_dev_auth_attempt` / `kakei_dev_auth_session` | HttpOnly; SameSite=Lax; Path=/; Domainなし。Secureなしの例外はこのProfileに限る |

AttemptのCookie上限は5分、Sessionは最長7日。Max-Ageは保存済みabsolute expiryと返却時のServer時刻の差を秒単位で切り捨てて設定する。Cookie保存期間でServer期限/無操作24hを延ばさない。発行時の残寿命が1秒未満なら正のMax-Ageを保証できないため、期限を過ぎた場合も含め、新Cookieを返さず503 unavailableとする。保存済み結果の有無を503から推測しない。

削除は同じ名前/Path/Domain条件で空値、Max-Age=0、過去Expiresを付ける。成功logout/確認済みSession無効の401ではSession Cookieを消す。login成功または再開始確定の409ではAttempt Cookieを消す。Origin拒否、CSRF Header欠落/形式不正、LogoutのCSRF拒否、Rate拒否、503やcommit結果不明では認証Cookieを変更しない。有効Sessionとの競合409でもSessionを消さない。

## Failureと非漏出

H-FAIL-1 / DC3: HTTP前提違反でService/Google/認証Recordを呼ばず、認証Cookieを変更しない。Rate counterの予約は認証Transactionと独立した技術的副作用であり、後続認証の拒否/rollbackで予算を戻さない。

全認証Responseに`Cache-Control: no-store`と`X-Content-Type-Options: nosniff`。JSONはapplication/json、204はBodyなし。公開Errorは`{ error: { code, requestId } }`だけとする。

| HTTP | code | 主な条件 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | JSON/未知Field/重複Field/Cookie構文不正、GET Body |
| 401 | AUTHENTICATION_REQUIRED | Sessionなし/失効/期限切れ、Google Credential拒否（存在や失敗理由を非開示） |
| 403 | REQUEST_REJECTED | Origin/Request Header/Fetch Metadata、LoginのCSRF Header欠落/形式不正、Logoutの有効Sessionに対するCSRF不足/不一致 |
| 405 | INVALID_REQUEST | 定義外Method。Allowは定義Methodのみ |
| 409 | LOGIN_RESTART_REQUIRED | canonicalなLogin CSRF不一致、試行の期限/消費済み/不在、既存有効Sessionとの競合 |
| 413 | INVALID_REQUEST | stream/Content-Lengthで18KiB超 |
| 415 | INVALID_REQUEST | 非JSON/不許可charset/圧縮Body |
| 429 | RATE_LIMITED | 予算超過。Retry-Afterは残Window秒の切上げ、最低1秒 |
| 503 | AUTHENTICATION_UNAVAILABLE | Provider/DB/Audit/Rate障害、commit不明、設定未完 |

H-FAIL-2 / AUTH-R6: 503からrollback済みと推測しない。begin/completeの結果喪失後は既存A1契約どおり再開始、logoutは同Cookieで再試行する。SDK/SQL例外、Cookie/Token/nonce/CSRF/issuer/sub/IP、Profile、設定の実値、StackをLog/Error/計測tagへ入れない。許可・拒否のStore Audit失敗は503とし、HTTP拒否のために既存A2 Audit schemaへ自由文を追加しない。

## 共有Rate limit

Rate制御は技術的Resource Policyであり業務Domain Invariantではない。1分の固定Windowごとに次の二つの予算を共有する。数値は本Projectへの初期提案であり外部仕様の推奨値とは主張しない。

| 操作 | 接続Peer別 / 分 | API全体 / 分 |
| --- | --- | --- |
| attempt | 10 | 120 |
| login | 20 | 300 |
| session inspect | 120 | 600 |
| logout | 30 | 300 |

R-PRE-1 / DC1/DC3: 専用HMAC `auth-http-rate-subject/v1`で正規化した接続Peerとdeployment namespaceとWindowを束縛する。既存Identity/Cookie/Auditの鍵を流用しない。鍵は全instanceで一致させ、Window中に替えない。Rate専用の単一policy行へdeployment namespace、policy版、共有HMAC世代と専用固定labelの鍵照合値を登録し、起動時/予約時の不一致は503とする。鍵MaterialをDBへ入れない。Credential/Cookie/Actor/Google情報をRate keyへ使わない。Raw IPを保存しない。HMACは匿名化ではなく短期仮名である。

R-POST-1: ServerのDB時刻によりWindowを決め、global→peerの固定順で同一Transactionのcounterを予約する。上限の最終枠は2接続でも1回だけ許可する。Rate予約のcommit/応答が不明なら503で認証を呼ばず、予算を戻したと推測しない。プロセス別Mapへfallbackしない。Window境界で最大2Window分のburstが起こる残Riskを明記する。

R-DATA-1: 追加の番号付きMigrationで`authentication_http.rate_policy`の単一policy行と`authentication_http.rate_window`を作る。policy行は上記の非秘密Metadataと32-byte鍵照合値のみを持ち、鍵変更/Policy変更を無条件upsertで受理しない。counterは固定operation、kind(global/peer)、32-byte subject digest、window_start_ms、count、expires_at_msだけを保存し、PKはoperation/kind/digest/window、countは1以上のsafe範囲、Windowは分境界、expiryは開始+60秒を制約する。global digestは専用固定ラベルから導出する。失敗時は列/制約を改変して成功扱いにしない。

R-DATA-2: 期限到達後のcounterを再利用せず、新Windowへ進む。期限行は小Batchで24時間以内に削除し、cleanup遅延/障害を固定Codeで通知する。Rate行は認証backup/復旧の正本にしない。退役したRate鍵を廃棄しても現Windowを空に戻さない。Productionでのcounter保護/DB Failover/Backupからの巻戻し対策、共有HMAC保管/Rotation、負荷と保持の実運用は別Gateであり、今回Productionを有効にしない。

localhost proxy経由は同じPeerへ集約されるため、Peer別上限はBrowser別ではなく開発利用全体へ掛かる。Host/Forwardedで任意Peerへ分散させない。この初期上限をMVP本番の容量保証としない。

## 開発CompositionとBuild隔離

D-PRE-1 / DC1/DC4: 認証有効化は専用開発entryの明示起動だけ。NODE_ENV=production、非localhost Origin、非loopback listen/DB接続、専用末尾`_auth_dev`でないDB、未設定Google Client ID、複数process、非空の既存認証Dataでは起動拒否する。localhostの`.env`は明示指定した公開可能な変数名だけを検証し、Processへ設定実値をdumpしない。

D-POST-1: OS CSPRNGの独立32-byte値を各HMAC用途・各DEKへ発行する。新しい開発processは新しいepoch/Provider所有token/DEKを使う。NonceはKeyごとに単調割当し、同process内の外側DB rollbackで戻さない。Key/counterを失った状態で同じKey世代を再生成しない。単一process leaseはDB advisory lockで保持し、接続喪失時はHTTP受付を止める。起動の非空検査と初期化はこのlease下で直列化する。

D-FAIL-1: 再起動後の認証Dataが非空なら、既存Ciphertextを新しい鍵で解こうとせず起動拒否する。Operatorが専用DB名と所有を確認し明示resetした場合だけ再開できる。通常のAPI起動やschema migrationに自動drop/resetを入れない。これは永続Providerを実装した証拠ではなく、使い捨てlocalhostだけのOwner承認済みのA2 durability例外であり、実装評価とProduction Gateは別である。

`apps/api/dev/`には実Google Verifierと実pg Storeを使う開発Compositionを置き、Test-only Provider/固定Identity/認証bypassをImportしない。開発実装は独立したtypecheck/lintとArchitecture Testの対象に追加する。Production buildには開発entry/Provider/合成鍵が入らないことを生成物でも確認する。通常mainの認証Capability不足時は未有効/503とし、環境Flagだけで開発Providerへfallbackしない。

Webは同じlocalhost Originの相対`/auth/*`を使い、開発時だけ固定loopback APIへ転送する。Originを信頼済み値に書き替えず、複数Set-Cookieを保持する。実Googleの開発ClientとAuthorized JavaScript Originの設定/手動Browser検証は#219で行い、A5の結合Testは署名検証Port境界だけを差し替える。

## Test TraceとDelivery

| #218 Done Criteria | 必須Evidence |
| --- | --- |
| DC1 事前設計 | Owner Decision、独立Security/Planning、保存後の別Planning、Origin/Rate/Provider/Build profileの全条件 |
| DC2 4操作/実保存 | HTTP→A1→実pg Storeのbegin/login/inspect/logout、Cookie属性/削除、Server nonce、Scope serialization、inspect非延長、別Session維持、OpenAPI一致 |
| DC3 異常/競合 | Origin欠落/null/scheme/port/重複、GET Origin省略とcustom Header、偽Forwarded、form/未知/重複Field/圧縮/stream超過/読取期限、CSRF欠落/不一致、Cookie不正、期限/失効、Audit/鍵/Rate障害、2instanceの上限最終枠、Window境界/応答喪失 |
| DC4 非漏出/隔離 | Response/Error/Log/Cache検査、no-store、raw IP非保存、Production buildに開発/Test認証なし、main未有効、専用DB/非空/loopback/NODE_ENV/lease喪失の拒否 |

実PostgreSQL17末尾_testの既存Suite隔離規約を維持し、専用`authentication_http` Schemaも所有検査/cleanup対象に含める。Migrationは空DBと既存認証/Group DBを検証し、既存5/6のchecksumを変更しない。新しいTable/Index/Check/保持をSchema文書・Inventoryへ同期する。追加Migration適用後はforward-fix、未使用専用DB以外で破壊的Downをしない。

既存#218を更新し、新Epicや重複HTTP Taskは作らない。前提PR230統合済み、Stack不要、#218通常PR→統合後#219個別評価。実装規模はPlanningで5人日/SP8とした。OpenAPI/README/API-docs validator、backend/Architecture Test、認証仕様、開発Runbook/環境Template、Rate Schema/保持、既存EpicのTraceを同じTaskで同期する。Accepted ADRの履歴は保持し、承認履歴と対応するOpenAPIを維持する。

## 外部根拠とDecisionの区別

2026-10-21に[Googleの開発Client設定](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)でlocalhostのOrigin登録、[OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)でOrigin/Proxy/Tokenの境界、[MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)でSecure/HttpOnly/host prefix、[PostgreSQL17 INSERT](https://www.postgresql.org/docs/17/sql-insert.html)で競合時UPSERTの原子性を確認した。HTTP/CSRF/Rate全体の正しさをUPSERT一つから保証しない。具体Cookie名/上限/保持/localhost例外/使い捨てProviderは2026-10-21にOwnerが承認したProjectのDecisionであり、公式推奨値ではない。

## 承認後に残るGate

Ownerは本案（非Secure localhost Cookieと再起動で復元できない使い捨て開発Dataを含む）を承認済み。独立Security・Planning・保存後確認は通過済みであり、実装後の4専門ReviewとDraft PRを残す。永続する開発認証への変更は別Provider Taskの設計を要する。実Google手動、Production Provider/Proxy/Traffic/Backup/退会運用の未実証を今回の設計やFake成功で解消しない。

## 実装・検証の参照

- [HTTP Adapter/入力検査](../../apps/api/src/presentation/http/authentication/)、[HTTP Port](../../apps/api/src/shared/application/authentication/authentication-http-ports.ts)、[共有Rate](../../apps/api/src/shared/infrastructure/authentication/postgres/postgres-authentication-http-rate.ts)
- [使い捨て開発入口](../../apps/api/dev/)、[開発Runbook](../operations/authentication-local-development.md)、[Web同一Origin転送](../../apps/web/app/auth/%5B...path%5D/route.ts)
- [HTTP Unit](../../apps/api/src/presentation/http/authentication/authentication-http.spec.ts)、[入力Unit](../../apps/api/src/presentation/http/authentication/authentication-http-input.spec.ts)、[実Runtime DI](../../apps/api/test/authentication-local-runtime.integration.spec.ts)、[共有Rate競合/故障](../../apps/api/test/authentication-http-rate.integration.spec.ts)、[Migration](../../apps/api/test/authentication-schema-migration.integration.spec.ts)

Web転送はdevelopmentだけ固定loopbackへ接続し、Productionでは503。Origin不在/不一致を補わず複数Set-Cookieを保持する。接続障害はURL/原因例外をLogへ出さず、同じno-storeの503 Envelopeで返す。Webもloopback待受を明示する。APIのHeader数/総量/Body上限と5秒期限はNode/API境界で強制する。
