# Group Management Application

既存`GroupCommandService`はGroupの純粋判断とstandalone `GroupRepository`を調整する。認証・SQL・暗号の実装をDomainへ移さず、公開API/通常mainへの接続は別Gateとする。

## #241 コードからのInvitation作成

`use-cases/registered-recipient-invitation-service.ts`の`RegisteredRecipientInvitationService.create`が、`CreateInvitationFromRecipientCode`の内部契約を実装する。入力はsessionSecret、不変CodeSecret、groupId、expectedVersion、operationIdだけ。Actor/宛先/Role/codeIdのClient申告、未知field/accessor/prototype、不正VO/版をawait前に拒否し、正規秘密値VOの派生prototypeも受け付けない。caller/recipient/codeIdは`RecipientCodeSessionPort.use`の検証済みfactsから得て、各Callbackのawait前に固定する。

新規作成は認可付きGroup loadと期待版照合後、全blocking Lock後Clock/Server InvitationIdを使い`Group.inviteParticipant`へ委譲する。現在Owner/Active/人数4未満/自己・Active重複判断を重複実装しない。7日Pendingを作るだけでParticipantを追加せず、枠予約なし・Owner譲渡後Pending維持・本人受諾・Left後の新Participantでの再参加を変更しない。

### 再送と保存計画

1. caller-only preflightでGMのActor内・全Command/全Group共通operation namespaceを照会する。成功は保存action/version、Group/要求版、保存proof世代/値、元Actor/operation、最小結果を照合して返す。現在Owner/現在Group版/宛先有効性/code行/current proof鍵を条件にしない。
2. missはNoReplayだけで終え、新規専用lease内でもownerがoperationを再照合する。並行成功があればcreateせず再送へ収束する。二つのleaseは別Transactionであり、preflightで業務保存しない。
3. createだけ認可付きGroup load/純粋判断/current proof作成を行う。`RecipientInvitationCommitPlan`は新Group/期待版、Invitation Created履歴、空のmembership/Closing変更、typed fingerprintと最小成功結果、codeId/recipient binding、同scopeの確定本文handleを持つ。
4. GM-owned `stage(scope, handle, plan)`が保存とGM Auditをstageして同scopeの登録Adapterによる証跡を返し、Applicationが`scope.consume(handle, evidence)`を一度だけ要求する。standalone commit/別Poolへfallbackしない。実コードWriter/Invitation/両Context Auditの原子性は#243で実証する。

失敗/Conflict/Mismatchでは成功operationを保存せず、業務状態の部分commitを認めない。Callback障害/結果不明はlease ownerのrollback/unavailableへ委譲する。新operationや新規処理の自動retryは行わず、明示再送で保存成功を再照会する。Responseはkind/groupId/invitationId/versionだけで、codeId/宛先/Profile/原コード/proofを展開しない。

### fingerprintと共通namespace

`group-policy-digest.ts`の`recipientCodeInvitationFingerprint`は既存GM canonical TLVを用いる。tag1は`group-recipient-invitation-fingerprint/v1`、2は新action、3はGroup ID、4は要求版の十進表記、5はproof鍵世代、6は32byte proof。tag昇順・1byte tag/4byte big-endian length、文字はUTF-8、proofはbinaryとする。旧string用vectorと既存locatorのtag/内容は変更しない。

proofはGM独立用途`gm-recipient-code-request/v1`の保存世代で照合し、lookup Digest/状態MACや原コードを既存JSON `CommandFingerprint`へ入れない。proof/byte列は同期Copyする。再送は保存世代でverifyし、current世代で作り直さない。新規のcodeId/宛先bindingは保護operation内だけへ保存する。

`RecipientInvitationRepository.findOperation`はlegacy `StoredOperation`も同じnamespaceから返す契約で、新Commandは異actionをMismatchにする。新しいコード用locator/Table/namespaceを作らない。新recordをlegacy readerへ無理に渡さず、既存codec/旧Command側を含む相互の異action拒否と同一保存kernelへの物理接続は[#242の保存Adapter](../infrastructure/postgres/README.md)で実装する。#241時点では既存Repository/SQL codecを変更せず、新しいrecordを実保存しなかった。現在の#242は共通kernelと新旧codecの相互Mismatchを実PGで検証する。

### 能力と未接続の境界

- `findOperation`: Actor/operationだけで保護検証済み保存成功を読む。Group復号/現在権限を再送条件にしない。
- `loadForInvitation`: membershipの存在非開示を先に照合し、権限外decrypt0を維持してGroupと版を固定する。実Lock/復号は#242のEvidenceが必要。
- `currentProofKeyVersion`: Actorより前に固定済みのGM key-stateを読む。Callback内で後付けLockしない。
- `stage`: Group/版/履歴/共通operation/GM Auditと、handle/codeId/宛先/operation/本文のregistry attestationを同scopeへ束縛する。接続所有権/commit能力を借用しない。

`registered-recipient-invitation-service.spec.ts`はfake lease/参加Portで入力・順序・Group判断・再送・結果不明・障害・snapshot/本文非漏出を検証する。proofの計算は合成鍵を使う既存暗号Adapterを使用し、`recipient-code-invitation-fingerprint.spec.ts`は独立encoder/byte Copy/用途/形式と旧locatorの不変を照合する。fakeのscope/証跡/commit/競合は実認証・SQL・registry・atomicityの証明ではない。

実GM Adapter/相互codec/namespace/復号0/保存証跡は#242、コード消費と両Context共通commitは#243、清掃/Restoreは#244/#245、公開契約/UIは#246以降へ残す。通常main/Dev/HTTPへのwiring、新Provider/Production有効化は行わない。


## #242の保存Adapter

[GM-owned認証Scope参加](../infrastructure/postgres/README.md)が本Portを実装する。共有認証の登録関数から得たquery/attestだけを非公開保持し、key-stateをActorより前に固定する。認可load/期待Root/履歴/最小結果/本文を照合し、共通保存kernelと実GM Auditの成功後だけ証跡を返す。code行/宛先Actor/current proof鍵を読まない保存世代replayと、旧Commandとの共通namespaceを維持する。

この接続の実PG検証は、認証owner/コード消費Writerを合成したGM参加境界である。#241のfake検証や#242の成功から、#243の実Session本人性・実コード消費・両Context業務atomicityを推論しない。公開API/UIと通常main/Dev/Productionは未接続のまま。
