# Browserから見えるOriginを1つにする配置方針

- Status: Accepted
- Owner: Project Owner（takeshi-arihori）
- 承認日: 2026-11-18
- Decision Check: 方針変更あり（配置の自由度の明確化。Cookie・Origin照合の契約は変えない）
- 承認記録: [Issue #302](https://github.com/takeshi-arihori/kakei_app/issues/302#issuecomment-6969415774)（Owner会話承認「案Bを採用する」）
- 関係: Supplements [Googleログイン・Actor・Session](google-login-actor-session.md)（Decision 5）、[認証HTTP・共有Rate limit・使い捨て開発Composition](authentication-http-and-development-boundary.md)（Decision 1／2／5／8）。依存する最初の実装: [#317](https://github.com/takeshi-arihori/kakei_app/issues/317)（[業務GraphQLの認証境界](business-graphql-authentication-boundary.md)）

## Context

- 既存のAccepted Decisionは、Browserから見えるWebとAPIを同一Originへ集約し、Cross-origin credential付きCORSを許可しないことを前提にしている。Production Cookieは`__Host-`、Secure、HttpOnly、SameSite=Lax、Path=/、Domainなし。target OriginはServer設定から取り、Host／Forwarded系HeaderをPeerの根拠にしない。
- Ownerは2026-11-18、本番の配置が同一Originにも別Originにもなりうるとして、この前提の見直しを求めた。配置先の候補にCloudflareがある。
- `__Host-` CookieはHost限定のため、Cookieを受け取るHostとGraphQLを呼ぶHostが一致しないとCookieが付かない。SameSite=LaxのCookieは別サイトへのfetchで送られず、`workers.dev`等のPaaS初期ドメインは別サブドメインでも別サイトになる。
- Ownerの「別Origin」はDeployの単位（WebとAPIを別のサービスやPortで動かす）を指すと確認した。

## Decision

- WebとAPIは別のサービス・別Portでデプロイしてよい。
- Browserから見えるOriginは1つにまとめる。Edgeのパス振り分け、WebのRoute Handlerによる中継、Service Binding等で実現する。
- 同一サイトの別Origin（例: `app.example.com`と`api.example.com`）と、別サイトは採らない。
- Cookie属性、Origin完全一致、CORSを返さない（#292）実装は変えない。業務GraphQLのOrigin照合も、この1つのcanonical Originへ行う。
- 本番の振り分け方法の選択と実証は、既存のDeployment Gate（認証HTTP境界ADRのDecision 5と8）で行う。このADRの採用でそのGateは解消しない。

## Alternatives

| 案 | 内容 | 不採用の理由 |
| --- | --- | --- |
| A | 現行維持（WebとAPIを同一Originへ集約） | 配置の自由度が書かれておらず、別Deployとの関係が曖昧 |
| C | 同一サイトの別Originを固定の許可Origin設定で許す | 独自登録可能ドメインが条件で、認証4操作のCORS、`Sec-Fetch-Site: same-site`の受理、Cookie Hostの一致が要る。必要になれば新しいADRで判断する |
| D | 別サイトも許可 | SameSite=Noneとサードパーティ Cookie制限への対応、またはCookie以外の認証方式が要り、認証の再設計に当たる |

## Consequences

- Cookie属性、Origin照合、CORSを閉じる実装は変えずに済む。
- 本番の振り分け方法は未実装の選択事項で、Peer識別（#295）、Set-Cookieの中継、Server設定のtarget Originに影響する。振り分けを導入するときは、採用前に独立したSecurity評価を行う。
- Cloudflare Workersで動かす場合は、起動入口、`schema.graphql`の読込、`node:crypto`の対応範囲、Google SDK、Hyperdrive経由の`pg`とadvisory lock、Peer取得（#295）を確認する。

## Implementation

- #317: 業務GraphQLのOrigin照合を、Compositionが注入する1つのcanonical Originへ行う。
- #295・#294: Peer抽出と起動入口はこのDecisionに依存する。

## Review Trigger

配置基盤を決めた時、同一サイトの別Originや別サイト構成が必要になった時、Cookie以外の認証方式を検討する時。

## Owner Decision

2026-11-18、Ownerが会話で案Bを採用すると回答した（「別Origin」はDeployの単位を指すと確認済み）。親Agentによる会話証跡の転記であり、Owner本人のGitHub操作は主張しない。承認証跡は[#302のComment](https://github.com/takeshi-arihori/kakei_app/issues/302#issuecomment-6969415774)。
