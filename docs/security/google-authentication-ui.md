# Googleログイン画面の契約（A6）

Knowledge State: Confirmed（Issue #219のRequirementと2026-10-25 Owner承認のCI方式）。[A5 HTTP契約](authentication-http-boundary.md)、[認証Lifecycle](google-authentication-lifecycle.md)、[localhost Runbook](../operations/authentication-local-development.md)を維持する。実Google手動成功、独立4専門Review、Draft PR、Production有効化はそれぞれ別のGate。

## 利用経路と責務

Homeから`/login`へ進み、現在Sessionをinspectする。未認証なら「Googleログインを準備」でServer Attemptを作り、公式日本語Google buttonを表示する。Googleのpopup確認後、同AttemptのCredential/CSRFをA5 loginへ送り、inspectの成功で「ログイン中」を確定する。現在Sessionのlogout成功または確認済401だけでログアウトを確定する。名前/email/avatar/Actor/Roleは表示・要求しない。

Server ComponentはRoute/公開設定、`src/features/authentication`はHTTP client・局所Controller・GIS Adapter・最小Client Viewを所有する。本人性、期待nonce、原子的消費、Session/CSRF/権限/保持/暗号の正本は既存Server。新しい業務InvariantやAPI/Schemaは追加しない。

## 操作契約と失敗

- UI-PRE-1: Webの公開Client IDはAPIと同じ値。Client Secret/API Keyは使用しない。Productionは開発能力を有効にせず、設定未完として案内する。
- UI-PRE-2: 相対4APIに`X-Kakei-Request: 1`、same-origin Cookie、no-storeを使う。Originを補わず、POST JSONと対応CSRFを送る。期待status/厳格なResponse構造/canonical秘密値/数値期限をunknownから検査する。生本文/例外の詳細を表示/Logしない。
- UI-POST-1: 初回/再読込/表示復帰はinspect200/401が状態の根拠。503/読取不能は未認証成功に置換しない。
- UI-POST-2: beginで返ったnonceだけをGISへ渡し、二重callback/二重送信を一回に制限。login204や結果不明の後もinspectで確認する。
- UI-POST-3: logoutは同Session CSRFとCookieを使う。失効前に独自にCookieを消さず、障害時はinspectと同Cookieでの再試行へ進む。
- UI-FAIL-1: 取消でUI試行を無効にし、遅いCredentialを送らない。Server Attemptの削除やGoogle popupの強制終了を主張しない。Google画面を閉じた場合も中止/再開始できる。
- UI-FAIL-2: 期限/409/再開始は必要に応じinspectで既存Sessionを確認し、新しいdocument/Attemptへ進む。同documentのGoogle initializeは一回。One Tap/auto select/redirectを使わない。
- UI-FAIL-3: 429はRetry-After後の明示再試行。未知Error、Script障害/15秒timeout、通信結果不明は固定日本語案内で再確認/再開始へ進む。無限自動retryなし。

## 継続する技術保証

Credentialは一回のHTTP送信だけ、nonce/CSRFはメモリ内だけで扱う。アプリのURL、Local/Session Storage、DOM診断、Log、計測へ保存しない。HttpOnly CookieをJSで読まない。Google SDK自身の内部通信をこの保証の実装済み範囲へ含めない。

generationと別inspect識別子で、unmount/取消/古い応答が新しいlogin/logoutを上書きしない。popup復帰のfocusで得た401だけでは現在の試行を捨てず、callbackとの競合を扱う。focus/visibility/pageshowで別TabのSession変更を再確認する。BrowserイベントをServer失効の正本にしない。

日本語Label、status/live regionとError通知、二重操作抑止、可視Focus、44px操作領域、狭幅/200%/Reduced Motionを検証する。GIS幅は表示先に収める。公式large buttonの40px高を縦横比を保つ1.1倍の拡大で44pxとし、320px/1280pxで公式buttonの操作領域と横方向のはみ出しがないことを別途確認する。合成Fixtureも拡大前の40px高を再現する。

2026-10-26 Ownerの明示指示により、実スクリーンリーダーによる読み上げ操作テストは今回はスキップする。成功／非該当とはせず未検証として残す。Label／status／alertの実装と自動検査、公式Google buttonのKeyboard操作と可視Focusの確認は維持する。

