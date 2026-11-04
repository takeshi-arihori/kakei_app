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

## 設計Proposal: #244の分割とOpen Questionの推奨案

Knowledge State: **Proposal（未採用）**。以下は独立Planning評価とOwner確認の入力であり、Accepted Decisionではない。評価でfailまたはOwnerが別案を選んだ場合は本節を修正する。実装は個別Ready後にだけ始める。

### Open Questionの推奨案

| #   | 論点                      | 推奨案                                                                                                                                                                                                                    | 根拠 / 未確認                                                                                                       |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | 孤立scopeの完全列挙       | コード専用の列挙Portを既存の`recipient-code-key-lifecycle.ts`系へ追加する。固定snapshotのPage＋所有cursorで、`codeId`・束縛Actor・期限・inventory版を返す（既存`pendingActorDeletionPage`と同型）。DB行の有無に依存しない | 既存のActor票走査と同じ欠落検出の考え方を再利用できる。新Port契約は新しい設計判断のため独立評価の対象               |
| 1b  | 遅延`allocate`の封鎖      | `allocate`へ束縛Actorを必須入力にし、対象Actorの削除ticket登録後は同Actorの新規割当をProviderが恒久拒否する                                                                                                               | 既存`allocate`は孤立scopeに期限を保持するが、Actor束縛と削除後の拒否は未定義                                        |
| 1c  | scope型                   | ticketのscopeを表す`AuthenticationKeyScope.recordKind`だけへ`'recipient-code'`を追加し、Record暗号用の`AuthenticationRow['recordKind']`とAAD/Codecは変更しない                                                            | `AuthenticationKeyScope`の使用箇所は保守Port/Adapter/Fixtureに限られる見込みだが、実装前の影響確認が必要（Aで確認） |
| 2   | 旧形式のdurable inventory | #244では移行しない。未知scope・列挙不完全・版不一致はfail closedで停止し、必要性が確認された場合は#245／Production Gateで別途判断する                                                                                     | 実環境の有無は未確認のまま                                                                                          |
| 3   | Actor無効化時点           | `authentication.actor.disabled_at_ms`（MAC検証済みActor行）をActor Lock下で読み、`dueAt=min(expiresAt, terminalAt, disabledAt)`へ含める                                                                                   | 列は`0005`で存在を確認済み。清掃側のActor Lock順序との整合はBで再検証する                                           |

### 分割と依存

```text
#244-A（型・Port・合成Provider） ──▶ #244-B（清掃） ──▶ #244-C（Actor削除・競合統合・docs）
```

各分割は直接Base `develop`の通常PRとし、Stacked PRにはしない。前提がdevelopへ統合された後にRedを再確認して個別Ready評価する。新Issue作成・Project登録は独立評価passとOwner承認の後に行い、本節だけを根拠に作成済みとは扱わない。

| 分割 | Scope                                                                                                                                                              | 主なDone Criteria対応                          | 主な検証                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| A    | ticket scope型の拡張、コード専用の列挙Portと遅延割当封鎖の契約、全世代closure契約のticket束縛、合成Provider Fixture、旧保守Writerの未知用途拒否の維持確認          | 全世代破棄/ticket契約、旧Writer停止契約        | 型・契約Unit、Fixture契約Test（Provider障害・偽closure・部分世代・版不一致・未知scope） |
| B    | PG清掃Adapter／清掃Serviceのコード対応。hint→Actor→code SKIP LOCKED/CAS、dueAt再検証、ticket登録→行除去→全世代closure→0-row、overdue封鎖、コード利用の即時拒否維持 | dueAt/Lock順、ticket順序、overdue              | 実PG（期限直前/等値/後、2接続の再発行・消費・取消競合）、故障注入、24h未達              |
| C    | 削除Coordinator／Prepared・Ledger・Witness inventoryへの全コード組込み、Actor無効化との競合、GM Invitation/proof鍵を巻き込まない確認、Runbook/docs同期             | Actor削除inventory、競合・故障・応答喪失、docs | 実PG+合成Provider（全世代の途中失敗、commit応答喪失、削除と清掃の競合）、V07/V12/V16    |

### 共通の制約

- 通常main/Dev/Productionへコード機能をwireしない。Scheduler・Provider・IAM・退会UIは追加しない。
- Restore専用の処理は#245へ残す。合成Providerの成功を実Provider耐久性・本番Capabilityの証拠として扱わない。
- GM Invitation・過去Actor参照・成功operation・proof鍵をcascadeや早期破棄の対象にしない。認証からGM Tableを直接参照しない。

### 評価へ渡す確認点

1. 推奨案1〜3はAccepted ADRの範囲内の具体化か、新しいDecisionか。
2. A/B/Cの分割と依存は、各1 Deliverableとして妥当な粒度か（初期見積2人日/5SPの再評価を含む）。
3. 実装前に追加の設計文書（ADR追補）が必要か。

## 事前検証と限界

基準と同じ tree で実行した認証・Group 単体回帰は 44 files / 851 tests、隔離した PostgreSQL 17 での既存統合回帰は 21 files / 485 tests が成功した。これらは既存挙動の回帰であり、#244 の新規清掃・全世代破棄・競合や実 Provider の耐久性を実証しない。Actor の不一致を新しい割当契約で拒否すべきことは一時的な探索的 Red で確認したが、恒久的な型付き Test は未作成。
