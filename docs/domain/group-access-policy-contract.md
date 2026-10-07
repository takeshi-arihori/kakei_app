# Group Access Policyの契約

## 対象と根拠

| 項目 | 内容 | 根拠 | 知識の状態 |
| --- | --- | --- | --- |
| Requirement | Group Managementが公開Access Policy Portと用途別Indexを所有する。 | GitHub Issue #76 | Confirmed |
| Actor | Settlement ApplicationがGroup Managementの公開Portを通じてSnapshotを読む。 | ADR #55 §4 | Confirmed |
| Trigger | Snapshot読取、参照権限へ影響する変更、operation再送結果の検索。 | Issue #76 | Confirmed |
| Success | 固定Policy Versionの下で所定の参照権限Matrixだけを許可し、一致する再送には保存済み結果を返す。 | ADR #55 §4, §6; ADR #73 | Confirmed |

## 契約

| ID | 種別 | 条件・保証 | 根拠 |
| --- | --- | --- | --- |
| PRE-001 | Precondition | 読取はCallbackの前にActor Access Digestを使う。 | ADR #55 §4 |
| PRE-002 | Precondition | 変更は固定Group／Policy Versionを渡し、Group IDの決定的な昇順で処理する。 | ADR #55 §4 |
| PRE-003 | Precondition | Actor内全Group共通のoperation検索はGroup IDを要求せず、actorSubject＋operationIdのcurrent／retired locator候補を使う。新規保存はcurrent key候補のみを使う。 | ADR #85; #86 |
| POST-001 | Postcondition | 参照権限へ影響する変更の成功時は`accessPolicyVersion`を進める。 | ADR #55 §4; ADR #73 |
| INV-001 | Invariant | Active Ownerは全件を読める。Active Participantは、そのParticipant ID自身が関係するRecordだけを読める。 | ADR #55 §4 |
| INV-002 | Invariant | Left Participantは必要承認者または支払のpayer／payeeとして関係するRecordだけを読める。再参加Actorの各IDは別々に評価する。 | ADR #55 §4 |
| INV-003 | Invariant | Archive履歴を読めるのは`ownerAtArchiveParticipantId`だけ。Closingは既存の読取Matrixを維持し、新しい業務・参照権限変更を拒否する。 | ADR #55 §4; ADR #73 |
| INV-004 | Invariant | Actor内全Group共通のlocatorはactorSubject＋operationIdのContext専用keyとVersion付きCanonical TLVを使う。Group-bound command fingerprintとはPurposeを分離し、locator missはdata-key read／decryptを行わない。 | ADR #85; #86 |
| INV-005 | Invariant | PortはPayloadを返す前に、Callbackが宣言したSnapshotへの関与を再検証する。 | ADR #55 §4 |
| FAIL-001 | Failure | Actor Indexに一致しない場合、Callback・復号を実行せず、汎用`Unavailable`を返す。 | ADR #55 §4 |
| FAIL-002 | Failure | Timeout、Deadlock、接続喪失、Callback例外、返却時のVersion不一致ではPayloadを破棄し、Rollbackして汎用`Unavailable`を返す。 | ADR #55 §4 |
| FAIL-003 | Failure | 検出したoperationはFingerprintが完全一致する場合だけ再送結果を返す。不一致はAlert対象とする。 | ADR #55 §6 |
| FAIL-004 | Failure | 非canonicalなGroup IDはDomain生成境界で拒否し、Repositoryへ到達しない。 | ADR #85; #86 |

## 責務境界とTrace

`GroupAccessPolicyPort`はGroup Management ApplicationのPortであり、SQLや`pg`の型を公開しません。#86はContext locator keyとGroup IDのApplication／Domain契約を実装する。#97はPostgreSQL adapterがGroup ID昇順に`FOR UPDATE`し、callbackを純粋計算として実行した後、既存state writerへ不変commit requestを同一transactionで渡す。Snapshot readはactor access index missを先に判定し、Group policy rowを`FOR SHARE`で固定してcallback結果を再認可する。Schemaは#42、暗号化済みGroup読取は#94、状態／履歴／索引writerは#95、operation result／locatorとの公開commitは#96が担う。Security-audit `requestId`とaudit fingerprintはProduction Security Gateの対象外のままである。

| Scenario | 種別 | 契約 |
| --- | --- | --- |
| Owner、Active、Left、再参加、非Member、Archive Ownerの権限MatrixとCallback結果の再検証 | 正常・境界・拒否 | INV-001–003, INV-005, FAIL-001 |
| Closing中の読取と新規業務・参照権限変更 | 境界・拒否 | INV-003, POST-001 |
| Context locator purpose、current／retired candidate lookup、Canonical TLV separation、全候補miss時のdata-key read／decrypt 0 | 正常・拒否・再試行 | PRE-003, INV-004 |
| canonical lowercase Group IDと信頼済みUUIDv4生成口 | 境界・拒否 | FAIL-004 |
| Version不一致、Callback例外、Timeout／Deadlock／接続喪失 | 競合・失敗 | FAIL-002 |
| 同じ入力と変更された入力によるoperation再送 | 再試行・拒否 | FAIL-003 |

ADR #85のDecisionはAcceptedで、#86がApplication／Domainのlocator入力・候補PortとGroup ID形式を同期する。実際のKey Provider、retired key保持、locator durable lookupは#42／#96とProduction Gateに従う。Group固定policyの並行transactionとrollbackは#97のscopeであり、本番Composition RootへのwiringはProduction Gateを満たすまで行わない。
