# Group Access Policy contract

## Context

| Item | Value | Evidence | Knowledge State |
| --- | --- | --- | --- |
| Requirement | Group Management owns a public access-policy port and purpose-separated indexes. | GitHub Issue #76 | Confirmed |
| Actor | Settlement Application reads a Snapshot through the Group Management public port. | ADR #55 §4 | Confirmed |
| Trigger | Snapshot read, access-affecting mutation, or operation replay lookup. | Issue #76 | Confirmed |
| Success | A fixed policy version permits only the specified access matrix; a matching replay returns its stored result. | ADR #55 §4, §6; ADR #73 | Confirmed |

## Contract

| ID | Kind | Condition / guarantee | Evidence |
| --- | --- | --- | --- |
| PRE-001 | Precondition | A read uses the actor access digest before its callback. | ADR #55 §4 |
| PRE-002 | Precondition | A mutation supplies fixed Group／policy versions in deterministic ascending Group ID order. | ADR #55 §4 |
| PRE-003 | Precondition | Actor内全Group共通のoperation検索はGroup IDを要求せず、actorSubject＋operationIdのcurrent／retired locator候補を使う。新規保存はcurrent key候補のみを使う。 | ADR #85; #86 |
| POST-001 | Postcondition | A successful access-affecting mutation advances `accessPolicyVersion`. | ADR #55 §4; ADR #73 |
| INV-001 | Invariant | An Active Owner reads all; an Active Participant reads only records involving that exact Participant ID. | ADR #55 §4 |
| INV-002 | Invariant | A Left Participant reads only required-approver or payment payer/payee responsibilities; a rejoined actor's IDs are evaluated separately. | ADR #55 §4 |
| INV-003 | Invariant | Only `ownerAtArchiveParticipantId` reads archived history. Closing preserves the existing read matrix and rejects new business/access mutations. | ADR #55 §4; ADR #73 |
| INV-004 | Invariant | Actor内全Group共通のlocatorはactorSubject＋operationIdのContext専用keyとVersion付きCanonical TLVを使う。Group-bound command fingerprintとはPurposeを分離し、locator missはdata-key read／decryptを行わない。 | ADR #85; #86 |
| INV-005 | Invariant | The port rechecks the callback-declared Snapshot involvement before releasing a payload. | ADR #55 §4 |
| FAIL-001 | Failure | Actor-index miss invokes no callback/decrypt and returns generic `Unavailable`. | ADR #55 §4 |
| FAIL-002 | Failure | Timeout, deadlock, connection loss, callback exception, or return-time version mismatch discards the payload, rolls back, and returns generic `Unavailable`. | ADR #55 §4 |
| FAIL-003 | Failure | A found operation replays only with an exact fingerprint; a different fingerprint is an alerting mismatch. | ADR #55 §6 |
| FAIL-004 | Failure | 非canonicalなGroup IDはDomain生成境界で拒否し、Repositoryへ到達しない。 | ADR #85; #86 |

## Boundary and traceability

`GroupAccessPolicyPort` is a Group Management Application port. It publishes neither SQL nor `pg` types. #86はContext locator keyとGroup IDのApplication／Domain契約を実装し、#42がPostgreSQL `FOR SHARE` / `FOR UPDATE`、durable replay data、二接続Integrationを実装する。Security-audit `requestId`とaudit fingerprintはProduction Security Gateの対象外のままである。

| Scenario | Type | Contracts |
| --- | --- | --- |
| Owner, active, left, rejoined, nonmember, archive-owner matrix and callback recheck | Normal / boundary / rejection | INV-001–003, INV-005, FAIL-001 |
| Closing read versus new/access mutation | Boundary / rejection | INV-003, POST-001 |
| Context locator purpose、current／retired candidate lookup、Canonical TLV separation、全候補miss時のdata-key read／decrypt 0 | Normal / rejection / retry | PRE-003, INV-004 |
| canonical lowercase Group IDと信頼済みUUIDv4生成口 | Boundary / rejection | FAIL-004 |
| Version mismatch, callback exception, timeout/deadlock/connection loss | Concurrency / failure | FAIL-002 |
| Exact and changed-payload operation replay | Retry / rejection | FAIL-003 |

ADR #85のDecisionはAcceptedで、#86がApplication／Domainのlocator入力・候補PortとGroup ID形式を同期する。実際のKey Provider、retired key保持、並行transaction、永続lookupは#42とProduction Gateに従う。
