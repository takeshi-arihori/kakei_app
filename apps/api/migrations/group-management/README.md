# Group Management migrations

`0001_group_management_storage.sql` is the source of truth for the initial PostgreSQL 17 storage shape accepted by ADR #55. Apply files in numeric order through `applySqlMigrations`; the runner records an exact SHA-256 checksum in `app_schema_migrations`, skips an identical re-run, and rejects a changed file at an already applied version.

## Data boundary

The schema stores only random record identifiers, CAS and access-policy versions, envelope metadata, ciphertext, 96-bit nonce, 128-bit authentication tag, technical timestamps, purpose-separated digests and request fingerprints. Participant identity, actor subject, owner identity, invitation payload and operation result remain inside the encrypted record. Key material, token plaintext and decrypted payload are never columns or fixtures.

## Rollback and forward-fix

`0001_group_management_storage.down.sql` is allowed only for an empty development or test schema. It fails when a Group row exists. Once business data has been applied, do not run destructive Down or Drop operations; add a new numbered Expand migration, deploy compatible readers and writers, then use a later Contract migration or forward-fix after the old shape is no longer referenced.

The migration does not select credentials, connection pools, timeouts or production deployment settings. Repository `load`, `findOperation`, `commit`, row locking and two-connection CAS remain in Issue #42.
