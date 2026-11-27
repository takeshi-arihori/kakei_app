# localhostの使い捨て認証環境

Knowledge State: Confirmed。採用範囲は[HTTP ADR](../adr/authentication-http-and-development-boundary.md)と[HTTP契約](../security/authentication-http-boundary.md)、Group Managementと業務GraphQLの接続は[開発Composition ADR](../adr/development-composition-group-management.md)（#307）と[業務GraphQLの認証境界ADR](../adr/business-graphql-authentication-boundary.md)（#304）。本番Provider、永続する開発鍵、実Google Browser操作の完了は主張しない。実Google Clientと画面の手動検証は[#219](https://github.com/takeshi-arihori/kakei_app/issues/219)。

## 起動条件

Node 24以上、PostgreSQL 17、Browser Origin `http://localhost:3000`、API待受 `127.0.0.1:3001`を使う。`NODE_ENV=production`、異なるOrigin/待受Port、loopback以外のDB URL、末尾`_auth_dev`以外のDB、Google Client ID未設定、既存の非空認証状態、他の稼働processは拒否する。通常の`DATABASE_URL`へfallbackしない。

`.env.example`の公開可能な変数名を参考に、専用環境変数をOperatorが設定する。環境ファイルの自動読込や値の表示は行わない。Google Client IDは公開識別子だが、本番や他環境の値を誤用しない。Token/Cookie/秘密鍵を環境Templateへ書かない。

```bash
# 専用の新しい空DBをOperatorが用意してから、その接続先を設定する。
export AUTH_DEV_DATABASE_URL='postgresql://local-user:local-password@127.0.0.1:5432/kakei_auth_dev'
export GOOGLE_CLIENT_ID='your-client-id.apps.googleusercontent.com'
export NODE_ENV=development
pnpm -C apps/api db:auth-dev:migrate
pnpm -C apps/api dev:auth
# 別のterminalで実行する。
pnpm -C apps/web dev
```

例の接続値は説明用であり、自動DB作成・認証情報の配布ではない。`db:auth-dev:migrate`は明示操作として、Group Management Migration 0001〜0004・0012と認証Migration 5/6/7を既存のChecksum台帳で原子的に適用する。招待用のGM 0010と認証8/9/11は適用しない。稼働leaseがあれば拒否し、DB作成/drop/resetをしない。この専用DBのGroup業務Dataは開発で作る使い捨てDataだけとし、実在の金融Dataを入れない。

Webは`next dev --hostname 127.0.0.1`で待受け、開発時だけ相対`/auth/*`を固定APIへ転送する。ClientはAPIの別Origin URLや独自Forwarded値を使わない。元のOriginを維持し、Session発行とAttempt削除の複数Set-Cookieを扱う。転送先への接続障害は詳細をLogへ出さずno-storeの503 Envelopeで返す。ProductionのWebから開発APIへ転送しない。Peerはproxy経由の接続Peerに集約され、Peer予算は開発利用全体で共有する。

## processの有効期間

専用advisory leaseを保持したprocessだけが、空の認証状態を独立したOS乱数鍵・新epochで初期化する。同じguard Transactionで、Group Managementの全業務表（`group_actor_membership_index`を含む）が空で`group_operation_locator_key_state`が未初期化であることを確かめ、processのGroup鍵版で初期化する。どちらかが非空・初期化済み、またはGroupの表がなければ起動を拒否する。Group鍵（Group別DEK、用途別HMAC、operation locator、Actor単位Group索引）は認証鍵とMaterialを共有しない独立した使い捨て鍵で、許可List外の用途を配らない。各DEKのNonceはprocess内の単調Counterで割当し、外側DB rollbackでも戻さない。閾値到達時は自動で同じ鍵を再生成せず拒否する。署名検証は実Google SDK、保存は実pg Storeを使う。Test-only Provider/固定Identity/認証bypassを開発入口へImportしない。

