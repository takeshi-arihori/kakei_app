import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  GroupActorMembershipIndexKeyPort,
  GroupOperationLocatorKeyPort,
} from '../src/group-management/application/group-access-policy.js';
import {
  importPurposeSeparatedDigest,
  type DigestPurpose,
  type PurposeSeparatedDigestPort,
} from '../src/shared/application/purpose-separated-digest.js';
import {
  importProtectedRecordKey,
  type ProtectedRecordKeyPort,
} from '../src/shared/infrastructure/protected-record/protected-record-codec.js';

/** 再起動後に復元できないlocalhost専用のGroup鍵。永続Providerとして利用しない。 */
export interface GroupManagementDevelopmentKeys {
  /** DEK・用途別HMAC・locatorが共有するprocess固有の世代識別子。Materialは用途ごとに独立する。 */
  readonly keyVersion: string;
  /** `group-management`のGroup別DEK。Nonceはprocess内でだけ単調に割り当てる。 */
  readonly recordKeys: ProtectedRecordKeyPort;
  /** 許可Listの用途だけを、用途ごとに独立した鍵でHMACする。 */
  readonly policyDigests: PurposeSeparatedDigestPort;
  /** Context単位のoperation locator。現行世代だけを返す。 */
  readonly locatorKeys: GroupOperationLocatorKeyPort;
  /** Context単位のActor単位Group索引（#306）。locatorとも独立した鍵で、現行世代だけを返す。 */
  readonly membershipIndexKeys: GroupActorMembershipIndexKeyPort;
  /** 以後の利用を拒否し、所有する鍵Materialを消去する。 */
  dispose(): void;
}

/** #307で承認した閉じた許可List。招待・Settlement等の用途は配らない。 */
const allowedDigestPurposes: readonly DigestPurpose[] = [
  'group-actor-access-index/v1',
  'group-membership-index/v1',
  'group-operation-fingerprint/v1',
];
const locatorPurpose = 'group-operation-locator/v2';
/** #306承認・2026-11-21 Owner判断で加えた、Group単位HMACの許可Listとは別のContext単位用途。 */
const membershipIndexPurpose = 'group-actor-membership-index/v1';
const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Codecが`seal-threshold`でRotationを要求する値。到達後は封印しない。 */
const sealCountLimit = 1n << 31n;

const unavailable = (): never => {
  // 入力値・鍵Materialを例外へ含めない。
  throw new Error('開発用Group鍵を利用できません');
};

const requireGroupScope = (input: {
  contextName: string;
  groupId: string;
}): string => {
  if (
    input.contextName !== 'group-management' ||
    typeof input.groupId !== 'string' ||
    !canonicalUuid.test(input.groupId)
  )
    return unavailable();
  return input.groupId;
};

const requireCanonicalInput = (value: Uint8Array): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length === 0)
    return unavailable();
  return value;
};

/**
 * 空の専用DBで単一process leaseを得た開発Compositionだけが生成する。
 * 認証の開発用鍵とはMaterialを共有しない。
 * @returns 再起動やDB rollbackでは再生成・復元しない使い捨てGroup鍵群。
 */
