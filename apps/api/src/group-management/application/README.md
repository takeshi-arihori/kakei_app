# Group Management Application

既存`GroupCommandService`はGroupの純粋判断とstandalone `GroupRepository`を調整する。認証・SQL・暗号の実装をDomainへ移さず、公開API/通常mainへの接続は別Gateとする。

## #241 コードからのInvitation作成

`use-cases/registered-recipient-invitation-service.ts`の`RegisteredRecipientInvitationService.create`が、`CreateInvitationFromRecipientCode`の内部契約を実装する。入力はsessionSecret、不変CodeSecret、groupId、expectedVersion、operationIdだけ。Actor/宛先/Role/codeIdのClient申告、未知field/accessor/prototype、不正VO/版をawait前に拒否し、正規秘密値VOの派生prototypeも受け付けない。caller/recipient/codeIdは`RecipientCodeSessionPort.use`の検証済みfactsから得て、各Callbackのawait前に固定する。

新規作成は認可付きGroup loadと期待版照合後、全blocking Lock後Clock/Server InvitationIdを使い`Group.inviteParticipant`へ委譲する。現在Owner/Active/人数4未満/自己・Active重複判断を重複実装しない。7日Pendingを作るだけでParticipantを追加せず、枠予約なし・Owner譲渡後Pending維持・本人受諾・Left後の新Participantでの再参加を変更しない。

### 再送と保存計画

1. caller-only preflightでGMのActor内・全Command/全Group共通operation namespaceを照会する。成功は保存action/version、Group/要求版、保存proof世代/値、元Actor/operation、最小結果を照合して返す。現在Owner/現在Group版/宛先有効性/code行/current proof鍵を条件にしない。
2. missはNoReplayだけで終え、新規専用lease内でもownerがoperationを再照合する。並行成功があればcreateせず再送へ収束する。二つのleaseは別Transactionであり、preflightで業務保存しない。
3. createだけ認可付きGroup load/純粋判断/current proof作成を行う。`RecipientInvitationCommitPlan`は新Group/期待版、Invitation Created履歴、空のmembership/Closing変更、typed fingerprintと最小成功結果、codeId/recipient binding、同scopeの確定本文handleを持つ。
4. GM-owned `stage(scope, handle, plan)`が保存とGM Auditをstageして同scopeの登録Adapterによる証跡を返し、Applicationが`scope.consume(handle, evidence)`を一度だけ要求する。standalone commit/別Poolへfallbackしない。実コードWriter/Invitation/両Context Auditの原子性は下記#243の内部統合で検証する。

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

実GM Adapter/相互codec/namespace/復号0/保存証跡は#242、コード消費と両Context共通commitは下記#243で検証し、清掃/Restoreは#244/#245、公開契約/UIは#246以降へ残す。通常main/Dev/HTTPへのwiring、新Provider/Production有効化は行わない。


## #242の保存Adapter

[GM-owned認証Scope参加](../infrastructure/postgres/README.md)が本Portを実装する。共有認証の登録関数から得たquery/run/beginPlan/attestの限定能力を非公開保持し、key-stateをActorより前に固定する。操作全体の受領/完了/失敗を追跡し、認可load/期待Root/履歴/最小結果/本文を照合して、共通保存kernelと実GM Auditの成功後だけ証跡を返す。code行/宛先Actor/current proof鍵を読まない保存世代replayと、旧Commandとの共通namespaceを維持する。

この接続の実PG検証は、認証owner/コード消費Writerを合成したGM参加境界である。#241のfake検証や#242の成功から、#243の実Session本人性・実コード消費・両Context業務atomicityを推論しない。公開API/UIと通常main/Dev/Productionは未接続のまま。


## #243の実内部統合

[内部Composition](../../recipient-invitation-runtime.ts)は本Serviceへ実lease/実GM Adapter/proofを注入し、同じregistryで実コード消費と両Auditまでを共通commitする。`create(command, signal?)`の中断要求はPortを通してlease ownerへ渡す。ServiceはSQL/接続所有/コードRecordを持たず、Groupの既存Domain判断を維持する。

