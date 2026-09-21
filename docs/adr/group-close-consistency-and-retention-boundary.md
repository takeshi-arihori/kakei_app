# Group終了の整合性と保持期限境界

- Status: Accepted
- Accepted: 2026-09-21
- Decision Owner: Project Owner（takeshi-arihori）
- Decision record: [GitHub ADR Issue #73](https://github.com/takeshi-arihori/kakei_app/issues/73)
- Owner decision evidence: [Issue comment](https://github.com/takeshi-arihori/kakei_app/issues/73#issuecomment-5755615829)
- Security review evidence: [Author-separated formal review pass](https://github.com/takeshi-arihori/kakei_app/issues/73#issuecomment-5755728805)（`findings=[]`、`missingEvidence=[]`）
- Amends: [Group Managementの整合性境界](group-management-consistency-boundary.md)、[Snapshot Revisionの保護と保持境界](snapshot-revision-security-and-retention.md)
- Related implementation: [Task #75](https://github.com/takeshi-arihori/kakei_app/issues/75)

## Context

GroupをArchiveするには、Group Managementが所有するOwnerとlifecycleだけでなく、Expense Recordingが所有する未精算Group Expenseと、Settlementが所有する進行中Settlementの不在を同じ判断時点で確認する必要がある。Group Managementから他ContextのTableを直接参照すると、Context ownershipを破り、確認後の書込み競合で「終了可能」という証拠が古くなる。

また、`deleteEligibleAt`はAsia/Tokyo基準で`archivedAt`の1暦年後とする既存Ruleがあるが、2月29日の翌年に同日が存在しない場合の境界が未決だった。

## Decision

### 1. Close IntentとContext所有fence

案Aを採用する。現在のGroup Ownerだけが、期待Group versionを指定してClose Intentを開始できる。Group ManagementはGroupを`Active`から`Closing`へ遷移させ、変更不能な`closeIntentId`、`closeCutoff`、開始時のGroup version、開始者を履歴へ記録する。`closeIntentId`は全Groupで一意に発行し、以後のPort呼出しとReceiptでは対象`groupId`へ明示的に束縛する。

Expense RecordingとSettlementは、それぞれのData Ownerが公開するPortを通じ、同じ`closeIntentId`と`closeCutoff`に束縛したclose fenceを自Contextの書込み境界で原子的に設置する。

- fence commitより前にcommitしたCommandは終了可否判定へ含める。
- fence設置と競合する進行中Commandは、commitまたはrollbackが確定するまでReceiptを発行しない。
- fence commit後の新しい業務Commandは、同じContext内でfail-closedに拒否する。
- Group Managementは他ContextのTable、Lock、Transactionを直接扱わない。

各Contextはfence設置後に、自Contextの判定条件を満たす場合だけversion付きReceiptを返す。

| Data Owner | 公開Portの責務 | Receipt条件 |
| --- | --- | --- |
| Expense Recording | Expense close fenceの設置・解除、未精算状態の判定 | 同じIntent／cutoffのfenceが有効で、未精算Group Expenseが0件 |
| Settlement | Settlement close fenceの設置・解除、進行中状態の判定 | 同じIntent／cutoffのfenceが有効で、進行中Settlementが0件 |
| Group Management | Intent開始、Receipt検証、Archiveまたは取消のcommit | 両Receipt、Group version、current Owner、closeIntentIdが一致 |

Receiptは少なくとも`groupId`、`closeIntentId`、`contextName`、`closeCutoff`、`fenceVersion`、判定結果、`completedAt`を束縛する。Group Managementは全Fieldを現在のGroup／Intentと照合し、別Group、別Intent、別cutoff、別Context、古いfence versionを拒否する。具体的な署名、配送、永続化方式は後続Infrastructure Taskで決め、Task #75では型付きPortとfake contractで意味契約を検証する。

### 2. Archive、取消、再試行

両Contextの有効な「終了可能」Receiptが揃い、Group version、current Owner、closeIntentIdが一致する場合だけ、Group Managementは1回のcommitで`Closing`から`Archived`へ遷移する。成功時に次を不変履歴として固定する。

- `ownerAtArchiveParticipantId`: Archive commit時のcurrent Owner
- `archivedAt`: 信頼境界内ClockのUTC Timestamp
- `deleteEligibleAt`: 下記の暦年規則で一度だけ計算したUTC Timestamp
- 使用したIntent、Receipt version、Group version

同じIntentの再送は冪等に扱う。片Contextだけfence／Receiptが成功した場合、timeout、応答喪失ではIntentと成功済みfenceを維持し、同じIntentで再試行する。新しいIntentへ自動で切り替えず、証拠欠落時にArchiveしない。

Closingの取消を開始できるのはcurrent Ownerだけである。最初のunfenceを依頼する前に、Group Managementは期待Group versionとIntentへのcompare-and-swapでClosing内の`closePhase`を`Canceling`へ変更し、取消権を予約する。Archiveは`Canceling`を拒否するため、この予約後に既存の終了可能ReceiptでArchiveできない。Archiveが先にcommitした場合は取消予約がversion conflictとなり、unfenceを一度も呼ばない。

取消予約後にだけ両Contextへunfenceを依頼する。片Contextだけ解除した場合やtimeout／応答喪失では`Canceling`を維持し、同じIntentで残りの解除とReceipt取得を再試行する。両Contextから`groupId`と同じIntentに束縛したunfence Receiptが揃うまでGroupを`Active`へ戻さず、新しい業務Commandの拒否を継続する。古いversion、別Group、別Intent、Receipt欠落／不一致は状態、履歴、operation結果を変更せず拒否する。

### 3. Closing／Archivedの認可とPolicy version

`Closing`中は、`Canceling` phaseを含め、開始前から許可されていた既存履歴のread-only参照だけを従来のAccess Policyで許可する。新しいExpense、Settlement、Invitation、Membership、Owner譲渡、Leave、Rejoin、およびその他のaccess-affecting mutationを拒否する。取消予約はcurrent Ownerだけに許可する。

`Archived`ではOwner変更、Leave、Rejoin、Invitation、Membership変更、新しい業務Commandを拒否する。Archive時に固定したOwnerだけが、保持期限まで既存履歴の参照とGroup CSV出力を行える。

Closing開始、各fence Receiptの反映、取消予約、各unfence Receiptの反映、Archive commit、Activeへ戻す取消commitは`accessPolicyVersion`を増加させる。固定versionで開始したread callbackが古い権限のResponseを返さないよう、Task #76と#42でtransaction contractを検証する。

### 4. 1暦年後の保持期限

`deleteEligibleAt`は`archivedAt`をAsia/Tokyoへ変換し、同じ現地時刻の1暦年後を求めてからUTCへ戻す。翌年に同じ月日が存在しない2月29日は2月28日へclampする。3月1日へrollしない。

| `archivedAt` | Asia/Tokyoでの計算 | `deleteEligibleAt` |
| --- | --- | --- |
| `2025-03-15T01:30:00Z` | 2025-03-15 10:30 +09:00 → 2026-03-15 10:30 +09:00 | `2026-03-15T01:30:00Z` |
| `2024-02-29T03:00:00Z` | 2024-02-29 12:00 +09:00 → 2025-02-28 12:00 +09:00 | `2025-02-28T03:00:00Z` |
| `2026-02-28T15:30:00Z` | 2026-03-01 00:30 +09:00 → 2027-03-01 00:30 +09:00 | `2027-02-28T15:30:00Z` |
| `2027-02-27T15:30:00Z` | 2027-02-28 00:30 +09:00 → 2028-02-28 00:30 +09:00 | `2028-02-27T15:30:00Z` |

## Interleaving and failure contract

| Scenario | Required result |
| --- | --- |
| Commandがfenceより先にcommit | Receipt判定へ含める。未精算／進行中なら終了不可 |
| Commandがfence設置と競合 | commit／rollback確定までReceiptを発行しない |
| fence後の新規Command | 対象Contextで拒否し、業務状態を変えない |
| 片Contextだけ成功 | Closingと成功済みfenceを維持し、同じIntentで再試行 |
| timeout／応答喪失 | 同じIntentを再送し、既存Receiptを照合。二重fence／履歴を作らない |
| Archiveが取消予約より先にcommit | 取消予約はversion conflict。unfenceを呼ばずArchivedを維持 |
| 取消予約がArchiveより先にcommit | `Canceling`でArchiveを拒否してからunfenceを開始 |
| 取消中にunfenceが片方だけ成功 | `Canceling`を維持し、新規Commandを拒否したまま残りを同じIntentで再試行 |
| 取消予約／unfenceの応答喪失 | 同じoperation／Intentで結果を照合し、予約と解除を重複させない |
| Receipt／Group／Group version／Intent不一致 | fail-closed。状態・履歴・operation結果を変えない |

## Alternatives

| Option | Decision | Reason |
| --- | --- | --- |
| A: Close Intent＋Contextごとの原子的fence／version付きReceipt | Accepted | Context ownership、競合安全性、将来のProcess分離を同時に維持できる |
| B: Group Managementから他Context Tableを同一DB transactionで確認 | Rejected | Data OwnerとContext境界を破り、物理配置を固定する |
| C: 各Contextへ同期照会した後、Group Managementが単独でArchive | Rejected | 照会とArchive commitの間に新規書込みが成立し、同一判断時点を保証できない |
| 2月29日を翌年3月1日へroll | Rejected | 保持が1日延び、「1暦年後」の決定論的な境界が分かりにくい |

## Consequences

Closing、fence、Receipt、取消、再試行の状態と運用責務が増える。一方、他Contextの内部Tableを参照せず、書込み競合に対して終了可否を同じ判断点へ束縛できる。将来Contextを別Processへ分離しても公開Portの意味契約を維持できる。

Production wiringはExpense Recording／Settlementの実fence、Receipt永続化と保護、配送／Outbox、監視、回復Runbookが揃うまで禁止する。Task #75のfakeが実Contextの原子性を証明したとは扱わない。

## Implementation and activation

1. Task #75で`Closing`（`Canceling` phaseを含む）／`Archived`遷移、Owner認可、暦年計算、Context Port、Groupへ束縛したReceipt検証、Archive／取消予約／unfenceのDomain・Application・fake contract testを実装する。別Group Receipt拒否、Archive先勝ち、取消予約先勝ち、片Context解除、応答喪失を含める。
2. Task #76でClosingを含むAccess Policy、`accessPolicyVersion`、blind indexとtransaction contractを実装する。
3. Task #42でPostgreSQL RepositoryのCAS、状態・履歴・operation結果・索引の原子性を検証する。
4. Expense Recording／Settlementの実fence、実Outbox、監視、回復Runbookは各Data Ownerの後続Taskへ分離する。

Ownerは、Context ownershipと競合安全性の代わりにClosing／Receipt／取消／再試行の複雑性が増えるTrade-offを確認して案Aと2月29日clampをAcceptedした。Authorから分離した正式Security Reviewが`findings=[]`かつ`missingEvidence=[]`でpassし、Repository同期PRがdevelopへ統合された時点でTask #75のReady Gateを満たす。

## Rollback and review trigger

このDecisionを取り消す場合は新ADRでAmendまたはSupersedeし、進行中Close Intentと両Context fenceを安全に解除または移行する計画を必須とする。文書だけをrevertしてfenceを残さない。

Context配置、Transaction境界、Group lifecycle、未精算／進行中の定義、fence／Receiptの配送・保護、Archive取消、保持期限、Timezone規則が変わる場合に再審査する。fence前commit、設置中競合、fence後拒否、部分失敗、timeout再送、取消、Archive／取消競合を後続contract testとIntegration Testで再確認する。
