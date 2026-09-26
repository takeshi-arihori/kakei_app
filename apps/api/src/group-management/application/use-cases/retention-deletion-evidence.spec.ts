import { describe, expect, it } from 'vitest';

import { OperationId } from '../group-repository.js';
import {
  isVerifiedRetentionDeletionEvidence,
  PreparedRetentionDeletionBinding,
  RetentionDeletionToken,
  verifyRetentionDeletionEvidence,
  type ContextDeletionReceiptVerifierPort,
  type ContextKeyDestructionVerifierPort,
  type ContextKeyDestructionVerificationResult,
  type ContextReceiptVerificationResult,
  type RetentionContextName,
  type VerifyRetentionDeletionEvidencePorts,
  type VerifiedRetentionDeletionEvidence,
} from './retention-deletion-evidence.js';

const token = RetentionDeletionToken.from('opaque-test-deletion-token');
const operationId = OperationId.from('retention-evidence-operation');
const binding = PreparedRetentionDeletionBinding.create({
  deletionToken: token,
  operationId,
  intentVersion: 2,
});

type ReceiptContext = 'ExpenseRecording' | 'Settlement';

class ReceiptVerifier<
  C extends ReceiptContext,
> implements ContextDeletionReceiptVerifierPort<C> {
  calls = 0;

  constructor(
    readonly context: C,
    private readonly result: ContextReceiptVerificationResult<C> = {
      kind: 'Verified',
      context,
      binding,
    },
  ) {}

  async verify(_request: {
    readonly canonicalReceipt: unknown;
    readonly binding: PreparedRetentionDeletionBinding;
  }): Promise<ContextReceiptVerificationResult<C>> {
    void _request;
    await Promise.resolve();
    this.calls += 1;
    return this.result;
  }
}

class KeyDestructionVerifier implements ContextKeyDestructionVerifierPort {
  calls = 0;

  constructor(
    readonly context: RetentionContextName,
    private readonly result: ContextKeyDestructionVerificationResult = {
      kind: 'Verified',
      context,
      binding,
      keyNamespace: 'GroupData',
    },
  ) {}

  async verify(_request: {
    readonly binding: PreparedRetentionDeletionBinding;
  }): Promise<ContextKeyDestructionVerificationResult> {
    void _request;
    await Promise.resolve();
    this.calls += 1;
    return this.result;
  }
}

const validPorts = () => ({
  expenseReceiptVerifier: new ReceiptVerifier('ExpenseRecording'),
  settlementReceiptVerifier: new ReceiptVerifier('Settlement'),
  keyDestructionVerifiers: [
    new KeyDestructionVerifier('GroupManagement'),
    new KeyDestructionVerifier('ExpenseRecording'),
    new KeyDestructionVerifier('Settlement'),
  ],
});

const verify = (ports: VerifyRetentionDeletionEvidencePorts = validPorts()) =>
  verifyRetentionDeletionEvidence(
    {
      binding,
      expenseRecordingReceipt: { raw: 'opaque-expense-receipt' },
      settlementReceipt: { raw: 'opaque-settlement-receipt' },
    },
    ports,
  );

