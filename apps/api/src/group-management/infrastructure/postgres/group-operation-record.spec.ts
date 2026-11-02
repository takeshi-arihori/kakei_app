import { describe, expect, it } from 'vitest';
import { ActorSubject, GroupId, InvitationId } from '../../domain/group.js';
import {
  CommandFingerprint,
  OperationId,
} from '../../application/group-repository.js';
import type { StoredRecipientInvitationOperation } from '../../application/recipient-invitation-repository.js';
import type { RecipientCodeRequestProof } from '../../application/recipient-code-request-proof.js';
import { recipientCodeInvitationFingerprint } from '../../application/group-policy-digest.js';
import { encodeOperationResultPayload } from './group-record-payload.js';
import {
  decodeStoredGroupOperation,
  encodeStoredGroupOperation,
} from './group-operation-record.js';

const groupId = GroupId.from('10000000-0000-4000-8000-000000000242');
const actorSubject = ActorSubject.from('10000000-0000-4000-8000-000000000020');
const operationId = OperationId.from('synthetic-operation-242');
const result = {
  kind: 'InvitationCreated' as const,
  groupId,
  version: 2,
  invitationId: InvitationId.from('10000000-0000-4000-8000-000000000042'),
};
const proof: RecipientCodeRequestProof = {
  purpose: 'gm-recipient-code-request/v1',
  scopeId: 'group-management',
  epoch: null,
  keyVersion: 'synthetic-proof-old',
  bytes: new Uint8Array(32).fill(24) as RecipientCodeRequestProof['bytes'],
};

const newOperation = (): StoredRecipientInvitationOperation => ({
  actorSubject,
  operationId,
  fingerprint: recipientCodeInvitationFingerprint(groupId, 1, proof),
  result,
  binding: {
    codeId: '10000000-0000-4000-8000-000000000030',
    recipientActorId: '10000000-0000-4000-8000-000000000010',
  },
});

describe('GM共通operation保存形式の互換性', () => {
  it('legacyの保護payloadをbyte不変で読み書きする', () => {
    const saved = {
      actorSubject,
      operationId,
      fingerprint: CommandFingerprint.from('synthetic-legacy-command'),
      result,
    };
    expect(encodeStoredGroupOperation(saved)).toEqual(
      encodeOperationResultPayload(saved),
    );
    expect(
      decodeStoredGroupOperation(encodeStoredGroupOperation(saved)),
    ).toEqual(saved);
  });

  it('新形式は保存proof世代と内部bindingを保持し、canonicalを復元する', () => {
    const saved: StoredRecipientInvitationOperation = {
      actorSubject,
      operationId,
      fingerprint: recipientCodeInvitationFingerprint(groupId, 1, proof),
      result,
      binding: {
        codeId: '10000000-0000-4000-8000-000000000030',
        recipientActorId: '10000000-0000-4000-8000-000000000010',
      },
    };
    const encoded = encodeStoredGroupOperation(saved);
    expect(decodeStoredGroupOperation(encoded)).toEqual(saved);
    expect(JSON.parse(new TextDecoder().decode(encoded))).toMatchObject({
      payloadVersion: 2,
    });
  });

  it('未知のpayload版を既存形式として救済しない', () => {
    expect(() =>
      decodeStoredGroupOperation(
        new TextEncoder().encode('{"payloadVersion":999}'),
      ),
    ).toThrow();
  });
  it.each([
    'root-extra',
    'fp-extra',
    'action',
    'fp-version',
    'proof-bytes',
    'proof-generation',
    'expected-version',
    'result-group',
    'result-version',
    'result-extra',
    'binding',
    'utf8',
  ] as const)('新保護payloadの%s不正を拒否する', (field) => {
    const encoded = encodeStoredGroupOperation(newOperation());
    const root = JSON.parse(new TextDecoder().decode(encoded)) as Record<
      string,
      unknown
    >;
    const fp = root.fingerprint as Record<string, unknown>,
      r = root.result as Record<string, unknown>,
      b = root.binding as Record<string, unknown>;
    switch (field) {
      case 'root-extra':
        root.rawCode = 'synthetic-extra';
        break;
      case 'fp-extra':
        fp.rawCode = 'synthetic-extra';
        break;
      case 'action':
        fp.action = 'OtherAction';
        break;
      case 'fp-version':
        fp.version = 2;
        break;
      case 'proof-bytes':
        fp.proof = String(fp.proof) + '=';
        break;
      case 'proof-generation':
        fp.proofKeyVersion = 'invalid generation';
        break;
      case 'expected-version':
        fp.expectedVersion = Number.MAX_SAFE_INTEGER;
        break;
      case 'result-group':
        r.groupId = '10000000-0000-4000-8000-000000000243';
        break;
      case 'result-version':
        r.version = 999;
        break;
      case 'result-extra':
        r.recipient = 'synthetic-extra';
        break;
      case 'binding':
        b.recipientActorId = 'not-a-uuid';
        break;
      case 'utf8':
        break;
    }
    expect(() =>
      decodeStoredGroupOperation(
        field === 'utf8'
          ? Uint8Array.of(255)
          : new TextEncoder().encode(JSON.stringify(root)),
      ),
    ).toThrow();
  });
  it('新canonical/proof byte列を元入力と共有せず、tampered canonicalの保存を拒否する', () => {
    const source = newOperation();
    const decoded = decodeStoredGroupOperation(
      encodeStoredGroupOperation(source),
    );
    if (decoded.fingerprint instanceof CommandFingerprint)
      throw new Error('expected new action');
    decoded.fingerprint.proof.bytes.fill(1);
    expect(source.fingerprint.proof.bytes).toEqual(proof.bytes);
    source.fingerprint.canonicalInput.fill(2);
    expect(() => encodeStoredGroupOperation(source)).toThrow();
  });
});
