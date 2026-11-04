# 招待コード保守の鍵inventory・ticket・Actor削除参加

- Status: **Proposed（未承認。AIはAccepted扱いにしない）**。
- Proposed Date: 2026-11-04（Asia/Tokyo）
- Decision Owner: Project Owner（Owner承認日: 未承認）
- Decision / Design Task: [#244](https://github.com/takeshi-arihori/kakei_app/issues/244)。Restoreは[#245](https://github.com/takeshi-arihori/kakei_app/issues/245)が使う。
- Epic: [#202](https://github.com/takeshi-arihori/kakei_app/issues/202)
- Decision Check: 方針変更あり（新しいPort契約とR5の解釈を含む）
- Supplements / Amends: [招待コードのLifecycle・保護保存・原子的消費](invitation-code-lifecycle-and-protected-storage.md)のR4/R5を実装可能な保守契約へ具体化する。同ADRの7項目と[認証Dataの保護保存](authentication-protected-storage.md)の既存契約は変更しない。ただし下記D2とD5はR5の解釈と[#238](https://github.com/takeshi-arihori/kakei_app/issues/238)の`allocate`契約を変更する候補である。
- 詳細: [設計Proposalと独立Planning評価の入力](../security/recipient-code-maintenance-proposal.md)、[運用設計](../operations/invitation-code-retention-restore.md)

## Problem / Context

Accepted設計は、コードの期限・終端・Actor無効化の最早時点から24時間以内にコード行と全Record MAC鍵世代を除去し、Actor削除と復旧でも取り残さないことを要求する。一方、現在のコードには次の事実がある（develop `087d8b8`で確認）。

- `AuthenticationKeyScope`はRecord暗号のDEK Portとcodecにも使われ、保守専用の型ではない。保守のscope検証は`google-identity`/`login-attempt`/`session`以外を拒否する。
- 清掃Serviceはコード用の再開入口を持たず、削除Serviceの`begin`は`google-identity`1件だけを`prepare`する。ticket系Portとコード系`RecipientCodeMacKeyLifecyclePort`は別契約で、橋渡しがない。
- 既存清掃AdapterはActorを`FOR SHARE`で読むが、R4はコード清掃で本人Actorを最初から`FOR UPDATE`とする。
- key-state読取は既知集合外のpurposeを拒否し、通常認証Storeはコードpurposeがあると止まる。
- 行のないscope（`allocate`後にrollbackされた孤立scope）を列挙する契約と、削除後の遅延`allocate`を拒否する契約がない。

R5の「既存Prepared/Checkpoint/Witness/全世代closureへ参加」を、実装前にどう満たすかを決める必要がある。

## Decision候補（Proposed）

採用するか、どの案にするかはOwnerが決める。以下は推奨であり承認ではない。

### D1 コード専用のscope型・ticket・保守Port

`AuthenticationKeyScope`・DEK Port・codec・`authenticationMaintenanceScope`は変更しない。コード専用の`RecipientCodeKeyScope`（codeIdと束縛Actor）とコード専用のticket/保守Portを新設する。通常の保守Reader/Writer経路へコードscopeを混入させない。旧Writerの未知用途拒否は維持する。

### D2 Actor削除への参加方式（R5の解釈）

- (i) 別ticket方式: Ledger形式を変えず、同`operationId`に紐づくコード専用ticketを明示的な別入口で参加させる。削除Completeの前提に全コードticketのclosureと0-rowを加える。
- (ii) digest束縛方式: Ledger/Witnessの検証対象へコード側digestを含める（形式変更）。

(i)は変更が小さい。ただしRestore（#245）やWitnessがコードclosureを直接検証できず、Done Criteriaの「Ledger/Witnessへの包含」を満たさない可能性がある。(ii)は包含を満たすがLedger/Witness形式の変更を伴う。**推奨は未確定でOwnerが選ぶ**。選択までActor削除統合（#244-C）はReadyにしない。

### D3 ticketの粒度・所有・採用・closure束縛

- 1 ticket=1 codeId。codeIdごとに未完了ticketは高々1つ。
- ticketは所有operationを持つ。別operationが同codeIdを必要とする場合は既存の未完了ticketを採用し、重複作成しない。採用の関係はdurableに記録する。
- 採用時のwindowは`dueAt=min(所有側, 採用側)`、`deadline=dueAt+24h`へ前倒しのみで、延長しない。版を上げるCASで更新する。
- closureとticketの`operationId`は常に所有operation。`closeAllGenerations({codeId, operationId, inventoryRevision, deadlineAt})`→`verifyClosure`で閉じ、全closure検証とDB 0-rowが揃うまで完了にしない。完了済みticketは充足済みとして扱い再作成しない。
- 清掃のdueAtは`min(expiresAt, terminalAt, disabledAt)`。Actor削除operationは`min(コード自身のexpiresAt/terminalAt, preparedAt)`。
- 再開入口として`pending(limit)`、`find`、`byOperation(operationId)`（所有または採用の全ticket）、`scopes`を置く。

### D4 孤立scopeの列挙契約

コード専用Portに、固定snapshotのPageと所有cursorによる列挙（codeId・束縛Actor・期限・inventory版）を置く。票のないscopeの完全列挙はProviderの新しい完全性保証である。保証できない場合は空成功にせず、未知scope・列挙不完全・版不一致は停止する。孤立scopeのdueAtは束縛ActorをActor Lock下で読んで算出する。

### D5 `allocate`のActor束縛と封鎖

`allocate`に束縛Actorを必須入力にする（#238契約の変更。既存呼出元と合成Providerを同じ変更で改修する）。順序は「Actor単位の封鎖登録→列挙snapshot」で、封鎖後に返すsnapshotは封鎖前に受理済みの全`allocate`を含む（linearizable）。封鎖後と、ticket登録済みcodeIdへの追加`allocate`（鍵rotationの再MACを含む）はAck `unavailable`とする。Actor削除の再開は封鎖（冪等）と列挙を再実行して不足分を登録し、Completeの前に再snapshotが検証済みticket集合と一致することを確認する。

### D6 key-stateとの共存・停止契約

通常認証Store（4認証API）のreaderはコードpurposeで止まったままにする（旧Writer停止の機構。緩めない）。既存の清掃・削除Adapterの読取だけを、コードpurpose初期化後も継続動作するよう拡張する。コード専用のkey-state読取は`quarantined`でも清掃を許す。コードpurposeの初期化・provisioningは#244の範囲外とする。`quarantined`から`active`へ戻す遷移はRestoreだけが持つことを維持する。

## Alternatives

- `AuthenticationKeyScope`へ`recipient-code`を追加する案: DEK Port・codec・保守guard・`absent`の暗黙分岐へ波及し、旧Writer拒否の定義を壊すため採らない。
- 1 ticketに複数codeIdを束ねる案: 既存ticketのwindow完全一致検証と、コードごとの最早期限の保持が両立しないため採らない。
- 清掃で既存の`FOR SHARE`を流用する案: R4（Actor `FOR UPDATE`）と食い違うため、採る場合はR4との差分を別Decisionとする。

## Consequences

- 実装は#244-A1/A2/B/Cへ分割し、各PRは直接Base `develop`の通常PRとする。A1/A2/BのReadyはD1・D3〜D6のAccepted後、CはD2のAccepted後に評価する。
- 合成Providerの成功は、実Providerの線形化・耐久性・IAM・Backup運用の証拠にならない。実Provider・物理Backup・本番運用は既存のProduction Gateのまま。
- コード機能を通常main/Dev/Productionへwireしない。公開契約・退会業務・Ingress・監視は対象外。

## Implementation

分割・受け入れ基準・検証・見積は[設計Proposal](../security/recipient-code-maintenance-proposal.md)を参照する。実装中に新しいDecisionが必要になった場合は止めて設計へ戻す。

## Review Trigger

- Providerの完全列挙・線形化を保証できない場合（D4/D5）。
- D2で(ii)を選ぶ場合（Ledger/Witness形式の変更は別途ADRの再Review対象）。
- 実環境に旧形式のdurable inventoryが存在すると判明した場合（移行は#245／Production Gateで判断）。
- #245のRestore設計がD3のticket/closure契約と整合しない場合。
