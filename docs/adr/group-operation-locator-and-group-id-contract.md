# Group operation locatorとGroup IDの保存契約

- Status: Accepted
- Accepted: 2026-09-22
- Decision Owner: Project Owner
- Decision record: [GitHub ADR Issue #85](https://github.com/takeshi-arihori/kakei_app/issues/85)
- Amends: [Snapshot Revisionの保護と保持境界](snapshot-revision-security-and-retention.md#6-operation-locator)（operation locatorの鍵境界とrotation）、[Group Commandの本人性・認可・競合と再試行](group-management-command-authorization.md)（Actor内operation IDの保存表現）
- Related implementation: [GitHub Task #86](https://github.com/takeshi-arihori/kakei_app/issues/86)、[GitHub Task #42](https://github.com/takeshi-arihori/kakei_app/issues/42)

## Context

`findOperation(actorSubject, operationId)`はActor内で全Groupに共通のoperation IDを検索する。CreateGroupでは検索時にGroup IDがまだ存在しないため、Group keyまたはGroup IDを入力に要求するlocatorでは同一要求の再送を照合できない。

また、Group IDはPostgreSQLの`uuid`とprotected recordのcanonical AADで同じ識別子として使うが、Domainの既存形式は任意の非空文字列だった。このままでは保存Adapterが入力形式により失敗し、Domain／Applicationと保存境界の契約が一致しない。

## Decision

### Context-scoped operation locator

- Group Management専用の`GroupOperationLocatorKeyPort`を置く。これはGroup data key、Membership index key、Audit keyと別Purposeであり、他用途へ再利用しない。
- locatorはActor subjectとoperation IDをVersion付きCanonical TLVでEncodeして作る単一digestとする。Actor単独digestや入力平文は保存しない。
- `findOperation`はcurrent keyとretired locator keyごとの候補digestを検索する。全候補がmissならGroup data keyのreadとoperation結果のdecryptを行わない。
- hitした行のrandom `groupId` FKだけを使ってGroup keyを選択し、暗号化済みoperation結果とfingerprintを照合する。同じActorかつ同じ入力だけをreplayし、異なる入力はMismatch、別ActorはMissingとする。
- `group_operation_locator`は`locator_digest`と`digest_key_version`を一意にし、random `groupId` FKとoperation result FKを持つ。Group Management Dataの削除時はlocatorと結果を同じcascadeで削除する。

### Rotationと並行性

- 新規書込みはcurrent locator keyだけで行う。retired locator keyはread-onlyであり、locator inputは意図的に保存しないためre-hashしない。
- command transactionはlocator key-state recordを`FOR SHARE`で固定し、rotationは同じrecordを`FOR UPDATE`で固定する。これにより切替とcommitは交差せず、同じoperationの旧／新key二重行を作らない。
- 同じkey versionでの並行insertは一意制約で一方だけを成功させ、敗者はwinnerを再照合してreplayまたはMismatchへ収束する。
- retired locator keyは、それを参照するlive locatorが0件であり、そのlocatorを含み得るBackupの35日restore windowも終了した後だけ破棄できる。破棄前に別Purposeへ再利用しない。

### v1からのForward-fix

v1の`actor_digest`／`operation_digest`は一方向で、actor subjectとoperation IDを安全に復元または再key化できない。v2 migrationはlegacy locatorが0件であることを最初に検査する。1件でもあればSchemaまたはDataを部分変更せずfail-closedとし、保存保持・移行を扱う別のOwner Decisionを要求する。Down migrationまたはData削除で解消しない。

### Group ID

- `GroupId`はlowercase canonical UUID形式だけを許可する。uppercase、波括弧付き、短縮形、任意文字列を正規化して受け入れない。
- 既存の`nextGroupId`依存は信頼境界の生成口として維持し、production実装は`crypto.randomUUID()`によるUUIDv4を返す。
- 非canonical Group IDはRepositoryへ到達する前に拒否する。Participant ID、Invitation ID、保存用logical record IDの形式はこのDecisionの対象外とする。

## Alternatives

| Option | Decision | Reason |
| --- | --- | --- |
| `findOperation`へGroup IDを追加する | Rejected | CreateGroup再送時にGroup IDがなく、Actor内全Group共通namespaceも失う |
| operation IDからGroup IDを決定的に作る | Rejected | Group同一性と冪等性を不必要に結合する |
| Group IDを任意文字列のまま保存用変換を加える | Rejected | AADとDBの同一ID境界、失敗時の扱い、migrationを複雑化する |
| Context-scoped locator keyとcanonical Group ID | Accepted | Accepted済みの再送契約を保ち、保存・暗号化境界と一致させられる |

## Consequences and implementation boundary

Task #86がApplication locator contract、fake、Group ID validation、架空UUID fixtureを更新する。Task #42はその完了後にPostgreSQL v2 Schema、locator key-state lock、Repository Adapter、2接続競合・故障・再送Integration Testを扱う。

Key Provider、Key material、Audit Store、GraphQL、Production Composition Root、既存Data削除はこのDecisionと#86の対象外である。#42のv1 legacy row検査が失敗した場合は、作業を中断して別Decisionへ戻る。

## Rollback and review trigger

Repository ADR同期PRが未統合の間は、このDecisionを取り下げられる。統合後の変更は本ADRを直接書き換えず、新しいADRで互換性・Forward-fixを定める。

Actor内operation ID namespace、locator key rotation、backup保持期間、Group IDの生成方式、operation結果の保持・削除、またはlocatorの一意性／transaction境界が変わる場合に再審査する。