export const createGroupManagementDevelopmentKeys =
  (): GroupManagementDevelopmentKeys => {
    const keyVersion = randomUUID();
    let active = true;
    const material: Buffer[] = [];
    const generate = (): Buffer => {
      const bytes = randomBytes(32);
      material.push(bytes);
      return bytes;
    };
    const records = new Map<
      string,
      { key: Buffer; count: bigint; disabled: boolean }
    >();
    const digestKeys = new Map<DigestPurpose, Buffer>(
      allowedDigestPurposes.map((purpose) => [purpose, generate()]),
    );
    const locatorKey = generate();
    const membershipIndexKey = generate();

    const recordKeys: ProtectedRecordKeyPort = {
      async allocateForSeal(input) {
        const groupId = requireGroupScope(input);
        if (!active) return { status: 'key-lost', keyVersion };
        let state = records.get(groupId);
        if (state === undefined) {
          state = { key: generate(), count: 0n, disabled: false };
          records.set(groupId, state);
        }
        if (state.disabled || state.count >= sealCountLimit)
          return { status: 'key-lost', keyVersion };
        // await前に割当をburnする。同processの外側Transactionがrollbackしても戻さない。
        const count = ++state.count;
        const nonce = Buffer.alloc(12);
        nonce.writeBigUInt64BE(count, 4);
        // dispose前のMaterialをawait前にCopyし、await中のdisposeを再確認する。
        const key = importProtectedRecordKey(state.key);
        await Promise.resolve();
        if (!active) {
          key.fill(0);
          return { status: 'key-lost', keyVersion };
        }
        return {
          status: 'allocated',
          key,
          keyVersion,
          nonce,
          sealCount: count,
        };
      },
      async readKey(input) {
        const groupId = requireGroupScope(input);
        await Promise.resolve();
        const state = records.get(groupId);
        if (!active || input.keyVersion !== keyVersion || state === undefined)
          return { status: 'key-lost' };
        return {
          status: 'available',
          key: importProtectedRecordKey(state.key),
          lifecycle: state.disabled ? 'retired' : 'current',
        };
      },
      async requestRotation(input) {
        const groupId = requireGroupScope(input);
        const state = records.get(groupId);
        if (state !== undefined && input.keyVersion === keyVersion)
          state.disabled = true;
        await Promise.resolve();
        // 使い捨てProviderは新しい鍵へ移らない。明示reset後の新processが必要。
        throw new Error('開発用Group鍵の再起動には専用DBの明示resetが必要です');
      },
    };

    const policyDigests: PurposeSeparatedDigestPort = {
      async digest(input) {
        const key = digestKeys.get(input.purpose);
        const groupId = requireGroupScope({
          contextName: 'group-management',
          groupId: input.groupId,
        });
        const canonicalInput = requireCanonicalInput(input.canonicalInput);
        if (key === undefined || !active) return unavailable();
        const groupBytes = Buffer.from(groupId, 'utf8');
        const length = Buffer.alloc(4);
        length.writeUInt32BE(groupBytes.length);
        const digest = importPurposeSeparatedDigest(
          createHmac('sha256', key)
            .update(length)
            .update(groupBytes)
            .update(canonicalInput)
            .digest(),
        );
        await Promise.resolve();
        // await中にdisposeされた場合は、計算済みの値も返さない。
        if (!active) return unavailable();
        return { digest, digestKeyVersion: keyVersion };
      },
    };

    /** Context単位の用途鍵1つで、現行世代だけを返すPortを作る。旧世代を保持しない。 */
    const contextScopedKeys = (purpose: string, key: Buffer) => {
      const digest = (input: {
        purpose: string;
        canonicalInput: Uint8Array;
      }) => {
        const canonicalInput = requireCanonicalInput(input.canonicalInput);
        if (input.purpose !== purpose || !active) return unavailable();
        return {
          digest: importPurposeSeparatedDigest(
            createHmac('sha256', key).update(canonicalInput).digest(),
          ),
          digestKeyVersion: keyVersion,
        };
      };
      return {
        async currentDigest(input: {
          purpose: string;
          canonicalInput: Uint8Array;
        }) {
          const value = digest(input);
          await Promise.resolve();
          // await中にdisposeされた場合は、計算済みの値も返さない。
          if (!active) return unavailable();
          return value;
        },
        async candidateDigests(input: {
          purpose: string;
          canonicalInput: Uint8Array;
        }) {
          // 旧世代を保持しないので、候補は現行世代だけになる。
          const value = digest(input);
          await Promise.resolve();
          if (!active) return unavailable();
          return [value];
        },
      };
    };
    const locatorKeys: GroupOperationLocatorKeyPort = contextScopedKeys(
      locatorPurpose,
      locatorKey,
    );
    const membershipIndexKeys: GroupActorMembershipIndexKeyPort =
      contextScopedKeys(membershipIndexPurpose, membershipIndexKey);

    return {
      keyVersion,
      recordKeys,
      policyDigests,
      locatorKeys,
      membershipIndexKeys,
      dispose() {
        active = false;
        for (const bytes of material) bytes.fill(0);
        records.clear();
        digestKeys.clear();
      },
    };
  };
