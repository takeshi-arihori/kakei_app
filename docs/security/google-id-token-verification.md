# Google IDトークン検証境界

[Task #207](https://github.com/takeshi-arihori/kakei_app/issues/207)は[ADR #203](../adr/google-login-and-registered-recipient-invitation.md)のGoogle Providerを内部技術Portとして実装する。Session発行・Actor登録・Group認可は行わず、Productionへ接続しない。

## 責務と契約

- Port: `apps/api/src/shared/application/google-id-token-verification.ts`。未検証`idToken: unknown`とServer保持の`expectedNonce`を受け取る。
- Adapter: `apps/api/src/shared/infrastructure/authentication/google-id-token-verifier.ts`。Server管理の`allowedAudiences`を起動時に検証・コピーし、同じSDK Clientを再利用する。空集合、空文字、前後空白を持つClient IDを許可しない。
- PRE: expectedNonceはServerが保持するLogin試行から渡す。ClientがTokenと一緒に申告するnonceを期待値に使わない。空または256文字超を拒否する。この長さは技術入力制限でありnonce生成方式の採用ではない。
- POST: Google公開鍵による実署名、RS256、issuer、Server設定audience、必須Claimの型、`iat <= 現在UTC秒 < exp`かつ`iat < exp`、nonce一致のすべてが成立したときだけ識別子を返す。
- 成功結果は`status: verified`と`identity: { issuer: https://accounts.google.com, subject: sub }`だけ。Googleの二つのissuer表記を正規化し、email・名前・Tokenを返さない。subは非空、前後空白なし、255文字以下とする。
- `iat`と`exp`は安全な整数を要求する。SDKの文字列からの数値変換や300秒のClock skewをPortの成功条件へ持ち込まない。SDK既定の最大有効期限検証も維持する。Server時計の適切な同期は運用側の前提となる。
- FAIL: Credential／署名／Claim不正は`invalid-credential`、公開鍵取得失敗は`unavailable`。いずれもidentityなし。SDK例外をLog・Result・causeへ伝播させない。

非文字列、空、16KiB超、JWTの3区間／Base64URL形式違反、不正Header／Payload JSON、RS256以外、空kidを公開鍵取得前に拒否する。未検証JSONは拒否判定だけに使い、鍵取得URLや本人性を決めない。SDKのGoogle固定endpointと証明書cacheを利用する。Node実行時は`https://www.googleapis.com/oauth2/v1/certs`から公開鍵だけを取得し、IDトークンを送信しない。通信timeoutは1試行5000ms、retryはSDK既定であり全体5秒を保証しない。

## 依存関係と検証

本番依存はAPIだけに`google-auth-library@11.1.0`を固定する。2026-10-10に利用者の継続指示を提示済み固定版SDK追加の続行として受領した。[公式検証仕様](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)、[Release](https://github.com/googleapis/google-cloud-node/releases/tag/google-auth-library-v11.1.0)、[公開Advisory](https://github.com/googleapis/google-cloud-node/security/advisories)を同日確認した。公開一覧に該当Advisoryの掲載なし。これだけで推移的依存の安全性を保証しないため、導入時の本番依存監査をPR Evidenceに記録する。

SDKはApache-2.0、Node >=22（アプリはNode >=24）、展開サイズ約602KB。直接依存はjws、gaxios、base64-js、gcp-metadata、ecdsa-sig-formatter、google-logging-utils。Webへ追加せず、署名検証を独自実装しない。Architecture Testで当該Adapterの正確なPathからSDK本体を参照する場合だけを許可し、他Module／LayerとSDK内部subpathを拒否する。protected-recordの外部依存許可は広げない。

Testは実行中だけ生成する合成RSA鍵とJWTを実SDKへ通し、公開鍵の通信だけを差し替える。改ざん・別鍵・kid／alg・issuer／audience・期限境界・未来iat・Claim型・sub／nonce・設定配列の変更・公開鍵取得障害・機密情報非伝播を確認する。実Credentialや鍵のFixtureを保存せず、Google通信・実アカウントE2Eはこの内部境界のTestに含めない。

## 後続Gate

nonce一致だけで再送防止やCSRFの完成を主張しない。Login試行の発行・保存・原子的消費、Actor対応／登録、Session発行・保存・失効、公開API／Error／Rate limit／CSRF／CORS、画面接続を後続Taskで確定・検証する。ここでのToken期限判定をSession TTLへ転用しない。Google APIアクセス用Tokenは取得しない。

招待コードの期限・再発行・取消・保護保存・原子消費も別Gateとする。ADR #36／#52／#55の業務認可・Invitation lifecycle・Protection／Audit／Retention／Backup／Deploymentの条件を維持し、Verifierの存在をProduction接続許可と解釈しない。
