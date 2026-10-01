# 精算Caseの初回申請と全員承認

[Task #160](https://github.com/takeshi-arihori/kakei_app/issues/160)の純Domain契約。[現行モデル](../product/current-model.md)のSettlement Approval・RevisionとNo Payment Required、および[ADR #152](../adr/expense-settlement-consistency-boundary.md)のCase Root／不変Revisionを根拠とする。[ADR #24](../adr/shared-expense-domain-boundaries.md)のState model＋不変履歴、[ADR #52](../adr/group-invitation-and-rejoin.md)の過去Participant寿命を維持する。新しいProduct／Provider／保存Decisionを採用しない。

## 対象と責務

`SettlementCase`はCase ID、初回対象Expense ID集合、元申請者の安定Actor subjectとParticipant、不変な初回Revision、別に追記するApprovalを所有し、全員承認のInvariantを判断する。各成功操作は同じCase IDの新Rootを返し、元Root・Revision・記録済み判断を変更しない。Rootを保存・復元するRepositoryやApplicationはまだ追加しない。

Revisionは独立した可変Rootではなく、freezeした内部内容Record。初回ordinal=1、previousSnapshotId=null、Case／Snapshot ID、実申請者、UTC申請時刻、[算術Content](settlement-snapshot-content-contract.md)、識別済み指示候補を固定する。Caseの現在Revision状態は同じSnapshot IDの判断履歴から導出し、内容Recordを書き換えない。登録Actor、購入日、表示名など追加保存／画面factsの取得契約、全Revision履歴と再申請・取り下げは[Task162の契約](settlement-case-revision-contract.md)で追加する。このRecordを実Snapshot保存／公開DTOの完成と扱わない。

候補の額・相手・canonical順は既存[最少計算](settlement-calculation-contract.md)から再利用する。Callerが同順に渡す指示IDを固定し、全員承認時に同じID／金額／相手の指示全件を有効にする。個別Instruction／Attemptの状態更新・支払報告・受取確認・差し戻し・完了Archive・取消は別Task。現在は支払実行Portやアプリ内送金を提供しない。

## 契約とTest Trace

| ID | 条件・担当 | 観測するTest／Verification |
| --- | --- | --- |
| SCA-PRE1 | 後続Applicationが本人性、Actor→Group内過去Participantの束縛、初回Active、Source取得・配賦・未精算対象・同一判断点、Group fence、期待Expense版、ID発番、予約とCase更新のatomic commitを確認する | 未接続Gate。factory／expectedVersion Guardだけでは証明しない |
| SCA-INV1 | 安定Case ID・初回対象集合・元申請者とRevision内容を固定。入力DateをUTC文字列へcopy、候補IDとActor参照をcopy/freeze。元Rootと内容は成功／失敗どちらでも不変 | Identity／ordinal／null、UTC offset、入力Actor／Date／ID配列の後続mutation、nested出力mutation、旧Root／Revision保持 |
| SCA-INV2 | 必要承認者はContentの固定集合。申請者が含まれる場合だけ本人承認を申請時刻で記録。Ownerは代理承認できない | 不要申請者／Owner、非payer全0%、payer0%、正割合burden0／net0、旧IDと再参加新ID、6人historical union |
| SCA-POST1 | AwaitingApproval／currentRevision／expectedVersion／必要本人／未判断の場合だけApproveまたは理由必須Reject。1人却下でRejected、以前の承認と理由を保持し指示無効。全員Approve時だけApproved／PaymentActiveで固定指示全件有効 | 部分承認では指示空、複数指示と元候補のID／金額／相手／順序一致、却下履歴、元Root不変 |
| SCA-POST1（0円） | 全Balance0は同じ必要承認者全員の承認後、PaymentActiveを経由せずApproved／Archived。NoPaymentRequired、archivedAtは最終承認UTC。申請者だけが必要なら申請操作内で即Archive | 相殺0／額0／1人／申請者不要、他者承認待ち、却下可能、時刻コピー、指示空 |
| SCA-FAIL1 | 無効な内部入力・状態・版・Revision・本人・再判断・却下理由をtyped固定messageで拒否し、元Rootを変えない | 下記全コード、approve／reject終端拒否、古い版／別Revision、二重承認・判断反転、理由／invalidDate、記録済み判断保持 |

Contractの業務条件はcurrent-modelのConfirmed、Root ownershipはADR #152のAccepted。ID Brand・UTCコピー・freeze・安全整数版は内部実装制約。Technical形式を新たなProduct上限・公開Inputとして扱わない。Test正本は`apps/api/src/settlement/domain/settlement-case.spec.ts`。Framework／DB／他Context Domain型を使わず、architecture Testで依存方向も確認する。

## 拒否分類と内部表現

`SettlementCaseInvariantViolation`のmessageは常に固定文であり、入力参照／金額／理由を含めない。公開Error変換は別Presentation契約とする。

| Code | 条件 |
| --- | --- |
| SNAPSHOT_CONTENT_INVALID | 算術Content VOとして生成されていないplain object（内部型をClient DTOにしない） |
| CASE_ID_INVALID / SNAPSHOT_ID_INVALID / INSTRUCTION_ID_INVALID | lowercase canonical UUID以外の参照 |
| ACTOR_SUBJECT_EMPTY / PARTICIPANT_ID_EMPTY | 空／空白だけ／文字列以外の初回主体参照 |
| UTC_INSTANT_INVALID | valid Date以外の申請／判断時刻 |
| INSTRUCTION_COUNT_MISMATCH / INSTRUCTION_ID_DUPLICATED | 候補とIDの数が不一致、候補内ID重複 |
| CASE_NOT_AWAITING_APPROVAL | Rejected／PaymentActive／Archived／Withdrawnに対する追加判断 |
| CASE_VERSION_CONFLICT / SNAPSHOT_MISMATCH | 読取Case版が不一致または安全整数以外、現在Snapshot参照が不一致 |
| PARTICIPANT_NOT_REQUIRED / APPROVAL_ALREADY_RECORDED | 固定集合外の判断、同Participantの二重／反転判断 |
| REJECTION_REASON_EMPTY | 空／空白だけ／文字列以外の却下理由 |

UUIDは[ADR #55](../adr/snapshot-revision-security-and-retention.md)のcanonical参照へ整合させ種類別Brandで区別する。Random生成／グローバル新規性はこの文字列検査で証明しない。Actor subjectは認証Tokenではなく内部安定参照。Participantを脱退・再参加で置換せず、本人への束縛はApplicationが判断する。Domainへ生Clientのsubject／Participantを渡してはならない。

versionは初回1、成功判断ごと+1。同Participantは1回しか判断できないため、本初回Scopeの版数は固定必要承認者数に比例する。安全整数は技術表現であり業務上限を追加しない。expectedVersionはローカルGuardであり、2つのRootを同じ版から生成できても保存の先着を決定しない。DBのCASと原子的commitが不可欠となる。Domainでは同じ判断の再投入を拒否し、Applicationのoperationキー／成功結果再送と競合／再試行契約はInventory G1/G2の後続設計とする。

TimestampはCallerからvalid Dateを受け取りUTC ISOへコピーする。DomainはDate.now／乱数／I/Oを使わず、業務上の新しい時刻順制約は加えない。却下理由は非空だけを検証し、前後空白も元の記録として保持する。理由文字数やClient Date形式の公開制約をここで採用しない。

## 後続Gate・文書・Rollback

[Settlement Inventory](../product/mvp-web-settlement-payment-inventory.md)にある公開認可・具体Port／lock／冪等結果／予約保存・保護Record種別／Migration／Key／Audit／本番Auth・Read契約は未完了。Current OwnerやLeft Participantのアクセス範囲、Source facts取得と原子性、競合時部分反映なしはApplication／各Owner Adapterで実検証を要する。再申請／Withdrawの純Domain部分はTask162で追加する。Rejected元Expense訂正・実Application接続、Attempt／全受取完了Archiveの純DomainはTask164で追加し、取消の純Domainは[Task166](settlement-cancellation-contract.md)で追加する。本ScopeのRejected／PaymentActiveを全Lifecycleの終端と扱わない。再申請とWithdrawnの契約・全履歴保持は[追加契約](settlement-case-revision-contract.md)を参照する。

Domain plaintext値をDB／Log／Auditへ直接保存してはならない。ADR #55のContext別保護とRetentionを維持し、既存snapshot-revision kindへCase可変状態や別Recordを押し込まない。SourceOwner／購入日等の追加factsを含む保存契約は別途設計する。既存solverの指数探索とhistorical unionについて公開接続前の入力規模・CPU／timeout／制限方針を引き継ぐ。6人fixtureはProduct上限ではない。

新しい[初回承認図](../diagrams/settlement-initial-approval.mermaid.md)はConfirmedな初回遷移だけを可視化する。現行モデル／ADR本文／既存ContextmapのRule・境界、公開Schema／Migration／UI／Runbookは変更しない。データ移行なし、未接続CodeのrevertでRollbackできる。数値Coverage、実認可／保存／障害注入は純Domain Test成功から主張しない。

[Task164の支払Attempt契約](settlement-payment-attempt-contract.md)で本人全額報告・受取確認・理由付き差し戻し・全受取Archiveを追加する。初回内容と承認履歴は維持し、[Task166の全体取消契約](settlement-cancellation-contract.md)で全員同意を追加する。実認可・保存・公開は後続Gate。
