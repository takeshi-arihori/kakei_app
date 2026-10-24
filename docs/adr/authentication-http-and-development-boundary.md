# 認証HTTP境界・共有Rate limit・使い捨て開発Composition

- Status: Accepted（2026-10-21 Owner会話承認。独立Security／Planning評価・実装・Production Gateは別）
- Proposed Date: 2026-10-21（Asia/Tokyo）
- Decision Owner: Project Owner
- Related: [Task #218](https://github.com/takeshi-arihori/kakei_app/issues/218)、[Epic #202](https://github.com/takeshi-arihori/kakei_app/issues/202)
- Supplements: [認証Lifecycle ADR](google-login-actor-session.md)、[A2保存ADR](authentication-protected-storage.md)
- 詳細契約: [HTTP契約](../security/authentication-http-boundary.md)

## Context

最新develop `bc7ab5b9c4a3b794e255f8ce05dcd5f42135de1c`では#217までの内部認証Store・保守処理が統合済み。公開認証HTTP、Cookie setter、Rate limit、起動時の具体鍵／Nonce Providerは未実装である。既存HTTP案を実装するには、#218のDone Criteriaが求める追加Owner Decisionが必要になる。

本ADRは下記Owner承認により本Taskの追加Decisionとする。既存AcceptedのProduction契約やProduction Gateを上書きしない。特に使い捨て開発ProviderはA2の永続性を満たした実Providerとして扱わない。

## Decision

1. BrowserのWeb/APIは同一Origin。4操作は既存案の`POST /auth/google/attempt`、`POST /auth/google/login`、`GET /auth/session`、`POST /auth/logout`とし、Honoの共有HTTP Adapterから既存A1 Serviceへ接続する。Group MutationやRoleを公開せず、Actor／Role／期待nonceのClient申告を拒否する。
2. 変更系は設定Originの完全一致を必須とし、欠落・null・別scheme/portを拒否する。全4操作に`X-Kakei-Request: 1`を必須とし、GETでOriginがあれば同じ照合を行う。Cookie/CSRF/Bodyを厳格に検証し、credential付きCORSを追加しない。JSON Body上限18KiB、Credential上限16KiB。全Responseをno-storeにする。
3. Production用Cookie契約は`__Host-kakei-auth-attempt`と`__Host-kakei-auth-session`、Secure/HttpOnly/SameSite=Lax/Path=/、Domainなし。設定でSecureを任意に無効化するAPIは設けない。既存TTLを維持し、失効成功前にCookieを消さない。
4. Rate limitはプロセス内Mapへ閉じず、既存PostgreSQL17/raw pgに独立した`authentication_http` Schemaのcounterを追加する。Peer別と全体の固定Windowを原子的に予約し、複数API instanceで共有する。具体上限・保持・障害時503は詳細案で固定する。Redis等の新Package/Serviceは追加しない。
5. target OriginはServer設定から取り、Host/Forwarded/X-Forwarded-*を本人性・安全scheme・Peerの根拠にしない。開発はWeb/APIをloopbackへbindし、Webから固定loopback APIへの同一Origin転送を使う。開発proxy経由のPeer予算は全Browser共通となることを明記する。ProductionのProxy/TLS/正当Peer抽出はDeployment Gateで別実証する。
6. 開発だけに、別名`kakei_dev_auth_attempt`／`kakei_dev_auth_session`のHttpOnly/Lax/Path=/ Cookieとhttp localhost例外を認める。固定の`http://localhost:3000`をBrowser Originとし、APIは127.0.0.1:3001、非loopback拒否、専用末尾`_auth_dev` DBと単一process leaseを要求する。既存の汎用開発DBへ接続しない。
7. 開発Key/Nonce ProviderはOS CSPRNGによる独立DEK/用途別HMACと、process lifetime内の単調Nonce割当を持つ使い捨て専用実装とする。Google本人確認は既存実SDKを使い、固定Actorや偽Token成功を追加しない。鍵は永続化せず、API再起動後に既存認証Dataを再利用しない。非空DBでの新Provider起動を拒否し、明示的な専用DB resetを要求する。自動Data削除や暗黙の再初期化をしない。
8. 開発entryとProviderは`apps/api/dev/`へ分離し、専用typecheck/lint/TestとArchitecture検査を適用する。Productionのsrc/build/起動経路からImportさせず、環境変数だけで開発entryへ切り替えない。Production mainでは具体Capability未実装のため認証経路を有効にしない。鍵/Nonce durability、実Ledger/Witness、Backup/退会/監視/Proxyの既存本番Gateを保持する。

## Alternatives

| 選択肢 | 評価 |
| --- | --- |
| 上記の使い捨てlocalhost開発 | 推奨案。具体Cloud選定なしで実SDK/実DB接続を開発できる。再起動で既存開発認証Dataを再利用できない制約がある |
| 永続する開発Key/Nonce Providerを先に実装 | 代替案。再起動後もActor/Sessionを維持できるが、鍵保管・原子的Nonce割当・障害復旧を独立Taskとして先行設計/検証する必要がある。HTTP Taskへ暗黙追加しない |
| Test-only Providerを通常起動へImport | 不採用案。合成Providerの成功を実Runtime Capabilityへ流用しない |
| Rate limitをMapだけで実装 | 不採用案。複数instanceで上限を共有できず、再起動で予算が戻る |
| 別Originのcredential CORS | 対象外。Accepted同一Origin方針を維持する |

## Consequences

Rate上限はProjectの初期運用値であり、Google/OWASP指定値ではない。固定Window境界のburst、NAT/開発proxyで予算が共有される不便、Rate DBの可用性依存が残る。通常ProcessによるRate counter削除/巻戻しや鍵喪失を安全な継続と扱わず封鎖する。Productionの容量・DoS・複数Region/Failoverは別検証を要する。

開発Machine上の他processやlocalhostの他portを安全な別主体として隔離できるとは主張しない。開発Cookieはhostに属しportでは分離されない。実在金融Dataや本番Credentialを使い捨て開発profileへ入れない。

## ImplementationとGate

既存#218を一つの認証HTTP Deliverableとして維持する。Scopeに新しい認証方式・業務Contextを増やさず、EstimateはPlanningで5人日/SP8とした。前提#217/PR230は統合済み。Owner承認後、独立Security評価、保存前Planning評価、Issue/Project保存、別Planning評価を通過し、TaskはIn Progressへ移った。実装後の4専門ReviewとDraft PRは別Gateである。最新develop基点の通常Branch/PR、Stackなし。#219は#218統合とGoogle開発Client設定後に別評価する。

実装はHTTP検証/Rate PortのRed、PostgreSQL共有Rate、Cookie/Service接続、開発entry/Build隔離、OpenAPI/文書同期、実DB回帰、Self Review、新規4専門Reviewの順。PR Ready化/Mergeは別の明示依頼を要する。

## Rollback / Review Trigger

設計承認後、Task #218で実装と合成Dataの検証を進める。通常mainのProduction認証は有効化せず、専用開発入口を閉じることで受付を止める。Rate Migrationは追加のみ、認証5/6やGroupを改変しない。運用Data適用後はforward-fix、空/使い捨て専用環境以外で破壊的Downをしない。

Rate上限/対象/保持、Cookie/Origin/Proxy、開発の永続化や対象Machine、Provider、Production接続を変える場合は新たにDecisionとSecurity評価を行う。

## Owner Decision

2026-10-21、提示したADR案とHTTP契約案（localhost限定の使い捨て開発環境・再起動時の鍵喪失と専用DB明示resetを含む）の確認に、Project Ownerが「提案を承認して進める（推奨）」と回答した。親Agentによる会話証跡の転記であり、Owner本人のGitHub操作は主張しない。独立評価後の実装を許可し、Production有効化・PR Ready化・Mergeは含まない。承認証跡とReady評価はTask #218に同期する。

## 2026-10-22 Owner承認追補: Login再開始の公開結果

実装調査でA1の`restart-required`は、canonicalなCSRF不一致と期限切れ/消費済み/不在Attemptを区別しないことを確認した。Ownerは会話で「一律409で内部契約を維持する（推奨）」と回答し、これらを409 `LOGIN_RESTART_REQUIRED`へ揃える変更を承認した。CSRF Header欠落/形式不正、Origin拒否は403を維持し、Logoutの有効Sessionに対するCSRF不一致も403のまま。再開始が確定した409ではAttempt Cookieだけを削除し、Session Cookieを変更しない。有効Session競合の409ではCookieを変更しない。

これは初回承認でCSRF不一致を一括403としたHTTP表現への明示追補であり、A1の内部結果・本人性・試行消費・TTLを変更しない。再評価で差分を確認し、元のOwner承認履歴を保持する。
