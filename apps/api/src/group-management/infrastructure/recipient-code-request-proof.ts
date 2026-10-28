import { createHmac, timingSafeEqual } from 'node:crypto';

import { RecipientCodeSecret } from '../../shared/application/authentication/recipient-code-input.js';
import {
  authenticationKeyVersion,
  authenticationObject,
  encodeAuthenticationTlv,
} from '../../shared/infrastructure/authentication/canonical-authentication.js';
import type {
  RecipientCodeRequestProof,
  RecipientCodeRequestProofKey,
  RecipientCodeRequestProofKeyPort,
  RecipientCodeRequestProofPort,
} from '../application/recipient-code-request-proof.js';
import { RecipientCodeRequestProofUnavailable } from '../application/recipient-code-request-proof.js';

const purpose = 'gm-recipient-code-request/v1';
const fail = (): never => {
  throw new RecipientCodeRequestProofUnavailable();
};
const copy32 = (v: unknown): Uint8Array => {
  try {
    if (!(v instanceof Uint8Array)) return fail();
    const result = new Uint8Array(v);
    return result.length === 32 ? result : fail();
  } catch {
    return fail();
  }
};

/**
 * GM専用に独立生成した鍵へBrandを付け、入力Bufferを共有しない。
 * @param material 認証鍵やGroup DEKとは独立した256-bit値。
 * @returns GM再送proofだけの鍵。
 * @throws RecipientCodeRequestProofUnavailable 固定長でない場合。
 */
export const importRecipientCodeRequestProofKey = (
  material: Uint8Array,
): RecipientCodeRequestProofKey =>
  Object.freeze({
    purpose,
    material: copy32(material) as RecipientCodeRequestProofKey['material'],
  });

/**
 * GM所有PortへNode HMACを適合する。コード行/認証鍵/偽Group IDを使わない。
 * @param options GM専用Providerと固定分類だけの障害通知。
 * @returns 保存世代による再送検証と新規proof作成。
 */
export const createRecipientCodeRequestProof = (options: {
  /** current選択・世代保持・破棄はこのProvider/呼出し側が所有する。 */ readonly keys: RecipientCodeRequestProofKeyPort;
  /** 生例外・proof・原コードを含まない通知。 */ readonly onAlert?: (signal: {
    /** 固定分類だけを扱う。 */ readonly code: 'RECIPIENT_CODE_REQUEST_PROOF_UNAVAILABLE';
  }) => void;
}): RecipientCodeRequestProofPort => {
  const keys = options.keys;
  const onAlert = options.onAlert;
  const safe = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch {
      try {
        onAlert?.({ code: 'RECIPIENT_CODE_REQUEST_PROOF_UNAVAILABLE' });
      } catch {
        /* 元例外も通知例外も公開しない。 */
      }
      return fail();
    }
  };
  const create = async (
    secret: unknown,
    keyVersion: unknown,
  ): Promise<RecipientCodeRequestProof> => {
    const version = authenticationKeyVersion(keyVersion);
    if (version.length > 255 || !(secret instanceof RecipientCodeSecret))
      return fail();
    const canonical = encodeAuthenticationTlv([
      'kakei_app',
      purpose,
      copy32(secret.copyBytes()),
    ]);
    const query = Object.freeze({
      keyVersion: version,
      epoch: null,
      scopeId: 'group-management',
    } as const);
    const response: unknown = await keys.readKey(query);
    const r = authenticationObject(response, [
      'status',
      'keyVersion',
      'epoch',
      'scopeId',
      'key',
    ]);
    if (
      r.status !== 'available' ||
      r.keyVersion !== version ||
      r.epoch !== null ||
      r.scopeId !== 'group-management'
    )
      return fail();
    const key = authenticationObject(r.key, ['purpose', 'material']);
    if (key.purpose !== purpose) return fail();
    const material = copy32(key.material);
    try {
      const bytes = Uint8Array.from(
        createHmac('sha256', material).update(canonical).digest(),
      ) as RecipientCodeRequestProof['bytes'];
      return Object.freeze({ ...query, purpose, bytes });
    } finally {
      material.fill(0);
    }
  };
  const operations: RecipientCodeRequestProofPort = {
    create: (input) =>
      safe(() => {
        const r = authenticationObject(input, ['secret', 'keyVersion']);
        return create(r.secret, r.keyVersion);
      }),
    verify: (input) =>
      safe(async () => {
        const r = authenticationObject(input, ['secret', 'saved']);
        const saved = authenticationObject(r.saved, [
          'purpose',
          'keyVersion',
          'epoch',
          'scopeId',
          'bytes',
        ]);
        if (
          saved.purpose !== purpose ||
          saved.epoch !== null ||
          saved.scopeId !== 'group-management'
        )
          return fail();
        const actual = copy32(saved.bytes);
        const expected = await create(r.secret, saved.keyVersion);
        return timingSafeEqual(actual, expected.bytes);
      }),
  };
  return Object.freeze(operations);
};
