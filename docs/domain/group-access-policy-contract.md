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
| POST-001 | Postcondition | A successful access-affecting mutation advances `accessPolicyVersion`. | ADR #55 §4; ADR #73 |
| INV-001 | Invariant | An Active Owner reads all; an Active Participant reads only records involving that exact Participant ID. | ADR #55 §4 |
| INV-002 | Invariant | A Left Participant reads only required-approver or payment payer/payee responsibilities; a rejoined actor's IDs are evaluated separately. | ADR #55 §4 |
| INV-003 | Invariant | Only `ownerAtArchiveParticipantId` reads archived history. Closing preserves the existing read matrix and rejects new business/access mutations. | ADR #55 §4; ADR #73 |
| INV-004 | Invariant | Locator and command fingerprint use their distinct purpose strings and versioned Canonical TLV bytes. | Issue #76; ADR #55 §6 |
| INV-005 | Invariant | The port rechecks the callback-declared Snapshot involvement before releasing a payload. | ADR #55 §4 |
| FAIL-001 | Failure | Actor-index miss invokes no callback/decrypt and returns generic `Unavailable`. | ADR #55 §4 |
| FAIL-002 | Failure | Timeout, deadlock, connection loss, callback exception, or return-time version mismatch discards the payload, rolls back, and returns generic `Unavailable`. | ADR #55 §4 |
| FAIL-003 | Failure | A found operation replays only with an exact fingerprint; a different fingerprint is an alerting mismatch. | ADR #55 §6 |

## Boundary and traceability

`GroupAccessPolicyPort` is a Group Management Application port. It publishes neither SQL nor `pg` types. The PostgreSQL `FOR SHARE` / `FOR UPDATE` implementation, durable replay data, and two-connection integration checks remain #42. Security-audit `requestId` and audit fingerprints are outside #76's Production Security Gate.

| Scenario | Type | Contracts |
| --- | --- | --- |
| Owner, active, left, rejoined, nonmember, archive-owner matrix and callback recheck | Normal / boundary / rejection | INV-001–003, INV-005, FAIL-001 |
| Closing read versus new/access mutation | Boundary / rejection | INV-003, POST-001 |
| Index-purpose and Canonical TLV separation | Normal / rejection | INV-004 |
| Version mismatch, callback exception, timeout/deadlock/connection loss | Concurrency / failure | FAIL-002 |
| Exact and changed-payload operation replay | Retry / rejection | FAIL-003 |

No open question was introduced: these contracts instantiate accepted ADR #55 and ADR #73 only.
