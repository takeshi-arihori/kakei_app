# 業務GraphQLの認証・CSRF・公開Errorの境界

- Status: Accepted
- Owner: Project Owner（takeshi-arihori）
- 承認日: 2026-11-19
- Decision Check: 方針変更あり
- 承認記録: [Issue #304](https://github.com/takeshi-arihori/kakei_app/issues/304#issuecomment-7006879293)（Owner会話承認「推奨案をすべて採用する」1A〜6A）
- 関係: Supplements [Googleログイン・Actor・Session](google-login-actor-session.md)（Decision 5）、[認証HTTP・共有Rate limit・使い捨て開発Composition](authentication-http-and-development-boundary.md)。前提 [Browserから見えるOriginを1つにする配置方針](single-browser-origin-deployment.md)（#302）。関連 [GraphQL入口の制限](graphql-entry-hardening.md)（#293）
- 実装: [#317](https://github.com/takeshi-arihori/kakei_app/issues/317)（Epic [#303](https://github.com/takeshi-arihori/kakei_app/issues/303)）

## Context

- `/graphql`はGraphQL Yogaへそのまま渡しており、Session Cookieから本人（Actor）を得る経路、変更系のOrigin・CSRF検査、公開Errorの写像、no-storeがなかった。CORSは#292で閉じた。
- 共有認証は`withAuthenticatedActor(secret, usage, callback)`を持つ。1 Transaction内で鍵状態→Session照合→Actor Lock→Session Lock→Callback→seal→（`activity`ならidle延長）→Audit→commitを行い、Callbackの本文handleをcommit後に返す。Lockは Callback完了とcommitまで保持される。
- 認証HTTP（`/auth/*`）は、Origin完全一致、`X-Kakei-Request: 1`、`Sec-Fetch-Site`、固定名Cookie選択、Session束縛CSRFの定数時間照合、`{ error: { code, requestId } }`、no-storeを持つ。
- `docs/engineering/backend.md`は「GraphQL認証・認可AdapterはContext Presentation」としており、全Context共通の本人性とContext固有の認可を区別していなかった。
- Server Componentからの呼出しはBrowserを経由しないため、Originを持てない。
- Group Managementは非在籍者へ`UnavailableToActor`で存在を開示しない。公開変換は本番接続前に定義するとしていた。

## Decision

### 1. 本人性: 業務Operation単位の認証lease

- 業務Operation（top-level field）ごとに`withAuthenticatedActor(secret, 'activity', …)`のleaseを開き、その内側で業務Use Caseを実行する。業務Transactionはlease（Actor／Session Lock保持中）の内側で開始・commitし、その後に認証がcommitする。
- LogoutやActor無効化はActor／Session Lockを要するため、業務commitは必ずそれらより前に直列化される。失効後に業務Dataを作らない。
- 業務commit後に認証commitが失敗した場合は結果不明として`SERVICE_UNAVAILABLE`を返す。Mutationは`operationId`の成功再送で同じ結果へ収束させる。
- 業務Query・Mutationとも`activity`（無操作24hの延長。最長7日は超えない）。`/auth/session`は従来どおり`inspect`。
- 認証Scopeへは固定本文だけを発行し、業務の値はcommit後に返す。Resolverへ渡す本人性は`actorSubject`だけで、秘密値・CSRF・期限を渡さない。
- 取得順は「認証→業務」に固定し、業務側から認証leaseを開かない。認証と業務のPool上限・待機timeoutはCompositionで分ける。

### 2. 配置: 本人性は共通GraphQL、認可はContext Application

- 共通`src/presentation/graphql`に、Request前提の検査（`X-Kakei-Request`・`Sec-Fetch-Site`・Origin・Session Cookie選択）、実行Operationの種別による変更系検査、`AuthenticatedOperation`（lease内でCSRF照合→業務処理）、公開Error型・写像・maskを置く。
- Context Presentationは共通GraphQLの`AuthenticatedOperation`の型と公開Error型だけを参照し、`actorSubject`をCommandへ写像する。共有認証を直接Importしない。
- 共通GraphQLは`shared/application/authentication`（Service型・Port）だけを参照できる。共有Infrastructure・認証HTTP Presentation・Context Application以下は参照しない。具体Service（pg／crypto／SDK）はCompositionが`createApp`へ注入する。
- 通常main（能力の注入なし）では、認証付きOperationを`SERVICE_UNAVAILABLE`で封鎖し、照合先のOriginがないためOrigin付きRequestを拒否する（認証経路を有効にしないDecision 8を維持）。

### 3. Origin・Header・CSRF

| 検査 | Query | Mutation | 失敗 |
| --- | --- | --- | --- |
| Method・Content-Type | POST＋`application/json`のみ（[#293](graphql-entry-hardening.md)） | 同左 | `INVALID_REQUEST` |
| `X-Kakei-Request: 1` | 必須（未認証の`apiStatus`も含む） | 必須 | 403＋`REQUEST_REJECTED` |
| Origin | 存在すれば設定canonical Originと完全一致。欠落は許可（Server Component経路） | 必須で完全一致。欠落・null・重複・不一致は拒否 | 403＋`REQUEST_REJECTED` |
| `Sec-Fetch-Site` | 存在すれば`same-origin`のみ | 同左 | 403＋`REQUEST_REJECTED` |
| CSRF | 不要 | `X-CSRF-Token`はcanonical形式が必須（形式不正は実行前・lease前に403）。lease内で`actor.csrf`と定数時間照合し、不一致なら業務を実行しない（200＋`REQUEST_REJECTED`） | `REQUEST_REJECTED` |
| CORS／preflight | 許可しない（#292） | 同左 | — |

- CSRF Tokenは`/auth/session`が返すSession束縛の値を再利用する。
- Mutation判定は、実行対象Operation（`operationName`で選択）の種別で行う。
- Session Cookieは認証HTTPと同じ固定名（productionは`__Host-kakei-auth-session`、開発は`kakei_dev_auth_session`）を1つだけ選択し、重複・構文不正は400＋`INVALID_REQUEST`。他のCookieは本人性に使わない。
- `X-Kakei-Request`は本人性やCSRF Tokenの代替ではない。

### 4. Server ComponentとBrowserの分担

- Server ComponentはQueryだけをAPIへServer間で送る。受信RequestからSession Cookie 1つだけを転送し、`X-Kakei-Request: 1`と`Content-Type: application/json`を付け、Originを付けない。`cache: 'no-store'`とし、Server-only Moduleに閉じる。
- MutationとClient側の再取得Queryは、Browserから同一Originの`/graphql`転送経由で送る。Origin・`X-Kakei-Request`・`X-CSRF-Token`はBrowserが付けたものをAPIが照合する。
- Server Actionsを業務Mutationに使わない。

### 5. 公開Error・mask・存在非開示・no-store

- 形式は`{ "errors": [{ "message": "<codeごとの固定文>", "extensions": { "code": "<CODE>", "requestId": "<Server発行UUID>" } }], "data": … }`。実行前の拒否では`data`を省略する。`locations`・`path`・入力値・原因を返さない。

| code | HTTP | 条件 |
| --- | --- | --- |
| `INVALID_REQUEST` | 400／405／413／415 | Body・Content-Type・Method・Cookie Header不正、GraphQLの構文・検証・制限違反 |
| `REQUEST_REJECTED` | 403（実行前）／200（lease内のCSRF不一致） | Origin、`X-Kakei-Request`、`Sec-Fetch-Site`、CSRF |
| `AUTHENTICATION_REQUIRED` | 200 | Cookieなし、Session失効・期限切れ、Actor無効（理由を区別しない） |
| `NOT_FOUND` | 200 | 存在しない、非在籍、退出済み、他GroupのID。すべて同じcode・message |
| `CONFLICT` | 200 | 版の不一致 |
| `OPERATION_MISMATCH` | 200 | 同一operationIdで異なる内容 |
| `INVALID_INPUT` | 200 | Use Case入力の検証失敗 |
| `SERVICE_UNAVAILABLE` | 200（実行中）／503（実行前） | DB・Audit・鍵障害、commit結果不明、能力未接続、予期しない例外（mask） |

- 許可List外の例外は、`NODE_ENV`に関係なく`SERVICE_UNAVAILABLE`へmaskする。Yogaの診断Logも出さない。
- 業務Errorから公開Errorへの写像はContext Presentationが1 Moduleで行う。
- 存在非開示: 非在籍者に「存在するが権限がない」と「存在しない」を区別させない（code・message・HTTP statusを同一にする）。処理時間の均一化は約束しない。
- `/graphql`の全Responseに`Cache-Control: no-store`と`X-Content-Type-Options: nosniff`を付ける。GraphQLはCookieを発行・削除しない。Session失効時のCookie削除は`/auth/session`の401が担う。

### 6. Rate limit

Epic #303（開発用Composition）では業務GraphQLにRate limitを掛けない。Production有効化前の必須Gateとして別Decisionで扱う。入口の下限はBody上限・読取期限・Query制限（#293）、Cookieなし・形式不正ではStoreを呼ばないこととする。

## Alternatives

| 論点 | 案 | 不採用の理由 |
| --- | --- | --- |
| 1 | Actorだけ解決してcommitし、解放後に業務Transaction | Logout／Actor無効化の直後に業務commitが起こりうる（TOCTOU） |
| 1 | 招待作成と同じく業務を認証Transactionへenlist | 共有認証の変更とContextごとのenlisted版が必要で、規模とReview範囲が大きい。Operationごとに強い原子性を選ぶことは許容する（招待作成） |
| 1 | Request全体で1回だけActor解決 | 未認証の`apiStatus`でもDBを触り、lease内で業務を実行できない |
| 2 | Context Presentationごとに本人性Adapter | 同じSecurity処理を3 Contextで複製する |
| 2 | Hono Middlewareだけで処理 | Mutation判定はGraphQL文書の解析後、CSRF照合はlease内でしかできない |
| 3 | Origin＋`X-Kakei-Request`だけ（CSRF Tokenなし） | Accepted Decision 5の「CSRF Header」の変更に当たり、Proxy誤設定時の二重化を失う |
| 3 | GraphQL専用CSRF Token | 配布経路と保存契約が増え、用途を分ける脅威がない |
| 3 | QueryにもCSRF | Server ComponentがTokenを持てず、読取はCORSなしで読めないため効果が小さい |
| 4 | Server ActionでMutation | Web Serverを信頼済みClientとする新しい信頼経路が要る |
| 4 | Web→API内部共有秘密 | 秘密の保管・Rotationと信頼境界が増える |
| 5 | 認証失敗をHTTP 401 | Operation単位の認証と未認証fieldの混在を表せない |
| 5 | 認証HTTPと同じ`{ error }` envelope | GraphQL Clientの標準処理から外れる |
| 6 | 認証HTTPの予算を共有、または専用予算 | Peerが Web Serverに集約され意味を持たない。本番のPeer抽出（#295）が未決 |

## Consequences

- 1 Requestで認証接続と業務接続の2本を同時に使う。Pool枯渇のdeadlockを避けるため取得順を固定し、Pool設定をCompositionで分ける（#314）。
- 業務処理の間Actor Lockを持つので、同一Actorの並行Requestは直列化される（MVPでは許容）。
- Request毎に認証Audit行が1件増える。
- 形式だけ正しい偽Cookieを大量に送ると、毎回DB検索とdeny Auditが走る。開発用Compositionはloopback限定なので許容し、Production Gateで解消する。
- 非在籍とGroup不存在の処理時間差は残る。

## Implementation

- #317: 共通`src/presentation/graphql`の`graphql-request-identity.ts`（Request前提・Session Cookie選択）、#316の`graphql-entry.ts`への組込み（Mutation前提・公開Error整形とrequestId・no-store）、`authenticated-operation.ts`（lease内実行・CSRF照合）、`public-graphql-error.ts`（8 code・固定文・mask）。`createApp`の`graphql`能力。依存表とArchitecture Test。
- #312: Context Presentationが`AuthenticatedOperation`と公開Errorで業務fieldを公開する。
- #314: 開発用Compositionへ能力と認証・業務Poolを接続する。
- #315: Webの`/graphql`転送RouteとServer Component用のServer-only fetch。

## Review Trigger

配置・Peer抽出（#302のDeployment Gate、#295）、Session方式の変更、Rate limit（Production Gate）、Server Actionsの採用、Context横断Operationの追加、1 Requestで複数の認証付きfieldを許す要求が出たとき。

## Owner Decision

2026-11-19、Ownerが会話で推奨案1A〜6Aをすべて採用すると回答した。親Agentによる会話証跡の転記であり、Owner本人のGitHub操作は主張しない。承認証跡は[#304のComment](https://github.com/takeshi-arihori/kakei_app/issues/304#issuecomment-7006879293)。
