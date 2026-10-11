# Googleログイン試行・内部Actor・Session

- Status: Accepted（方式・TTL・保持方針。詳細保存・公開接続・Production Gateは別）
- Proposed / Accepted Date: 2026-10-11（Asia/Tokyo）
- Decision Owner: Project Owner
- Related Epic: [認証・招待 #202](https://github.com/takeshi-arihori/kakei_app/issues/202)
- Supplements: [ADR #203](google-login-and-registered-recipient-invitation.md)
- Related: [ADR #36](group-management-command-authorization.md)、[ADR #55](snapshot-revision-security-and-retention.md)
- 詳細・検証・作業分割: [設計提案](../security/google-login-session-proposal.md)

## Context

PR #208によりGoogleの署名・issuer・audience・期限・Server期待nonceを検証する内部Portが完成した。ログイン試行、内部Actor対応、Session、公開API、画面は存在しない。ADR #203のAccepted対象はGoogleのみ、相手の事前登録、コード共有招待の3点であり、これらのLifecycleを含まない。

## Decision

1. 有効なGoogleログインの初回成功で内部Actorを自動作成する。正規化した検証済みissuer＋subに対して安定したランダムActor IDを一つ割り当てる。メール・氏名・画像・Google API用Tokenを登録・保存しない。メールによる統合、手動のActor指定、Account復旧・Provider追加は今回扱わない。ActorとGroup Participantは別であり、登録だけでGroupへの権限を与えない。
2. Login AttemptはServer発行の一回限り、5分有効とする。BrowserのHttpOnly Cookie、Server期待nonce、試行専用CSRF Tokenを束縛する。Google検証後にも期限・未消費・Browser束縛を再検証し、試行消費・Actor作成または再利用・Session保存を一つのTransactionで確定する。同じ試行から二つのSessionを作らない。
3. SessionはServer保存型とし、CSPRNGの32-byte秘密値をHttpOnly Cookieで渡す。保存する認証検索値は用途分離した秘密値のDigestだけとし、JWTやGoogle TokenをアプリSessionとして使わない。最長7日、無操作24時間、延長しても最長期限を超えない。時計はServer側のUTCを正本とする。これらの期間は本Projectへの提案でありGoogle／OWASPの指定値ではない。
4. 複数BrowserのSessionを許可する。ログアウトは現在のSessionをServer側で失効させてからCookieを消す。Googleアカウント全体からのログアウトではない。再ログインでは常に新しい秘密値を発行する。Sessionが有効なBrowserで別Accountへ切り替える場合は、先にログアウトを要求する。
5. Browserから見えるWebとAPIは同一Originへ集約する。認証用HTTP Endpointと業務GraphQLを分離し、Origin完全一致・JSON・CSRF Headerを要求する。CookieはProductionでSecure、HttpOnly、SameSite=Lax、Path=/、Domain指定なし、`__Host-` prefixとする。Cross-origin credential付きCORSをMVPで許可しない。
6. 認証は3つの業務Contextに属さないAPI内の共有技術境界とする。第四の業務Context、独立Package、GroupへのAccount所有権を追加しない。既存PostgreSQL／raw pg／Version付きSQL Migrationを認証専用Schemaにも利用する案とし、Group用Table・暗号鍵・AADを流用しない。
7. 期限切れ／消費済みAttemptと期限切れ／失効済みSessionの認証用Recordは24時間以内に削除する。Actor対応は利用中維持する。退会要求時はActorをまず無効化して全Sessionを失効させ、外部Identity対応・その復号鍵を24時間以内に除去する方針とする。Group側の過去Participantや精算を連鎖削除しない。必要な内部Actor参照は関連業務Dataの既存保持期限まで残す。退会受付・業務上の未完了責務・Backupからの復活防止を含む運用契約は別Taskで確定し、その完了までProduction有効化しない。
8. Google issuer／sub、期待nonce、CSRF秘密値は認証専用の保護保存対象とする。認証Auditは直接ID・Token・IP・連絡先を含まない最小の用途別仮名・action・decision・reason・UTC・requestIdだけで90日、Backupは最大35日とする案。認証用Envelope／鍵Namespace／Nonce割当・Rotation／削除・Restore契約は専用設計・独立Security Reviewを通す。ADR #55のGroup用Envelopeを偽のGroup IDで流用しない。

## Alternativesと理由

| 選択肢 | 判断案 | 理由・制約 |
| --- | --- | --- |
| Server保存型Session | 推奨 | ログアウト・利用停止をServerで即時判定できる。DB照会と清掃が必要 |
| 自己完結JWT Session | 不採用案 | 即時失効のため別の状態管理が必要になる |
| 初回ログイン時の自動登録 | 推奨 | ADR #203の事前登録をGoogleログインだけで完了できる |
| メールによるActor統合 | 不採用案 | 検証済みissuer＋subの本人性境界を弱める |
| 別Origin＋credential付きCORS | MVP対象外案 | Cookie／CSRF／配置の組合せを増やす |
| Session最長24時間 | 代替 | 再認証頻度が増えるが、盗難Sessionの最大利用期間が短い |

7日／無操作24時間は利便性寄りの案である。端末共有時は明示ログアウトが必要で、Session窃取・XSSのRiskは残る。Session方式だけで本番安全性を保証しない。

## ScopeとActivation

Owner承認後も、正式Task、詳細契約、個別Ready評価、TDD、Self Review、独立Evaluator、Draft PRを省略しない。最初は内部LifecycleとPortの単独成果を実装し、その後に保護保存、公開HTTP、画面へ進む。

実Google画面への接続とProduction有効化を分ける。保護保存Provider、durable Audit、Rate limit、認証Data削除・Backup Restore、信頼Proxy／TLS／環境設定、障害Runbookの実装・検証が揃うまでProductionの認証経路を有効にしない。ADR #55の業務Data用Composition Gateも維持する。

## Owner Decision

2026-10-11（Asia/Tokyo）、Project Ownerが本設計案への承認と内部処理からの実装継続を求める確認に「進めていいです。」と回答した。上記8点の方針と、詳細保存・公開接続・Production有効化を別Gateに残す境界を承認した証跡として記録する。親Agentによる会話証跡の転記であり、Owner本人のGitHub Comment・承認操作を主張しない。GitHub承認証跡は [ADR #209](https://github.com/takeshi-arihori/kakei_app/issues/209)、内部実装Taskは [#210](https://github.com/takeshi-arihori/kakei_app/issues/210)。

## Rollback / Review Trigger

承認時点で実行挙動・保存Dataへの変更はまだない。実装後のRollbackは各Taskで定義し、保存Data適用後の破壊的Downを避ける。Provider・Account統合／復旧、Session方式・期間、Cookie／Origin、保持・削除、鍵／AAD・Provider、本番接続の変更時は新DecisionとSecurity Reviewで再評価する。
