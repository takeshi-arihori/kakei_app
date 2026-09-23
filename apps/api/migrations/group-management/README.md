# Group Management migrations

`0001_group_management_storage.sql` is the source of truth for the initial PostgreSQL 17 storage shape accepted by ADR #55. Apply files in numeric order through `applySqlMigrations`; the runner records an exact SHA-256 checksum in `app_schema_migrations`, skips an identical re-run, and rejects a changed file at an already applied version.

`0002_group_locator_v2.sql` adds the ADR #85 locator shape and the ADR #73 protected Group close-history shape. The migration takes an `ACCESS EXCLUSIVE` lock on the v1 locator table before checking its row count. Any v1 row raises an error and rolls back the entire migration transaction; it must be resolved by a separate Owner Decision. When the count is zero, the migration leaves the v1 table in place and adds `group_operation_locator_v2`, `group_operation_locator_key_state`, and `group_close_history_record`. No v1 row, table, or column is deleted. A later Contract migration may remove the unused v1 table only after a separate compatibility review.

The key-state singleton starts with a null current key version. Command writers must fail closed until an approved key provider initializes it. The row is the shared lock target for command `FOR SHARE` and rotation `FOR UPDATE`; the migration neither creates nor stores key material.

## Data boundary

The schema stores only random record identifiers, CAS and access-policy versions, envelope metadata, ciphertext, 96-bit nonce, 128-bit authentication tag, technical timestamps, purpose-separated digests and request fingerprints. Participant identity, actor subject, owner identity, invitation payload and operation result remain inside the encrypted record. Key material, token plaintext and decrypted payload are never columns or fixtures.

The v2 locator stores one digest of canonical Actor subject plus operation ID, its key version, a command fingerprint digest, random Group ID and protected operation-result FK. It does not store the Actor or operation input. The Group close-history table uses the same protected envelope columns as other immutable histories; Task #95 supplies its append-only writer.

## Read adapter and protected payload

Task #94's `PostgresGroupReadRepository` implements the read-only `GroupRepository.load(groupId)` and `findOperation(actorSubject, operationId)` surface. It derives current and retired locator candidates through the Group Management locator key port, queries the v2 locator before touching a Group data key, and reads only the FK-linked protected operation result on a hit. Missing candidates or rows return `Missing` without key-read or decrypt; malformed metadata, authentication failure, key loss, invalid payload, and DB failure all become the same generic read failure. The separate candidate-based `GroupOperationReplayPort` is not implemented by this adapter.

Protected Group and operation-result payloads use versioned JSON inside the AES-256-GCM envelope. The read adapter reconstructs canonical AAD from the row's record ID, random Group ID, record kind, schema/key/aggregate versions, validates the protected payload against the row, and rehydrates the Domain Group rather than exposing a PostgreSQL row as a Domain type. The codec, canonical AAD encoder and locator key port are injected; this Task does not introduce a production key provider or wire the adapter into the API. Task #95 owns state writes; Task #96 owns public atomic commit and locator/result writes.

## Rollback and forward-fix

`0001_group_management_storage.down.sql` is allowed only for an empty development or test schema. It fails when a Group row exists. Once business data has been applied, do not run destructive Down or Drop operations; add a new numbered Expand migration, deploy compatible readers and writers, then use a later Contract migration or forward-fix after the old shape is no longer referenced.

The migration does not select credentials, connection pools, timeouts or production deployment settings. After the #42 Task split, Repository `load`/`findOperation` belong to #94, state/history CAS to #95, locator/result commit and key-state lock to #96, and fixed access-policy locks to #97. `pnpm --filter @kakei/api test:e2e` exercises the migration against PostgreSQL; CI runs the same command with an ephemeral PostgreSQL 17 service. Production migration runs only after an operator confirms the v1 row-count preflight, compatible readers/writers and a forward-fix path.
