# Retention削除とGroup Management Receiptの順序

- Status: Accepted / Active（Owner Decision: 2026-09-26; see #115）
- Decision record: [GitHub ADR Issue #115](https://github.com/takeshi-arihori/kakei_app/issues/115)
- Decision Owner: Project Owner（takeshi-arihori）
- Amends: [ADR #55: Snapshot Revisionの保護と保持境界](snapshot-revision-security-and-retention.md)、[ADR #102: CloseIntentIdの保持期間と一意性境界](close-intent-id-retention-boundary.md)
- Related implementation: [Task #103](https://github.com/takeshi-arihori/kakei_app/issues/103)（Accepted ADR同期PR #117統合、Receipt record Task #118、verified deletion-evidence Task #119完了までBlocked）

Project Ownerは2026-09-26にこのDecisionをAcceptedとして記録した（[Issue #115](https://github.com/takeshi-arihori/kakei_app/issues/115)）。本ADRは削除Receiptの循環順序を解消するためADR #55と#102を一部改訂する。本Decisionは本番削除を認可せず、ADR #55の全Production Gateを維持する。

## Context

ADR #55はGroup Management（GM）、Expense Recording、Settlementの各Contextが自分のGroup所有DataとGroup data-encryption key versionsを削除し、削除後のcanonical receiptを発行することを要求する。Receiptは`dataAbsent=true`と`allContextKeyVersionsDestroyed=true`を証明する。ADR #102は全必須ContextのReceiptとkey-destruction確認をRetention Coordinatorが検証した後にだけGM削除を実行し、GMのCloseIntent registry退役とGroup削除を同一PostgreSQL transactionで行う。

このままでは、GM自身のpost-deletion receiptはGM削除後まで存在しない一方、GM削除はGM receiptを含む全Receiptの検証後まで開始できない。全Contextの削除証拠、post-deletion receiptの意味、ContextごとのData Ownershipを維持するため、以下の二段階順序を採用する。

## Accepted decision

1. **Preparedとfenceを先行commitする。** GMは、不可逆な鍵破棄より先に、削除Token、operation ID、intent version、必要な最小状態を持つdurable Prepared intentをcommitする。同じcommitがすべてのGM Group read、write、command経路をfenceする。Prepared中の通常操作は、内部状態を漏らさないgeneric unavailableでfail closedする。fence解除はGMのComplete記録のcommit後だけ許可する。
2. **他の二Contextを先に削除する。** Expense RecordingとSettlementは各自のContextでGroup所有business rowとそのContextのGroup data-encryption key versionsだけを削除する。各Contextは全対象rowの不在と対象key versionの不在を検証した後、ADR #55のcanonical receiptを発行する。Retention Coordinatorは各Context所有のreceipt verifierを通してReceiptを検証し、Prepared intentの削除Token、operation ID、intent versionへの一致を確認する。Contextのkeyやsecretを別Contextへ渡さない。
3. **GM data keyを破棄して検証する。** 二つの外部Context Receiptが検証された後、GMはGM所有Group data-encryption key versionsを破棄し、各対象versionが実際に不在であることを検証する。`AlreadyDestroyed`応答だけを証明として扱わない。Receipt verification key、Audit key、DeletedGroupToken keyは別namespaceであり、Group data-key破棄の対象に含めない。
4. **GM削除、registry退役、GM Receipt記録を同一transactionにする。** GMは単一の`deletedAt`を取得し、一つのGM PostgreSQL transactionで以下を行う。
   - CloseIntent registry rowを`group_id = NULL`へ退役し、`retain_until`を`deletedAt`からAsia/Tokyoの1暦年後に設定する。2月29日は2月28日へclampし、UTCで保存する。
   - GMが所有するGroup rootとGroup業務/domain rowを削除する。
   - 同じoperationを再開できる最小Prepared identityと、canonical GM receiptを再読込できるreceipt記録を保持する。
   - GM canonical post-deletion receipt recordを永続化する。

   registry退役、Group削除、receipt recordはtransaction commitで一緒に可視化する。したがって`ON DELETE RESTRICT`は原子的に満たされる。GM receiptはcommit成功後にだけCoordinatorへ返す。transaction rollback時はGroup rootとlive registry rowが残り、先にcommit済みのPrepared fenceは維持される。必要なkeyがすでに破棄済みでもPreparedの同一operationをfail closedで再試行し、別operationを開始しない。
5. **GM receiptの不在境界を限定する。** GMの`dataAbsent=true`は、GMが所有するGroup業務/domain rowおよびciphertextが存在しないことを意味する。削除再試行と完了に必要なRetention Control Ledgerの最小Prepared identity/state/receipt record/Complete Tombstone、およびopaque CloseIntent UUIDと期限Metadataだけを持つretired registry rowは、この条件から明示的に除外する。業務Dataまたはciphertextをこれらの制御記録へ複製してはならない。他Contextの`dataAbsent=true`もそれぞれのGroup所有domain rowとciphertextの不在を意味する。
6. **key確認の対象namespaceを明示する。** Receiptの`allContextKeyVersionsDestroyed=true`は、そのContextのGroup data-encryption key versionsのみを指す。Receipt MAC/verification key、Audit key、DeletedGroupToken keyは含めず、それらの別の保持・削除規則はADR #55に従う。Receipt verification keyは未完了Prepared intentの検証に必要な間保持し、該当する35日Backup windowが過ぎるまで利用可能にする。verifier keyをdata keyと共有しない。
7. **全Receipt後にCompleteへ進める。** Coordinatorは3 Contextすべてのcanonical receiptを検証する。続くGM Control Ledger transactionでPreparedのGroup identityとraw receiptを削除し、最小Complete Tombstoneを保存する。Complete commitまではfenceを維持する。Complete前の障害では同じoperation/intent versionだけを再開し、古い、異なる、または不一致の証拠はfail closedとする。
8. **GM receiptの再取得を冪等にする。** GM削除transaction commit後にresponseを失った、またはprocessが再起動した場合、Coordinatorは同じoperation IDとintent versionでGMにcommit済みReceiptを再読込する。削除済みGroup rowを再削除したり、新しいReceiptを発行したりしない。commit前に失敗した場合は通常のtransaction retryとして同一operationを再開する。

## Alternatives

| 案 | 判断 | 理由 |
| --- | --- | --- |
| GMを含む全Receiptが揃うまでGMを削除しない | 不採用 | GM post-deletion receiptをGM削除前に検証できず循環する |
| 必須ContextからGMを除外する | 不採用 | ADR #55の全Context削除証拠を弱める |
| 削除前にReceiptをauthorizationとして発行する | 不採用 | 削除後のrow不在とkey破棄を証明するReceiptの意味を弱める |
| 他ContextがGM root cascadeで削除される | 不採用 | Data Owner境界とContextごとの削除責務に反する |

## Consequences and gates

Prepared commitはすべてのGroup操作経路に適用されるfenceと原子的でなければならない。既存Group read/write/command adapterの一部でもfenceを迂回できる間は実装・本番有効化しない。GM receipt recordをPrepared中に安全に再取得できるControl Ledger契約と、receipt verification key保持能力が必要になる。GM data keyを先に破棄した後でGM transactionがrollbackする場合、Groupは復号不能のままfenced状態となるため、通常利用へ戻すrollbackは行わず同じintentをfail closedで完了または運用復旧する。

本ADRのAcceptedは、Retention Coordinator、Context所有deletion/verifier/key provider、Checkpoint/Witness、Backup/WAL/Restore、Alert/Runbook、production wiringの未完Production Gateを解除しない。これらすべてのADR #55 gateが満たされるまでProduction deletion trafficを無効のままにする。#103はGM自身のGroup row削除、CloseIntent registry退役・期限切れpurge、およびcanonical GM Receipt recordを同一削除transactionへ保存してcommit後に返す範囲を担当する。GM-owned Receipt Portとimmutable record contractはTask #118が定義し、GMが受け取るverified deletion-evidence input contract（ER／Settlementの検証済みReceipt outcomeと3 Contextのkey-destruction確認結果を同一Prepared intentへ束縛）はTask #119が定義する。#103は両境界を利用する。Coordinator実装、他Context削除、GM Receiptのcanonicalization／署名／verificationは#103に含めず、独立TaskとADR #55のProduction Gateに従う。#103はPR #117のdevelop統合および#118／#119完了までBlockedとする。

## Implementation and compatibility

このADRはADR文書だけを変更対象とし、ADR #55／#102のAccepted本文、runtime、Schema、Migration、key provider、Coordinator実装、Receipt実装、Runbook、本番wiringを変更しない。実装Issueを本Decisionへ同期する。schema/protocolが必要なら互換性、failure recovery、rollbackまたはforward-fix計画を含むTaskを準備する。本ADRは新しいReceipt fieldやContextを追加しない。

## Review trigger

GM read/write/commandのfence完全性、Prepared retry semantics、receiptのpost-deletion意味、対象key namespace、35日Backup window、CloseIntent保持規則、Context間Data Ownershipのどれかが変わる場合は再審査する。Owner Decisionは2026-09-26にAcceptedとしてIssue #115と本Repository記録へ反映した。理由は、全Contextのpost-deletion証拠を維持してGM Receiptの循環を解消するためである。ADR #55のProduction Gateは継続する。
