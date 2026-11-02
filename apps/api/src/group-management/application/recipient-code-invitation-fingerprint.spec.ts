import { describe, expect, it } from 'vitest';
import { GroupId } from '../domain/group.js';
import {
  operationLocatorDigestInput,
  recipientCodeInvitationFingerprint,
} from './group-policy-digest.js';
import type { RecipientCodeRequestProof } from './recipient-code-request-proof.js';
import { ActorSubject } from '../domain/group.js';
import { OperationId } from './group-repository.js';
const id = GroupId.from('10000000-0000-4000-8000-000000000001');
const proof = (): RecipientCodeRequestProof => ({
  purpose: 'gm-recipient-code-request/v1',
  scopeId: 'group-management',
  epoch: null,
  keyVersion: 'proof-v1',
  bytes: new Uint8Array(32).fill(11) as RecipientCodeRequestProof['bytes'],
});
const reference = (
  values: readonly (string | Uint8Array)[],
  tags = values.map((_, i) => i + 1),
) =>
  Buffer.concat(
    values.map((value, i) => {
      const b =
        typeof value === 'string'
          ? Buffer.from(value, 'utf8')
          : Buffer.from(value);
      const length = Buffer.alloc(5);
      length[0] = tags[i];
      length.writeUInt32BE(b.length, 1);
      return Buffer.concat([length, b]);
    }),
  );
describe('新コード招待fingerprintのGM canonical契約', () => {
  it('action/version・Group・期待版・proof世代/値を独立encoderと照合する', () => {
    const saved = proof();
    const fp = recipientCodeInvitationFingerprint(id, 7, saved);
    expect(Buffer.from(fp.canonicalInput)).toEqual(
      reference([
        'group-recipient-invitation-fingerprint/v1',
        'CreateInvitationFromRecipientCode',
        id.value,
        '7',
        'proof-v1',
        new Uint8Array(32).fill(11),
      ]),
    );
    expect(fp.action).toBe('CreateInvitationFromRecipientCode');
    expect(fp.version).toBe(1);
    saved.bytes.fill(99);
    expect(fp.proof.bytes).toEqual(new Uint8Array(32).fill(11));
    expect(Buffer.from(fp.canonicalInput)).toEqual(
      reference([
        'group-recipient-invitation-fingerprint/v1',
        'CreateInvitationFromRecipientCode',
        id.value,
        '7',
        'proof-v1',
        new Uint8Array(32).fill(11),
      ]),
    );
  });
  it('Group/版/保存世代/proofのどの差も別のcanonical内容になる', () => {
    const p = proof();
    const base = recipientCodeInvitationFingerprint(id, 7, p).canonicalInput;
    const changed = [
      recipientCodeInvitationFingerprint(
        GroupId.from('10000000-0000-4000-8000-000000000002'),
        7,
        p,
      ),
      recipientCodeInvitationFingerprint(id, 8, p),
      recipientCodeInvitationFingerprint(id, 7, {
        ...p,
        keyVersion: 'proof-v2',
      }),
      recipientCodeInvitationFingerprint(id, 7, {
        ...p,
        bytes: new Uint8Array(32).fill(
          22,
        ) as RecipientCodeRequestProof['bytes'],
      }),
    ];
    for (const fp of changed) expect(fp.canonicalInput).not.toEqual(base);
  });
  it.each([
    { purpose: 'auth-recipient-code-lookup/v1' },
    { epoch: 'old' },
    { scopeId: 'authentication' },
    { keyVersion: 'bad space' },
    { keyVersion: '' },
    { bytes: new Uint8Array(31) },
    { extra: true },
  ])('不正proof %jを入力なしの固定失敗にする', (patch) => {
    expect(() =>
      recipientCodeInvitationFingerprint(id, 7, {
        ...proof(),
        ...patch,
      } as never),
    ).toThrow('Invalid recipient invitation fingerprint');
  });
  it('proof getterを評価せず拒否する', () => {
    let accessed = false;
    const p = { ...proof() };
    Object.defineProperty(p, 'bytes', {
      enumerable: true,
      get: () => {
        accessed = true;
        return new Uint8Array(32);
      },
    });
    expect(() => recipientCodeInvitationFingerprint(id, 7, p)).toThrow();
    expect(accessed).toBe(false);
  });
  it('既存共通locatorの内容/形式に新actionやGroupを混ぜない', () => {
    const actor = ActorSubject.from('synthetic-actor'),
      operation = OperationId.from('synthetic-operation');
    expect(
      Buffer.from(operationLocatorDigestInput(actor, operation).canonicalInput),
    ).toEqual(
      reference(
        [
          'group-operation-locator/v2',
          'operation-locator',
          actor.value,
          operation.value,
        ],
        [1, 2, 3, 5],
      ),
    );
  });
});
