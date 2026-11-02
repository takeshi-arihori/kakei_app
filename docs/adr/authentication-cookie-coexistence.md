# 認証Cookieと外部SDK Cookieの共存

Status: Accepted（検査範囲のDecision。実装検証・独立Security・実Google確認は別Gate）。Owner承認日: 2026-10-25。
Related Task: [#219](https://github.com/takeshi-arihori/kakei_app/issues/219)。
Amends: [認証HTTP境界](authentication-http-and-development-boundary.md)のCookie値の検査範囲だけ。

## Context

Google側で認証した後にアプリ画面が失敗するとの手動報告があった。経路とstatusだけの記録ではAttempt作成201の後にinspect400が続き、login送信まで進んでいない。実CookieやCredentialは収集していないため、この報告の原因確定は再確認を残す。

合成した非認証Cookie `g_state={"i_l":0}` とアプリAttempt Cookieが共存すると、修正前のHTTP入力検査が400を返すことを再現した。Google公式は[SDKがg_stateを使用する](https://developers.google.com/identity/gsi/web/guides/automatic-sign-in-sign-out)と説明する。ここでのJSONは合成Test Caseであり、Googleの値形式を公開契約として保証するものではない。

## Decision

- Cookie Header全体の8KiB上限、可視ASCII限定、各pairの区切りと名前の検査を維持する。
- Compositionが固定するAttempt/Session Cookieの値だけを既存構文で検査し、同名重複を400で拒否する。URL decode、JSON parse、暗黙正規化はしない。
- 他のCookieの値は解釈せず無視し、認証・Actor・CSRF・鍵取得先等に使用しない。特定のSDK Cookie名への例外表を持たない。
- 認証秘密値のcanonical Base64URL、Origin、CSRF、nonce、実署名検証、TTL、Rate、Cookie名/属性/発行消去は従来どおりとする。

## Alternatives

1. 全Cookie値を従来どおり厳格構文で拒否する: SDKや同一hostの他用途Cookieにより認証が利用できなくなる場合がある。
2. Web転送で特定SDK Cookieを削除する: SDKごとの例外が増え、API直結と異なる検証境界になる。
3. 認証Cookie値の検証も緩める: 本人性の境界を不要に広げるため採用しない。

## Consequences

認証に使わないCookie値の一部を、入力構文Errorの理由にしなくなる。Header総量/制御文字/名前/区切りの検査は認証Cookieの選択前に残す。Cookieの区切りは`;`のままで、引用符やJSONを解釈して任意の値を復元しない。選択Cookieへの値注入や重複の曖昧な選択を許可しない。

## Implementation / Verification

HTTP parser、[HTTP契約](../security/authentication-http-boundary.md)、OpenAPI、[UI契約](../security/google-authentication-ui.md)を同期する。合成SDK Cookie共存、認証Cookie不正/重複、Header上限/制御文字のUnitと、popup復帰inspect→login→再読込→logoutの実SDK/API/PG Browser回帰を追加する。実Googleの本人操作は別に再確認する。独立Securityを含む最新対象の4役Reviewを必要とする。

## Review Trigger

Cookieの選択方法、名前/値の正規化、上限、複数Header解釈、発行属性、SDK能力、Production接続を変更するときは再評価する。通常main/Productionの有効化、使い捨て開発DBや鍵の永続化はこのDecisionに含めない。

## Owner Decision

2026-10-25、Ownerは提示したCookie互換性修正案に「修正案を承認して進める（推奨）」と回答した。親Agentによる会話証跡の転記であり、Owner本人によるGitHub承認操作は主張しない。承認は上記の検査範囲と文書/実装/検証の進行だけ。独立Security pass、実Google手動成功、PR Ready化/Merge、Production有効化の証明または承認へ読み替えない。
