import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ActorSubject, GroupId, InvitationId } from '../domain/group.js';
import { OperationId } from '../application/group-repository.js';
import { recipientCodeInvitationFingerprint } from '../application/group-policy-digest.js';
import type { RecipientCodeRequestProof } from '../application/recipient-code-request-proof.js';
import {
  createGroupInvitationAuditProtector,
  importGroupInvitationAuditKey,
} from './group-invitation-audit.js';

const operation = () => {
  const groupId = GroupId.from('10000000-0000-4000-8000-000000000242');
  return {
    actorSubject: ActorSubject.from('10000000-0000-4000-8000-000000000020'),
    operationId: OperationId.from('synthetic-op'),
    fingerprint: recipientCodeInvitationFingerprint(groupId, 1, {
      purpose: 'gm-recipient-code-request/v1',
      scopeId: 'group-management',
      epoch: null,
      keyVersion: 'proof-old',
      bytes: new Uint8Array(32).fill(9) as RecipientCodeRequestProof['bytes'],
    }),
    binding: {
      codeId: '10000000-0000-4000-8000-000000000030',
      recipientActorId: '10000000-0000-4000-8000-000000000010',
    },
    result: {
      kind: 'InvitationCreated' as const,
      groupId,
      version: 2,
      invitationId: InvitationId.from('10000000-0000-4000-8000-000000000040'),
    },
  };
};
describe('GM招待Auditの独立用途とrequest semantic束縛', () => {
  const make = () =>
    createGroupInvitationAuditProtector({
      keys: {
        readCurrent: ({ scopeId }) =>
          Promise.resolve({
            status: 'available' as const,
            scopeId,
            keyVersion: 'synthetic-audit-v1',
            key: importGroupInvitationAuditKey(new Uint8Array(32).fill(42)),
          }),
      },
    });
  it('仮名の用途を分け、秘密値と直接参照を出力しない', async () => {
    const op = operation();
    const result = await make().protect({
      operation: op,
      accessPolicyVersion: 2,
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        'actorPseudonym',
        'groupPseudonym',
        'resourcePseudonym',
        'requestFingerprint',
        'auditKeyVersion',
      ].sort(),
    );
    const values = [
      result.actorPseudonym,
      result.groupPseudonym,
      result.resourcePseudonym,
      result.requestFingerprint,
    ];
    expect(
      new Set(values.map((v) => Buffer.from(v).toString('hex'))).size,
    ).toBe(4);
    values.forEach((v) => expect(v).toHaveLength(32));
  });
  it('同要求だけが同fingerprintで、Policy版とoperation変更は一致しない', async () => {
    const p = make(),
      op = operation();
    const a = await p.protect({ operation: op, accessPolicyVersion: 2 });
    expect(
      await p.protect({ operation: operation(), accessPolicyVersion: 2 }),
    ).toEqual(a);
    expect(
      (await p.protect({ operation: op, accessPolicyVersion: 3 }))
        .requestFingerprint,
    ).not.toEqual(a.requestFingerprint);
    expect(
      (
        await p.protect({
          operation: { ...op, operationId: OperationId.from('other-op') },
          accessPolicyVersion: 2,
        })
      ).requestFingerprint,
    ).not.toEqual(a.requestFingerprint);
  });
  it.each(['action', 'version'] as const)(
    '未知%sを固定actionのAuditへ正規化しない',
    async (field) => {
      const op = operation();
      const malformed = { ...op, fingerprint: { ...op.fingerprint } };
      Reflect.set(
        malformed.fingerprint,
        field,
        field === 'action' ? 'OtherAction' : 2,
      );
      await expect(
        make().protect({ operation: malformed, accessPolicyVersion: 2 }),
      ).rejects.toThrow('Group invitation audit unavailable');
    },
  );
  it('独立参照encoderのActor仮名vectorと一致する', async () => {
    const op = operation();
    const fields = [
      'kakei_app',
      'gm-security-audit/v1',
      'actor',
      op.result.groupId.value,
      op.actorSubject.value,
    ];
    const canonical = Buffer.concat(
      fields.map((value, index) => {
        const content = Buffer.from(value);
        const header = Buffer.alloc(6);
        header[0] = index + 1;
        header[1] = 1;
        header.writeUInt32BE(content.length, 2);
        return Buffer.concat([header, content]);
      }),
    );
    const expected = createHmac('sha256', Buffer.alloc(32, 42))
      .update(canonical)
      .digest();
    expect(
      Buffer.from(
        (await make().protect({ operation: op, accessPolicyVersion: 2 }))
          .actorPseudonym,
      ),
    ).toEqual(expected);
  });
  it('鍵Provider待機中の元binding/proof/結果変更がAuditへ混入しない', async () => {
    const op = operation();
    const expected = await make().protect({
      operation: operation(),
      accessPolicyVersion: 2,
    });
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const protector = createGroupInvitationAuditProtector({
      keys: {
        async readCurrent({ scopeId }) {
          entered();
          await gate;
          return {
            status: 'available',
            scopeId,
            keyVersion: 'synthetic-audit-v1',
            key: importGroupInvitationAuditKey(Buffer.alloc(32, 42)),
          };
        },
      },
    });
    const pending = protector.protect({
      operation: op,
      accessPolicyVersion: 2,
    });
    await started;
    op.fingerprint.proof.bytes.fill(1);
    op.fingerprint.canonicalInput.fill(2);
    op.binding.recipientActorId = '10000000-0000-4000-8000-000000000099';
    op.result.invitationId = InvitationId.from('other-invitation');
    finish();
    expect(await pending).toEqual(expected);
  });
});
