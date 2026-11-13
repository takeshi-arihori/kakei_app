import { createHash } from 'node:crypto';

import type {
  AuthenticationConsistencyBinding,
  AuthenticationConsistencyEvidence,
  AuthenticationConsistencyEvidenceHandle,
  AuthenticationConsistencyEvidencePort,
  AuthenticationRestoreEvidenceDigest,
} from '../../application/authentication/authentication-consistency-evidence.js';
import { AuthenticationCryptoUnavailable } from '../../application/authentication/authentication-record-protection.js';
import {
  authenticationObject,
  authenticationUuid,
} from './canonical-authentication.js';

const fail = (): never => {
  throw new AuthenticationCryptoUnavailable();
};
const encoder = new TextEncoder();
const tag = encoder.encode('restore-evidence/v1');
const contextName = /^[a-z][a-z0-9-]{0,62}$/;

const digest32 = (value: unknown): Uint8Array =>
  value instanceof Uint8Array && value.length === 32
    ? Uint8Array.from(value)
    : fail();
const uint16 = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff)
    return fail();
  return Uint8Array.of(value >> 8, value & 0xff);
};
const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
};
/** 空でない、重複のないContext名をUTF-8 byte順の昇順へ並べたCopy。 */
const contextsCopy = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 0xffff)
    return fail();
  const names = [...(value as unknown[])].map((name) =>
    typeof name === 'string' && contextName.test(name) ? name : fail(),
  );
  if (new Set(names).size !== names.length) return fail();
  return Object.freeze(
    names.sort((left, right) =>
      compareBytes(encoder.encode(left), encoder.encode(right)),
    ),
  );
};
const uuidBytes = (value: unknown): Uint8Array =>
  Uint8Array.from(
    Buffer.from(authenticationUuid(value).replaceAll('-', ''), 'hex'),
  );
const evidenceCopy = (value: unknown): AuthenticationConsistencyEvidence => {
  const r = authenticationObject(value, [
    'recoveryPointId',
    'contexts',
    'consistencyDigest',
  ]);
  return Object.freeze({
    recoveryPointId: authenticationUuid(r.recoveryPointId),
    contexts: contextsCopy(r.contexts),
    consistencyDigest: digest32(r.consistencyDigest),
  });
};
const bindingCopy = (value: unknown): AuthenticationConsistencyBinding => {
  const r = authenticationObject(value, ['runId', 'recoveryPointId', 'head']);
  const head = authenticationObject(r.head, ['sequence', 'hash']);
  if (
    typeof head.sequence !== 'number' ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 0 ||
    typeof head.hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(head.hash) ||
    (head.sequence === 0 && head.hash !== '0'.repeat(64))
  )
    return fail();
  return Object.freeze({
    runId: authenticationUuid(r.runId),
    recoveryPointId: authenticationUuid(r.recoveryPointId),
    head: Object.freeze({ sequence: head.sequence, hash: head.hash }),
  });
};
const sameBinding = (
  left: AuthenticationConsistencyBinding,
  right: AuthenticationConsistencyBinding,
) =>
  left.runId === right.runId &&
  left.recoveryPointId === right.recoveryPointId &&
  left.head.sequence === right.head.sequence &&
  left.head.hash === right.head.hash;

/**
 * ADR #278 論点3の`evidenceDigest`を固定順序・長さ前置書式で計算する。
 * @returns tag、fingerprint、コード参加、整合証跡を覆うSHA-256のPort実装。
 */
export const createAuthenticationRestoreEvidenceDigest =
  (): AuthenticationRestoreEvidenceDigest => ({
    digest(input) {
      const parts: Uint8Array[] = [
        uint16(tag.length),
        tag,
        digest32(input.fingerprint),
      ];
      parts.push(
        input.codeClosure === null
          ? Uint8Array.of(0)
          : Uint8Array.of(1, ...digest32(input.codeClosure)),
      );
      if (input.consistency === null) {
        parts.push(Uint8Array.of(0));
      } else {
        const evidence = evidenceCopy(input.consistency);
        parts.push(
          Uint8Array.of(1),
          evidence.consistencyDigest,
          uuidBytes(evidence.recoveryPointId),
          uint16(evidence.contexts.length),
        );
        for (const name of evidence.contexts) {
          const bytes = encoder.encode(name);
          parts.push(uint16(bytes.length), bytes);
        }
      }
      const hash = createHash('sha256');
      for (const part of parts) hash.update(part);
      return Uint8Array.from(hash.digest());
    },
  });

/** Compositionが他Contextの検証を橋渡しするSource。鍵や本文を渡さない。 */
export interface AuthenticationConsistencyEvidenceSource {
  /**
   * 復旧点とLedger headについて、全Contextの検証結果をcatalogから取得する。
   * @param binding run、復旧点、検証済みhead。
   * @returns 復旧点に一致したcatalog entryの検証結果。0件と複数件は拒否される。
   */
  verify(
    binding: AuthenticationConsistencyBinding,
  ): Promise<readonly AuthenticationConsistencyEvidence[]>;
}

/**
 * 整合証跡のhandleを発行・単回消費するregistry。registryの再作成で旧handleは失効する。
 * @param options 他Contextの検証を橋渡しするSource。
 * @returns 認証側consumer Portの実装。
 */
export const createAuthenticationConsistencyEvidenceRegistry = (
  options: Readonly<{ source: AuthenticationConsistencyEvidenceSource }>,
): AuthenticationConsistencyEvidencePort => {
  const issued = new WeakMap<
    AuthenticationConsistencyEvidenceHandle,
    Readonly<{
      binding: AuthenticationConsistencyBinding;
      evidence: AuthenticationConsistencyEvidence;
    }>
  >();
  return {
    async verify(input) {
      const binding = bindingCopy(input);
      let candidates: unknown;
      try {
        candidates = await options.source.verify(binding);
      } catch {
        return fail();
      }
      if (!Array.isArray(candidates) || candidates.length !== 1) return fail();
      const evidence = evidenceCopy(candidates[0]);
      if (evidence.recoveryPointId !== binding.recoveryPointId) return fail();
      const handle = Object.freeze(
        {},
      ) as AuthenticationConsistencyEvidenceHandle;
      issued.set(handle, Object.freeze({ binding, evidence }));
      return handle;
    },
    consume(handle, input) {
      const entry = issued.get(handle) ?? fail();
      // 不一致でも消費する。取り違えたhandleを別bindingで再利用させない。
      issued.delete(handle);
      if (!sameBinding(entry.binding, bindingCopy(input))) return fail();
      return Object.freeze({
        recoveryPointId: entry.evidence.recoveryPointId,
        contexts: entry.evidence.contexts,
        consistencyDigest: Uint8Array.from(entry.evidence.consistencyDigest),
      });
    },
  };
};
