import { createHash, createHmac, randomUUID } from 'node:crypto';

import type {
  AuthenticationAttestationVerifier,
  AuthenticationBackupManifest,
  AuthenticationDeletionRecord,
  AuthenticationHeadAttestation,
  AuthenticationLedgerEvidence,
  AuthenticationLedgerHead,
  AuthenticationLedgerMacKeys,
  AuthenticationLedgerProvider,
  AuthenticationRecoveryRecord,
  AuthenticationVerifiedHead,
  AuthenticationVerifiedIntent,
} from '../../application/authentication/authentication-maintenance-ports.js';
import { AuthenticationCryptoUnavailable } from '../../application/authentication/authentication-record-protection.js';
import {
  authenticationKeyVersion,
  authenticationObject,
  authenticationUuid,
  encodeAuthenticationTlv,
} from './canonical-authentication.js';
import { authenticationBytesEqual } from './authentication-digests.js';

const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};
const integer = (value: unknown, minimum = 0): number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= minimum &&
  !Object.is(value, -0)
    ? value
    : fail();
const bytes = (value: unknown): Uint8Array =>
  value instanceof Uint8Array && value.length === 32
    ? Uint8Array.from(value)
    : fail();
const hash = (value: unknown): string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : fail();
const reference = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
    ? value
    : fail();
const headCopy = (value: unknown): AuthenticationLedgerHead => {
  const r = authenticationObject(value, ['sequence', 'hash']);
  const result = { sequence: integer(r.sequence), hash: hash(r.hash) };
  if (result.sequence === 0 && result.hash !== '0'.repeat(64)) return fail();
  return Object.freeze(result);
};
const sameHead = (
  left: AuthenticationLedgerHead,
  right: AuthenticationLedgerHead,
) => left.sequence === right.sequence && left.hash === right.hash;

const recordCopy = (
  input: unknown,
): AuthenticationDeletionRecord | AuthenticationRecoveryRecord => {
  if (typeof input !== 'object' || input === null) return fail();
  const kind: unknown = Object.getOwnPropertyDescriptor(input, 'kind')?.value;
  if (kind === 'actor-deletion') {
    const r = authenticationObject(input, [
      'kind',
      'operationId',
      'actorDigestKeyVersion',
      'actorDigest',
      'preparedAt',
      'version',
      'state',
      'targetReference',
    ]);
    if (r.state !== 'prepared' && r.state !== 'complete') return fail();
    return Object.freeze({
      kind,
      operationId: authenticationUuid(r.operationId),
      actorDigestKeyVersion: authenticationKeyVersion(r.actorDigestKeyVersion),
      actorDigest: bytes(r.actorDigest),
      preparedAt: integer(r.preparedAt),
      version: integer(r.version, 1),
      state: r.state,
      targetReference: reference(r.targetReference),
    });
  }
  if (kind !== 'recovery') return fail();
  const r = authenticationObject(input, [
    'kind',
    'operationId',
    'epoch',
    'completedAt',
    'evidenceDigest',
  ]);
  return Object.freeze({
    kind,
    operationId: authenticationUuid(r.operationId),
    epoch: authenticationUuid(r.epoch),
    completedAt: integer(r.completedAt),
    evidenceDigest: bytes(r.evidenceDigest),
  });
};

const entryBody = (
  sequence: number,
  previousHash: string,
  record: AuthenticationDeletionRecord | AuthenticationRecoveryRecord,
  keyVersion: string,
): Uint8Array =>
  encodeAuthenticationTlv([
    'kakei_app',
    'auth-deletion-ledger/v1',
    'authentication/v1',
    String(sequence),
    previousHash,
    record.kind,
    record.operationId,
    keyVersion,
    ...(record.kind === 'actor-deletion'
      ? [
          record.actorDigestKeyVersion,
          record.actorDigest,
          String(record.preparedAt),
          String(record.version),
          record.state,
          record.targetReference,
        ]
      : [record.epoch, String(record.completedAt), record.evidenceDigest]),
  ]);
const entryHash = (body: Uint8Array, mac: Uint8Array): string =>
  createHash('sha256')
    .update(encodeAuthenticationTlv(['auth-checkpoint/v1', body, mac]))
    .digest('hex');
const sameDeletion = (
  a: AuthenticationDeletionRecord,
  b: AuthenticationDeletionRecord,
) =>
  a.operationId === b.operationId &&
  a.actorDigestKeyVersion === b.actorDigestKeyVersion &&
  authenticationBytesEqual(a.actorDigest, b.actorDigest) &&
  a.preparedAt === b.preparedAt &&
  a.targetReference === b.targetReference;
