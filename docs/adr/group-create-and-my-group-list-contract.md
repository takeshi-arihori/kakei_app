# Group作成と自分のGroup一覧の公開契約

- Status: Accepted
- Owner: Project Owner（takeshi-arihori）
- 承認日: 2026-11-19
- Decision Check: 方針変更あり（Group作成と一覧の公開契約を新しく決める）
- 承認記録: [Issue #305](https://github.com/takeshi-arihori/kakei_app/issues/305#issuecomment-7007086597)（Owner会話承認「推奨案をすべて採用する」、論点1A〜5A。親Agentによる会話証跡の転記であり、Owner本人のGitHub操作は主張しない）
- 関係: Epic [#303](https://github.com/takeshi-arihori/kakei_app/issues/303)。前提は[#304](https://github.com/takeshi-arihori/kakei_app/issues/304)（業務GraphQLの認証・CSRF・公開Error、2026-11-19承認）と[#302](https://github.com/takeshi-arihori/kakei_app/issues/302)（Browserから見えるOriginは1つ）。Supplements [Group Commandの本人性・認可・再試行](group-management-command-authorization.md)（#36）、[Snapshot Revisionの保護と保持境界](snapshot-revision-security-and-retention.md)（#55）§4・§5
- Amended By: [Actor単位のGroup索引と存在非開示](group-actor-membership-index.md)（#306、2026-11-20。論点4の再認可で否のときは、Lock後に索引行が消えていれば競合として黙って除外し、残っている場合だけ不整合としてAlertする）
- 実装: [#308](https://github.com/takeshi-arihori/kakei_app/issues/308)（一覧のQuery Use CaseとPort）、[#309](https://github.com/takeshi-arihori/kakei_app/issues/309)（索引保守）、[#310](https://github.com/takeshi-arihori/kakei_app/issues/310)（索引からの読取）、[#312](https://github.com/takeshi-arihori/kakei_app/issues/312)（GraphQL公開）、[#315](https://github.com/takeshi-arihori/kakei_app/issues/315)（Web）。このADRは#308と#309のうち先にEpic BranchへMergeするPRに同梱し、後のPRはこれを参照する

## Context

- `GroupCommandService.createGroup`は入力がActorと`operationId`だけで、保存まで実装済みだが公開経路がない。`OperationId`の形式は未規定。
- 自分のGroup一覧は、Query Use Case、公開契約、Actorから全Groupを引ける索引のいずれもない。既存の`group_actor_access_index`はGroupIdをdigestに含み、Actorから横断して引けない。
- DomainのGroupには作成日時のfieldがない。`Group.create`は`joinOrder = 1`の参加者の`joinedAt`へ作成時刻を入れ、Leaveでも参加記録を消さない。
- Group名等の表示属性はDomainになく、本Epicでは持たせない（2026-11-19 Owner判断）。
- ADR #55 §4の固定版照合と§5のSecurity auditはSnapshot読取を前提にしており、Group単位のメタデータ読取への適用が決まっていなかった。
- 画面inventoryは作成・一覧を独立screen（Proposed）としていたが、入力項目がない。

## Decision

### 1. `createGroup`の入力・再送・結果

```graphql
type Mutation {
  createGroup(input: CreateGroupInput!): CreateGroupResult!
}

input CreateGroupInput {
  operationId: ID!
}

type CreateGroupResult {
  groupId: ID!
}
```

- Actorは認証lease（#304）からだけ得る。Inputに`actorSubject`・Role・Participantを持たせない。
- `operationId`はClientが作成の1回の意図ごとに`crypto.randomUUID()`で生成する。小文字canonicalのUUIDv4以外は`INVALID_INPUT`とし、Use Caseを呼ばない。結果不明（`SERVICE_UNAVAILABLE`、通信断）では同じ値で再送し、成功または確定Errorの後は破棄する。保存はClientのmemoryだけとする。
- 同じActor・同じ`operationId`の再送は最初と同じ`groupId`を返す。別のActorには結果を返さない。再送の成功は一覧の閲覧権限を与えない（#36）。
- 結果は`groupId`だけ。`participantId`と`version`は返さない。
- Error: `AUTHENTICATION_REQUIRED`、`REQUEST_REJECTED`、`INVALID_INPUT`、`OPERATION_MISMATCH`（同じ`operationId`を別Commandで使用済み）、`SERVICE_UNAVAILABLE`（`UNAVAILABLE`、commit結果不明、Server生成IDの衝突による`GROUP_ALREADY_EXISTS`、想定外例外をmask）。Union Resultは使わず`extensions.code`にそろえる（#304）。

### 2. 一覧の項目・並び・上限

```graphql
type Query {
  myGroups: MyGroupList!
}

type MyGroupList {
  items: [MyGroupSummary!]!
  hasMore: Boolean!
}

type MyGroupSummary {
  groupId: ID!
  lifecycle: GroupLifecycle!
  myRole: GroupRole!
  activeParticipantCount: Int!
  createdAt: String!
  joinedAt: String!
  deleteEligibleAt: String
}

enum GroupLifecycle { ACTIVE CLOSING CANCELING ARCHIVED }
enum GroupRole { OWNER PARTICIPANT }
```

| 項目 | 内容 |
| --- | --- |
| `lifecycle` | Domainの`status`とClosing内の`phase`を写像する。Closing＋Fencingは`CLOSING`、Closing＋Cancelingは`CANCELING` |
| `myRole` | Archived以外は、自分のActive Participantが現在Ownerなら`OWNER`、それ以外は`PARTICIPANT`。Archivedは一覧に出るのがownerAtArchiveだけなので常に`OWNER` |
| `activeParticipantCount` | `status = Active`の参加者数。氏名・ParticipantIdは返さない |
| `createdAt` | `joinOrder = 1`の参加者の`joinedAt`から導出する。平文の技術Timestamp（`group_aggregate_record.created_at`）を業務値として返さない |
| `joinedAt` | 一覧の対象になった自分のParticipantの参加時刻 |
| `deleteEligibleAt` | Archivedのときだけ値がある |

- 時刻はRFC 3339 UTC（ミリ秒）。
- 並びは`createdAt`の新しい順、同時刻は`groupId`の昇順。
- 最大50件。51件目があれば`hasMore = true`。続きの取得（cursor）は本Epicでは提供しない。後から`after`引数と`endCursor`を追加しても既存Clientを壊さない。
- 空の一覧は`items: []`、`hasMore: false`でErrorにしない。
- Error: `AUTHENTICATION_REQUIRED`、`REQUEST_REJECTED`、`SERVICE_UNAVAILABLE`。非在籍のGroupは含まれないだけで、`NOT_FOUND`は使わない。

### 3. 一覧の対象

いまGroupを参照できるActorだけに出す。対象は既存の`group_actor_access_index`と同じ集合とする。

- Archived以外: 自分がActive ParticipantのGroup。
- Archived: ownerAtArchiveが自分のGroupだけ。Archive後の履歴参照とCSVの権限がこのParticipantにだけあるため、入口を残す。
- Leftの旧Participantは対象にしない。再参加した場合は新しいActive Participantで判定し、`myRole`と`joinedAt`も新しいParticipantで決める。
- 保持期限を過ぎて物理削除されたGroupは出ない。

Actor単位の索引（#306）も同じ集合を、既存索引と同じ契機（作成、受諾、Leave、Archive、Retention削除、Restore）で保守する。

### 4. Read時の固定版照合とSecurity audit

1 Transaction（#304の認証leaseの内側）で次の順に処理する。

1. 本人性（lease）
2. Actor単位の索引から、作成の新しい順に最大51件のGroupIdを得る
3. GroupId昇順に`group_aggregate_record ... FOR SHARE`で`aggregate_version`／`access_policy_version`を固定する
4. 必要最小限で復号する
5. §3の述語で再認可する
6. 要約を作り、版の不一致がないことを確かめてcommitする

- 索引のhitは認可の根拠にしない。再認可で否となったGroupは結果から除き、索引の不整合としてAlertする。Errorにはしない（存在非開示）。
- 索引のmissでは復号しない。
- Lockの順はCommandの`FOR UPDATE`と同じGroupId昇順とする。
- Lock timeout、Deadlock、接続断、復号失敗、版の不一致は一覧全体を`SERVICE_UNAVAILABLE`とし、一部だけは返さない。
- ADR #55 §5のSecurity auditはGroup一覧に書かない。§5は関与判定を伴うSnapshot Payloadの開示を対象とし、Group一覧は本人が現在参加しているGroupの状態だけを本人へ返す。Requestごとの認証Auditは認証leaseが書く。Group一覧・概要の読取をAudit対象にするかは、Production Security Gate（Settlement接続、Snapshot読取の公開時）で再評価する。

### 5. 画面のRoute

- `/groups`を一覧とし、同じ画面に「Groupを作成」ボタンを置く。作成専用のRouteは作らない。
- `/groups`はServer Componentで`myGroups`を取得する。未ログインなら`/login`へredirectし、戻り先URLは渡さない。空状態と`hasMore`の表示を持つ。
- 作成はClient Componentで、押下時に`operationId`を生成して同一Originの`/graphql`へ送る。送信中は無効化し、結果不明では同じ`operationId`で再試行を出す。成功後は一覧を取り直す。
- `/`と`/login`（ログイン済み表示）から`/groups`へのLinkを置く。一覧の各行はLinkにせず、`/groups/[groupId]`はGroup概要用に予約するだけとする。

## Alternatives

| 論点 | 案 | 採らない理由 |
| --- | --- | --- |
| 1 | Serverが`operationId`を生成する | 応答喪失後の再送で別Groupができ、同じoperationIdでの照合ができない |
| 1 | `Idempotency-Key` HTTP Headerで受ける | GMの冪等性はCommand入力の`operationId`で、1 Requestに複数Operationがある場合の対応が曖昧になる。#304の共通境界の責務が広がる |
| 1 | 結果にGroup要約を含める | Mutationが読取モデルとAccess Policy照合へ依存し、再送で現在状態を返すと最小結果の原則に反する。後から互換的に追加できる |
| 1 | `operationId`を任意の文字列にする | 衝突や推測しやすい値と、再利用による`OPERATION_MISMATCH`の事故が増える |
| 2 | 初めからcursor pagination | 索引で安定順序と改ざん防止が必要になり、#306と#310が重くなる。本Epicの利用量では不要で、後から互換的に追加できる |
| 2 | 上限なしで全件 | 所属数に上限がなくRate limitもないため、1 Requestの復号数と応答が際限なく増える |
| 2 | `createdAt`を返さず`joinedAt`順 | Group自体の識別には作成時刻のほうが安定している。`joinedAt`は項目として返す |
| 2 | `groupId`だけ返す | Group名がないので一覧で区別できない |
| 2 | `lifecycle`を3値にする | Cancelingを区別して表示できない |
| 3 | Archivedを除く | Archive時の索引除外とbackfillが別に要り、owner-at-archiveの入口を失う |
| 3 | Leftも含める | 退出後の変化を元参加者へ見せ、残った参加者のPrivacyに影響する。現行Access PolicyはLeftにGroup単位の閲覧を許していない |
| 3 | Archivedを全元参加者に出す | Archive後の参照はowner-at-archiveだけとする#73・#55に反する |
| 4 | 索引hitだけで返す | 索引保守のBugがそのまま漏えいになる。ADR #55 §4の多層防御を失う |
| 4 | Lockせず REPEATABLE READで読む | 既存`GroupAccessPolicyPort`と異なる読取経路が増える。性能上の必要が出たときの選択肢として残す |
| 4 | Groupごとに§5のAuditを書く | Audit基盤が本Epicの範囲外で、Audit保存失敗で一覧全体が使えなくなる |
| 4 | 再認可で否があれば一覧全体をError | 本人と無関係なGroupの不整合で一覧が使えなくなる。除外してAlertすれば足りる |
| 5 | `/groups/new`を作成専用画面にする | 入力項目がなく、遷移が増えるだけ |
| 5 | `/`をログイン後の一覧にする | 認証状態で同じURLの中身が変わり、cacheと検証が複雑になる |
| 5 | 作成後に`/groups/[groupId]`へ遷移 | Group概要は本EpicのOut of scope |

## Consequences

- Group Management Applicationは一覧のQuery Use Caseと読取Port・通知Portを持つ（#308）。PostgreSQLの実装は#310、索引は#306・#309が担う。
- GraphQLは§1・§2のSDLと、`operationId`の形式検査、`GROUP_ALREADY_EXISTS`の`SERVICE_UNAVAILABLE`へのmaskを実装する（#312）。
- 画面inventoryの「作成は独立screen」は「`/groups`の一覧画面の中の操作」に変わる（#315で更新）。
- 申し送り: 既存索引はLeft Participantを含まないが、ADR #55 §4はLeft ParticipantにSnapshotの一部の読取を許す。Settlementの読取を接続するまでに整理が要る。本ADRの一覧には影響しない。

残Risk:

- 結果不明のまま再読込すると、Groupが重複して作られることがある（`operationId`をClientのmemoryにだけ持つため）。一覧で確認できるので許容する。
- Actorあたりの作成数に上限がなく、Rate limitもない。一覧は50件で打ち切るが、作成の乱用はProduction Gateで扱う。
- 51件目以降は本Epicでは見られない。
- Group一覧の読取はGM Security auditを残さない（認証Auditだけ）。

## Rollback / Review Trigger

次のときに再評価する。

- Group名等の表示属性を追加するとき
- cursor paginationを追加するとき
- Settlement接続とSnapshot読取を公開するとき（Security auditの対象範囲）
- Archive・Closeを公開するとき
- Production Security Gate

本ADRの範囲はGroup ManagementとWebの追加に閉じるため、Rollbackは公開Operationと画面を外すことで行える。既存のCommand・保存形式は変更しない。
