# 保存レコードの保護基盤

このPackageは、ADR #55で採用した、特定Providerに依存しない保存レコードの保護境界を実装します。Canonical AADの符号化・検証、AES-256-GCMによる暗号化・復号、Contextごとの鍵と一意なNonceを取得するPortを提供します。業務認可、永続化、具体的なKMS／Providerの選定、永続的なAlert配送、Audit保存、本番への接続は担当しません。

## 鍵とNonceの契約

`ProtectedRecordKeyPort.allocateForSeal`は、Group・Context・鍵Versionの組ごとに、一意な96-bit Nonceと単調増加する暗号化回数を原子的に割り当てる必要があります。呼出し側はCodecへNonceを指定できません。ProviderがCounterの後退や鍵の喪失を明示的に報告すると、Codecは鍵のRotationを要求し、外部には`ProtectedRecordUnavailable`だけを返します。

Codecは暗号化回数が`2^31`に達するとRotationを要求し、`2^32`以上の割当を拒否します。`readKey`は、認証対象と完全一致する鍵Versionについて、現行鍵または旧鍵を返せます。これによりRotation中は両Versionを読み取れます。原子性、Counterの永続状態、鍵のLifecycleは具体的なProviderの責務です。

保存レコードの暗号鍵とBlind IndexのDigestは、別のBrand型とPortで区別します。Digestの用途にはVersionを付け、Membership、Actor Access、operation locator、Fingerprintの名前空間をまたいで再利用しません。

Group Managementの不変履歴は、Membership変更、Invitation変更、Group終了で異なるAADのRecord種別を使います。Group終了履歴は、RandomなGroup ID、論理Record ID、Aggregate Versionに束縛され、Close Intent・Receipt・Actorの各値は暗号化されたまま保持されます。

## 失敗とAlertの境界

不正または非CanonicalなAAD、Metadataの不一致、鍵の利用不能、Nonce／Tag長の不正、認証失敗は、すべて同じ汎用Errorである`ProtectedRecordUnavailable`を返します。任意のAlert Callbackへ渡すのは操作種別と固定Codeだけです。ID、Payload、Ciphertext、Nonce、Tag、鍵は渡しません。永続的なAlert配送は後続の本番Gateです。
