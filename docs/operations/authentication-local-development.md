# localhostの使い捨て認証環境

Knowledge State: Confirmed。採用範囲は[HTTP ADR](../adr/authentication-http-and-development-boundary.md)と[HTTP契約](../security/authentication-http-boundary.md)。本番Provider、永続する開発鍵、実Google Browser操作の完了は主張しない。実Google Clientと画面の手動検証は[#219](https://github.com/takeshi-arihori/kakei_app/issues/219)。

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

例の接続値は説明用であり、自動DB作成・認証情報の配布ではない。`db:auth-dev:migrate`は明示操作として認証Migration 5/6/7だけを既存のChecksum台帳で原子的に適用する。稼働leaseがあれば拒否し、DB作成/drop/resetをしない。専用認証DBにGroup業務Dataを置かない。

Webは`next dev --hostname 127.0.0.1`で待受け、開発時だけ相対`/auth/*`を固定APIへ転送する。ClientはAPIの別Origin URLや独自Forwarded値を使わない。元のOriginを維持し、Session発行とAttempt削除の複数Set-Cookieを扱う。転送先への接続障害は詳細をLogへ出さずno-storeの503 Envelopeで返す。ProductionのWebから開発APIへ転送しない。Peerはproxy経由の接続Peerに集約され、Peer予算は開発利用全体で共有する。

## processの有効期間

専用advisory leaseを保持したprocessだけが、空の認証状態を独立したOS乱数鍵・新epochで初期化する。各DEKのNonceはprocess内の単調Counterで割当し、外側DB rollbackでも戻さない。閾値到達時は自動で同じ鍵を再生成せず拒否する。署名検証は実Google SDK、保存は実pg Storeを使う。Test-only Provider/固定Identity/認証bypassを開発入口へImportしない。

通常APIの`dev`/Production `start`はこの入口を選ばず、認証能力未接続の4経路は503を返す。API Production buildは`dev/`を除外し、開発Sourceは別にtypecheck/lint/Architecture/unit testを実行する。

lease接続の切断またはProbe失敗時はHTTP受付を停止し、鍵能力を封鎖する。SIGINT/SIGTERMでも受付を閉じてPool/lease/Timerを解放する。起動/環境/SQL/SDK例外の詳細は表示せず、`AUTH_DEVELOPMENT_START_FAILED`または`AUTH_DEVELOPMENT_MIGRATION_FAILED`だけを通知する。

## 終了後の明示reset

鍵は終了で失われる。認証Recordだけでなく初期化済み鍵Metadata/Rate Policyも既存状態として扱い、次のprocessは起動拒否する。以前のCiphertextを新しい鍵で開くことはできない。

再開が必要なOperatorは、API/Web停止、専用DB名・接続先・所有者と他用途Dataがないことを確認し、**その使い捨てDBだけ**をDB管理手段で明示削除・再作成する。その後に上のMigrationと開発APIを起動する。通常起動、Migration、終了処理に自動resetを追加しない。誤操作防止のため、任意のDBを削除できるreset Commandは提供しない。

この例外はlocalhostの使い捨てDataだけに適用する。永続Provider・本番認証・退会/Backup/Restoreの有効化には[本番Gate](authentication-retention-restore.md)の独立したEvidenceを要する。

## HTTP予算の保守

起動後は1分ごとに期限行を500行ずつ、1回の保守で最大20 Batch削除する。現WindowとPolicyは削除せず予算を戻さない。障害または24h以上の遅延は`AUTH_HTTP_RATE_CLEANUP_UNAVAILABLE`だけを通知する。繰返し発生する場合は受付を停止し、専用環境の接続/容量を調べる。診断へIP、Cookie、Google値、鍵、SQLを出さない。Productionの監視先・運用容量・Failoverによる巻戻し防止は別Gateである。
