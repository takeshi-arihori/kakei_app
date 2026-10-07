import { createCipheriv, createDecipheriv } from 'node:crypto';

import {
  CanonicalAadViolation,
  decodeCanonicalAad,
  encodeCanonicalAad,
  type ProtectedRecordHeader,
} from './canonical-aad.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const ROTATION_THRESHOLD = 1n << 31n;
const SEAL_LIMIT = 1n << 32n;

declare const protectedRecordKeyBrand: unique symbol;

/** 暗号鍵をDigestと混同させない256-bit鍵のBrand型。 */
export type ProtectedRecordKey = Uint8Array & {
  /** 構造が同じByte列との誤用を防ぐ、Module非公開の型識別子。 */
  readonly [protectedRecordKeyBrand]: true;
};

/**
 * 256-bit Byte列をコピーし、Digestとは別の鍵型として扱う。
 * @param bytes 32-byteの鍵。呼出し側の配列は変更しない。
 * @returns 入力と参照を共有しないBrand付き鍵。
 * @throws TypeError 鍵が32-byteでない場合。
 */
export const importProtectedRecordKey = (
  bytes: Uint8Array,
): ProtectedRecordKey => {
  if (bytes.length !== KEY_BYTES) {
    throw new TypeError('A protected record key must be 256 bits');
  }
  return Uint8Array.from(bytes) as ProtectedRecordKey;
};

type WithoutKeyVersion<T> = T extends ProtectedRecordHeader
  ? Omit<T, 'keyVersion'>
  : never;

/** 鍵Versionを除く暗号化時の事実。鍵VersionはKey Portの割当で確定する。 */
export type ProtectedRecordSealHeader =
  WithoutKeyVersion<ProtectedRecordHeader>;

/** Key Portによる暗号化用の割当結果。Counter後退・鍵喪失は成功と区別する。 */
export type SealKeyAllocation =
  | Readonly<{
      /** 成功・鍵喪失・Counter後退を区別する判定。失敗を割当済みとして扱わない。 */
      status: 'allocated';
      /** Providerから取得する256-bit鍵。DB・Logへ保存せずDigestと混同しない。 */
      key: ProtectedRecordKey;
      /** 認証する鍵Version。復号時は期待値と完全一致する鍵を取得する。 */
      keyVersion: string;
      /** 鍵Versionごとに一意に割り当てる96-bit値。Callerによる指定は禁止する。 */
      nonce: Uint8Array;
      /** 同鍵Versionの単調増加する暗号化回数。2^31でRotation、2^32以上は拒否する。 */
      sealCount: bigint;
    }>
  | Readonly<{
      /** 成功・鍵喪失・Counter後退を区別する判定。失敗を割当済みとして扱わない。 */
      status: 'counter-regressed' | 'key-lost';
      /** 認証する鍵Version。復号時は期待値と完全一致する鍵を取得する。 */
      keyVersion: string;
    }>;

/** 指定した鍵Versionの読取結果。現行鍵と旧鍵を区別し、鍵喪失を明示する。 */
export type ReadKeyResult =
  | Readonly<{
      /** 利用可能な鍵を取得できたことを示す判定。 */
      status: 'available';
      /** Providerから取得する256-bit鍵。DB・Logへ保存せずDigestと混同しない。 */
      key: ProtectedRecordKey;
      /** 指定Versionの鍵が現行か旧鍵かを示す。Rotation中の両Version読取に使う。 */
      lifecycle: 'current' | 'retired';
    }>
  | Readonly<{
      /** 指定Versionの鍵が失われ、復号できないことを示す判定。 */
      status: 'key-lost';
    }>;

/** 鍵のRotationを要求する固定理由。機密値を含めない。 */
export type RotationReason =
  | 'seal-threshold'
  | 'seal-limit'
  | 'counter-regression'
  | 'key-loss'
  | 'nonce-invalid';

