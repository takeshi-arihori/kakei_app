# 共有認証Application

ログイン試行・Actor対応・Sessionの技術Use CaseとPortを置く。本人性は有効Sessionから解決し、GroupのRole・Invitation・業務判断は各Contextが所有する。

## 招待コードのPolicyと契約（#236）

[Accepted設計](../../../../../../docs/security/invitation-code-lifecycle.md)のR1〜R4に対応する内部部品。公開API、SQL、暗号処理、実Session認証、専用leaseはまだ実装していない。

| 部品 | 責務と限界 |
| --- | --- |
| `recipient-code-input.ts` | await前にcanonical 43文字を同期検証し、独立した32-byte入力値を作る。trim・大小変換・非canonical末尾bitを許可しない。秘密値を列挙可能なPropertyやJSONへ展開せず、暗号Adapterには毎回Copyを渡す。メモリの強制消去を保証するものではない |
| `recipient-code-record.ts` | 最小Inventory・用途別byte型・固定失敗。未知field・状態/日時/版/byte長を検証してCopyする。構造検証はMAC/epoch/本人認証の代替ではない。配列は独立Copyであり、MAC検証は#238以降が担う |
| `recipient-code-policy.ts` | 非負safe integerのClock、10分期限の等値拒否、Issuedからの一方向終端化、再発行計画。渡されたactive Actor/epochはtrusted factsでありPolicyが認証したとは扱わない。旧Issuedを変更せず置換計画を返し、新行/Auditと全rollbackできる保存境界へ渡す |
| `recipient-code-ports.ts` | 発行・取消・状態確認・初回消費と成功再送の内部契約。消費handle、GM保存証跡、確定本文、検索/MAC/Audit出力を別の型にする。Brandは誤用検出だけで、偽造・別Scope・二重受付の実行時拒否は#239の非公開registryで実証する |

一Actor一IssuedはPolicyが受け取る唯一の旧Recordと新規発行計画、#237の制約、#239/#240のActor排他Lockと共通commitで成立させる。PolicyのUnit Testだけで競合や保存の原子性を保証しない。

新規作成ではGMの現在Owner・Group版・人数等を別途検証する。成功再送はcaller-only preflightと専用lease内で共通GM operationを照合し、保存proof世代で元の内容を検証する。期限切れ/清掃済みコード・宛先無効・Owner喪失を理由に既存成功を誤拒否せず、現在有効なcaller Sessionは必須とする。再送でPolicyの消費を再実行しない。

取消は本人保有照合後だけAlreadyInactiveを返す。不在行の所有をPolicyが判定することはできず、他人のcodeIdとの外部差異を公開しない責務はAdapter/公開契約へ残る。コード取消は作成済みInvitationを消さない。logoutだけでコードを失効させる入力もPolicyへ追加しない。

## 契約と検証Trace

| 設計 / Done Criteria | #236の検証 | 後続で必要なEvidence |
| --- | --- | --- |
| V01 / IC-PRE-2 | 正規形、独立Base64url実装との256合成入力の一致、空白/Unicode/padding/末尾bit/大小の区別、入力と配列のCopy | HTTPでの形式拒否・Store非呼出しは#246後の公開実装 |
| V02 / IC-PRE-4 | 10分期限の直前・等値・後、Clock/版overflow、Actor/epoch不一致 | Lock待機と最終serialize時点の再確認は#239/#243 |
| V03/V07 / IC-INV-2/FAIL-1 | 再発行/消費/取消計画、全終端状態、不変な旧Issued、disabled拒否 | 2接続の排他、一回消費・MAC・Audit・GMとの共通rollbackは#239〜#243 |
| R4 / IC-FAIL-2 | 最小Inventoryの形、未知field/status・不正Metadata・用途型の拒否 | 暗号認証・差替え検知は#238、実PG制約は#237 |
| V11 / IC-POST-2 | 再送と消費を分けたPort、opaque handleと確定本文の型検査 | GM共通namespace・保存proof世代・原子的な成功再送は#241〜#243 |

Testは合成入力のみ。`recipient-code-policy.spec.ts`は純粋判断、`recipient-code-ports.spec.ts`は型契約、既存`architecture-dependencies.spec.ts`は依存方向を検証する。SQL/Schema/既存認証Port/Invitationの7日・受諾契約は変更しない。公開契約・清掃/Restore・具体Provider/Production Gate完了前にmain/Dev/HTTPへ接続しない。