const transition = (
  records: Map<string, AuthenticationDeletionRecord>,
  record: AuthenticationDeletionRecord | AuthenticationRecoveryRecord,
): void => {
  if (record.kind === 'recovery') return;
  const previous = records.get(record.operationId);
  if (previous === undefined) {
    if (record.state !== 'prepared' || record.version !== 1) return fail();
  } else if (
    !sameDeletion(previous, record) ||
    previous.state !== 'prepared' ||
    record.state !== 'complete' ||
    record.version !== previous.version + 1
  )
    return fail();
  records.set(record.operationId, record);
};

const proofCopy = (
  value: unknown,
  challenge: string,
): AuthenticationHeadAttestation => {
  const r = authenticationObject(value, [
    'namespace',
    'source',
    'challenge',
    'head',
    'attestation',
  ]);
  if (
    r.namespace !== 'authentication/v1' ||
    (r.source !== 'checkpoint' && r.source !== 'witness') ||
    r.challenge !== challenge ||
    !(r.attestation instanceof Uint8Array) ||
    r.attestation.length === 0 ||
    r.attestation.length > 16384
  )
    return fail();
  return {
    namespace: r.namespace,
    source: r.source,
    challenge,
    head: headCopy(r.head),
    attestation: Uint8Array.from(r.attestation),
  };
};

/**
 * 専用HMACと完全chain、独立latest証跡を検証し、所有registryに能力を登録する。
 * @param options 認証専用の外部Store、署名検証、独立MAC鍵と現行書込世代。
 * @returns GroupのLedgerを参照せず、偽造handleを拒否する証跡境界。
 * @throws AuthenticationCryptoUnavailable 現行MAC世代表記が不正な場合。
 */
