# 認証PostgreSQL保存境界

[Task #216](https://github.com/takeshi-arihori/kakei_app/issues/216)と[Accepted A2](../../../../../../../docs/security/authentication-protected-storage.md)に従う認証Storeの5操作・同Transaction Audit・Callback lease。HTTP、業務Repositoryの本番接続、具体鍵Provider、削除／Restoreは含めない。

## 責務と接続

`createPostgresAuthenticationStore({ pool, codec, digests, scopes })`へ実Poolと認証専用Portを注入する。`createAuthenticationTransactionScopes()`の所有能力はStoreにだけ渡し、参加Repositoryには`scopes.participants`だけを渡す。Applicationへpg型・SQL・接続・commit／release能力を渡さない。

| Module | 責務 |
| --- | --- |
| postgres-authentication-store | 5操作、認証判断、Lock順、Actor解決、Alias再試行 |
| authentication-transactions | 同一接続のBEGIN／COMMIT／ROLLBACK、結果不明と接続破棄 |
| authentication-transaction-scopes | 受付状態、同一接続への参加、失敗記録、本文handle所有検証 |
| authentication-key-state | 現行epochと全検索／必須書込世代の検証 |
| authentication-record-selection | 全世代検索、Cookie／Identityの複数hit拒否 |
| authentication-record-rows | bigint・Row／Envelope復元、insertと旧版CAS |
| authentication-audit | 固定Enum、用途別仮名、同一接続へのinsert |

既存Schema v5＋v6を使用し、Migrationを変更しない。Production認証からGroupのMigration Runnerへ依存しない。

## Lock・世代・再試行

READ COMMITTEDの同一接続で、key_state FOR SHARE → Actor UUID昇順FOR SHARE → Session UUID昇順FOR UPDATE → Attempt UUID昇順FOR UPDATE → Identity／Alias → Audit insertの順にlockする。無効化側はActor FOR UPDATE、Rotation公開はkey_state FOR UPDATE。非locking lookupはhintであり、Lock後にRecord ID・Actor FK・Digest・epoch・版を再確認する。更新済み版は最新暗号文と共に再検証し、completeはsnapshot全Fieldの一致も必須とする。判断時刻は必要なLockと暗号検証後の注入Clockから取得する。

active／rotatingだけを許可する。Identityは全searchableと全write-required世代を使い、旧AliasだけのActorも不足required Aliasを同Transactionで補完する。Actor状態MACは保存行の読取世代で検証する。Auditは独立3用途のMaterialと共通write-requiredラベルを使い、世代不足・部分公開を拒否する。新Cookieの衝突も全検索世代で検査し、旧世代の同値を再発行しない。

0-hitだけでActorを新規作成する。既存IdentityはLockと復号本人性の完全一致を確認し、異Identity多重hitを任意に選ばない。Alias Unique敗者だけが全rollback確認後に新Transactionで全世代・期限・未消費を再検証し、初回を含む最大3Transactionで終了する。Cookie／Session ID／Audit衝突、deadlock、serialization failure、rollback結果不明は再試行しない。VerifierやCallbackを再実行しない。

## Scopeと本文

Callbackは`(actor, scope) => Promise<AuthenticationSerializedValue>`。Scope.serialize(value)でJSON-safeな値を同期Copyし、lease内でJSON.stringifyを完了する。handleはnull prototype、own data propertyのbody:stringだけを持つfrozen Object。元Objectの後続変更は本文に反映しない。

Accessor／custom prototype／toJSON／関数／Symbol／BigInt／undefined／非有限数／循環／疎Arrayを拒否する。同じ本文でも別Scopeのhandle・偽造Object・未確定の任意値を受理しない。

1. open: Callbackの参加queryとserializeを受け付ける。
2. sealed: Callback直後に受付だけを止め、DB接続とActor／Session Lockを保持する。
3. 未完了query・受付中の失敗・handle所有を検査し、ownerだけがidle更新・Audit・commitを行う。
4. Outcome処理後にclosedとして接続を解放し、成功commit後だけ本文を返す。

参加queryは同じregistryのopen Scopeで単一SELECT／INSERT／UPDATE／DELETEだけを許可する。固定文とParameterを分け、コメント・文区切り・Transaction制御・QueryConfig Objectを受理しない。Tableを作成する[SELECT INTO](https://www.postgresql.org/docs/17/sql-selectinto.html)を防ぐため、SELECT文のINTO語もSQL実行前に保守的に拒否する。値はParameterへ分離し、参加Repositoryの固定SQLをReviewする。握り潰されたquery／serialization失敗もcommitを拒否し、未await queryは収束後にrollbackする。sealed／closed後はSQL／JSON評価前に拒否する。後続Transportはcommit後のresult.value.bodyをそのまま送信し、元Dataやhandleを再serializationしない。Callback内の外部副作用のrollbackを保証しない。

## Audit・Outcome・検証

許可・拒否とも固定action／decision／reasonと独立用途のHMAC仮名を保存する。不在対象はnull。eventId／requestIdはServer生成UUIDv4。Cookie・Token・Google本人性・直接ID・IP／UA・例外自由文を保存しない。Audit失敗は判断結果より優先してunavailableとする。

commit前障害は全rollbackを試みるが、ProviderのNonce割当はburnしたまま。COMMIT送信後の応答喪失は共通commit済みの可能性を残し、接続破棄・unavailableとして秘密値／本文を返さない。Session秘密値や同Attemptの成功をDBから復元しない。Alertは固定operation／Codeのみ。

`apps/api/test/authentication-store.integration.spec.ts`は末尾_testの実DBにv5＋v6を適用する。既存Suiteと同じadvisory lockで直列化し、Schema不存在を確認し、Suite所有Schemaだけを削除する。異なるbackend PIDとpg_blocking_pidsで同Attempt・同本人・Logout・Actor無効化・Rotation競合を観測する。合成参加TableのPIDとxminで書込み・idle・Auditの同一Transactionを確認する。SQL／鍵／Codec故障、期限等値・Lock待機中期限跨ぎ、再試行上限、世代混在、改竄、Scope逸脱、commit前rollbackと実COMMIT後応答喪失、秘密値非漏出も検証する。

テスト用無効化／Rotation Writerは競合を検証する合成実装であり、本番Workflowではない。具体Providerのdurability・独立Failure domain・IAM・全世代破棄・外部Ledger／Witness・Restore訓練、HTTP／Rate limit／実Google／Browserは別Evidenceが必要。削除／Restoreは#217、HTTPは#218、Google画面は#219にTraceする。
