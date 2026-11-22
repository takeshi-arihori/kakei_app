# Actor単位のGroup索引と存在非開示

- Status: Accepted（索引の表・書込はこのADRを同梱する#309で実装。読取は#310、開発用鍵Providerへの用途追加は#314、Rotation用の再構築・本番Provider・Restore実装はProduction Gate）
- Owner: Project Owner（takeshi-arihori）
- 承認日: 2026-11-20
- Decision Check: 方針変更あり（ADR #55 §4のKey scopeに、Context単位の用途を追加する）
- 承認記録: [Issue #306](https://github.com/takeshi-arihori/kakei_app/issues/306#issuecomment-7033381622)（Owner会話承認。推奨案1A・2A・3A・4Aをすべて採用）
- 関係: Amends [Snapshot Revisionの保護と保持境界](snapshot-revision-security-and-retention.md)（ADR #55。§2の平文許可、§4のKey scope、§7の0件確認対象）。Amends [Group作成と自分のGroup一覧の公開契約](group-create-and-my-group-list-contract.md)（#305。論点4のAlert条件だけを§2のとおり補正する）。Related [Group operation locatorとGroup IDの保存契約](group-operation-locator-and-group-id-contract.md)（ADR #85）、[使い捨て開発CompositionへのGroup Managementと開発用Group鍵の追加](development-composition-group-management.md)（#307）
- Related: Epic [#303](https://github.com/takeshi-arihori/kakei_app/issues/303)、実装[#309](https://github.com/takeshi-arihori/kakei_app/issues/309)（索引・書込）、[#310](https://github.com/takeshi-arihori/kakei_app/issues/310)（読取）、[#314](https://github.com/takeshi-arihori/kakei_app/issues/314)（開発Composition配線）

## Context

#305は「自分のGroup一覧」を、Actorから参加中のGroupを引く索引で候補を得て、固定版で再認可する形に決めた。既存の`group_actor_access_index`は次の理由でこの用途に使えない。

- digestの入力と鍵がGroupごとに分かれている（`actorAccessIndexDigestInput(groupId, actorSubject)`、ADR #55 §4のGroup用途鍵）。Actorから全Groupを横断して引けない。
- 全Groupについてdigestを計算して照合する方式は、Group総数に比例して計算と照会が増える。

ADR #85のoperation locatorは、Context単位の用途鍵でActorを含むdigestを作る前例である。新しい索引はGroup Recordの暗号化Payload内にあるActor subjectから作るため、既存Group行からSQLだけでは作れない。

## Decision

### 1. 索引の形（1A）

一覧の候補列挙専用の表`group_actor_membership_index`をMigration 0012で追加する。既存の`group_actor_access_index`は変えない。

| Column | 内容 |
| --- | --- |
| `actor_digest` | Context単位の用途鍵によるActor digest。非空 |
| `digest_key_version` | digestの鍵版。`^[A-Za-z0-9._:-]+$` |
| `group_id` | Random Group ID。`group_aggregate_record`へFK `ON DELETE CASCADE` |
| `created_at` | 技術Timestamp（保存時刻）。業務時刻ではない |

- 主キーは`(actor_digest, digest_key_version, group_id)`、`group_id`に副索引を置く。Actor subject、Role、状態、業務時刻は保存しない。
- digestの用途は`group-actor-membership-index/v1`とする。入力はCanonical TLV `{0x01: 'group-actor-membership-index/v1', 0x02: 'actor-membership-index', 0x03: actorSubject}`で、GroupIdを含めない。
- 鍵はGroup Management専用の`GroupActorMembershipIndexKeyPort`（`currentDigest`／`candidateDigests`）から得る。Group DEK、Group単位HMAC（`PurposeSeparatedDigestPort`）、operation locator、Audit鍵とMaterialを共有しない。既存の`DigestPurpose`（Group scope）には加えない。
- 並びのKeyは索引に複製しない。読取（#310）は`group_aggregate_record.created_at`とJOINして並べる。
- 新索引は認可の根拠にしない。Snapshot読取とCommandの認可は従来どおり既存索引と固定版の再認可を使う。

受け入れるLinkability: DBやBackupを読める者は、同じ仮名Actorがどの（Random）Groupに属するかを横断で結び付けられる。既存のGroup単位digestでは結び付けられなかったので、これは本Decisionで新たに受け入れる。鍵がなければ仮名からActor subjectへは戻れず、認証側のActor digestとも鍵が別なので結合できない。業務内容・金額・業務時刻は漏れない。

### 2. 存在非開示、鍵世代とRotation（2A）

- 一覧は、現行とRetiredの全候補digestで索引を引く。全候補missなら空の一覧を返し、Group鍵の取得と復号を1回も行わない。
- hitしたGroupだけを、GroupId昇順の`FOR SHARE`、復号、`actorsAllowedByCurrentGroupState`と同じ述語で再認可する（#305 4A）。Lock後、自分のdigestの索引行がまだあるかを同じTransactionで再確認する。行が消えていれば退出等との正常な競合として黙って除外し、行が残っているのに再認可が否なら索引の不整合として除外してAlertする。`hasMore`は索引hit数で決める。
- 書込は現行鍵版だけを使う。Commandは対象Groupの行を全削除して再挿入するので、1つのGroupの行が複数の鍵版に分かれない。
- この索引は保護Group Recordから再計算できる射影である。Rotationでは、Retired鍵版の行が残るGroupを順に`FOR UPDATE`→復号→現行鍵で再挿入して移行する。key-state singletonは置かない。現行鍵がProviderにない場合、`currentDigest`が失敗してCommandはfail-closedになる。
- Retired鍵は、その版のlive行が0件、かつその行を含み得るBackupの35日Windowが終わった後だけ破棄できる。破棄前に別用途へ再利用しない。

### 3. 書込（3A）

- 唯一のWriter`PostgresGroupStateWriter.persist`のcreate／update両経路で、既存索引の置き換えと同じTransactionの中で新索引も置き換える。Group行、既存索引、新索引は一緒にcommitまたはrollbackされる。
- 載せる集合は、既存索引と同じ`actorsAllowedByCurrentGroupState`（Archived以外はActive Participant、ArchivedはownerAtArchiveだけ、Leftなし）から作る。Commandごとに契機を列挙しない。Groupの状態を保存するCommand（作成、招待受諾、招待コード経由、Leave、Owner移譲、Close開始・取消、Archive、今後追加するもの）はすべてこのWriterを通る。
- digestは`GroupRecordPreparer.prepare`で既存索引と一緒に計算する。Portの例外、空digest、不正な鍵版は保存全体を失敗させ、Writerは`Unavailable`を返す。
- Migration 0012は`group_aggregate_record`を`SHARE`ModeでLockし、1行でもあれば中断してSchemaを変えない。既存Dataのbackfillは別のOwner Decisionで扱う。Downは索引が空の開発・Test環境だけで使い、Data適用後はForward-fixする。

### 4. Retention削除とRestore（4A）

- `group_id`の`ON DELETE CASCADE`により、`PostgresGroupManagementRetentionAdapter`の`DELETE FROM group_aggregate_record`と同じTransactionで消える。Adapterのコードは変えない。ADR #55 §7の「対象Group rowが0件」の確認対象にこの表を加える。
- 鍵はContext単位なので、Group削除時の「Group鍵の破棄」の対象ではない（locator鍵と同じ扱い）。行はcascadeで消え、仮名digestだけが残ることはない。Complete Tombstoneとdeletion receiptの内容は変えない。
- Restore: 本索引は保護Group Recordの射影であり、正本ではない。Restore後に食い違う場合はGroup Recordを正として、Rotationと同じ手順で索引を再構築する。Backup 35日以内の行が参照し得るRetired鍵版の保持は、§2の破棄条件に含まれる。GM側のRestore検証、Ledger／Witness、Restore fingerprintへの算入は、[ADR #278](restore-consistency-evidence-and-recipient-code-participation.md)が定めたGM Restore設計（Production Gate側）で扱う。本Epicの開発Compositionは使い捨てDBなのでRestoreを行わない。

## Alternatives

| 論点 | 案 | 採らない理由 |
| --- | --- | --- |
| 1 | Actorごとに暗号化した所属Groupリストを1行で持つ | 所属グラフをDB読者から隠せるが、複数GroupのCommandが同じActor行を更新するためLock順の設計が増える。Retentionをcascadeで済ませられず、Restore・Rotationも複雑になる |
| 1 | 既存索引のdigestをContext単位鍵に置き換える | Snapshot読取・Command認可を含む全Access判定のKey scopeを弱める。既存行の再hashに復号を伴うbackfillが要る |
| 1 | 既存表へContext単位digestのColumnを追加する | 1行に2用途のdigestが並び、用途分離・Rotation・主キーの意味が混ざる |
| 1 | 索引を持たず全Groupについてdigestを照合する | Group総数に比例して計算と照会が増える |
| 1 | 索引に作成時刻を複製して索引だけで並べる | 平文の複製が増える。1 Actorの所属数分の並べ替えで足りる |
| 2 | locatorと同じkey-state singletonを置く | 置き換え方式では重複行が起きず、Retired行も読めるので、全Commandに共有Lockを足す利点が小さい |
| 2 | Retired鍵を無期限に読む | Retired鍵を破棄できず、鍵侵害時に所属グラフの仮名が残り続ける |
| 2 | missでもダミー復号して時間を揃える | 本人に本人の件数が分かるだけで、他人のGroupの存在は分からない |
| 3 | Commandごとに差分を書く | 契機の列挙漏れが起きやすく、既存索引の置き換え方式と非対称になる |
| 3 | 非同期Projectionで更新する | 作成直後の一覧に出ない。`apps/worker`は未採用 |
| 3 | 0012でbackfillを実行する | Migrationに鍵と復号を持ち込む。対象Dataが現状ない |
| 4 | 索引をRestoreの検証対象に含め、不一致ならQuarantineする | 射影の不一致は再構築で直せる。GMのRestore設計全体が未定で先取りする根拠がない |
| 4 | Retention時に索引を明示DELETEしてから本体を削除する | cascadeと同じ結果で手順が増える |

## Consequences

- #309: Migration 0012と`.down.sql`、`GroupActorMembershipIndexKeyPort`とdigest入力関数、Preparer・Writerでの置き換えを実装する。Retention Adapterはコードを変えず、削除後0件をTestする。Restoreは本ADRの契約だけ。
- #310: 鍵Portの`candidateDigests`で全候補を照会し、§2のLock後の再確認で「競合による除外」と「不整合によるAlert」を分ける。
- #314: 開発用鍵Providerの許可Listへ`group-actor-membership-index/v1`（Context単位、現行世代だけ）を加え、起動時の空DB検査の対象表に`group_actor_membership_index`を加える。それまで開発用Compositionの書込は鍵Portを渡せない。
- 既存Groupがある環境では0012が中断する。
- 残Risk: DBやBackupを読める者による所属グラフの横断的な結び付け。Rotation用の再構築処理とRunbookは未実装で、本番接続前に必要。競合で除外が起きると、50件未満でも`hasMore = true`になることがある。

## Review Trigger

- 所属グラフの秘匿がProductionの脅威モデルで必須になった場合（Actorごとの暗号化リストへの移行を再評価する）。
- 索引の用途を一覧の候補列挙以外（認可の根拠等）へ広げる場合。
- Key Provider、Rotation、Restoreの設計が確定する場合、または本番接続する場合（索引の再構築処理と一致検証を前提条件とする）。
- 既存Dataのある環境へ導入する場合（backfill）。