この入口だけが`/graphql`の業務Operation（`createGroup`・`myGroups`）へ本人性能力とGroup Managementを注入する。業務Transactionは認証Pool（max 8）と別の業務Pool（max 4、`application_name=kakei-group-disposable-development`）で、認証leaseの内側に開始・commitする。取得順は認証→業務に固定する。業務接続の待機は1秒、Lock待機は2秒、Statementは4秒を上限とし、超えたOperationは`SERVICE_UNAVAILABLE`になる。業務接続を取得できなかったOperationは認証leaseもrollbackする。通常APIの`dev`/Production `start`はこの入口を選ばず、認証能力未接続の4経路は503、業務Operationは`SERVICE_UNAVAILABLE`を返す。API Production buildは`dev/`を除外し、開発Sourceは別にtypecheck/lint/Architecture/unit testを実行する。

lease接続の切断またはProbe失敗時はHTTP受付と業務GraphQLを停止し、認証鍵とGroup鍵を破棄する。SIGINT/SIGTERMでも受付停止→鍵破棄→認証Pool・業務Poolのendの順に解放する。起動/環境/SQL/SDK例外の詳細は表示せず、`AUTH_DEVELOPMENT_START_FAILED`または`AUTH_DEVELOPMENT_MIGRATION_FAILED`だけを通知する。自分のGroup一覧で索引にhitしたが再認可で否になったGroupは、一覧から除いて`GROUP_LIST_INTEGRITY_ALERT`とそのRandom Group IDだけを通知する（Actor・本文・鍵は出さない）。繰り返す場合は索引とGroup Recordの不整合として専用DBをresetする。

## 終了後の明示reset

鍵は終了で失われる。認証Recordだけでなく初期化済み鍵Metadata/Rate Policy、Group Recordとlocator鍵状態も既存状態として扱い、次のprocessは起動拒否する。以前のCiphertextを新しい鍵で開くことはできず、開発で作ったGroupは保持されない。

再開が必要なOperatorは、API/Web停止、専用DB名・接続先・所有者と他用途Dataがないことを確認し、**その使い捨てDBだけ**をDB管理手段で明示削除・再作成する（認証とGroupの両Contextをまとめてresetする）。その後に上のMigrationと開発APIを起動する。通常起動、Migration、終了処理に自動resetを追加しない。誤操作防止のため、任意のDBを削除できるreset Commandは提供しない。

この例外はlocalhostの使い捨てDataだけに適用する。永続Provider・本番認証・退会/Backup/Restoreの有効化には[本番Gate](authentication-retention-restore.md)の独立したEvidenceを要する。

## HTTP予算の保守

起動後は1分ごとに期限行を500行ずつ、1回の保守で最大20 Batch削除する。現WindowとPolicyは削除せず予算を戻さない。障害または24h以上の遅延は`AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE`だけを通知する。削除前に検出した遅延は同じ保守のBatch間で保持し、その回に超過行を全削除しても1回通知する。次回の保守に過去の遅延は持ち越さない。繰返し発生する場合は受付を停止し、専用環境の接続/容量を調べる。診断へIP、Cookie、Google値、鍵、SQLを出さない。Productionの監視先・運用容量・Failoverによる巻戻し防止は別Gateである。


## Google画面と手動確認

Webの`.env.local`にAPIと同じ公開Client IDを設定し、Owner管理のGoogle Web Clientへ`http://localhost:3000`（Google推奨の`http://localhost`も）をAuthorized JavaScript Originとして登録します。Client Secretは使用しません。Webを起動して`http://localhost:3000/login`を開き、「Googleログインを準備」→公式Google button→ログイン中→再読込→ログアウトを確認します。Google画面を閉じた後は「ログインを中止」から再開始できます。

認証E2Eは`pnpm --filter @kakei/web test:auth:e2e`。同じ専用fixtureが業務GraphQLの本人性とGroup Managementも接続し、`/groups`の作成・一覧（#315）を実PostgreSQL 17で検証する。固定Portを使用するため、通常の開発API/Webは先に止めます。専用Test fixtureは試験所有DBをcleanupしますが、通常devの終了/再起動に自動resetはありません。合成画面/実SDK署名の結果と、実Google本人操作の結果は[UI契約](../security/google-authentication-ui.md)に従い別記録にします。