SDK等の非認証Cookieの値は[Cookie共存ADR](../adr/authentication-cookie-coexistence.md)に従いServerで解釈せず無視する。認証Cookieの厳格値/重複、Header総量8KiB/制御文字/名前/区切りの拒否を維持する。popup復帰時のinspectとlogin/reload/logoutを合成SDK状態Cookieの共存でも検証し、外部Cookieを消して成功させる回避策は使わない。

## Google設定とlocalhost

`NEXT_PUBLIC_GOOGLE_CLIENT_ID`はNextが読む公開IDだけ。APIは既存の明示環境変数`GOOGLE_CLIENT_ID`。`http://localhost:3000`をAuthorized JavaScript Originへ登録し、Google推奨の`http://localhost`も設定する。popup callbackを使い、独自redirect URI/Token保存先を追加しない。Google CloudのOAuthブランド/テスト利用者等はOwnerが管理する。

公式ScriptのURLは`https://accounts.google.com/gsi/client?hl=ja`に固定。開発`/login`だけReferrer-Policy no-referrer-when-downgrade、COOP same-origin-allow-popupsを設定し、本番へこの例外を広げない。API/Webの固定loopback/Origin、専用_auth_dev、使い捨て鍵/非空再起動拒否を変更しない。

## Test Traceと非漏出

| 条件 | Evidence |
| --- | --- |
| API検査/状態不明/拒否 | authentication-client.spec、API/PG既存回帰 |
| 二重/取消/期限/旧inspect/結果不明/再試行 | authentication-controller.spec、認証Browser E2E |
| 実SDK署名/nonce/Cookie/保存 | 専用認証E2Eの実Runtime/SDK/PGとbad-signature/bad-nonceの拒否 |
| 初回/再読込/logout/別Tab/期限/503/Rate | localhost:3000の認証E2E、HttpOnly/URL/Storageの秘密非保存検査 |
| 日本語/設定未完/Production未接続 | Panel Unit、Production Shell E2E |
| Keyboard/Focus/狭幅/拡大/Reduced Motion | Chromium E2Eと合成画面Screenshot。公式GISは匿名BrowserのTab/Enter、可視Focus、44pxと横幅を別確認 |
| 実スクリーンリーダー操作 | 2026-10-26 Owner指示でスキップ。Label/通知の自動検査から実読み上げ成功を推定しない |
| 実Google | Owner操作のClient/Origin/login→再読込→logout/取消の手動記録。合成結果で代替しない |

Owner承認によりCIはGoogle外部境界（GIS応答と公開鍵取得）だけを合成する。各Test専用processがRSA鍵/JWTを実行中だけ生成し、実Google SDKで署名/issuer/audience/nonce/期限を検証する。API/Runtime/Store/Rate/Cookieは実物。偽署名/別nonceは拒否する。通信障害はBrowserのTransportで故障注入し、本人性の成功を固定しない。

API test/supportのFixtureはNODE_ENV=testと専用flagを要求し、管理接続のPG17/末尾_testを検査、試験所有の一時_auth_devだけ作成/終了時cleanupする。鍵/TokenはFile/Logへ保存しない。Test Clockと制御endpointを通常dev/Productionへimportせず、Test資料やBrowser Profile/Traceを製品へ含めない。実Google手動ではToken/Cookie/個人情報のScreenshotや通信本文を保管しない。

## 外部根拠/残るGate

2026-10-25に[Google JS Reference](https://developers.google.com/identity/gsi/web/reference/js-reference)、[Setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)とNext16.2.10同梱docsを確認。popup/nonce/初期化と開発Headerの根拠であり、本人性/TTL/ProductionのDecisionを上書きしない。

公式buttonの縦横比を保った拡大は、2026-10-26確認の[Googleブランドガイド](https://developers.google.com/identity/branding-guidelines)に従う。独自の代替buttonやGoogle画面の模写は製品へ追加しない。

Production鍵/Nonce耐久性、Ledger/Witness、物理Backup、退会/Ingress/IAM/Failover/監視は従来の別Gate。Group参加/招待画面とGoogle APIアクセス用Tokenは対象外。画面完成をProduction公開やEpic全体完了とは扱わない。
