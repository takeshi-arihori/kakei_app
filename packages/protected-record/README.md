# Protected record foundation

This package implements the provider-independent protected-record boundary accepted by ADR #55. It owns canonical AAD encoding and validation, AES-256-GCM seal/open behavior, and the ports used to obtain context-scoped key material and unique nonces. It does not own business authorization, persistence, concrete KMS/provider selection, durable alerts, audit storage, or production wiring.

## Key and nonce contract

`ProtectedRecordKeyPort.allocateForSeal` must atomically allocate a unique 96-bit nonce and monotonically increasing seal count for one Group, Context, and key version. Callers cannot provide a nonce to the codec. A provider reports counter regression or key loss explicitly; the codec then requests rotation and returns only `ProtectedRecordUnavailable`.

The codec requests rotation at seal count `2^31` and rejects an allocation at or above `2^32`. `readKey` may return either the current or a retired key for the exact authenticated key version, enabling dual reads during rotation. Concrete providers remain responsible for atomicity, durable counter state, and key lifecycle.

Protected-record encryption keys and blind-index digests use separate branded types and separate ports. A digest purpose is versioned and cannot be reused across membership, actor-access, operation-locator, or fingerprint namespaces.

Group Management immutable history uses distinct AAD record kinds for membership, invitation, and Group-close changes. A Group-close history record remains bound to its random Group ID, logical record ID, and aggregate version; the close Intent, receipt, and actor fields remain encrypted.

## Failure and alert boundary

Malformed or noncanonical AAD, metadata mismatch, unavailable keys, invalid nonce/tag lengths, and authentication failure all return the same generic `ProtectedRecordUnavailable`. The optional alert callback receives only an operation and stable code; it never receives IDs, payload, ciphertext, nonce, tag, or key material. Durable alert delivery is a later production gate.
