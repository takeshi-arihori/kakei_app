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

export type ProtectedRecordKey = Uint8Array & {
  readonly [protectedRecordKeyBrand]: true;
};

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

export type ProtectedRecordSealHeader =
  WithoutKeyVersion<ProtectedRecordHeader>;

export type SealKeyAllocation =
  | Readonly<{
      status: 'allocated';
      key: ProtectedRecordKey;
      keyVersion: string;
      nonce: Uint8Array;
      sealCount: bigint;
    }>
  | Readonly<{
      status: 'counter-regressed' | 'key-lost';
      keyVersion: string;
    }>;

export type ReadKeyResult =
  | Readonly<{
      status: 'available';
      key: ProtectedRecordKey;
      lifecycle: 'current' | 'retired';
    }>
  | Readonly<{ status: 'key-lost' }>;

export type RotationReason =
  | 'seal-threshold'
  | 'seal-limit'
  | 'counter-regression'
  | 'key-loss'
  | 'nonce-invalid';

export interface ProtectedRecordKeyPort {
  allocateForSeal(input: {
    contextName: ProtectedRecordHeader['contextName'];
    groupId: string;
  }): Promise<SealKeyAllocation>;

  readKey(input: {
    contextName: ProtectedRecordHeader['contextName'];
    groupId: string;
    keyVersion: string;
  }): Promise<ReadKeyResult>;

  requestRotation(input: {
    contextName: ProtectedRecordHeader['contextName'];
    groupId: string;
    keyVersion: string;
    reason: RotationReason;
  }): Promise<void>;
}

export type AlertSignal = Readonly<{
  operation: 'seal' | 'open';
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

export class ProtectedRecordUnavailable extends Error {
  constructor() {
    super('Protected record unavailable');
    this.name = 'ProtectedRecordUnavailable';
  }
}

export type ProtectedRecordEnvelope = {
  header: ProtectedRecordHeader;
  aad: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authenticationTag: Uint8Array;
};

export type ProtectedRecordCodec = Readonly<{
  seal(input: {
    header: ProtectedRecordSealHeader;
    plaintext: Uint8Array;
  }): Promise<ProtectedRecordEnvelope>;
  open(input: {
    expectedHeader: ProtectedRecordHeader;
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

export const createProtectedRecordCodec = (options: {
  keyPort: ProtectedRecordKeyPort;
  onAlert?: (signal: AlertSignal) => void;
}): ProtectedRecordCodec => {
  const emit = (signal: AlertSignal): void => {
    try {
      options.onAlert?.(Object.freeze(signal));
    } catch {
      // An observability callback cannot expose a protected payload or replace
      // the generic failure returned by this boundary.
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