export const createAuthenticationLedgerEvidence = (
  options: Readonly<{
    /** linearizable latest／conditional appendを持つ認証専用外部Store。 */
    provider: AuthenticationLedgerProvider;
    /** Provider固有の署名とFailure domainの検証能力。 */
    attestations: AuthenticationAttestationVerifier;
    /** Audit/DEK/削除照合と独立したMAC鍵。 */
    keys: AuthenticationLedgerMacKeys;
    /** 新規appendにだけ使う現行MAC世代。 */
    writeKeyVersion: string;
  }>,
): AuthenticationLedgerEvidence => {
  const writeVersion = authenticationKeyVersion(options.writeKeyVersion);
  const heads = new WeakMap<
    AuthenticationVerifiedHead,
    {
      head: AuthenticationLedgerHead;
      records: Map<string, AuthenticationDeletionRecord>;
      entryHashes: Map<number, string>;
    }
  >();
  const intents = new WeakMap<
    AuthenticationVerifiedIntent,
    AuthenticationDeletionRecord
  >();
  const ownedHead = (value: AuthenticationVerifiedHead) =>
    heads.get(value) ?? fail();
  const mac = async (
    body: Uint8Array,
    keyVersion: string,
    operation: 'verify' | 'append',
  ) => {
    const key = await options.keys.read(keyVersion);
    if (
      key.purpose !== 'auth-deletion-ledger/v1' ||
      key.keyVersion !== keyVersion ||
      (key.lifecycle !== 'current' && key.lifecycle !== 'read-only') ||
      (operation === 'append' && key.lifecycle !== 'current')
    )
      return fail();
    const material = bytes(key.material);
    try {
      return createHmac('sha256', material).update(body).digest();
    } finally {
      material.fill(0);
    }
  };
  const latest = async (
    manifest?: AuthenticationBackupManifest,
  ): Promise<AuthenticationVerifiedHead> => {
    const challenge = randomUUID();
    const proofs = await options.provider.latest(challenge);
    if (!Array.isArray(proofs) || proofs.length !== 2) return fail();
    // Providerの返却配列やByte列をawait中に再評価しない。
    const copies = proofs.map((proof) => proofCopy(proof, challenge));
    if (new Set(copies.map((proof) => proof.source)).size !== 2) return fail();
    const expected = copies[0].head;
    if (!sameHead(expected, copies[1].head)) return fail();
    for (const proof of copies) {
      if (!(await options.attestations.verifyHead(proof))) return fail();
    }
    let backupHead: AuthenticationLedgerHead | undefined;
    if (manifest !== undefined) {
      const m = authenticationObject(manifest, [
        'createdAt',
        'schemaVersion',
        'keyStateVersion',
        'epoch',
        'checkpoint',
      ]);
      integer(m.createdAt);
      if (m.schemaVersion !== 6) return fail();
      integer(m.keyStateVersion, 1);
      authenticationUuid(m.epoch);
      backupHead = headCopy(m.checkpoint);
      if (backupHead.sequence > expected.sequence) return fail();
    }
    let current: AuthenticationLedgerHead = {
      sequence: 0,
      hash: '0'.repeat(64),
    };
    let manifestFound =
      backupHead === undefined || sameHead(backupHead, current);
    const records = new Map<string, AuthenticationDeletionRecord>();
    const entryHashes = new Map<number, string>();
    while (current.sequence < expected.sequence) {
      const page = await options.provider.page(current.sequence, expected);
      if (!Array.isArray(page) || page.length === 0 || page.length > 128)
        return fail();
      const entries = page.map((value) => {
        const r = authenticationObject(value, [
          'sequence',
          'previousHash',
          'record',
          'macKeyVersion',
          'mac',
          'hash',
        ]);
        return {
          sequence: integer(r.sequence, 1),
          previousHash: hash(r.previousHash),
          record: recordCopy(r.record),
          macKeyVersion: authenticationKeyVersion(r.macKeyVersion),
          mac: bytes(r.mac),
          hash: hash(r.hash),
        };
      });
      for (const entry of entries) {
        if (
          entry.sequence !== current.sequence + 1 ||
          entry.sequence > expected.sequence ||
          entry.previousHash !== current.hash
        )
          return fail();
        const body = entryBody(
          entry.sequence,
          entry.previousHash,
          entry.record,
          entry.macKeyVersion,
        );
        if (
          !authenticationBytesEqual(
            entry.mac,
            await mac(body, entry.macKeyVersion, 'verify'),
          ) ||
          entry.hash !== entryHash(body, entry.mac)
        )
          return fail();
        transition(records, entry.record);
        entryHashes.set(entry.sequence, entry.hash);
        current = { sequence: entry.sequence, hash: entry.hash };
        if (backupHead !== undefined && sameHead(current, backupHead))
          manifestFound = true;
      }
    }
    if (!sameHead(current, expected) || !manifestFound) return fail();
    // Page取得中の新削除・片側append・rollbackを古いheadで隠さない。
    const finishChallenge = randomUUID();
    const finish = await options.provider.latest(finishChallenge);
    if (!Array.isArray(finish) || finish.length !== 2) return fail();
    const finished = finish.map((proof) => proofCopy(proof, finishChallenge));
    if (new Set(finished.map((proof) => proof.source)).size !== 2)
      return fail();
    for (const proof of finished) {
      if (
        !sameHead(proof.head, expected) ||
        !(await options.attestations.verifyHead(proof))
      )
        return fail();
    }
    const handle = Object.freeze(
      Object.create(null),
    ) as AuthenticationVerifiedHead;
    heads.set(handle, {
      head: Object.freeze({ ...current }),
      records,
      entryHashes,
    });
    return handle;
  };
  const list = (
    head: AuthenticationVerifiedHead,
  ): readonly AuthenticationVerifiedIntent[] =>
    [...ownedHead(head).records.values()].map((record) => {
      const handle = Object.freeze(
        Object.create(null),
      ) as AuthenticationVerifiedIntent;
      intents.set(handle, record);
      return handle;
    });
  return {
    writeKeyVersion: writeVersion,
    latest,
    head: (head) => ({ ...ownedHead(head).head }),
    intents: list,
    intent: (head, operationId) => {
      authenticationUuid(operationId);
      return (
        list(head).find(
          (intent) => intents.get(intent)!.operationId === operationId,
        ) ?? null
      );
    },
    resolve: (intent) => {
      const record = intents.get(intent) ?? fail();
      const copy = recordCopy(record);
      return copy.kind === 'actor-deletion' ? copy : fail();
    },
    append: async (head, input) => {
      const owned = ownedHead(head);
      const record = recordCopy(input);
      const copy = new Map(owned.records);
      transition(copy, record);
      const sequence = integer(owned.head.sequence + 1, 1);
      const body = entryBody(sequence, owned.head.hash, record, writeVersion);
      const signature = await mac(body, writeVersion, 'append');
      const expectedHash = entryHash(body, signature);
      await options.provider.append(
        { ...owned.head },
        {
          sequence,
          previousHash: owned.head.hash,
          record,
          macKeyVersion: writeVersion,
          mac: signature,
          hash: expectedHash,
        },
      );
      const result = await latest();
      const newHead = ownedHead(result);
      if (newHead.entryHashes.get(sequence) !== expectedHash) return fail();
      if (record.kind === 'actor-deletion') {
        const saved = newHead.records.get(record.operationId) ?? fail();
        if (
          !sameDeletion(saved, record) ||
          saved.version !== record.version ||
          saved.state !== record.state
        )
          return fail();
      }
      return result;
    },
  };
};