describe('verified retention deletion evidence contract', () => {
  it('issues one opaque value bound to all receipts and Group data-key confirmations', async () => {
    const ports = validPorts();
    const result = await verify(ports);

    expect(result.kind).toBe('Verified');
    if (result.kind !== 'Verified')
      throw new Error('Expected verified evidence');
    expect(result.evidence.binding).toBe(binding);
    expect(isVerifiedRetentionDeletionEvidence(result.evidence)).toBe(true);
    expect(ports.expenseReceiptVerifier.calls).toBe(1);
    expect(ports.settlementReceiptVerifier.calls).toBe(1);
    expect(ports.keyDestructionVerifiers.map(({ calls }) => calls)).toEqual([
      1, 1, 1,
    ]);
  });

  it('rejects missing or duplicate context-owned key verifiers before invoking ports', async () => {
    const ports = validPorts();
    const missing = await verify({
      ...ports,
      keyDestructionVerifiers: ports.keyDestructionVerifiers.slice(0, 2),
    });
    expect(missing).toEqual({ kind: 'Rejected', reason: 'MissingContext' });
    expect(ports.keyDestructionVerifiers.map(({ calls }) => calls)).toEqual([
      0, 0, 0,
    ]);

    const duplicate = await verify({
      ...ports,
      keyDestructionVerifiers: [
        ...ports.keyDestructionVerifiers,
        new KeyDestructionVerifier('Settlement'),
      ],
    });
    expect(duplicate).toEqual({ kind: 'Rejected', reason: 'DuplicateContext' });
  });

  it('rejects receipt verifier identity that does not match its required Context', async () => {
    const ports = validPorts();
    const result = await verify({
      ...ports,
      expenseReceiptVerifier: new ReceiptVerifier(
        'Settlement',
      ) as unknown as ContextDeletionReceiptVerifierPort<'ExpenseRecording'>,
    });

    expect(result).toEqual({ kind: 'Rejected', reason: 'DuplicateContext' });
    expect(ports.settlementReceiptVerifier.calls).toBe(0);
  });

  it('rejects a Verified receipt whose returned Context identity is unexpected', async () => {
    const ports = validPorts();
    const mismatched = new ReceiptVerifier('ExpenseRecording');
    mismatched.verify = async () => {
      await Promise.resolve();
      return {
        kind: 'Verified',
        context: 'Settlement',
        binding,
      } as unknown as ContextReceiptVerificationResult<'ExpenseRecording'>;
    };
    const result = await verify({
      ...ports,
      expenseReceiptVerifier: mismatched,
    });

    expect(result).toEqual({ kind: 'Rejected', reason: 'UnexpectedContext' });
  });

  it('rejects a key confirmation whose returned Context differs from its owner port', async () => {
    const ports = validPorts();
    const mismatched = new KeyDestructionVerifier('GroupManagement', {
      kind: 'Verified',
      context: 'Settlement',
      binding,
      keyNamespace: 'GroupData',
    });
    const result = await verify({
      ...ports,
      keyDestructionVerifiers: [
        mismatched,
        ...ports.keyDestructionVerifiers.slice(1),
      ],
    });

    expect(result).toEqual({ kind: 'Rejected', reason: 'UnexpectedContext' });
  });

  it.each([
    ['GroupManagement', 'MissingContext'],
    ['ExpenseRecording', 'MissingContext'],
    ['Settlement', 'MissingContext'],
  ] as const)(
    'rejects a missing verified Group-data-key confirmation for %s',
    async (context, reason) => {
      const ports = validPorts();
      const failing = new KeyDestructionVerifier(context, {
        kind: 'Rejected',
        reason: 'MissingEvidence',
      });
      const result = await verify({
        ...ports,
        keyDestructionVerifiers: ports.keyDestructionVerifiers.map((port) =>
          port.context === context ? failing : port,
        ),
      });

      expect(result).toEqual({ kind: 'Rejected', reason });
    },
  );

  it('rejects incomplete key-version evidence and never accepts a partial version set', async () => {
    const ports = validPorts();
    const incomplete = new KeyDestructionVerifier('GroupManagement', {
      kind: 'Rejected',
      reason: 'IncompleteEvidence',
    });
    const result = await verify({
      ...ports,
      keyDestructionVerifiers: [
        incomplete,
        ...ports.keyDestructionVerifiers.slice(1),
      ],
    });

    expect(result).toEqual({ kind: 'Rejected', reason: 'IncompleteEvidence' });
  });

  it.each(['ReceiptVerification', 'Audit', 'DeletedGroupToken'] as const)(
    'rejects non-Group-data key namespace %s',
    async (keyNamespace) => {
      const ports = validPorts();
      const verifier = new KeyDestructionVerifier('GroupManagement', {
        kind: 'Verified',
        context: 'GroupManagement',
        binding,
        keyNamespace,
      });
      const result = await verify({
        ...ports,
        keyDestructionVerifiers: [
          verifier,
          ...ports.keyDestructionVerifiers.slice(1),
        ],
      });

      expect(result).toEqual({
        kind: 'Rejected',
        reason: 'KeyNamespaceMismatch',
      });
    },
  );

  it('fails closed when any Context verifier is unavailable', async () => {
    const ports = validPorts();
    const result = await verify({
      ...ports,
      settlementReceiptVerifier: new ReceiptVerifier('Settlement', {
        kind: 'Unavailable',
      }),
    });

    expect(result).toEqual({ kind: 'Unavailable' });
  });

  it('rejects malformed runtime receipt outcomes without throwing', async () => {
    const ports = validPorts();
    const malformed = new ReceiptVerifier('ExpenseRecording');
    malformed.verify = async () => {
      await Promise.resolve();
      return null as unknown as ContextReceiptVerificationResult<'ExpenseRecording'>;
    };
    const result = await verify({
      ...ports,
      expenseReceiptVerifier: malformed,
    });

    expect(result).toEqual({ kind: 'Rejected', reason: 'InvalidEvidence' });
    expect(ports.keyDestructionVerifiers.map(({ calls }) => calls)).toEqual([
      0, 0, 0,
    ]);
  });

  it('fails closed when a Context key verifier is unavailable', async () => {
    const ports = validPorts();
    const unavailable = new KeyDestructionVerifier('Settlement', {
      kind: 'Unavailable',
    });
    const result = await verify({
      ...ports,
      keyDestructionVerifiers: [
        ...ports.keyDestructionVerifiers.slice(0, 2),
        unavailable,
      ],
    });

    expect(result).toEqual({ kind: 'Unavailable' });
  });

  it('rejects malformed runtime key outcomes without throwing', async () => {
    const ports = validPorts();
    const malformed = new KeyDestructionVerifier('GroupManagement');
    malformed.verify = async () => {
      await Promise.resolve();
      return null as unknown as ContextKeyDestructionVerificationResult;
    };
    const result = await verify({
      ...ports,
      keyDestructionVerifiers: [
        malformed,
        ...ports.keyDestructionVerifiers.slice(1),
      ],
    });

    expect(result).toEqual({ kind: 'Rejected', reason: 'IncompleteEvidence' });
  });

  it.each([
    ['BindingMismatch', 'BindingMismatch'],
    ['StaleEvidence', 'StaleEvidence'],
    ['InvalidReceipt', 'InvalidEvidence'],
  ] as const)(
    'rejects receipt verifier outcome %s',
    async (portReason, expectedReason) => {
      const ports = validPorts();
      const result = await verify({
        ...ports,
        expenseReceiptVerifier: new ReceiptVerifier('ExpenseRecording', {
          kind: 'Rejected',
          reason: portReason,
        }),
      });

      expect(result).toEqual({ kind: 'Rejected', reason: expectedReason });
      expect(ports.keyDestructionVerifiers.map(({ calls }) => calls)).toEqual([
        0, 0, 0,
      ]);
    },
  );

  it('rejects receipt outcomes bound to a different token, operation, or intent version', async () => {
    for (const mismatchedBinding of [
      PreparedRetentionDeletionBinding.create({
        deletionToken: RetentionDeletionToken.from('another-token'),
        operationId,
        intentVersion: 2,
      }),
      PreparedRetentionDeletionBinding.create({
        deletionToken: token,
        operationId: OperationId.from('another-operation'),
        intentVersion: 2,
      }),
      PreparedRetentionDeletionBinding.create({
        deletionToken: token,
        operationId,
        intentVersion: 3,
      }),
    ]) {
      const ports = validPorts();
      const result = await verify({
        ...ports,
        settlementReceiptVerifier: new ReceiptVerifier('Settlement', {
          kind: 'Verified',
          context: 'Settlement',
          binding: mismatchedBinding,
        }),
      });
      expect(result).toEqual({ kind: 'Rejected', reason: 'BindingMismatch' });
    }
  });

  it('rejects stale and mismatched key-destruction evidence', async () => {
    for (const reason of ['StaleEvidence', 'BindingMismatch'] as const) {
      const ports = validPorts();
      const result = await verify({
        ...ports,
        keyDestructionVerifiers: [
          new KeyDestructionVerifier('GroupManagement', {
            kind: 'Rejected',
            reason,
          }),
          ...ports.keyDestructionVerifiers.slice(1),
        ],
      });
      expect(result).toEqual({ kind: 'Rejected', reason });
    }
  });

  it('rejects key confirmations bound to a different token, operation, or intent version', async () => {
    const alternateBindings = [
      PreparedRetentionDeletionBinding.create({
        deletionToken: RetentionDeletionToken.from('another-token'),
        operationId,
        intentVersion: 2,
      }),
      PreparedRetentionDeletionBinding.create({
        deletionToken: token,
        operationId: OperationId.from('another-operation'),
        intentVersion: 2,
      }),
      PreparedRetentionDeletionBinding.create({
        deletionToken: token,
        operationId,
        intentVersion: 3,
      }),
    ];

    for (const mismatchedBinding of alternateBindings) {
      const ports = validPorts();
      const result = await verify({
        ...ports,
        keyDestructionVerifiers: [
          new KeyDestructionVerifier('GroupManagement', {
            kind: 'Verified',
            context: 'GroupManagement',
            binding: mismatchedBinding,
            keyNamespace: 'GroupData',
          }),
          ...ports.keyDestructionVerifiers.slice(1),
        ],
      });
      expect(result).toEqual({ kind: 'Rejected', reason: 'BindingMismatch' });
    }
  });

  it('does not expose a factory and rejects caller-forged evidence at runtime', async () => {
    const forged = Object.freeze({
      binding,
    }) as unknown as VerifiedRetentionDeletionEvidence;
    const result = await verify();

    expect(isVerifiedRetentionDeletionEvidence(forged)).toBe(false);
    // @ts-expect-error the module-private brand prevents structural construction
    const forgedAtTypeLevel: VerifiedRetentionDeletionEvidence = Object.freeze({
      binding,
    });
    expect(isVerifiedRetentionDeletionEvidence(forgedAtTypeLevel)).toBe(false);
    expect(
      'create' in (result.kind === 'Verified' ? result.evidence : {}),
    ).toBe(false);
    expect(
      isVerifiedRetentionDeletionEvidence({
        kind: 'Verified',
        evidence: { binding, verified: true },
      }),
    ).toBe(false);
  });

  it('maps thrown verifier failures to Unavailable and issues no evidence', async () => {
    const throwing = new ReceiptVerifier('ExpenseRecording');
    throwing.verify = async () => {
      await Promise.resolve();
      throw new Error('internal verifier failure');
    };
    const ports = validPorts();
    const result = await verify({ ...ports, expenseReceiptVerifier: throwing });

    expect(result).toEqual({ kind: 'Unavailable' });
    expect(isVerifiedRetentionDeletionEvidence(result)).toBe(false);
  });
});
