declare const purposeSeparatedDigestBrand: unique symbol;

export type DigestPurpose =
  | 'group-actor-access-index/v1'
  | 'group-membership-index/v1'
  | 'group-operation-fingerprint/v1';

export type PurposeSeparatedDigest = Uint8Array & {
  readonly [purposeSeparatedDigestBrand]: true;
};

export const importPurposeSeparatedDigest = (
  bytes: Uint8Array,
): PurposeSeparatedDigest => {
  if (bytes.length === 0) {
    throw new TypeError('A purpose-separated digest must not be empty');
  }
  return Uint8Array.from(bytes) as PurposeSeparatedDigest;
};

export interface PurposeSeparatedDigestPort {
  digest(input: {
    purpose: DigestPurpose;
    groupId: string;
    canonicalInput: Uint8Array;
  }): Promise<
    Readonly<{
      digest: PurposeSeparatedDigest;
      digestKeyVersion: string;
    }>
  >;
}