/** Group・Context別の鍵取得とNonceの原子的割当を担う境界。具体Providerは別責務。 */
export interface ProtectedRecordKeyPort {
  /**
   * Group・Context・鍵Versionごとに鍵、一意Nonce、単調増加Counterを原子的に割り当てる。
   * @param input 鍵のScopeとなるContextとGroup。
   * @returns 割当済みfacts、またはCounter後退／鍵喪失の判定。
   */
  allocateForSeal(input: {
    /** Data OwnerのContext識別子。Groupと合わせて鍵のScopeを決める。 */
    contextName: ProtectedRecordHeader['contextName'];
    /** 暗号化またはDigestのScopeとなるGroup参照。AADでは小文字Canonical UUIDを要求する。 */
    groupId: string;
  }): Promise<SealKeyAllocation>;

  /**
   * 指定Versionと一致する現行鍵または旧鍵を取得する。
   * @param input Context・Groupと認証対象の鍵Version。
   * @returns 一致する鍵とLifecycle、または鍵喪失の判定。
   */
  readKey(input: {
    /** Data OwnerのContext識別子。Groupと合わせて鍵のScopeを決める。 */
    contextName: ProtectedRecordHeader['contextName'];
    /** 暗号化またはDigestのScopeとなるGroup参照。AADでは小文字Canonical UUIDを要求する。 */
    groupId: string;
    /** 認証する鍵Version。復号時は期待値と完全一致する鍵を取得する。 */
    keyVersion: string;
  }): Promise<ReadKeyResult>;

  /**
   * 指定した鍵VersionのRotationをProviderへ要求する。
   * @param input Context・Group・鍵Versionと機密値を含まない理由。
   */
  requestRotation(input: {
    /** Data OwnerのContext識別子。Groupと合わせて鍵のScopeを決める。 */
    contextName: ProtectedRecordHeader['contextName'];
    /** 暗号化またはDigestのScopeとなるGroup参照。AADでは小文字Canonical UUIDを要求する。 */
    groupId: string;
    /** 認証する鍵Version。復号時は期待値と完全一致する鍵を取得する。 */
    keyVersion: string;
    /** 機密値を含まないRotationの固定理由。 */
    reason: RotationReason;
  }): Promise<void>;
}

/** ID・Payload・Ciphertext・Nonce・Tag・鍵を含まない監視通知。 */
export type AlertSignal = Readonly<{
  /** 失敗が暗号化か復号かを区別する操作種別。 */
  operation: 'seal' | 'open';
  /** 原因を内部監視へ分類する固定Code。入力値を含めない。 */
  code:
    | 'AAD_INVALID'
    | 'HEADER_MISMATCH'
    | 'ENVELOPE_INVALID'
    | 'AUTHENTICATION_FAILED'
    | 'ENCRYPTION_FAILED'
    | 'KEY_UNAVAILABLE'
    | 'COUNTER_REGRESSION'
    | 'SEAL_LIMIT_REACHED'
    | 'ROTATION_REQUEST_FAILED';
}>;

/** 鍵・改ざん・不正形式などの原因を外部へ開示しない汎用失敗。 */
export class ProtectedRecordUnavailable extends Error {
  /** 原因や入力値を外部へ開示しないErrorを生成する。 */
  constructor() {
    super('Protected record unavailable');
    this.name = 'ProtectedRecordUnavailable';
  }
}

/** AADと認証付き暗号文を保持する保存値。復号前に期待Headerと照合する。 */
export type ProtectedRecordEnvelope = {
  /** 暗号文のRecordと版を特定する事実。復号時はAAD・期待Headerと完全一致させる。 */
  header: ProtectedRecordHeader;
  /** 固定順序のCanonical TLV。暗号文とともに認証し、非Canonical形式を拒否する。 */
  aad: Uint8Array;
  /** 鍵Versionごとに一意に割り当てる96-bit値。Callerによる指定は禁止する。 */
  nonce: Uint8Array;
  /** 認証付き暗号文。平文の代わりに保存する。 */
  ciphertext: Uint8Array;
  /** 改ざん・差替えを検出する128-bit認証Tag。 */
  authenticationTag: Uint8Array;
};

