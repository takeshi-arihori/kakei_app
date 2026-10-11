# Googleログイン接続の設計・作業提案

Knowledge State: ADRの方式・TTL・保持方針は2026-10-11にOwner Accepted。作業候補・未実装公開契約・詳細保存案はProposedであり、一括Readyではない。[Accepted ADR](../adr/google-login-actor-session.md)と[内部Lifecycle契約](google-authentication-lifecycle.md)を参照する。

## 基準と事前調査

- Base: 最新取得済み`origin/develop` = `2a3e52d`（PR #208統合、2026-10-11確認）。primary checkoutと同一Commit、dirtyなし、既存追加Worktreeなしを確認してから`.worktree/auth-session-design`を作成した。
- Requirement: [Epic #202](https://github.com/takeshi-arihori/kakei_app/issues/202)の「Googleだけでログイン・ログアウトし、検証済み外部識別子を内部Actor・アプリSessionへ接続」。今回は招待コード・Group参加を対象外にする。
- Confirmed Decision: [ADR #203](../adr/google-login-and-registered-recipient-invitation.md)のGoogle／事前登録／コード共有、[ADR #36](../adr/group-management-command-authorization.md)の信頼済みActor、[ADR #55](../adr/snapshot-revision-security-and-retention.md)の既存Production Gateを維持する。
- 現行実装: `apps/api/src/shared/application/google-id-token-verification.ts`とSDK Adapterは期待nonceを受け、検証済みissuer／subだけを返す。`apps/api/src/app.ts`はhealthとGraphQLだけ、`main.ts`はPORTだけを読む。`apps/web/app/page.tsx`は入口、Google環境変数は準備用で未接続。認証DB・Session Guard・ログイン画面は存在しない。
- Domain要素: ActorSubjectはGroup Commandが受け取る本人性参照、ParticipantはGroup内の別Lifecycle、Invitationは宛先Actorへ束縛される。Login Attempt／Sessionは技術的な状態であり、Group AggregateのChild Entityや業務Eventにしない。
- 設計品質: VerifierはGoogle本人確認へ凝集しており変更不要。Actor登録やCookieをVerifierへ追加すると単一責任を破る。Group認可はSessionにRoleを固定せず、既存Application Policyと同判断点のGroup版に任せる。共有暗号基盤はGroup-boundであり、Accountにそのまま流用できない。
- Open Issue 8件を確認。#202の後続3・4は正式Taskでない。#203は3つの選択だけAccepted。#206／#12／#15は別Scope、#172はReceipt、#90／#92は画面・公開契約のTrace先。既存Epicを再利用し、重複Epicを作らない。品質改善2件はこの認証Taskに混ぜない。

## Requirementと受入結果

| ID | 必要な結果 | Done Criteria / 主なEvidence |
| --- | --- | --- |
| AUTH-R1 | 本人確認とBrowserのログイン操作を結び付ける | 他Browser・別nonce・期限切れ・消費済み試行では登録／Sessionを作らない |
| AUTH-R2 | 同じGoogle本人は同じ内部Actorになる | 同時初回ログインでもActor一つ、email・Client申告IDは不使用 |
| AUTH-R3 | CookieだけからServerが本人性を確立する | 期限／失効／Actor無効を毎Request検証し、秘密値・RoleをClient保存しない |
| AUTH-R4 | 明示ログアウトで現在Sessionを使えなくする | 応答後に開始したRequestは認証不可。別Browserは継続する |
| AUTH-R5 | Googleボタンからログイン・ログアウトを操作できる | 成功・取消・期限切れ・通信失敗・再試行・再読込を画面／実APIで確認する |
| AUTH-R6 | 部分反映と機密漏出を防ぐ | Transaction故障／並行消費／鍵・Audit障害でfail closed。TokenをLog・DB・URLへ残さない |

## 責務と配置案

`src/shared/application/authentication/`に内部契約、Use Case、Clock／Entropy／Store／Audit／RateLimit Portを置き、具体DB・Google SDK・Node暗号をImportしない。`src/shared/infrastructure/authentication/`にAdapterを置く。既存Verifierを別Portとして再利用し、用途別Digest／認証Envelopeの設計は保存Taskで確定する。

共通HTTPの薄いAdapterを`src/presentation/http/authentication/`に置く案。Transport共通の本人性確立に限り共有Application Portの参照を認めるBackend Rule追補を承認後の同期Taskで行う。Context固有の業務認可・Resolverは移さない。Architecture Testを正確なPath単位で更新し、任意の共有Infrastructure参照を許可しない。

Use CaseはbeginGoogleLogin、completeGoogleLogin、withAuthenticatedActor、logoutCurrentSession。Session Storeはopaque credentialの検索、原子的なcompleteLogin、固定された本人性の下でCallbackを実行する境界、失効を提供する。Groupへの実接続は後続TaskでSession→Actor→Groupのlock順と同じ判断点を検証する。信頼済みActorSubjectを生成できる入口はServer側のSession境界だけに限定する。

## 操作契約案

各行の根拠はAUTH-R1〜R6とAccepted ADRである。業務Invariant、Transport検証、Transaction制約を区別する。

| Contract | 分類／責務 | 条件と失敗時の状態保証 |
| --- | --- | --- |
| LOGIN-PRE-1 | PRE / HTTP | 設定済みOrigin完全一致、POST JSON、許容Body size。違反時はCookie・保存状態を変更しない |
| LOGIN-POST-1 | POST / Application | begin成功で5分有効のAttempt、CSPRNGの独立したBrowser秘密値・nonce・CSRF値を発行。Browser秘密値はCookieだけ、nonce／CSRFはno-store Responseだけに返す |
| LOGIN-PRE-2 | PRE / Trust | completeでCookieのDigest・CSRF・Server保持nonceを同じAttemptへ照合。Token内／Client本文のnonceを期待値に使わない |
| LOGIN-FAIL-1 | FAIL / Application | 不正CredentialはActor・Session・試行消費を変更しない。Google障害も試行を残し、期限内に再試行できる。Rate limitの試行数は増えてよい |
| LOGIN-POST-2 | POST / Transaction | Google検証後、commit時刻で`now < expiresAt`かつ未消費をCAS確認し、Actor対応・Session・Attempt消費・成功Auditを共通commitする |
| LOGIN-INV-1 | INV / Persistence | 一つの外部IdentityにActor一つ、AttemptからSession最大一つ。Actor登録競合の敗者は既存Actorを使い、新たなActorを残さない |
| LOGIN-FAIL-2 | FAIL / Retry | 消費済み試行の再送は再ログイン要求。成功応答喪失でもSession秘密値のDB復元・再返却をせず、新Attemptから始める。到達しなかったSessionは期限／清掃で除去 |
| SESSION-PRE-1 | PRE / Trust | `now < absoluteExpiresAt`かつ`now < idleExpiresAt`かつ未失効・Actor有効。期限と等しい時刻は拒否。DB／鍵障害はUnavailableで認証しない |
| SESSION-POST-1 | POST / Transaction | 有効な利用でidleExpiresAtを`min(now+24h, absoluteExpiresAt)`に更新する。無効Cookieでは更新しない。単純なバックグラウンドpollで無期限に延命しない |
| LOGOUT-POST-1 | POST / Transaction | 現Session失効commit後にCookie削除応答。失効済み／期限切れ／CookieなしはOrigin検査後204。Store障害では503、成功扱いしない |
| SESSION-INV-1 | INV / Coordination | Session認証のlease／lockは対象CallbackのcommitまたはResponse serializationまで保持し、logoutは同じSessionを排他的に失効。既開始処理はlogoutより先に完了するか、失効後に拒否する |
| ACTOR-FAIL-1 | FAIL / Trust | Actor無効化は新規Session発行と既存Session利用の両方を拒否。Client申告Actor、Role、email、任意Providerを本人性として受け取らない |

VerifierのネットワークI/O中はDB row lockを保持しない。completeLoginは検証前にAttempt snapshotを取得し、検証後に同じRecord版・期限・Cookie／CSRF束縛を再確認する。Serverで検証済みIdentityを作ってからStoreへ渡し、Transport Inputでこの型を偽造しない。

beginの再送は既存未消費Attemptを置換する。複数Tabでは最後のCookieに対応する試行だけを完了でき、古い画面は再試行表示へ戻る。有効Sessionがあるbegin／completeは409を返し、別Accountへの無言の切替を許可しない。

## 公開HTTP契約案

同一Originの`/auth/*`と`/graphql`をHonoへRouteする。配置経路・Proxy trustの具体化は公開接続TaskのReady条件であり、Host／X-Forwarded-*自己申告を信頼しない。実装前は[OpenAPI](../api/openapi.yaml)へ追加しない。

| Endpoint | Input | 成功結果 |
| --- | --- | --- |
| POST /auth/google/attempt | 空のJSON、Origin | 201 `{ nonce, csrfToken, expiresAt }`＋Attempt Cookie |
| POST /auth/google/login | `{ credential }`、Attempt Cookie、X-CSRF-Token、Origin | 204、Session Cookie＋Attempt Cookie削除 |
| GET /auth/session | Session Cookie | 200 `{ authenticated: true, csrfToken, expiresAt }`、無効なら401 |
| POST /auth/logout | Session Cookie、X-CSRF-Token、Origin | 204、Cookie削除 |

Session CSRFはSessionへ束縛し、GET sessionで同一OriginのScriptだけにno-storeで返す。GETはidle期限を延長しない。開始・完了・Logoutはstrict Origin、認証済みの将来の業務MutationもCSRFを要求する。GIS JavaScript callbackで得たcredentialをアプリのJSON Endpointへ送る方式とし、Google直接POST用`g_csrf_token`検査を自前JSON経路で実装済みとは主張しない。One Tap／auto-selectはMVPでは使わずGoogleボタンによる明示操作とする。

Bodyは18KiB上限、credentialは既存Verifierの16KiB上限。未知Field・Actor／Role等を拒否する。認証Responseは`Cache-Control: no-store`、中間Cache／Service Worker／Error reporterにもCredentialを保存しない。

Error envelope案は`{ error: { code, requestId } }`だけ。400 INVALID_REQUEST、401 AUTHENTICATION_REQUIRED、403 REQUEST_REJECTED、409 LOGIN_RESTART_REQUIRED、429 RATE_LIMITED、503 AUTHENTICATION_UNAVAILABLE。nonce／issuer／sub／Cookie／SDK例外・DB例外・Account存在を返さない。期限切れ・不正Credentialの区別を利用者識別に流用しない。Rate limit上限・分散Store・信頼IP抽出は公開接続Taskの追加設計Gateであり現時点では未確定。

CookieのProduction属性はADR案に従う。localhost専用の非Secure Cookie例外を設けるなら別名・loopback限定・Production起動拒否をTaskで確定する。Secureを設定で任意に無効化する契約は採用しない。実GoogleのAuthorized JavaScript Origin設定と同じ開発用Client IDのWeb/API接続を実機検証する。

## 保存・保持・移行案

認証専用SchemaはActor、Google Identity対応、Login Attempt、Sessionを所有する。Groupから認証SchemaへCascade FKを追加しない。Actor IDはCSPRNG UUIDv4。外部Identityの検索は専用keyed digest、Cookie秘密値は256-bit乱数の用途別digestを使う。平文として許容するのはランダムRecord ID、版、期限・失効・消費状態、必要最小のFK／索引だけという案。外部Identity／nonce／CSRF値を通常Columnに保存しない。平文索引による認証Schema内のLinkabilityはThreat Reviewで明示する。

Group用protected-recordは利用できる抽象部分だけを検討し、Group IDを偽造して使わない。認証用AAD、Record kind、Actor別鍵、Attempt用鍵、keyed digest用途・Rotation／複数Version照合・Nonce counter、Audit原子性・保存先を保護保存Task前に定義する。Actor一意性は鍵Rotation中も維持し、旧索引の移行と旧鍵retirement前に同じGoogle本人の二重登録を検査する。Sessionから外部Identityを復号する必要はない。

専用Migrationを空DB／既存Group DBに適用し、既存業務Dataが変わらないことを実PostgreSQLで確認する。最初は追加のみ。Data適用後はForward-fixとし、Downは空／未使用の分離環境だけで確認する。

認証Recordの期限と24時間以内の物理清掃を区別する。Sessionは期限到達時点で利用不能であり、Batchを待たない。Actorの無効化・全Session失効とIdentity鍵破棄の再試行、35日以内のBackup復旧で消費済みAttempt／失効Session／削除Identityを復活させない手順は本番Gate。未完了支払・Owner在籍・本人の過去閲覧権との関係を退会運用Taskで解消するまで退会UI・Production有効化を行わない。

## Task候補・Delivery順序

A1は[正式Task #210](https://github.com/takeshi-arihori/kakei_app/issues/210)、承認証跡は[ADR #209](https://github.com/takeshi-arihori/kakei_app/issues/209)。A2以降の行は正式Issueではなく、個別Planningで1 Deliverable／Branch／Draft PRへ分割する。A2以降は未決設計・先行実装待ちのためBacklog相当・Blocked Yes。Epic #202、Private Project #9、Owner takeshi-arihori、Priority High、Milestone MVP設計、Decision Check 方針変更あり、Related ADR #203／#36／#55＋新提案。Estimateは人日目安でありカレンダー日数・完成日の約束ではない。

| ID / Deliverable | Done Criteria / Verification | 依存 / 初期Estimate / Area・Phase |
| --- | --- | --- |
| A0: 承認済み認証Decision・契約同期 | 独立TaskにせずA1の文書影響へ統合する。承認証跡・ADR・設計Gate・責務・Issue Traceを同じ差分で同期 | A1に包含／個別Estimateなし |
| A1: Login Attempt→Actor→Session内部Lifecycle | 上記契約のUse Case／Portを実装。Fake境界で全拒否・期限・再送・状態保証をTDD、依存方向検査。DB・HTTPなし | Owner承認済み・#207 merge済み／2人日・SP5／Backend・Validation |
| A2: 認証Dataの保護保存契約 | 認証Envelope／平文Inventory／用途・鍵Rotation／Nonce／監査／削除Restore・lock順を実装可能な仕様へ確定。独立Security Review。未決Providerは本番Gateへ分離 | A1 merge／2日／Security・Design |
| A3: 認証専用Schema／Migration | 承認済みA2へ沿う制約・索引を追加。空／既存DBのMigration、FK／一意性、Forward-fix検証 | A2 merge／1日／Data・Validation |
| A4: 原子的Login・Session保存Adapter | Attempt消費＋Actor一意＋Session＋成功Audit、照会／失効の実PostgreSQL Adapter。2接続競合・故障rollback・応答喪失・Rotation／破損を検証 | A3 merge／2日／Data・Validation |
| A5: 認証HTTP・Cookie境界 | 上記HTTP契約をOpenAPI／READMEへ同期。Origin／CSRF／Cache／Cookie／失効／公開Error・Rate limit契約とDI結合Test。Body・Proxy／localhost設計も確定後着手 | A4 merge＋公開接続の追加設計／2日／API・Validation |
| A6: Googleログイン／ログアウト画面 | /login、Googleボタン、取消／失敗／再開、認証状態、Logoutを実APIへ接続。日本語・keyboard・狭幅・E2E。Google SDK callbackだけを境界差替えしたCI＋実アカウント手動検証を区別 | A5 merge＋安全な開発Composition設計／2日／Web・Validation |

順序はA1（A0包含）→A2→A3→A4→A5→A6。A0はRequirement／Decisionの同期だけでA1へのCode依存がないため、独立Taskとmerge待ちを廃し、最初の実装の文書同期として包含した。前提merge後の最新developから開始する通常PRで、未merge Codeへの依存を使わないためStacked PRなし。後続Taskは先行merge後に個別Planning／Ready評価し、必要ならさらに分割する。現在の表のまま後続を一括Readyへ移さない。並行Agent実装は予定しない。

A1は保存前・保存後の独立Planning評価を通過したTask #210へ対応する。A2以降の暗号詳細、Provider／公開Rate limit、同一Origin配置、開発Compositionは未決のまま明示的に設計へ残す。Production Composition、durable Provider／Audit／Retention／Backup、退会運用、信頼Proxy／Deploymentは別の正式Task化・承認・検証が必要で、A6完了を本番利用可能／MVP全完成とは報告しない。

## 検証Trace

| 対象 | 必須Scenario |
| --- | --- |
| A1 / R1・R2・R3・R4 | 5分／7日／24時間の等値境界、独立Browser／nonce／CSRF、不正・障害・期限跨ぎ、同じ本人、使用済み、失効／Actor無効、ログアウト対象限定 |
| A3・A4 / R2・R3・R4・R6 | 同時初回、同Attempt二重消費、異Attempt同本人、Insert各段故障、commit応答喪失、再送、logout対authenticate、Audit／鍵障害、Envelope差替え、Rotation中一意性 |
| A5 / R1・R3・R4・R6 | Origin欠落／null／別scheme・port、偽Proxy、form／oversize、CSRF欠落／不一致、Cookie属性・削除、no-store、Rate limit・Store故障、Error／LogにCredentialなし |
| A6 / R5 | 実API login→再読込→logout、Session期限／通信失敗／別Tab、Google取消／SDK失敗、設定未完・Provider利用不可表示、keyboard・狭幅 |

将来のTestでHTTPのGoogle署名検証を二重実装しない。既存Verifierの実署名Testを保持し、SessionテストはVerifier Portだけを置換する。Production buildにFake Identity／固定Actor・認証bypassを追加しない。A1の内部Application／PortとUnit Testは同じPRで実装する。DB・E2E・実Google接続の検証は実Adapter／公開接続の後続Taskで行う。

## 外部仕様の確認

2026-10-11に[Google JS API reference](https://developers.google.com/identity/gsi/web/reference/js-reference)のnonce／callback、[Google server verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)のToken検証とsub識別を確認した。[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)のServer側期限・失効と、[CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)のlogin pre-sessionを設計根拠として確認した。本提案の具体期限・Cookie／保存設計はProject判断案であり、それらが公式推奨値と一致するとは主張しない。

## Skill・文書影響・残事項

使用: pre-investigation、prepare-github-work、domain-design（Actor／Participant・責務の整理）、api-design、database-change、specification-contract。新規Domain Rule発見は不要なのでdomain-modeling省略。A1でimplement-github-task／feature-development／testing／implementation／code-reviewを使用する。Stack未採用のためstacked-pr-delivery、画面差分がないためprepare-pr-evidenceを省略する。

A1は承認済みADR・内部契約・ADR一覧・design-gates・backend・Verifier契約・Epic／Taskを同期する。SDL／OpenAPI、Schema、環境変数、Runtime wiringは対象外。リンク／公開内容scan／状態区分とUnit／API回帰を確認し、最新DiffのSelf Review・新しいread-only task_evaluator pass後にDraft PRへ進む。

## Owner承認

2026-10-11（Asia/Tokyo）、Ownerは提示した設計案に「進めていいです。」と回答した。方式・TTL・保持方針はAccepted、詳細保存・公開接続・Production Gateは後続へ維持する。検証・独立評価の実行EvidenceはTask／PRへ記録し、この文書を進捗の二重正本にしない。
