# 使い捨て開発CompositionへのGroup Managementと開発用Group鍵の追加

- Status: Accepted（設計。開発用Compositionへの配線は#314、Production Gateは別）
- Owner: Project Owner（takeshi-arihori）
- 承認日: 2026-11-19
- Decision Check: 方針変更あり（開発用Compositionの対象Contextを広げる）
- 承認記録: [Issue #307](https://github.com/takeshi-arihori/kakei_app/issues/307#issuecomment-7007212342)（Owner会話承認。推奨案1A・2A・3A・4Aをすべて採用）、[許可Listの補足](https://github.com/takeshi-arihori/kakei_app/issues/307#issuecomment-7011121305)（2026-11-19）
- 関係: Supplements [認証HTTP・共有Rate limit・使い捨て開発Composition](authentication-http-and-development-boundary.md)（Decision 6〜8）、[Snapshot Revisionの保護と保持境界](snapshot-revision-security-and-retention.md)（S2、§4、Composition Gate）
- Related: Epic [#303](https://github.com/takeshi-arihori/kakei_app/issues/303)、[#304](https://github.com/takeshi-arihori/kakei_app/issues/304)、[#306](https://github.com/takeshi-arihori/kakei_app/issues/306)、[#313](https://github.com/takeshi-arihori/kakei_app/issues/313)、[#314](https://github.com/takeshi-arihori/kakei_app/issues/314)

## Context

Epic #303は、開発用の同一Origin構成（`dev:auth`）で、ログインした本人がGroupを作成・一覧できるようにする。現在の開発用Compositionの状況は次のとおり。

- 開発用Compositionは認証だけを組む。具体的には、使い捨ての認証鍵、`_auth_dev` DB、単一process lease、非空DBの拒否を持つ。
- Group保存（`PostgresGroupRepository`）に必要な鍵（Group DEK、用途別HMAC、operation locator）の具体Providerは、Test fixtureにしか存在しない。
- 開発DBにGroup Managementの表がない。Runbookは、専用認証DBにGroup業務Dataを置かないと定めている。
- 非空検査、lease喪失時の鍵破棄、resetの手順は、認証だけを対象にしている。
- Poolは1本だけである。#304で承認した「認証接続を保持したまま業務接続を取る」形では、Pool枯渇によるdeadlockが起こりうる。
- ADR #55のComposition Gate（Key Provider等が揃うまで本番配置しない）が`dev/`を含むかどうかは、明文化されていない。

## Decision

### 1. 開発用Group鍵Provider

- `apps/api/dev/group-management-development-keys.ts`に、認証の開発用鍵とは別のModuleとして置く。Materialはすべて用途ごとに独立したOS乱数（256-bit）で生成し、認証のDEK／HMACを流用しない。
- 提供する能力は、次の閉じた許可Listだけとする。
  - `ProtectedRecordKeyPort`: `contextName='group-management'`かつGroupごとに独立したDEKを持つ。Nonceは(Group, keyVersion)ごとにprocess内で単調に割り当て、await前にburnする。外側Transactionがrollbackしても戻さない。
  - `PurposeSeparatedDigestPort`: `group-actor-access-index/v1`、`group-membership-index/v1`、`group-operation-fingerprint/v1`を許可する。用途ごとに独立した鍵を持ち、許可List外の用途は拒否する。
  - `GroupOperationLocatorKeyPort`: Context単位の独立HMACとする。`candidateDigests`は現行世代だけを返す。
- `group-operation-fingerprint/v1`は2026-11-19のOwner承認による補足である。既存のGroup保存処理（`group-commit-kernel.ts`の`stage`）が全Commandで使う既存用途で、#313の実装中に許可Listからの漏れを確認した。新しい用途の追加ではない。
- 含めないもの: 招待のproof鍵、招待Audit鍵、Settlement／Expense鍵、Restore／Retention／保守系の能力。#306（Actor単位索引）で新しい用途鍵が承認された場合だけ、その用途を許可Listへ加える（Code変更とReviewを伴う）。
- 鍵版: process起動ごとに乱数の`keyVersion`を1つ発行し、DEK・HMAC・locatorで共有する。共有するのは世代識別子だけで、Materialは用途ごとに独立する。
- Rotation／上限: Codecが閾値（2^31）で`requestRotation`を呼んだら、その鍵を封印に使えなくし、要求自体も失敗させる（fail-closed）。新しい鍵へは移らず、明示resetを要求する。
- 終了: lease喪失・終了時は、認証鍵と同時に`dispose`して0埋めする。以後は`key-lost`を返すか拒否する。

### 2. Migration・非空拒否・再起動（#314で実装）

- 同じ使い捨ての`_auth_dev` DBへ、GM Migration 0001〜0004と認証5〜7を適用する。0010（招待enlist）と、認証8・9・11（招待コード）は含めない。Script名と環境変数は変えない。
- 起動時の初期化は、認証の初期化と同じguard Transactionで行う。`group_operation_locator_key_state`をLOCKし、`current_key_version IS NULL`を確認してから、processの`keyVersion`を設定する。
- 非空検査の対象に、GMの全業務表を加える。必要な表がない場合も、固定文言で起動を拒否する。
- 再起動では、認証とGroupの両Contextをまとめて明示resetする。自動削除や暗黙の再初期化はしない。

### 3. Pool（#314で実装）

- 同じDBへ、認証Poolと業務Poolを別々に作る。接続の取得順は「認証→業務」に固定し、業務側から認証leaseを開かない。
- 業務接続の待機がtimeoutしたら`SERVICE_UNAVAILABLE`を返し、認証leaseをrollbackする。
- lease喪失・closeでは、受付停止→鍵破棄→両Poolの`end`の順にする。

### 4. Production除外とADR #55のGate

- 開発用Group鍵ProviderとGMの接続は、`apps/api/dev/`だけに置く。`src/**`（`app.ts`、`main.ts`、`recipient-invitation-runtime.ts`を含む）からのImportと到達を、`architecture-dependencies.spec.ts`で拒否する。`dev/`からTest-only fixtureへのImportも拒否する。
- ADR #55のComposition Gateは「Production Composition Root／本番配置」を対象とする。`dev/`の使い捨てCompositionは、Gateの例外ではなく対象外とする。Gateの条件（Key Provider、Durable Audit、Retention Coordinator、Checkpoint／Witness、Backup Restore、KMS）は緩めない。開発用Providerは、A2／S2の永続性を満たす実Providerとして扱わない。

## Alternatives

| 論点 | 案 | 評価 |
| --- | --- | --- |
| 1 | 認証の開発用Providerを拡張して1 Moduleにまとめる | 不採用。認証とGMの鍵Scopeが混ざって用途分離のReviewが難しくなり、#218のSecurity評価範囲にも再び触れる |
| 1 | 永続する開発用Group鍵Provider | 不採用。鍵保管と永続Nonceの設計が必要になる。認証鍵は再起動で失うので、Groupだけ残してもActorと結べない |
| 1 | `test/support`の合成実装をdevから使う | 不採用。認証HTTP境界ADRのDecision 8と既存のArchitecture検査に反し、固定版名とRotationの空実装をRuntimeへ持ち込む |
| 1 | 単一のprocess master鍵からHKDFで用途鍵を導出する | 不採用。用途分離は保てるが、認証の開発用Providerと方式が分かれ、利点が小さい |
| 2 | GM用に別DBを置く | 不採用。lease・非空検査・resetが2系統になる。鍵は両方同時に失うので、運用を誤る余地が増えるだけになる |
| 2 | 起動時にGM表を自動TRUNCATEする | 不採用。Decision 7（自動削除・暗黙の再初期化をしない）に反する |
| 2 | 0010も適用する | 不採用。使わない招待表と鍵状態を置くことになる |
| 3 | 1つのPoolを共有してmaxを増やす | 不採用。Pool枯渇deadlockが起こりうる |
| 3 | Pool分離に加えてDB Roleも分ける | 開発では採らない。Production Gate（Credential）で扱う |
| 4 | ADR #55のGate文言を改訂する | 不採用。Production Gateを緩めたように読める |
| 4 | 環境変数で通常mainから切り替える | 不採用。Decision 8に反する |

## Consequences

- 再起動のたびに専用DBの明示resetが必要になり、開発で作ったGroupは保持されない。
- 同一Machine上の他processからの隔離は主張しない。開発DBへ実在の金融Dataを入れない。
- Group鍵の用途を追加するには、本ADRの許可Listの変更とSecurity Reviewが必要になる。

## ImplementationとGate

- #313: 開発用Group鍵Provider（Decision 1）と、Production除外の検査（Decision 4のImport検査）。
- #314: Runtime配線、Migration、locator鍵状態の初期化、非空検査、Pool分離（Decision 2・3）と、Runbook・`backend.md`の更新。
- #313・#314とも`security-reviewer`の対象とする。

## Rollback / Review Trigger

次の変更を行う場合は、新たにDecisionとSecurity評価を行う。

- 開発データの永続化
- 許可Listへの用途追加（招待・Settlement等）
- DBの分離
- Production接続

## Owner Decision

2026-11-19、Ownerは#307の推奨案1A・2A・3A・4Aを会話ですべて採用した。同日、論点1Aの許可Listへ既存用途`group-operation-fingerprint/v1`を加える補足にも「追加する」と回答した。これは親Agentによる会話証跡の転記であり、Owner本人のGitHub操作は主張しない。承認証跡は#307のCommentにある。
