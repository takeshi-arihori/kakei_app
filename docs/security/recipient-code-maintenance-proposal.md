# 招待コード清掃・Actor削除の事前調査

Knowledge State: **Proposal（未採用・実装前）**。対象は [#244](https://github.com/takeshi-arihori/kakei_app/issues/244)。本書は実装完了、Task の Ready、設計の採用、または本番有効化を示さない。採用済みの[招待コード ADR](../adr/invitation-code-lifecycle-and-protected-storage.md)、[操作契約](invitation-code-lifecycle.md)、[清掃・復旧運用設計](../operations/invitation-code-retention-restore.md)を変更しない。

## 対象と基準

基準は develop `82188fca2770acbcffc9a87032b8688642e2c193`。前提の #243 は [PR #254](https://github.com/takeshi-arihori/kakei_app/pull/254) で統合済み。#244 は、期限・終端・Actor 無効化の最早時点から24時間以内にコード行と全 record MAC 鍵世代を除去し、障害から再試行できる内部保守境界を要求する。Restore 全体は #245、公開 API・画面と本番接続は別の設計・実装・運用 Gate に残る。

招待コードは共有認証が所有する技術 Record であり、Group Management の Invitation や Participant ではない。Group の履歴・成功結果・再送用 proof 鍵はコード清掃の対象に含めない。

## 現状と不足

| 領域         | 確認した現状                                                                                                                                                                                     | #244 で必要な結果                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 清掃         | 既存の[認証清掃](../../apps/api/src/shared/application/authentication/authentication-cleanup-service.ts)は ticket、DB 不在、全世代破棄の証拠を照合する。コードは既存の保守 scope に含まれない    | コード期限・Actor 状態を含む最早期限を確認し、同じ処理を再開できること                       |
| 鍵 inventory | [コード鍵 Port](../../apps/api/src/shared/application/authentication/recipient-code-key-lifecycle.ts)は既知コードの全世代 inventory と closure を提供する。割当は DB rollback では取り消されない | 行のない孤立 scope も発見し、期限・所有範囲・全世代を照合できること                          |
| Actor 削除   | [削除 Coordinator](../../apps/api/src/shared/application/authentication/authentication-deletion-service.ts)は既存の Prepared・Ledger・Witness と鍵破棄を調整する                                 | コードを取り残さず、無効化と遅延した鍵割当の競合を安全に扱うこと                             |
| 互換性       | 旧保守 Reader は未知のコード用途を拒否する。通常認証も用途の初期化状態に依存する                                                                                                                 | 旧 Writer の拒否と既存4認証 API の維持を異なる条件で検証し、通常環境を誤って有効化しないこと |

## 検討中の境界

以下はいずれも **Proposal** であり、実装方式や新しい Decision として確定していない。

1. 鍵 scope の Actor との束縛、全世代の完全列挙、削除中の新規割当の封鎖を Provider 契約として表現する。DB 行がない場合も、信頼できる inventory と未完了 ticket の最早期限を失わない。
2. 小 Batch の処理が継続的な発行によって進捗不能にならないよう、固定された列挙とその後の変更を漏れなく追跡する。監視できない期限・不完全な列挙・証拠不明を成功にしない。
3. Actor 無効化の確定後に、対象 Actor の全 scope を再確認する必要がある。清掃と Actor 削除が競合するときは Lock を保持したまま別処理を待たず、既存の Prepared / Ledger / Witness と各 ticket の所有・期限を維持する。
4. 結果不明や部分的な鍵破棄では、DB の 0-row のみを完了とみなさず、同一操作の ticket・全世代 closure・DB 不在を再照合する。既知の期限未達は既存の隔離契約に従う。

旧形式の durable inventory が実環境に存在するか、完全列挙できるかは未確認である。未知 scope は無視せず安全側へ停止し、実移行の必要性が確認された場合は #245 と Production Gate との責務を含めて別途判断する。

## 完了までに必要な作業

- [ ] 上記の Provider 契約、期限監視、遅延 allocation、清掃 ticket と Actor 削除 operation の競合を具体化し、Accepted Decision との整合と Task 粒度を独立 Planning 評価する。
- [ ] 必要に応じて #244 と後続 Task の分割・依存を確定し、Issue / Project へ保存後、別の独立評価で再取得を確認する。#244 が Ready になるまで Production 実装へ進まない。
- [ ] Requirement に対応する Red を固定し、清掃・Actor 削除・必要な内部 Port / Adapter を実装する。途中段階で Actor 削除が鍵を残したまま Complete にならないことを保証する。
- [ ] 期限直前・等値・後、発行 / 取消 / 消費との2接続競合、孤立 scope、全世代の部分破棄、Provider / SQL / Audit 障害、commit 応答喪失、overdue を実 PostgreSQL と合成 Provider で検証する。
- [ ] 実装・関連 docs をセルフレビューし、最新対象について code / test / specification / security の4専門レビューを実施する。指摘の修正後は必要な再検証を行う。
- [ ] #245 の Restore、公開契約・画面、および具体 Provider / Backup / 監視の既存 Gate を維持する。PR の Ready 化・Merge は別の明示依頼を要する。

## 設計Proposal: #244の分割とOpen Questionの推奨案（改訂3）

Knowledge State: **Proposal（未採用）**。本節は独立Planning評価とOwner確認の入力であり、Accepted Decisionではない。評価は2回failし（初回: 型拡張の前提誤りと分割粒度、2回目: R5との整合・再開入口・封鎖順序・docs分配・停止契約の検証）、指摘を反映して改訂した。ADR追補がAcceptedになるまでTaskをReadyにしない。

### 現状コードの事実（評価で追加確認）

- `AuthenticationKeyScope.recordKind`は`AuthenticationRow['recordKind']`（identity/attempt/session）と同じ型で、Record暗号のDEK Port（`allocateForSeal`/`readKey`/`requestRotation`）とRecord Codecにも使われる。保守専用の型ではない。
- 実行時ガード`authenticationMaintenanceScope`は3種以外を拒否する。コードscopeは「保守に含まれない」のではなく**明示的に拒否される**。これが旧保守Reader/Writerの未知用途拒否の実体である。
- PG清掃の`absent`は`google-identity`/`session`以外を`login_attempt`として照会する暗黙分岐を持つ。清掃Serviceも`google-identity`以外の全scopeをCredentialとして破棄する。型の拡張だけでは誤った表を照会し、Actor削除Workflowを経ずに破棄し得る。
- ticket系`AuthenticationKeyDestructionPort`（scope単位の`destroy(ticket)`）とコード系`RecipientCodeMacKeyLifecyclePort`（`inventory`/`closeAllGenerations`/`verifyClosure`）は別契約で、橋渡しは未定義。既存の清掃Serviceはコード用の再開入口を持たない（`deleteExpired`と`pendingCredentials`だけを走査する）。
- 削除Serviceと`prepareAuthenticationDestruction`は`google-identity`1件を前提に、`authenticationMaintenanceScope`で検証した期待scope集合との完全一致を要求する。
- PG清掃AdapterはActor行を`FOR SHARE SKIP LOCKED`で読み、`digests.verifyActorState`でMAC検証してから使う。`disabled_at_ms`は`0005`に存在する。

### 推奨案

| #   | 論点                      | 推奨案                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 区分                                                                 |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | scope型と経路             | `AuthenticationKeyScope`・DEK Port・Codec・`authenticationMaintenanceScope`は**変更しない**。コード専用の`RecipientCodeKeyScope`（codeId＋束縛Actor）と、コード専用のticket/保守Portを新設する。通常の保守Reader/Writer経路へはコードscopeを混入させない                                                                                                                                                                                                                                                                         | 新Decision（ADR追補）                                                |
| 1b  | Actor削除への参加         | R5は全recipient-codeを既存のPrepared/Checkpoint/Witness/全世代closureへ参加させると定める。形式を変えず、同`operationId`に紐づくコード専用の別ticketを明示的な別入口で参加させる案を推奨する。Ledgerの削除Prepared/Completeは変更せず、削除Completeの前提条件として「コードticketの全scope closure検証とDB 0-row」を加える。Ledger/Witness形式を拡張する案（既存ticketのdigestへコード側digestを束縛する、Prepared record自体を拡張する）はR5の再解釈・形式変更になるため採らない。この選択がR5を満たすかは**ADR追補で判断する** | 新Decision（ADR追補。R5の解釈）                                      |
| 2   | ticketとclosureの橋渡し   | コード専用Portがticketを発行し、各codeIdの`inventoryRevision`をticketへ保持する。各scopeを`closeAllGenerations({codeId, operationId, inventoryRevision, deadlineAt})`→`verifyClosure`で閉じる。`deadlineAt`は**コードごと**に`min(expiresAt, terminalAt, disabledAt)+24h`とし、ticketのwindowは**最早dueAt**を使う（バッチ内の最早期限を最遅へ延ばさない）。全scopeのclosure検証とDB 0-rowの両方が揃うまで完了にしない                                                                                                           | 具体化（既存`closeAllGenerations`の入力に一致。形はADR追補に含める） |
| 2b  | 再開入口                  | コード専用Portに`pending(limit)`、`find`、`scopes`を置き、コード専用の清掃入口（既存の認証清掃とは別のUse Case）がticketから各codeIdのinventoryRevisionを復元して同operationを再照合する。コードticketを既存の`pendingCredentials`へ載せない                                                                                                                                                                                                                                                                                     | 新Decision（ADR追補）                                                |
| 3   | 孤立scope列挙             | コード専用Portに固定snapshotのPage＋所有cursorを持つ列挙（codeId・束縛Actor・期限・inventory版）を置く。「票のないscopeの完全列挙」はProviderの新しい完全性保証であり、既存のActor票走査とは別契約とする。保証できない場合は空成功にせず、未知scope・列挙不完全は停止する（受け入れ基準に含める）                                                                                                                                                                                                                                | 新Decision（ADR追補）                                                |
| 4   | 遅延`allocate`封鎖        | `allocate`へ束縛Actorを必須入力にする。契約の順序は「Actor単位の封鎖登録→列挙snapshot」で、封鎖後の`allocate`はAck `unavailable`とする。署名変更と合成Provider・既存呼出元（`recipient-code-transition-writer.ts`等）の改修は**A**で行う。Actor束縛のない既存割当はfail closed（合成Providerのみで実環境の既存分は#5）。封鎖の統合検証は**C**                                                                                                                                                                                    | 新Decision（ADR追補、実ProviderはProduction Gate。#238契約の変更）   |
| 5   | 旧形式のdurable inventory | #244では移行しない。未知scope・列挙不完全・版不一致はfail closedで停止する。実環境の有無は**未確認**で、必要なら#245／Production Gateで判断する                                                                                                                                                                                                                                                                                                                                                                                  | 既存設計の範囲内                                                     |
| 6   | Actor無効化時点           | MAC検証済みの`authentication.actor.disabled_at_ms`（既存清掃AdapterのActor `FOR SHARE`＋`verifyActorState`経路）をActor Lock下で読み`dueAt=min(expiresAt, terminalAt, disabledAt)`へ含める。Lock順はhint→Actor→code                                                                                                                                                                                                                                                                                                              | 既存設計の具体化                                                     |

分類の根拠: 既存の`closeAllGenerations`入力をそのまま使う橋渡し（案2）は具体化、型・経路、R5参加、再開入口、列挙保証、`allocate`契約変更は新しいPort契約またはR5の解釈であり、AIがAccepted扱いにしない。

### 旧保守Writerの停止契約（記述場所・条件・検証）

- 条件: `authenticationMaintenanceScope`と既存の保守経路は`recipient-code`を拒否し続ける。コード用途は新Portだけが扱う。旧Writerが`quarantine`/overdue封鎖の後に利用受付へ戻らないこと、`key_state`を`active`へ戻さないことを契約とする。コードの利用受付が`key_state`／epochと連動する経路は**未確認**で、Aで実コードとRestore設計を確認し、根拠となる機構（key-state/epoch/fence）を文書へ明記する。確認できない場合はOpen Questionとして設計へ戻す。
- 記述場所: 新Portのdoc comment、認証保守README、Runbook、capability matrix。
- 検証: 「既存保守経路が`recipient-code`scopeを拒否する」Red、および旧Writer共存時に封鎖状態から受付が再開しないTestをAで固定し、Bで清掃経路へ拡張する。#245のRestore固有の再開禁止は渡す。

### 分割（縦切り）と依存

```text
#244-A（型分離・Port・合成Provider・allocate署名＋最小縦切り） ──▶ #244-B（清掃の本格化） ──▶ #244-C（Actor削除統合）
```

各分割は直接Base `develop`の通常PRで、Stacked PRにはしない。前提がdevelopへ統合された後にRedを再確認して個別Ready評価する。待ち時間と再確認のコストは見積へ含める。docs・Runbookは各PRで実装と同じ変更として同期する。新Issue作成・Project登録は独立評価passとOwner承認の後に行う。

| 分割 | Scope                                                                                                                                                                                                                                                | 受け入れ基準（Done Criteria対応）                                                                                                  | 検証                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A    | コード専用scope型・ticket・保守Port契約、合成Provider、`allocate`署名変更と既存呼出元改修、停止契約の記述・拒否Red・再開しないTest、**縦切り**: 期限切れコード1件をticket登録→行除去→全世代closure→0-rowまで実PGで完了、契約docs・停止契約docsの同期 | 全世代破棄/ticket順序（一世代/0-rowだけで完了としない）、旧Writer停止契約、列挙保証の失敗は空成功にならない                        | 契約Unit、実PG（最小縦切り）、Fixture契約（偽closure・部分世代・版不一致・未知scope・列挙不完全・Provider障害）、build通過 |
| B    | 清掃の本格化: dueAt（disabledAt含む）再検証、hint→Actor→code SKIP LOCKED/CAS、小Batch、孤立scope清掃、overdue封鎖、再開入口、Runbook同期                                                                                                             | dueAt/Lock順、**コード利用がdisabled・期限等値/後でBatchを待たず拒否される（実PGの受け入れ基準）**、overdue、2接続競合、再開しない | 実PG（期限直前/等値/後、再発行・消費・取消の2接続競合）、故障注入（SQL/Provider/**Audit**/commit応答喪失）、24h未達        |
| C    | Actor削除の別入口でのコードticket参加（削除Complete前提）、封鎖の統合検証、削除と清掃の競合、GM Invitation/proof鍵を巻き込まない確認、通常環境へwireされない確認、docs/capability matrix同期                                                         | Actor削除inventory（R5のADR判断に従う）、封鎖、競合・故障、docs、wireしない                                                        | 実PG＋合成Provider（途中失敗、commit応答喪失、競合、**Audit**障害）、wireしないことのTest、V07/V12/V16                     |

disabled Actorの新規消費拒否は既存の消費Writer（#243）が所有する。#244は期限等値/後・disabledでの拒否がBatch清掃を待たないことを回帰として固定するだけで、拒否ロジックの新設はしない。

### 見積

初期見積2人日/5SPは分割後の合計に対して過小と評価された。暫定: A 3人日/8SP、B 3人日/8SP、C 3人日/8SP。個別Readyで再評価し、SPへ自動換算しない。

### Decision候補と未確認

- ADR追補が必要: 推奨案1・1b・2b・3・4。AIはAccepted扱いにしない。
- Owner Decision候補: Aを縦切りにする粒度。
- 未確認: 実環境の旧形式durable inventory、コードの利用受付と`key_state`／epochの連動、Providerがコードticketを保持する実運用、「事前検証と限界」の回帰件数（基準developが異なり再現していない）。

### 評価へ渡す確認点

1. 推奨案1・1b・2b・3・4をADR追補で扱う前提で、Proposalは完結しているか。
2. A/B/Cの縦切りと受け入れ基準はDone Criteriaを漏れなく重複なく覆うか。
3. 事実記述と分類に誤りがないか。

## 事前検証と限界

基準と同じ tree で実行した認証・Group 単体回帰は 44 files / 851 tests、隔離した PostgreSQL 17 での既存統合回帰は 21 files / 485 tests が成功した。これらは既存挙動の回帰であり、#244 の新規清掃・全世代破棄・競合や実 Provider の耐久性を実証しない。Actor の不一致を新しい割当契約で拒否すべきことは一時的な探索的 Red で確認したが、恒久的な型付き Test は未作成。
