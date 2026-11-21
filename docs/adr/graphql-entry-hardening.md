# GraphQL入口のGraphiQL・introspection・GET・Query制限

- Status: Accepted
- Owner: Project Owner（takeshi-arihori）
- 承認日: 2026-11-19
- Decision Check: 方針変更あり（公開入口のSecurity境界と恒久的な上限値を決める）
- 承認記録: [Issue #293](https://github.com/takeshi-arihori/kakei_app/issues/293#issuecomment-7007217744)（Owner会話承認「推奨案をすべて採用する」。論点1A〜8A）
- 関係: Epic [#303](https://github.com/takeshi-arihori/kakei_app/issues/303)、実装 [#316](https://github.com/takeshi-arihori/kakei_app/issues/316)。業務GraphQLの認証・CSRF・公開Error（[#304](https://github.com/takeshi-arihori/kakei_app/issues/304)、実装[#317](https://github.com/takeshi-arihori/kakei_app/issues/317)）と対になり、そのADRとは別ファイルで管理する。前提: [認証HTTP境界](authentication-http-and-development-boundary.md)（H-PRE-3の入口値）、[#302](https://github.com/takeshi-arihori/kakei_app/issues/302)（Browserから見えるOriginは1つ）

## Context

`/graphql`はgraphql-yoga 5.21.2の既定設定のまま公開されていた（2026-11-19、`bf356c3`時点）。

- GraphiQLとlanding pageが有効で、`GET /graphql`＋`Accept: text/html`でHTMLを返し、外部CDNからScriptを読む。
- GETでQueryを実行でき、POSTは`application/json`に加えmultipart、`application/graphql`、`application/x-www-form-urlencoded`を受理する。CORSを返さなくても、form等の単純Request（preflightなし）でQueryを実行できる。
- `maskedErrors: true`でも`NODE_ENV=development`では`extensions.originalError`（message・stack）を応答し、元Errorを`logger.error`へ丸ごと出す。
- introspectionが有効で、検証ErrorはSchema名の候補（Did you mean）を表示する。
- Body、token数、深さ、alias、top-level field数に上限がない。#304で業務Operationごとに認証lease（DB Transaction＋Audit行）を開くことにしたため、認証付きfieldを多数並べたRequestで資源を占有できる。Rate limitはProduction Gateへ送った（#304 6A）ので、入口の上限が唯一の下限になる。

## Decision

1. GraphiQLとlanding pageは全環境・全Compositionで無効にする。
2. introspection（`__schema`・`__type`）は全環境で無効にし、`__typename`は許可する。検証Errorにfield候補を出さない。RepositoryはPublicなのでSchemaの秘匿効果はない。目的は、用途のない重いQueryを上限の例外にしないことと、将来の段階公開fieldを実行時に列挙させないことである。
3. `/graphql`はPOSTだけを受け付ける。GET（`apiStatus`も例外にしない）、OPTIONS、HEAD等は405＋`Allow: POST`。CORS Headerは返さない（#301）。POSTは`application/json`（任意で`charset=utf-8`）だけを受理し、それ以外は415。
4. 構文・検証・上限・Operation選択・変数の違反は、HTTP 400と`{ "errors": [{ "message": "<固定文>", "extensions": { "code": "INVALID_REQUEST", "requestId": "<Server発行UUIDv4>" } }] }`だけを返す。`data`、`locations`、graphql-jsのmessageは返さない。検証は最初の1件で打ち切る。development Compositionでも同じ形にし、`NODE_ENV`に関係なく`originalError`・stackを応答へ出さない。Yogaのloggingは止め、元Errorを丸ごと出力しない。
5. 文書の上限は次の固定値とし、依存Packageを増やさず共通`src/presentation/graphql`で実行前（認証lease前）に検査する。文書内のすべてのOperationに適用する。

   | 制限 | 上限 | 数え方 |
   | --- | --- | --- |
   | token | 1,000 | graphql-jsの`maxTokens`（EOFを除く） |
   | 深さ | 5 | fragment・inline fragmentを展開したfield選択の深さ。root fieldを1と数える |
   | alias | 5 | 文書全体 |
   | top-level field | 5 | 1 Operationのresponse key数（fragment展開後、実行時と同じく同一keyは1つ） |
   | 認証付きtop-level field | 1 | 上と同じ数え方 |
   | Mutationのtop-level field | 1 | 上と同じ数え方 |
   | directive | 10 | 文書全体 |

   「認証付きfield」は、未認証で公開するroot fieldの許可List（現在は`Query.apiStatus`だけ）にない`__typename`以外のroot fieldとする。印の付け忘れが上限の迂回にならないよう、既定を認証付き側に倒す。業務fieldを未認証で公開するときだけ、このADRの見直しとあわせて許可Listへ追加する。

   Complexity（Cost分析）は導入しない。#305の一覧が引数なし・固定50件・ネスト1段であることと上の上限で、1 Requestの費用は有界である。
6. Bodyは18,432 bytesをstreamで計測し（Content-Lengthの省略・偽装でも超過を拒否）、読取期限は5秒、Content-Encodingはidentityだけとする。認証HTTP（H-PRE-3）と同じ値である。超過は413、期限超過・Content-Length不一致・不正UTF-8／JSONは400、圧縮は415。
7. batchは受け付けない。Bodyは`query`（必須・文字列）、`operationName`（任意・文字列）、`variables`（任意・Object）だけのObjectとし、JSON配列、`extensions`を含む未知Key、型不正は400。
8. 実行前の拒否を含む`/graphql`の全Responseに`Cache-Control: no-store`と`X-Content-Type-Options: nosniff`を付ける。Yogaへは検証済みのBodyだけを`Accept: application/json`で渡し、SSE等のstream応答を選ばせない。

## Alternatives

| 論点 | 不採用案 | 理由 |
| --- | --- | --- |
| GraphiQL | development Compositionだけ有効 | 環境分岐が増え、flag誤設定で本番に出る。GETでHTMLを返すため、GET禁止・必須Header・CSRF（#304）と両立しない |
| introspection | 有効のまま／developmentだけ有効 | 有効だと深いintrospection Queryを上限の例外にする必要がある。GraphiQLがないため開発での使い手もいない |
| GET | 未認証の`apiStatus`だけGETを許可 | `/health`と役割が重なる。Operation名ごとのMethod例外を入口に作り、SameSite=Laxが防がないトップレベルGETの許可List保守を将来に残す |
| 検証Error | graphql-jsのmessageを公開／developmentだけ公開 | literal引数の値をmessageに含むRuleがあり、入力値をErrorへ反映しない方針（#304 5A）と矛盾する。Compositionで応答形が変わるとTestが本番形を検証しない。Web側はcodegenがbuild時に検証する |
| 上限 | `@escape.tech/graphql-armor`等の既製Plugin | Security境界に依存を足し、追従とReviewが要る。認証付きfield数はどのみち自前Ruleになる |
| 上限 | Trusted Documents（Operation許可List） | 最も強いが、WebとAPIのDeploy順序・ハッシュ配布・手動確認手段が要り、#302のDeployment Gate前に決める根拠が薄い。Production Gateの候補として残す |
| Body | GraphQL専用の小さい値／既製`bodyLimit`だけ | 上限が2種類になる。既製Middlewareは読取期限・Content-Encodingを同時に扱えず、認証HTTPと挙動がずれる |
| batch | 上限付きで許可 | 認証付きfield 1の上限をRequest単位で数え直す必要がある。Server Component中心のWebでは往復削減の利点が小さい |

## Consequences

- WebはGraphiQLなしで開発する。手動確認はcurl等のPOSTで行う。1 Requestで取得できる認証付きQueryは1 fieldだけなので、複数必要な画面はRequestを分ける（#303の範囲では該当なし）。
- 後続のContext公開Task（#312ほか）は、未認証で公開するroot fieldだけを許可Listへ足す。認証付きfieldは何もしなくても上限の対象になる。
- 実行前に拒否するため、#317の認証lease・CSRF照合・業務Use Caseは上限違反のRequestでは呼ばれない。
- 認証HTTPのBody読取Helperは依存表上、共通GraphQLから参照できない。同じ値の読取を共通GraphQLにも置き、値はこのADRと[認証HTTP境界](authentication-http-and-development-boundary.md)の両方を変えるときにそろえる。
- 残Risk: Schemaは公開Repositoryにあり秘匿されない。Rate limitがない（Production Gate）。Trusted Documentsは未採用。上限内の文書でも標準検証（OverlappingFieldsCanBeMerged等）の費用は残る（token上限で有界）。上限値の容量保証のための負荷試験はしていない。
- 診断: 応答は固定形で、拒否の理由（Rule名）は現時点でLogへ出さない。`requestId`とServer Logの対応付けは#317以降の公開Error・観測の範囲で扱う。

## Implementation

- 共通`apps/api/src/presentation/graphql/`の`graphql-request-body.ts`（Body・JSON形）、`graphql-document-limits.ts`（parse・検証・上限・Operation選択・変数）、`graphql-entry.ts`（Method・Yoga設定・固定拒否形・no-store）。`app.ts`は`/graphql`の全MethodをこのEntryへ渡す。
- HTTP transportは[`openapi.yaml`](../api/openapi.yaml)、Operation catalogは[`graphql-contracts.md`](../api/graphql-contracts.md)。

## Owner Decision

2026-11-19、Ownerが会話で「推奨案をすべて採用する」（1A〜8A）と回答した。親Agentによる会話証跡の転記であり、Owner本人のGitHub操作は主張しない。承認証跡は[#293のComment](https://github.com/takeshi-arihori/kakei_app/issues/293#issuecomment-7007217744)。

## Review Trigger

- 引数付きPagination、ネストしたList、Context横断fieldを追加するとき（Cost分析の導入を判定する）
- 業務fieldを未認証で公開するとき
- Trusted Documentsを採用するとき（`extensions`拒否も見直す）
- 第三者Clientを追加するとき、batchやGET cacheの要求が出たとき
- Production Gate（Rate limit、Peer抽出）を決めるとき
