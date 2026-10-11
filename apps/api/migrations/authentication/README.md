# Authentication Schema Migration

Authentication records are owned by the `authentication` PostgreSQL schema. Migration `0005_authentication_schema.sql` uses the API's existing numbered `app_schema_migrations` ledger; version 5 follows the four Group Management migrations already recorded in that shared ledger. A version is applied once and its source checksum is immutable. Future changes append a new version.

The schema contains only the A2 inventory: `actor`, `google_identity`, `identity_alias`, `login_attempt`, `session_record`, `audit_event`, `key_state`, and `deletion_intent`. Its foreign keys stay inside Authentication. It has no Group reference or cascading relationship to business data.

The migration seeds exactly one `key_state` row as `uninitialized`, with no epoch. The `key_generation` table starts empty and stores key-version/search/write metadata only; it never creates, stores, or derives key material. Writers remain unavailable until a separately approved provider initializes key state. All persisted times use nonnegative UTC Unix milliseconds within JavaScript's safe-integer range.

Constraints enforce opaque identifiers, versions, state/terminal-time consistency, five-minute login-attempt expiry, session idle/absolute boundaries, envelope and digest lengths, one Google identity per actor, one alias per identity and key generation, cookie digest uniqueness per key generation, and one successful completion audit per attempt pseudonym. The audit enums are fixed and do not permit direct identifiers, provider tokens, network addresses, or diagnostic text.

The down migration rejects any populated Authentication records or initialized key state before dropping objects. It removes only the Authentication schema and its version-5 entry from the migration ledger. It does not drop or cascade into Group Management. Once Authentication data is in use, keep the migration and use a forward fix.