caller-only missと専用lease内の再照合、コードLock待機後の再照合により、並行成功を消費済み/期限理由で誤拒否しない。保存障害/結果不明後の一回照合はlease ownerが行い、Serviceの新規Callbackを自動retryしない。確定本文だけを返し、照会missで結果不明を確定失敗へ読み替えない。実検証と未実証の運用境界は[認証保存README](../../shared/infrastructure/authentication/postgres/README.md#243-実コード消費と内部composition)に記載する。


## #308 自分のGroup一覧のQuery

[Group一覧ADR](../../../../../docs/adr/group-create-and-my-group-list-contract.md)の論点2〜4を、`use-cases/list-my-groups.ts`の`MyGroupQueryService.listMyGroups`が実装する。入力は信頼済みActorだけで、結果は表示属性なしの要約（`groupId`、`lifecycle`、`myRole`、`activeParticipantCount`、`createdAt`、`joinedAt`、`deleteEligibleAt`）を作成の新しい順（同時刻は`groupId`昇順）に最大50件と`hasMore`で返す。

- `my-group-list-read-port.ts`の`MyGroupListReadPort.readCandidates`へ51件を要求する。Portは1 Transactionで索引のhitを`groupId`昇順に固定版で読み、版を確かめた`Group`と索引のhit数を返す。Lock後に自分の索引行が消えていたGroupは、退出等との競合として復号せずに除く（#306 2A）。障害は`Unavailable`にし、一部だけは返さない。
- 索引のhitは認可の根拠にしない。ApplicationがArchived以外は自分のActive Participant、ArchivedはownerAtArchiveだけを許す述語で再認可し、否の候補は除いて`MyGroupListIntegrityAlertPort`へ`groupId`だけを通知する。Leftの旧Participantは対象にせず、再参加は新しいParticipantで判定する。
- `createdAt`は`joinOrder = 1`の参加者の`joinedAt`から導出する。
- `hasMore`は索引のhit数が51件あるかで決める（#306 2A）。Portが競合で除いた候補と、再認可で除外した候補も数え、続きがある可能性を隠さない。
- Portの`Unavailable`・例外、hit数の不整合（要求件数の超過、返したGroup数より少ない、整数でない）、`groupId`の重複、`joinOrder = 1`の参加者がないGroup、通知の失敗は、一覧全体を`MyGroupListApplicationError('UNAVAILABLE')`にする。

索引のKeyは[Actor単位のGroup索引ADR](../../../../../docs/adr/group-actor-membership-index.md)（#306）に従い、`group-policy-digest.ts`の`actorMembershipIndexDigestInput`とContext単位の`GroupActorMembershipIndexKeyPort`で作る。GroupIdを入力に含めず、Group DEK・Group単位HMAC・locator・Audit鍵と共有しない。書込は#309のState Writer、読取は#310の[`PostgresMyGroupListReader`](../infrastructure/postgres/README.md#310-自分のgroup一覧の読取)。

`list-my-groups.spec.ts`はfake Portで対象・写像・並び・上限・除外と通知・障害を検証する。fakeの成功はPostgreSQLのLock、復号、索引の存在非開示の証明ではなく、#310の`test/my-group-list-reader.integration.spec.ts`で実PG検証する。GraphQL公開は#312で、Security auditは書かない（ADR論点4）。

## #312 公開Transportからの入力組立

`use-case-inputs.ts`の`createGroupCommandFrom`と`listMyGroupsQueryFrom`は、認証leaseが与えたActorとClientの`operationId`（文字列）から、`createGroup`のCommandと一覧のQueryをDomain Value Objectで組み立てる。依存表上PresentationはDomainを参照できないため、Value Objectの生成だけをここに置く。業務Ruleと再送照合は既存Use Caseのままで、`operationId`のUUIDv4形式の公開検査は[GraphQL Presentation](../presentation/graphql/README.md)が先に行う。