/** 業務認可と保存を担当せず、認可済みCallerのByte列を保護する境界。 */
export type ProtectedRecordCodec = Readonly<{
  /**
   * Key Portの割当で暗号化し、NonceをCallerに選ばせない。
   * @param input AADの事実と認可済み平文。
   * @returns AAD、暗号文、Nonce、認証Tagを含むEnvelope。
   * @throws ProtectedRecordUnavailable 不正Header、鍵・Counter・Nonce・暗号化の失敗時。
   */
  seal(input: {
    /** 暗号文のRecordと版を特定する事実。復号時はAAD・期待Headerと完全一致させる。 */
    header: ProtectedRecordSealHeader;
    /** 認可済みCallerが渡すByte列。Codecは業務認可や保存を実行しない。 */
    plaintext: Uint8Array;
  }): Promise<ProtectedRecordEnvelope>;
  /**
   * 期待Header・AAD・認証Tagを照合してから復号する。
   * @param input 信頼済み期待Headerと保存Envelope。
   * @returns 認証に成功した平文Byte列。
   * @throws ProtectedRecordUnavailable 形式・Header・鍵・認証のいずれかが不正な場合。
   */
  open(input: {
    /** 信頼済み保存参照から組み立てる期待Header。復号前にEnvelopeと照合する。 */
    expectedHeader: ProtectedRecordHeader;
    /** 保存から得た保護値。不正Metadata・Nonce・Tag・改ざんを検証する。 */
    envelope: ProtectedRecordEnvelope;
  }): Promise<Uint8Array>;
}>;

const headersEqual = (
  left: ProtectedRecordHeader,
  right: ProtectedRecordHeader,
): boolean =>
  left.envelopeVersion === right.envelopeVersion &&
  left.algorithmId === right.algorithmId &&
  left.app === right.app &&
  left.contextName === right.contextName &&
  left.recordKind === right.recordKind &&
  left.groupId === right.groupId &&
  left.logicalRecordId === right.logicalRecordId &&
  left.schemaVersion === right.schemaVersion &&
  left.keyVersion === right.keyVersion &&
  left.aggregateVersion === right.aggregateVersion &&
  left.revisionOrdinal === right.revisionOrdinal;

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && Buffer.from(left).equals(Buffer.from(right));

/**
 * Node.js標準暗号と注入したKey Portで保存レコードの保護境界を組み立てる。
 * @param options 鍵取得と機密値を含まない監視通知の依存。
 * @returns seal／openを提供する不変Codec。各操作の失敗はProtectedRecordUnavailableで拒否する。
 */
