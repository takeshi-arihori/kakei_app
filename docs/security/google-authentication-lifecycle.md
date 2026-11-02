# Google認証内部Lifecycle契約

根拠: [認証Epic #202](https://github.com/takeshi-arihori/kakei_app/issues/202)、[Accepted認証ADR](../adr/google-login-actor-session.md)。本書は共有ApplicationとPortの内部契約を定め、暗号部品#215と[PostgreSQL Store #216](../../apps/api/src/shared/infrastructure/authentication/postgres/README.md)へ接続する。HTTP、Cookie設定、共有Rate limit、localhost用環境設定と使い捨て鍵Providerは[#218のHTTP契約](authentication-http-boundary.md)に従う専用開発Compositionへ接続済みである。永続的な本番鍵／Nonce Provider、通常mainとProductionのwiringは引き続き別Gateであり、本書や開発接続の実装だけでは有効化しない。

## 型と境界

時刻はUTC Unix epoch millisecondsの非負safe integerとし、Clock Portから取得する。期限と等しい時刻は無効。Login Attempt TTLは300,000ms、Session absoluteは604,800,000ms、idleは86,400,000ms。

Entropy Portは用途`attempt`／`nonce`／`login-csrf`／`session`／`session-csrf`ごとに新しい32-byte CSPRNG値のpaddingなしcanonical Base64URL（43文字）を返す。Applicationは形式と同一発行内の重複を拒否する。CSPRNGの品質・用途間／発行間の独立性はAdapterと独立Security Reviewの責務。新しい実依存・具体乱数実装は追加しない。

外部入力はunknownから検証し、Token／CSRF値の暗黙変換をしない。AttemptとSessionの秘密値はTransport内部のCookie setterへ渡すResultにだけ含め、Actor／Google IdentityをClient入力として受け取らない。VerifiedGoogleIdentityは既存Verifierからのみ取得し、その成功Resultを最小のCopyにしてStoreへ渡す。PortのSDK例外・Store例外・Callback例外はcauseやLogを付けず`unavailable`へ変換する。

Storeは以下の原子的責務を持つPortである。同一接続・Audit・競合・Outcomeは#216の実DB Testで検証し、具体Providerの本番durabilityは別Gateとする。ClockをPortへ渡し、Adapterはlock取得後・実際の判断点でClockを再取得する。ApplicationがI/O前に固定した時刻だけで期限を検証してはならない。

## Begin

Input: 任意の旧Attempt秘密値、任意の現在Session秘密値。存在する値はcanonical形式を検査する。存在するが不正なSession値を有効本人性として扱わず、新しいログイン開始は許可する。不正な旧Attempt値で任意Recordを失効させない。

Applicationは3つの独立秘密値を生成し、Store.beginへ渡す。Storeは同じ判断点で有効な現在Sessionがあれば`already-authenticated`を返し、それ以外は旧未消費Attemptを無効化し新Attemptを保存する。Storeは衝突時に既存Attemptを上書きせず`unavailable`とする。成功は`started`とAttempt秘密値・nonce・CSRF・expiresAt。不成功では生成した秘密値を返さない。

## Complete

Input: Credential unknown、Attempt秘密値 unknown、CSRF unknown、任意の現在Session秘密値。必須秘密値が不正なら`restart-required`でStore／Verifierを呼ばない。

1. Store.readAttemptへCookie由来秘密値・CSRFを渡す。Storeは同じ試行への束縛、未消費、期限、Server期待nonceを確認し、`ready`とimmutable snapshot（Record ID／version／nonce／expiresAt）だけを返す。CSRFの比較・保存保護はAdapter責務で、CallerからexpectedNonceを受け取らない。
2. Applicationはsnapshotの期限・形を確認してCopyし、既存Google VerifierへCredentialとServer nonceを渡す。Verifierの`invalid-credential`／`unavailable`ではStore.completeを呼ばず、Actor・Session・消費状態を変更しない。
3. verified Identityの正規化issuer、subの非空・前後空白なし・255文字以下を確認する。2つの新しいSession秘密値を生成する。Attempt秘密値・期待nonce・Login CSRFのいずれとも再利用しない。
4. Store.completeは改めてCookie／CSRF・snapshot version・nonce・期限・未消費と、任意の現在Sessionの有効性をlock下で確認する。既存有効Sessionなら`already-authenticated`。Actor無効なら`restart-required`。Identity一意性、既存Actor再利用または新ランダムUUIDv4 Actor作成、Session保存、Attempt消費、成功Auditを共通commitする。
5. 成功は`authenticated`と新Session秘密値・absoluteExpiresAtだけ。Actor本人性は後続のSession照会から取得する。HTTPの204／Cookie設定はこのResultを後続Adapterが変換する。

同Attemptの再送・並行消費は最大1成功で、他は`restart-required`。Google検証中に期限／version／消費状態／Actor状態が変化した場合は部分登録せず拒否する。応答喪失時は同秘密値を復元せず、新Attemptから再ログインする。

状態不変を保証するのはVerifier拒否／障害、commit前の拒否、確実にrollbackした失敗である。Storeからcommit結果不明またはcommit後応答喪失が報告された場合は`unavailable`とし、Actor／Session／試行消費が共通commit済みの可能性を残す。失敗Resultだけからrollback済みと判断せず、同Attemptを再消費したり秘密値を復元したりしない。Testではcommit前故障とcommit後応答喪失を区別し、後者で成功済みRecordが存在しても新Session秘密値を返さないことを検証する。

## Session利用とLogout

withAuthenticatedActorはSession秘密値 unknown、usage（`inspect`または`activity`）、非公開のApplication Callbackを受ける。秘密値が不正なら`unauthenticated`でCallbackを呼ばない。

Store.withSessionはlock下で未失効・Actor有効・absolute／idle期限を検証し、Callbackへ内部ActorSubject・absoluteExpiresAt・Session束縛CSRFを渡す。Group Domain型をImportせず、既存ActorSubjectへ変換可能な非空の内部参照文字列を使う。Actor値はServer生成のランダムUUIDv4としGoogle sub／emailを返さない。usage=inspectはidleを変更しない。activityは成功Callbackと同じTransactionでidleをmin(now+24h,absolute)に更新する。許可対象Requestの判定は後続HTTP Adapterが所有する。

Callbackの完了・commit／serializationまでleaseを保持する。失効は同じSessionを排他取得し、すでに開始したCallbackは先に完了するか、失効後に拒否される。commit前のCallback例外やDB／鍵／Audit障害は確実にrollbackした場合だけ状態不変を保証する。withSessionでもcommit結果不明／commit後応答喪失では業務変更・idle更新が確定済みの可能性を残し、Callback結果を返さず`unavailable`とする。Callback内の外部副作用をrollbackできるとは主張しない。将来の業務CallbackはPortが保証するTransaction範囲で実行する必要がある。

Logoutは有効形式のSession秘密値だけをStore.revokeへ渡す。Cookieなし・形式不正・照合なし・期限切れ・すでに失効なら`logged-out`。現在のSessionだけを失効し別Sessionを変更しない。Store障害／失効commit失敗は`unavailable`で成功扱いしない。Origin／CSRFチェック・Cookie削除は後続HTTP境界で行う。

begin／withSession／revokeもcompleteと同様に、commit前の確実なrollbackとcommit結果不明／成功後応答喪失を区別する。後者は状態変更済みの可能性がある`unavailable`である。beginの返却不能Attemptは期限で無効化・清掃し、Logoutは同じCookieで安全に再試行する。Test-only StoreではwithSessionのcommit前故障と成功後応答喪失でidle状態と返却値を比較する。実DBでの故障位置・Transaction Outcome検証は保存Adapter TaskへTraceする。

## TransactionScopeの内部契約

#216ではStoreとApplicationのCallback第2引数へ`AuthenticationTransactionScope`を渡し、Tを`AuthenticationSerializedValue`へ制約する。CallbackはScope.serialize(value)でJSON-safeな値を同期Copyし、lease内で確定した本文handleだけを返す。handleはown data propertyのbody:stringだけを持つnull prototypeのfrozen Object。Object identityと発行元Scopeを検証するため、同じ本文でも別Scopeのhandle・偽造Objectを受理しない。Result Union／status、Command／Actor、TTL、Verifier非呼出し規則は維持する。

Scopeはopen（Callback操作受付）→sealed（受付停止・DB lease保持）→closed（Outcome処理後）と進む。Callback直後にsealedとし、未await query・握り潰されたquery／serialization失敗・handle所有を検査してからownerがAuditとcommitを行う。sealedでも正当なhandleを検証できるが、新query／serializeは拒否する。Accessor／toJSON／独自prototype／非JSON型／循環／疎Arrayを成功にしない。後続Transportはcommit後のresult.value.bodyをそのまま送信し、元Dataやhandleを再serializationしない。Applicationへpg型・SQL・接続所有能力を露出しない。

## 保証と検証範囲

Application Unit TestはTest-onlyの決定的なStore／Entropy／Clock／Verifierを境界として使い、呼出し回数だけでなく状態・返却値を検査する。期待nonce、期限等値・検証中期限跨ぎ、Actor再利用、試行二重消費、Session絶対／idle、inspect非延長、失効対象限定、Callback拒否／例外、障害非漏出、未知入力・Entropy異常をTDDで検証する。

Fake Storeでの成功はSQL原子性・平文禁止・Audit永続化・鍵Rotation・実Browser認証のEvidenceではない。#216の実Adapter Testでは同じContractを実PostgreSQLの2接続、故障注入、応答喪失、lease対Logout、暗号／Audit障害で検証する。ProductionにTest Store／固定Actorを追加しない。

## A2保存設計へのTrace

[認証Data保護保存仕様](authentication-protected-storage.md)と[ADR](../adr/authentication-protected-storage.md)は2026-10-11のOwner会話承認「はい。」と独立Security Review passによりAccepted。Storeの原子的責務を認証専用Envelope・Digest・Key-state／Row Lock・Auditへ写像し、清掃・削除・Restoreを分割する。Schema・暗号・Storeの検証と、未接続のProduction Gateを区別する。Application契約・TTL・commit不明時の保証は本書を維持する。

## A5 HTTP接続の追補（2026-10-22）

[HTTP契約](authentication-http-boundary.md)と[HTTP ADR](../adr/authentication-http-and-development-boundary.md)に従い、#218が4操作/Cookie/共有Rateとlocalhost専用Compositionを接続する。内部Serviceの`restart-required`は維持し、Owner追補によりcanonicalなLogin CSRF不一致・期限切れ/消費済み/不在試行を一律409へ写像する。欠落/形式不正Headerは403。inspect本文はScope内で確定し、LogoutはSession CSRF照合とrevoke成功後のCookie削除をHTTP側で所有する。既存TTL、本人性、Store原子性、業務Roleの境界を変更しない。通常main/Production/退会運用は未有効、実Google Browserと画面は#219である。
