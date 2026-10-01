# 共有割り勘MVP Group Management 操作・画面境界

- Knowledge State: Groupの業務RuleとGroup Managementの責務境界は参照先のAccepted／Confirmedを転記したもの。画面境界の分類は本Taskの`Proposed`であり、Route、Navigation、Layout、公開API契約を決めない。
- Scope: Groupの作成、選択・概要、Membership／Owner、Invitation、Group終了、履歴・Retention表示。Expense Recording／Settlementの業務画面は対象外とし、Group Managementから見た連携上の状態だけを記す。
- Baseline: Issue [#144](https://github.com/takeshi-arihori/kakei_app/issues/144)、親Epic [#90](https://github.com/takeshi-arihori/kakei_app/issues/90)。

## 1. Knowledge Stateと境界

| State | この文書での意味 |
| --- | --- |
| `Confirmed` | `docs/product/current-model.md`およびAccepted ADRで決まっている業務Rule。UI表示の採用を意味しない。 |
| `Proposed` | 操作を利用者へ届けるための仮の画面境界分類。OwnerによるUX確認が必要で、確定したRoute／遷移ではない。 |
| `Open Question` | 正本に決定がなく、利用者確認または後続設計が必要な事項。 |
| `Gate` | 実装・外部公開の前提が不足しており、依存箇所を実装Readyにできない事項。 |

Group、Active Membership、Owner Role、Invitation、Close Intent、Archive情報のData OwnerはGroup Managementである。Group Managementは本人性の確立やExpense Recording／Settlementの業務データを所有しない。Frontendは表示と入力の境界であり、UI上の非表示を認可として扱わない。

## 2. Source of TruthとAccepted Decision

| Source | このInventoryで使う決定 |
| --- | --- |
| [共有割り勘の設計境界 ADR #24](../adr/shared-expense-domain-boundaries.md) | Group Management、Expense Recording、Settlementの3 Context、MVP Modular Monolith、State modelと必要な不変履歴、Command／Queryの分離。公開画面構成やGraphQL公開契約は決めない。 |
| [Group Management境界 ADR #35](../adr/group-management-consistency-boundary.md) | Group ManagementがGroup／Membership／Owner Roleを所有する。Group RootにActive Participantと唯一のOwnerを束ね、1〜4人のActive membershipを保つ。 |
| [認可 ADR #36](../adr/group-management-command-authorization.md) | 内部Commandでは信頼済みActorとGroup versionに基づいて認可する。非在籍者への外部応答は存在を漏らさない`UnavailableToActor`境界とする。本番本人性、認証Provider、公開Errorへの変換は未決。 |
| [Invitation／再参加 ADR #52](../adr/group-invitation-and-rejoin.md) | 7日期限、取消、枠非予約、受諾時の最新状態再検査、所有者移譲後のPending継続、新Participantによる再参加。本人性・宛先解決・Token・配送・公開ErrorはGate。 |
| [Snapshot保護・Retention ADR #55](../adr/snapshot-revision-security-and-retention.md) | 非在籍者へGroup／Snapshotの存在を開示しない。Active Owner、関与するActive Participant、過去責務のあるLeft Participant、再参加前後のParticipant IDを区別する。Archive後の読取主体・期限を保護する。 |
| [Group終了 ADR #73](../adr/group-close-consistency-and-retention-boundary.md) | OwnerがClose Intentを開始。Closing／Canceling、fence／Receipt、同じIntentでの再試行、取消競合、Archive、owner-at-archive、読み取り専用、1暦年のRetention境界。 |
| [現行業務モデル](current-model.md) | Group・Membership・CSV・Retentionの利用者向けConfirmed Ruleの統合正本。特にGroup Role／Invitation、Group終了、CSV Exportの各節。 |
| [未確定・未移行Gate](design-gates.md) | 本番本人性、配送、Context間認可、Persistence・Retention運用、Production wiringのGate。 |
| [API設計書](../api/README.md)／[GraphQL Operation Trace](../api/graphql-contracts.md) | 現行実装済み公開GraphQL Operationは疎通確認用Shared APIの`Query.apiStatus`だけ。Group Management等の業務Operationは未実装として扱う。 |
| [Frontend Rule](../engineering/frontend.md) | 表示・入力と認可／業務Ruleの責務境界、Server Stateと画面state、Loading／Error／Conflict、Accessibilityの確認軸。 |
| [Coding Rule](../engineering/coding-standards.md) | Domain Ruleの正本、認可・Group scope、Error境界、Context間依存方向。 |
| [Testing Rule](../engineering/testing.md) | 文書変更に対する構造・リンク・参照整合性の検証方針。 |

## 3. Group Management操作Inventory

「境界分類」は画面数や画面配置の決定ではない。既存画面内の状態として扱う場合も、後続UX設計で独立画面・Dialog等へ再分類できる。利用者から見た操作の所有者と、認可を最終判断する境界を併記する。

| Capability | Operation／State | 業務Rule／操作主体 | Data Owner／Authorization Source／境界 | Proposed境界分類 | Knowledge State／Gate／State・failure observation | Follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| Group Management | Group作成 | 本人がGroupを作り、作成者を最初のParticipantかつ唯一のOwnerとする。Active人数は1〜4人。 | Group Management。内部は信頼済みActor本人として作成する（#35／#36）。 | 独立screen（Proposed）。既存Groupを持たない利用者にも作成入力の入口が必要なため。入力項目・既定名・成功後の遷移は決めない。 | RuleはConfirmed。画面と本番本人性／MutationはGate。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のNavigation／screen review、およびAPI Gate後のGroup作成・選択slice。 |
| Group Management | Group選択 | 1人が複数Groupを作成・参加できる。選択対象のMembership／Actor単位のGroup一覧Queryは公開契約に存在しない。 | Group ManagementがMembershipを所有。非在籍者にはGroupの存在を漏らさない（#36／#55）。 | 独立screen（Proposed）。複数Groupから操作対象のscopeを選ぶ入口が必要なため。検索・並び順・選択後の遷移は決めない。 | 複数Group所属はConfirmed。検索・並び順・空状態・公開Read APIはOpen Question／Gate。 | §7のNavigation／screen review、およびGroup一覧Read contract。 |
| Group Management | Group概要 | Group名等の表示属性・概要項目は初回境界で必須化されていない。Active／Closing／Canceling／ArchivedのLifecycleは業務上区別される。 | Group ManagementのGroup state。参照時に認可済みGroup scopeが必要。 | 既存screen内state transition（Proposed）。選択中GroupのLifecycleを同じscopeで観測するため。概要項目、表示順は決めない。 | LifecycleはConfirmed。概要内容・公開Read APIはOpen Question／Gate。 | §7のNavigation／screen review、およびGroup一覧Read contract。 |
| Group Management | Active Participant／Membership表示 | 参加中人数は1〜4人。Ownerは1人。Leave後も過去Membershipを削除しない。再参加は新Participant IDで別履歴となる。 | Group ManagementがMembership／Owner Roleを所有。閲覧を許すActorと履歴範囲は#55のAccess Policyに従う。 | 既存screen内state transition（Proposed）。選択中Groupの概要と同じscopeで在籍・Roleを確認するため。全履歴・個人情報の表示範囲は未決。 | 件数・Role・履歴RuleはConfirmed。表示属性と履歴の範囲はOpen Question。 | §7のNavigation／screen review、およびMembership・Owner操作slice。 |
| Group Management | Invitation作成 | 現在OwnerがActive Groupで招待を作る。4人なら拒否。3人以下でもInvitationは人数枠を予約しない。 | Group Management。current Ownerを内部で再認可（#35／#36／#52）。 | dialog／補助flow（Proposed）。選択中Groupで招待先入力を伴う操作を行うため。招待先の入力UIは未定。 | RuleはConfirmed。宛先解決、本人性、配送、公開Mutation／ErrorはGate。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のInvitation lifecycle slice。 |
| Group Management | Invitation取消 | 現在OwnerはPending Invitationを取消できる。Owner移譲後も旧Ownerの招待はPendingのまま残り、現在Ownerが取消できる。 | Group Management。操作時点のcurrent Ownerで認可（#36／#52）。 | dialog／補助flow（Proposed）。対象のPending Invitationを指定して取消の影響を確認するため。確認文言は未決。 | RuleはConfirmed。取消理由・確認文言はOpen Question。公開契約はGate。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のInvitation lifecycle slice。 |
| Group Management | Invitation受諾 | 招待された本人が受諾する。Group Active、宛先一致、Pending、7日以内、空き枠、Active重複なしを最新状態で再検査し、新Participant等を原子的に成立させる。 | Group Management。信頼済み宛先Actorを内部で検証（#36／#52）。 | dialog／補助flow（Proposed）。招待された本人が対象Invitationを確認して参加を決めるため。受諾URLや画面Routeは決めない。 | 業務条件はConfirmed。本人性／公開接続／Token／配送／公開ErrorはGate。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のInvitation lifecycle slice。 |
| Group Management | Invitation期限切れ | 発行時刻から7日でExpired。延長せず、参加したければOwnerから再発行する。Expirationは自動状態変化であり、Invitationは枠を占有しない。 | Group Management。expiryAtはサーバー側の信頼値（#52）。 | 既存screen内state transition（Proposed）。表示中のInvitationがExpiredになったことを観測するため。利用者操作を必須としない。 | RuleはConfirmed。期限判定表示と期限処理の本番接続はGate。 | §7のInvitation lifecycle slice。 |
| Group Management | 受諾時の定員再検査 | Invitation作成後に定員が埋まった場合、受諾を拒否し部分更新しない。Inviteは枠を予約しない。 | Group Managementの現在Aggregate/versionが最終判断（#35／#52）。 | 既存screen内state transition（Proposed）。受諾中の定員拒否をその操作のfailure stateとして扱うため。 | RuleはConfirmed。公開Errorと再試行案内はOpen Question／Gate。 | §7のInvitation lifecycle slice。 |
| Group Management | 再参加 | Left Actorは新Invitationを受諾して再参加する。新Participant ID／より大きいjoinOrderを割り当て、過去責務を変えない。 | Group Managementが新旧Membershipを区別（#52）。過去のExpense／Settlement責務の可視性は各所有Contextと#55の関与Policyに従う。 | 既存screen内state transition（Proposed）。受諾後の新Membership成立を観測するため。旧履歴の併合をしない。 | RuleはConfirmed。新旧参加履歴の見せ方と本番認可はOpen Question／Gate。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のInvitation lifecycle sliceとMembership・Owner操作slice。 |
| Group Management | Owner移譲 | 現在Ownerが同GroupのActive ParticipantへOwnerを移譲する。旧OwnerはParticipantとして残る。自己譲渡はNo-op。 | Group Management。信頼済みActor、現在Owner、Group versionで認可（#35／#36）。 | dialog／補助flow（Proposed）。譲渡先とOwner権限を失う影響を確認してから操作するため。確認UIの詳細は未決。 | RuleはConfirmed。確認UIと公開Command／ErrorはGate。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のMembership・Owner操作slice。 |
| Group Management | Participant leave | Activeな非Owner本人だけがLeaveできる。Ownerは先に移譲またはGroup終了が必要。Leave後も過去Membership・Expense／Settlement責務は残り、他人を除名する機能はない。 | Group ManagementがMembership状態を変更（#35／#36）。過去支払責務はSettlementが判定。 | 既存screen内state transition（Proposed）。選択中Groupで本人MembershipがLeftになる結果を観測するため。移譲や未完了責務の案内は後続UX確認。 | RuleはConfirmed。明示的な阻止説明／確認内容はOpen Question。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のMembership・Owner操作slice。 |
| Group Management | Close Intent開始 | current Ownerの明示操作でActiveからClosingへ。未精算Expense・進行中Settlementがある場合は終了できない。各Contextのfence Receiptで終了可否を判定し、他ContextのTableを直接参照しない。 | Group ManagementがGroup lifecycleを所有。Expense Recording／Settlementは各自のfence／Receiptを所有（#24／#73）。 | dialog／補助flow（Proposed）。Group終了の影響を明示操作前に確認するため。未精算件数やContext結果の具体表示は決めない。 | RuleはConfirmed。公開Command、他Context wiring、Receipt表示／ErrorはGate。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のClose／Cancel status slice。 |
| Group Management | Closeの再試行 | 部分成功、timeout、応答喪失ではClosingと成功済みfenceを維持し、同じIntentで残りの処理・Receipt取得を再試行する。新規Intentを暗黙に作らない。 | Group Managementが同じcloseIntentIdを維持し、各Contextが自Contextのfence状態を所有（#73）。 | 既存screen内state transition（Proposed）。同じIntentの進行状況と再試行結果をClosingのまま観測するため。利用者操作／自動実行の選択は未決。 | 同一Intent再試行はConfirmed。利用者操作／自動実行の選択と公開状態はOpen Question／Gate。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のClose／Cancel status slice。 |
| Group Management | Close取消 | current Ownerが取消を開始する。最初のunfence前にClosing内でCancelingを予約。両Contextの同Intent un-fence Receiptが揃うまでActiveへ戻さない。Archiveが先なら取消を行わない。 | Group Managementが競合をCASで決め、Contextごとのunfence完了を検証（#73）。 | dialog／補助flow（Proposed）。対象Intentの取消を確認して開始するため。処理中のCanceling表示は§4の既存stateで観測する。 | RuleはConfirmed。取消可能状態の利用者向け説明／公開契約はOpen Question／Gate。 結果不明・競合時の回復は§5.1のConfirmed契約を参照。 | §7のClose／Cancel status slice。 |
| Group Management | Closing／Canceling read-only | Closing（Canceling含む）では開始前から許可された既存履歴だけ参照可能。Invitation、Membership、Owner移譲、Leave、Rejoin、新しいExpense／Settlement等の更新を拒否。取消開始はcurrent Ownerに限る。 | Group Managementのlifecycleと#55の固定Access Policy。表示隠しだけでなくServer側認可必須。 | 既存screen内state transition（Proposed）。従来の認可済み履歴のscopeを維持して操作不可を示すため。 | RuleはConfirmed。未完了Closeのstatus公開APIと失敗表現はGate。 | §7のClose／Cancel status slice。 |
| Group Management | Archived read-only | Archive後のOwner変更、Leave、Rejoin、Membership変更、新しい業務操作を拒否する。Groupは1年保持する。 | Group ManagementのArchived state。#73／#55のAccess Policy。 | 既存screen内state transition（Proposed）。Group終了後の概要・履歴を同じscopeで読み取り専用にするため。 | RuleはConfirmed。公開Read APIと失効後の表示はGate。 | §7のArchived history／CSV／Retention display slice。 |
| Group Management | owner-at-archive履歴 | Archive commit時点のcurrent Ownerを`ownerAtArchiveParticipantId`へ固定する。保持期限までのGroup履歴参照権はこのParticipantに限定し、再参加後のIDを同一視しない。 | Group ManagementのArchive履歴と#55のAccess Policyが最終認可する。 | 既存screen内state transition（Proposed）。固定Ownerの参照権限をArchived historyの権限状態として扱うため。Owner切替UIは設けない。 | RuleはConfirmed。本人性・公開認可はGate。 | §7のArchived history／CSV／Retention display slice。 |
| Group Management | Group CSV export | OwnerはGroup全体を8つのCSVを含むZIPとして要求時に生成・Downloadできる。脱退Membership、未精算Expense、Archive済みSettlement Snapshot等も対象。Archivedではowner-at-archiveのみ、`deleteEligibleAt`まで許可。 | Group ManagementがCSVのGroup範囲・操作権限を決定。各Data Ownerから適法に取得する境界が必要（#24／#55／#73）。 | dialog／補助flow（Proposed）。選択中GroupのExport要求からDownloadまでを扱うため。ファイル名・進捗UIは決めない。 | 出力範囲はConfirmed。公開Export契約・他Context接続・実装はGate。 | §7のArchived history／CSV／Retention display slice。 |
| Group Management | `deleteEligibleAt`表示 | Archived Groupの参照画面に保持期限を常時表示する。`archivedAt`のAsia/Tokyo同時刻から1暦年後、2月29日は翌年2月28日へclamp。期限の延長・取消・事前通知はない。 | Group ManagementがArchive時刻・期限を保持。 | 既存screen内state transition（Proposed）。Archived概要で保持期限を常時確認する必要があるため。配置・書式は決めない。 | 表示要件と計算RuleはConfirmed。期限値を返す公開Query／Batch運用はGate。 | §7のArchived history／CSV／Retention display sliceとRetention運用Gate。 |
| Group Management | 利用者による物理削除 | 個別の「Groupを今すぐ削除」操作は提供しない。期限後はRetention BatchがGroup業務Dataを削除する。期限前の延長・取消も許可しない。 | Group Managementと各ContextのRetained Data lifecycle（#55／#73）。削除は運用されたRetention境界。 | deferred／gated（利用者操作は非提供）。物理削除はRetention Batchの責務で、利用者による即時削除を提供しないため。期限説明は前行の表示に含める。 | 非提供はConfirmed。Retention Batch／Backup／運用Gateは継続。 | §7のArchived history／CSV／Retention display sliceとRetention運用Gate。 |

## 4. Group lifecycleと画面状態の対応

| 業務状態 | 利用者にとっての意味 | 確認済み操作制約 | 画面境界案 |
| --- | --- | --- | --- |
| `Active` | Group Management操作が可能な通常状態。 | 操作ごとにcurrent Owner／Active Participant本人性をServer側で検証。 | 作成、Membership、Invitationなどの入口を持ち得る。具体的Navigationは未決。 |
| `Closing` | Close Intentとfence確認が進行中。 | 既存の認可済み履歴参照のみ。業務Mutation不可。同じIntentで再試行。 | close statusを既存Group内に示す候補。status APIと再試行導線はGate／Open Question。 |
| `Canceling` | Ownerが取消権を予約し、各Contextのunfence完了待ち。 | Archiveは拒否。両Receiptが揃うまでActiveに戻さず、業務Mutation不可。 | Closingとは区別して取消処理中を示す候補。状態公開契約はGate。 |
| `Archived` | Groupは終了し、既存履歴を保持期限まで参照できる。 | owner-at-archiveのみ履歴参照／CSV。状態・Membership変更や新規業務Mutation不可。 | Read-only history。`deleteEligibleAt`は常時表示。 |
| Retention期限経過 | 次回の正常Retention Batch実行で物理削除対象となる。 | 利用者がGroupを物理削除・延長・取消する操作はない。具体的Batch時刻は未決。 | 保持期限表示後の利用者画面挙動は未決。期限切れを先行表示するかはOpen Question。 |

## 5. 認可・エラー・API Gate

- [API契約正本](../api/README.md)と[Operation Trace](../api/graphql-contracts.md)で確認できる実装済み公開GraphQL Operationは疎通確認用Shared APIの`Query.apiStatus`のみであり、業務Operationではない。Group ManagementのQuery／Mutationは未実装であり、この文書から追加・推定しない。
- #36の信頼済みActorSubjectは内部Application契約であり、利用者入力のrole、participant ID、subjectを信頼済み本人性へ昇格させない。本番Authentication Provider、Session、Token、本人とInvitation宛先の照合が未決のため、Group画面の実操作は公開接続Gateを持つ。
- #36／#55に従い、非在籍者や他Group IDの参照からGroupの存在が漏れない。公開応答の`UnavailableToActor`変換、NotFound／Forbiddenの扱い、認証切れ、Rate limit、公開Error codeは未決。UIが独自文言をConfirmed扱いしない。
- Current Owner／Active Participantの許可範囲はサーバー側の固定Group versionと保存条件で検証される。権限変更と競合した画面表示や操作は、Server結果を正本とし、Client側状態だけで成功を表示しない。
- Closing／Canceling／Archivedの読取・更新範囲は#55／#73のAccess Policyに従う。Left Participantと再参加後の旧／新Participantは独立して評価し、前の権限を新しいIDへ引き継がない。
- Group／Invitation／Membership／Archive／CSVいずれの公開APIも本Taskでは設計しない。公開契約、認証認可、Context間DataのRead boundaryが個別TaskのReady条件を満たすまでWireしない。

### 5.1. Commandの成功結果確認・再送（Confirmed）

[ADR #36のDecision](../adr/group-management-command-authorization.md#decision)に従う共通の認可・回復条件である。§3のCommandに適用し、公開Errorの文言や具体的な回復UIは後続設計へ分離する。

- 同一Actor・同一operationId・同一内容の成功済み再送だけ、記録済みの最小結果を返す。異なる内容はOperationMismatchとして拒否し、異なるActorには結果を返さない。
- Owner移譲やLeaveが成功した後に応答を失っても、同じActorは現在の操作権限を失ったことを理由に成功結果の確認を拒否されない。返すのは当該結果のID・versionだけで、現在Groupの参照権限を付与しない。
- 成功したか不明なUnavailable／応答喪失では、同じActor・同じoperationId・同じ内容で結果を照合する。結果不明のまま新しい操作として再送しない。
- 未記録／失敗後の操作は最新状態で再認可する。Conflict後に入力・期待版を変更する場合は新operationIdを使う。失敗結果は記録しない。[ADR #52](../adr/group-invitation-and-rejoin.md#decision)に従い、Invitation受諾のConflictは自動再試行しない。
- [ADR #73](../adr/group-close-consistency-and-retention-boundary.md#2-archive取消再試行)のClose／取消では、上記operationの照合に加えて同じcloseIntentIdを維持する。Intentとoperationの識別を混同せず、部分成功や取消処理中に新Intentへ切り替えない。

## 6. 日付・翻訳に関するOpen Question

- 業務期限はUTC内部TimestampとAsia/Tokyo暦日のルールに従うが、画面上の日時表示、利用者設定Timezone、相対時刻の表示形式はこのTaskでは決めない。
- `deleteEligibleAt`は業務上の必須表示だが、表示書式・説明文は後続UX決定に委ねる。
- Product／Repository docsに採用済みのi18n方針、対応言語、翻訳キー・fallback仕様を確認できない。日本語固定、英語対応、locale選択のいずれもAcceptedにしない。
- 用語（Owner、Participant、Invitation、Closing等）の最終利用者向け訳語、単複、日付・数値のlocale表現はOwner Decision待ち。

## 7. 後続Task候補と依存Gate

下記は分割候補であり、作成済みTaskや依存関係を表明するものではない。各候補はRequirement、Done Criteria、Accepted Decision、依存を確認してReady評価する。

| 候補 | 成果 | 先行Gate／依存 |
| --- | --- | --- |
| MVP Navigation／screen boundary review | Group選択、概要、Membership、Invitation、Archive表示の画面・主要JourneyをOwnerと確認する。 | 本InventoryのProposed分類を確認。Route／Layout案は別途Owner合意までProposed。 |
| Group Management公開Read contract | Group一覧／概要／Membership／Invitation／Lifecycle／保持期限の読み取り契約を設計・実装する。 | 本人性、存在秘匿、公開Error、Context Data boundary、schema compatibilityを確定。 |
| Group作成・選択screen slice | API Gate解消後、作成からGroup概要までをEnd-to-Endに届ける。 | 公開本人性とCreate／Read contract。 |
| Membership・Owner操作 slice | Participant表示、Owner移譲、本人Leaveを接続する。 | §5.1の成功結果再取得・競合／再送契約を入力とし、Group公開認可と画面上の確認・失敗文言を確定。 |
| Invitation lifecycle slice | 招待作成・取消・受諾・Expired・容量競合・再参加を届ける。 | ADR #52は業務LifecycleをAccepted済み。本番本人性、宛先解決、配送、Token、公開Errorが別Gate。 |
| Close／Cancel status slice | Close Intent、同一Intent再試行、取消、Closing／Cancelingの読取専用状態を届ける。 | Expense Recording／Settlementの実fence・Receipt wiring、公開状態Read／Mutation、再試行運用Gate。 |
| Archived history／CSV／Retention display slice | owner-at-archiveによる読取、CSV出力、期限表示を接続する。 | #55 Access Policy、本番本人性、各Contextの読取境界、CSV API、Retention/Backup運用Gate。 |
| Expense／Receipt／Category Inventory | Expense Recording Contextの確定済み利用者操作、actor、Data Owner、認可境界、Presentation候補を別Inventoryへ整理する。 | 対象ContextのRequirementとAccepted Ruleを確認し、未決のCategory／Receipt契約をGateとして扱う。本TaskではInventory化しない。 |
| Settlement／Payment Inventory | Settlement Contextの確定済み操作と履歴・Payment状態の表示境界を別Inventoryへ整理する。 | Settlement／PaymentのAccepted Rule、Data Owner、公開契約と未決Gateを先に確認する。本TaskではInventory化しない。 |
| 横断Navigation／主要Journey | Group、Expense／Receipt／Category、Settlement間のNavigationと主要利用Journeyを設計する。 | 各Contextの操作Inventoryを入力とし、Route／Navigation順序はOwner合意までProposedとする。 |
| UI state matrix／共通UI state | Context横断のLoading、Empty、Error、Conflict、Read-only等の表示・回復方針を整理する。 | §5.1のConfirmed回復条件、操作ごとのServer failure／認可／競合契約とFrontend責務を入力とし、Client stateを認可正本にしない。 |
| App shell | Accepted Navigation／主要Journeyに基づくWeb App shellを設計・実装する。 | 横断Navigationと認証後の利用者境界を確認。未決Route、本人性、公開API、共通UI契約を暗黙に確定しない。 |
| 契約Ready後のvertical slice | API／認証／Context間Data boundaryがReadyになった操作から、画面・公開契約・Backendを通す小さなvertical sliceを届ける。 | 各sliceを個別TaskとしてReady評価し、該当Context Inventory、Accepted Design、公開認可・Error・wiring Gateの解消を確認する。 |
| Frontend UX／i18n decision | 主要Journey、日付表示、i18nと用語を確定する。 | Owner確認とRepositoryのi18n正本更新。 |

## 8. Issue #144 Done Criteria trace

| Done Criteria | Evidence |
| --- | --- |
| Source of Truth／Accepted Decisionを特定 | §2。Product current model、design gates、ADR #24／#35／#36／#52／#55／#73、API docsへのリンク。 |
| Group create、select／overview、Membership／Ownerを含む | §3の先頭各行。未決のQueryや画面属性をGate／Open Questionに分離。 |
| Invitation作成・取消・受諾・期限・定員・再参加を含む | §3のInvitation関連行。期限7日、4人境界、枠非予約、新Participantを記載。 |
| Owner移譲・Participant leaveを含む | §3の該当行。current Owner／非Owner本人制約と過去責務を明記。 |
| Close開始・再試行・取消・Closing／Canceling／Archivedを含む | §3と§4。closeIntent同一再試行、fence／Receipt、読み取り専用状態を記載。 |
| owner-at-archive、履歴、CSV、保持期限、物理削除非提供を含む | §3。権限主体、8 CSV、`deleteEligibleAt`、利用者削除非提供を記載。 |
| Screen／Dialog／subflow／既存state／deferred-gated分類と理由 | §3の全21行を一意に分類し理由を記載。分類はProposedで、Route／Nav／Layoutは決定していない。 |
| Confirmed／Proposed／Open Question／Gateを混同しない | §1、§3、§6、§7。Accepted業務RuleとProposed UI分類を分離。 |
| 公開API、認可境界、frontend/data ownerを明記 | §2、§5。公開GraphQLはapiStatusのみ、内部ActorとGroup Management Data Ownerを記載。 |
| ADR #24／#35／#36／#52／#55／#73へのpermission／retention trace | §2／§3／§5に各Decisionと操作ごとのowner境界を記載。§5.1と該当Command行に権限喪失後の最小成功結果再取得、結果不明の照合、Conflict後の新operationIdをTrace。 |
| 日付・i18nの正本不在をOpen Question化 | §6。業務Retention算定と表示localization決定を区別。 |
| 後続Task候補を列挙 | §7。候補と先行Gateを記載。 |

## 9. 検証と残Risk

- Domain挙動を追加・変更しない文書Taskなので、先行する振る舞いTestは価値がない。`docs/engineering/testing.md`に従い、ローカル参照先、Inventory項目とDone Criteriaのtrace、Knowledge State／未決事項の分離を決定的に確認する。
- Issue #144のDone Criteriaに従い、Repository標準の`pnpm check`を実行する。これは文書変更だけでは不要とする一般的な例外を本Taskへ適用しないためであり、docs・repository-wide gateを含む標準検証を記録する。Production code、API schema、Route、Mermaid図は変更しない。
- 残Risk: Issue #144の画面分類はOwner UX確認前のProposedである。公開Group API、本人性、公開認可・Error、Context間のデータ取得、i18nが未決／Gateの間、操作screenをProductionへ接続できない。