export const createProtectedRecordCodec = (options: {
  /** 鍵と一意Nonceを原子的に取得する境界。 */
  keyPort: ProtectedRecordKeyPort;
  /** 機密値を含まない固定Codeの監視通知を受け取る。 */
  onAlert?: (signal: AlertSignal) => void;
}): ProtectedRecordCodec => {
  const emit = (signal: AlertSignal): void => {
    try {
      options.onAlert?.(Object.freeze(signal));
    } catch {
      // 監視Callbackから保護Payloadを露出させず、この境界が返す
      // 汎用失敗を置き換えない。
    }
  };

  const unavailable = (
    operation: AlertSignal['operation'],
    code: AlertSignal['code'],
  ): never => {
    emit({ operation, code });
    throw new ProtectedRecordUnavailable();
  };

  const rotate = async (
    header: ProtectedRecordSealHeader,
    keyVersion: string,
    reason: RotationReason,
  ): Promise<void> => {
    try {
      await options.keyPort.requestRotation({
        contextName: header.contextName,
        groupId: header.groupId,
        keyVersion,
        reason,
      });
    } catch {
      return unavailable('seal', 'ROTATION_REQUEST_FAILED');
    }
  };

  const allocateForSeal = async (
    header: ProtectedRecordSealHeader,
  ): Promise<SealKeyAllocation> => {
    try {
      return await options.keyPort.allocateForSeal({
        contextName: header.contextName,
        groupId: header.groupId,
      });
    } catch {
      return unavailable('seal', 'KEY_UNAVAILABLE');
    }
  };

  const readKeyForOpen = async (
    header: ProtectedRecordHeader,
  ): Promise<ReadKeyResult> => {
    try {
      return await options.keyPort.readKey({
        contextName: header.contextName,
        groupId: header.groupId,
        keyVersion: header.keyVersion,
      });
    } catch {
      return unavailable('open', 'KEY_UNAVAILABLE');
    }
  };

  return Object.freeze({
    async seal({ header, plaintext }) {
      const allocation = await allocateForSeal(header);

      if (allocation.status !== 'allocated') {
        const counterRegressed = allocation.status === 'counter-regressed';
        await rotate(
          header,
          allocation.keyVersion,
          counterRegressed ? 'counter-regression' : 'key-loss',
        );
        return unavailable(
          'seal',
          counterRegressed ? 'COUNTER_REGRESSION' : 'KEY_UNAVAILABLE',
        );
      }
      if (allocation.sealCount < 0n) {
        await rotate(header, allocation.keyVersion, 'counter-regression');
        return unavailable('seal', 'COUNTER_REGRESSION');
      }
      if (allocation.sealCount >= SEAL_LIMIT) {
        await rotate(header, allocation.keyVersion, 'seal-limit');
        return unavailable('seal', 'SEAL_LIMIT_REACHED');
      }
      if (allocation.nonce.length !== NONCE_BYTES) {
        await rotate(header, allocation.keyVersion, 'nonce-invalid');
        return unavailable('seal', 'ENVELOPE_INVALID');
      }
      if (allocation.key.length !== KEY_BYTES) {
        await rotate(header, allocation.keyVersion, 'key-loss');
        return unavailable('seal', 'KEY_UNAVAILABLE');
      }
      if (allocation.sealCount >= ROTATION_THRESHOLD) {
        await rotate(header, allocation.keyVersion, 'seal-threshold');
      }

      const protectedHeader = {
        ...header,
        keyVersion: allocation.keyVersion,
      } as ProtectedRecordHeader;

      let aad: Uint8Array;
      try {
        aad = encodeCanonicalAad(protectedHeader);
      } catch (error) {
        if (error instanceof CanonicalAadViolation) {
          return unavailable('seal', 'AAD_INVALID');
        }
        throw error;
      }

      const key = Buffer.from(allocation.key);
      try {
        const cipher = createCipheriv('aes-256-gcm', key, allocation.nonce, {
          authTagLength: AUTHENTICATION_TAG_BYTES,
        });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        const authenticationTag = cipher.getAuthTag();

        return {
          header: protectedHeader,
          aad: Uint8Array.from(aad),
          nonce: Uint8Array.from(allocation.nonce),
          ciphertext: Uint8Array.from(ciphertext),
          authenticationTag: Uint8Array.from(authenticationTag),
        };
      } catch {
        return unavailable('seal', 'ENCRYPTION_FAILED');
      } finally {
        key.fill(0);
      }
    },

    async open({ expectedHeader, envelope }) {
      let decodedHeader: ProtectedRecordHeader;
      try {
        decodedHeader = decodeCanonicalAad(envelope.aad);
      } catch (error) {
        if (error instanceof CanonicalAadViolation) {
          return unavailable('open', 'AAD_INVALID');
        }
        throw error;
      }
      if (!bytesEqual(encodeCanonicalAad(decodedHeader), envelope.aad)) {
        return unavailable('open', 'AAD_INVALID');
      }

      if (
        !headersEqual(decodedHeader, envelope.header) ||
        !headersEqual(decodedHeader, expectedHeader)
      ) {
        return unavailable('open', 'HEADER_MISMATCH');
      }
      if (
        envelope.nonce.length !== NONCE_BYTES ||
        envelope.authenticationTag.length !== AUTHENTICATION_TAG_BYTES
      ) {
        return unavailable('open', 'ENVELOPE_INVALID');
      }

      const readResult = await readKeyForOpen(decodedHeader);
      if (readResult.status !== 'available') {
        return unavailable('open', 'KEY_UNAVAILABLE');
      }
      if (readResult.key.length !== KEY_BYTES) {
        return unavailable('open', 'KEY_UNAVAILABLE');
      }

      const key = Buffer.from(readResult.key);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, {
          authTagLength: AUTHENTICATION_TAG_BYTES,
        });
        decipher.setAAD(envelope.aad);
        decipher.setAuthTag(envelope.authenticationTag);
        return Uint8Array.from(
          Buffer.concat([
            decipher.update(envelope.ciphertext),
            decipher.final(),
          ]),
        );
      } catch {
        return unavailable('open', 'AUTHENTICATION_FAILED');
      } finally {
        key.fill(0);
      }
    },
  });
};
