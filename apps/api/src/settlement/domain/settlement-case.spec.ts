import { describe, expect, it } from 'vitest';
import { SettlementCase, type StartSettlementCase } from './settlement-case.js';
import { SettlementCaseInvariantViolation } from './settlement-case-invariant-violation.js';
import { SettlementSnapshotContent } from './value-objects/settlement-snapshot-content.js';

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const groupId = uuid(1);
const caseId = uuid(2);
const snapshotId = uuid(3);
const time = () => new Date('2026-10-01T00:00:00Z');
const content = () =>
  SettlementSnapshotContent.from(groupId, [
    {
      expenseId: 'expense-1',
      groupId,
      amount: 100n,
      payerParticipantId: 'a',
      allocations: [
        { participantId: 'a', joinOrder: 1, percentage: 50, burden: 50n },
        { participantId: 'b', joinOrder: 2, percentage: 50, burden: 50n },
      ],
    },
  ]);
const startInput = () => ({
  caseId,
  snapshotId,
  content: content(),
  applicant: { actorSubject: 'actor-a', participantId: 'a' },
  submittedAt: time(),
  instructionIds: [uuid(20)],
});
const decision = (participantId = 'b', expectedVersion = 1) => ({
  participantId,
  expectedVersion,
  snapshotId,
  decidedAt: time(),
});

describe('Settlement Case initial approval', () => {
  it('SCA-POST1: all required approvers must approve before payment activation', () => {
    const submitted = SettlementCase.start(startInput());
    expect(submitted.status).toBe('AwaitingApproval');
    const approved = submitted.approve(decision());
    expect(approved.status).toBe('PaymentActive');
    expect(submitted.status).toBe('AwaitingApproval');
  });
});

const threePartyContent = () =>
  SettlementSnapshotContent.from(groupId, [
    {
      expenseId: 'expense-three',
      groupId,
      amount: 100n,
      payerParticipantId: 'a',
      allocations: [
        { participantId: 'a', joinOrder: 1, percentage: 50, burden: 50n },
        { participantId: 'b', joinOrder: 2, percentage: 40, burden: 40n },
        { participantId: 'c', joinOrder: 3, percentage: 10, burden: 10n },
      ],
    },
  ]);
const balancedContent = () =>
  SettlementSnapshotContent.from(groupId, [
    ...content().expenses,
    {
      ...content().expenses[0],
      expenseId: 'expense-2',
      payerParticipantId: 'b',
    },
  ]);
const submit = (snapshotContent = content(), participantId = 'a') =>
  SettlementCase.start({
    ...startInput(),
    content: snapshotContent,
    applicant: { actorSubject: `actor-${participantId}`, participantId },
    instructionIds: snapshotContent.candidates.map((_, i) => uuid(20 + i)),
  });
const expectViolation = (operation: () => unknown, code: string) => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SettlementCaseInvariantViolation);
    expect(error).toMatchObject({
      code,
      message: 'Settlement case invariant violated',
    });
    return;
  }
  throw new Error(`Expected ${code}`);
};

describe('SCA-INV1/INV2: immutable initial revision and applicant approval', () => {
  it('fixes identity, selection, applicant and UTC without mixing mutable approvals into content', () => {
    const input = startInput();
    input.submittedAt = new Date('2026-10-01T09:00:00+09:00');
    const root = SettlementCase.start(input);
    expect(root.caseId).toBe(caseId);
    expect(root.targetExpenseIds).toEqual(['expense-1']);
    expect(root.snapshot).toMatchObject({
      caseId,
      snapshotId,
      ordinal: 1,
      previousSnapshotId: null,
      submittedAt: '2026-10-01T00:00:00.000Z',
      applicant: { actorSubject: 'actor-a', participantId: 'a' },
    });
    expect(root.version).toBe(1);
    expect(root.approvals).toEqual([
      {
        snapshotId,
        participantId: 'a',
        decision: 'Approved',
        decidedAt: root.snapshot.submittedAt,
        reason: null,
      },
    ]);
    expect(root.snapshot).not.toHaveProperty('approvals');
    expect(root.revisionStatus).toBe('AwaitingApproval');
    expect(root.activePaymentInstructions).toEqual([]);
    expect(root.archivedAt).toBeNull();
    expect(root.archiveReason).toBeNull();
    input.applicant.actorSubject = 'changed';
    input.applicant.participantId = 'rejoined-a';
    input.submittedAt.setUTCFullYear(2030);
    input.instructionIds[0] = uuid(99);
    expect(root.snapshot.applicant).toEqual({
      actorSubject: 'actor-a',
      participantId: 'a',
    });
    expect(root.snapshot.submittedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(root.snapshot.paymentInstructionCandidates[0].instructionId).toBe(
      uuid(20),
    );
  });

  it('does not approve on behalf of others when applicant is not required (including Owner)', () => {
    const root = submit(content(), 'current-owner');
    expect(root.approvals).toEqual([]);
    expectViolation(
      () => root.approve(decision('current-owner')),
      'PARTICIPANT_NOT_REQUIRED',
    );
    const a = root.approve(decision('a'));
    expect(a.status).toBe('AwaitingApproval');
    const b = a.approve(decision('b', 2));
    expect(b.status).toBe('PaymentActive');
    expect(b.approvals.map((x) => x.participantId)).toEqual(['a', 'b']);
    expect(b.snapshot).toBe(root.snapshot);
  });

  it('payer0%, positive percentage with burden0 and net0 all remain required', () => {
    const tiny = SettlementSnapshotContent.from(groupId, [
      {
        expenseId: 'tiny',
        groupId,
        amount: 1n,
        payerParticipantId: 'c',
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 50, burden: 1n },
          { participantId: 'b', joinOrder: 2, percentage: 50, burden: 0n },
          { participantId: 'c', joinOrder: 3, percentage: 0, burden: 0n },
        ],
      },
    ]);
    const first = submit(tiny, 'c');
    expect(first.approvals.map((x) => x.participantId)).toEqual(['c']);
    const a = first.approve(decision('a'));
    expect(a.status).toBe('AwaitingApproval');
    expect(a.activePaymentInstructions).toEqual([]);
    expect(a.approve(decision('b', 2)).status).toBe('PaymentActive');
  });

  it('retains six historical IDs and rejects a new rejoin ID rather than replacing the old vote', () => {
    const historical = SettlementSnapshotContent.from(
      groupId,
      [0, 2, 4].map((i) => ({
        expenseId: `historical-${i}`,
        groupId,
        amount: 2n,
        payerParticipantId: `p${i + 1}`,
        allocations: [
          {
            participantId: `p${i + 1}`,
            joinOrder: i + 1,
            percentage: 50,
            burden: 1n,
          },
          {
            participantId: `p${i + 2}`,
            joinOrder: i + 2,
            percentage: 50,
            burden: 1n,
          },
        ],
      })),
    );
    let root = submit(historical, 'new-applicant');
    expect(root.snapshot.content.requiredApproverIds).toHaveLength(6);
    expectViolation(
      () => root.approve(decision('p1-rejoined')),
      'PARTICIPANT_NOT_REQUIRED',
    );
    for (let i = 1; i <= 6; i++) {
      root = root.approve(decision(`p${i}`, root.version));
      expect(root.status).toBe(i < 6 ? 'AwaitingApproval' : 'PaymentActive');
    }
    expect(root.activePaymentInstructions).toHaveLength(3);
    expect(root.snapshot.content.requiredApproverIds).toContain('p1');
  });
});

describe('SCA-POST1: activation, rejection and no payment archive', () => {
  it('activates every fixed instruction atomically only after the last approval', () => {
    const initial = submit(threePartyContent());
    const b = initial.approve(decision());
    expect(b.status).toBe('AwaitingApproval');
    expect(b.activePaymentInstructions).toEqual([]);
    const c = b.approve(decision('c', 2));
    expect(c.status).toBe('PaymentActive');
    expect(c.revisionStatus).toBe('Approved');
    expect(c.version).toBe(3);
    expect(c.activePaymentInstructions).toEqual([
      {
        instructionId: uuid(20),
        payerParticipantId: 'b',
        payeeParticipantId: 'a',
        amount: 40n,
        currency: 'JPY',
      },
      {
        instructionId: uuid(21),
        payerParticipantId: 'c',
        payeeParticipantId: 'a',
        amount: 10n,
        currency: 'JPY',
      },
    ]);
    expect(c.activePaymentInstructions).toBe(
      initial.snapshot.paymentInstructionCandidates,
    );
    expect(c.snapshot).toBe(initial.snapshot);
    expect(initial.approvals).toHaveLength(1);
    expect(b.approvals).toHaveLength(2);
  });

  it('reasoned rejection preserves all earlier votes and immutable revision, without activation', () => {
    const initial = submit(threePartyContent());
    const b = initial.approve(decision());
    const rejected = b.reject({
      ...decision('c', 2),
      reason: '  金額を確認したい  ',
    });
    expect(rejected.status).toBe('Rejected');
    expect(rejected.revisionStatus).toBe('Rejected');
    expect(rejected.snapshot).toBe(initial.snapshot);
    expect(rejected.activePaymentInstructions).toEqual([]);
    expect(rejected.approvals.map((x) => x.decision)).toEqual([
      'Approved',
      'Approved',
      'Rejected',
    ]);
    expect(rejected.approvals[2]).toMatchObject({
      snapshotId,
      participantId: 'c',
      decidedAt: '2026-10-01T00:00:00.000Z',
      reason: '  金額を確認したい  ',
    });
    expect(rejected.targetExpenseIds).toEqual(initial.targetExpenseIds);
    expect(b.status).toBe('AwaitingApproval');
    expect(rejected.archivedAt).toBeNull();
  });

  it('all-zero balances still await others, then archive directly at the last UTC decision', () => {
    const initial = submit(balancedContent());
    expect(initial.status).toBe('AwaitingApproval');
    expect(
      initial.snapshot.content.balances.every((x) => x.amount === 0n),
    ).toBe(true);
    expect(initial.snapshot.paymentInstructionCandidates).toEqual([]);
    const date = new Date('2026-10-02T01:00:00+09:00');
    const archived = initial.approve({ ...decision(), decidedAt: date });
    date.setUTCFullYear(2030);
    expect(archived.status).toBe('Archived');
    expect(archived.revisionStatus).toBe('Approved');
    expect(archived.archiveReason).toBe('NoPaymentRequired');
    expect(archived.archivedAt).toBe('2026-10-01T16:00:00.000Z');
    expect(archived.approvals[1].decidedAt).toBe(archived.archivedAt);
    expect(archived.activePaymentInstructions).toEqual([]);
    expect(initial.archivedAt).toBeNull();
  });

  it.each([0n, 100n])(
    'sole required applicant archives immediately even for expense amount %s',
    (amount) => {
      const solo = SettlementSnapshotContent.from(groupId, [
        {
          expenseId: 'solo',
          groupId,
          amount,
          payerParticipantId: 'a',
          allocations: [
            {
              participantId: 'a',
              joinOrder: 1,
              percentage: 100,
              burden: amount,
            },
          ],
        },
      ]);
      const root = submit(solo);
      expect(root.status).toBe('Archived');
      expect(root.archiveReason).toBe('NoPaymentRequired');
      expect(root.archivedAt).toBe(root.snapshot.submittedAt);
      expect(root.approvals).toHaveLength(1);
      expect(root.activePaymentInstructions).toEqual([]);
    },
  );

  it('zero yen with multiple positive shares still requires everyone and permits rejection', () => {
    const zero = SettlementSnapshotContent.from(groupId, [
      {
        ...content().expenses[0],
        amount: 0n,
        allocations: content().expenses[0].allocations.map((x) => ({
          ...x,
          burden: 0n,
        })),
      },
    ]);
    const initial = submit(zero);
    expect(initial.status).toBe('AwaitingApproval');
    const rejected = initial.reject({
      ...decision(),
      reason: '対象を確認したい',
    });
    expect(rejected.status).toBe('Rejected');
    expect(rejected.archiveReason).toBeNull();
  });

  it('never auto-approves an applicant with only nonpayer zero-share involvement', () => {
    const onlyA = SettlementSnapshotContent.from(groupId, [
      {
        ...content().expenses[0],
        allocations: [
          { participantId: 'a', joinOrder: 1, percentage: 100, burden: 100n },
          { participantId: 'b', joinOrder: 2, percentage: 0, burden: 0n },
        ],
      },
    ]);
    const root = submit(onlyA, 'b');
    expect(root.status).toBe('AwaitingApproval');
    expect(root.approvals).toEqual([]);
    expect(root.approve(decision('a')).status).toBe('Archived');
  });
});

describe('SCA-FAIL1: invalid inputs and unchanged state', () => {
  it('does not activate payments from a plain object forged with an empty approval set', () => {
    const source = content();
    const forged = { ...source, requiredApproverIds: [], equals: () => true };
    expectViolation(
      () => SettlementCase.start({ ...startInput(), content: forged }),
      'SNAPSHOT_CONTENT_INVALID',
    );
  });
  it.each([
    '',
    '   ',
    'not-a-uuid',
    uuid(10).toUpperCase(),
    '00000000-0000-4000-8000-00000000000',
  ])('rejects noncanonical case ID %j', (value) => {
    expectViolation(
      () => SettlementCase.start({ ...startInput(), caseId: value }),
      'CASE_ID_INVALID',
    );
  });
  it.each(['', 'invalid', uuid(10).toUpperCase()])(
    'rejects noncanonical snapshot ID %j',
    (value) => {
      expectViolation(
        () => SettlementCase.start({ ...startInput(), snapshotId: value }),
        'SNAPSHOT_ID_INVALID',
      );
    },
  );
  it.each(['', 'invalid', uuid(10).toUpperCase()])(
    'rejects noncanonical instruction ID %j',
    (value) => {
      expectViolation(
        () =>
          SettlementCase.start({ ...startInput(), instructionIds: [value] }),
        'INSTRUCTION_ID_INVALID',
      );
    },
  );
  it.each(['', '  '])('rejects empty actor %j', (value) => {
    expectViolation(
      () =>
        SettlementCase.start({
          ...startInput(),
          applicant: { actorSubject: value, participantId: 'a' },
        }),
      'ACTOR_SUBJECT_EMPTY',
    );
  });
  it.each(['', '  '])('rejects empty applicant participant %j', (value) => {
    expectViolation(
      () =>
        SettlementCase.start({
          ...startInput(),
          applicant: { actorSubject: 'actor-a', participantId: value },
        }),
      'PARTICIPANT_ID_EMPTY',
    );
  });
  it('rejects duplicate instruction IDs across multiple candidates', () => {
    expectViolation(
      () =>
        SettlementCase.start({
          ...startInput(),
          content: threePartyContent(),
          instructionIds: [uuid(20), uuid(20)],
        }),
      'INSTRUCTION_ID_DUPLICATED',
    );
  });
  it.each(
    [[], [uuid(20), uuid(21)]].map((instructionIds) => ({ instructionIds })),
  )('rejects wrong instruction count %j', ({ instructionIds }) => {
    expectViolation(
      () => SettlementCase.start({ ...startInput(), instructionIds }),
      'INSTRUCTION_COUNT_MISMATCH',
    );
  });
  it('rejects nonexistent instructions on zero-balance settlement', () => {
    expectViolation(
      () =>
        SettlementCase.start({ ...startInput(), content: balancedContent() }),
      'INSTRUCTION_COUNT_MISMATCH',
    );
  });
  it('rejects invalid initial date and non-Date input', () => {
    for (const submittedAt of [new Date(NaN), '2026-10-01']) {
      expectViolation(
        () =>
          SettlementCase.start({
            ...startInput(),
            submittedAt,
          } as StartSettlementCase),
        'UTC_INSTANT_INVALID',
      );
    }
  });
  it.each([0, -1, 2, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects wrong/invalid expected version %s',
    (expectedVersion) => {
      const root = submit();
      expectViolation(
        () => root.approve(decision('b', expectedVersion)),
        'CASE_VERSION_CONFLICT',
      );
      expect(root.version).toBe(1);
      expect(root.approvals).toHaveLength(1);
    },
  );
  it('rejects stale version after another vote, and old/other revision ID', () => {
    const root = submit(threePartyContent()).approve(decision());
    expectViolation(
      () => root.approve(decision('c', 1)),
      'CASE_VERSION_CONFLICT',
    );
    expectViolation(
      () => root.approve({ ...decision('c', 2), snapshotId: uuid(99) }),
      'SNAPSHOT_MISMATCH',
    );
    expect(root.status).toBe('AwaitingApproval');
    expect(root.approvals).toHaveLength(2);
  });
  it.each(['outsider', 'rejoined-a', '', 'current-owner'])(
    'does not treat nonrequired participant %j as a proxy',
    (participantId) => {
      const root = submit();
      expectViolation(
        () => root.approve(decision(participantId)),
        'PARTICIPANT_NOT_REQUIRED',
      );
      expectViolation(
        () => root.reject({ ...decision(participantId), reason: '確認' }),
        'PARTICIPANT_NOT_REQUIRED',
      );
    },
  );
  it('rejects repeated or reversed vote without overwriting its original time', () => {
    const root = submit(threePartyContent()).approve(decision());
    expectViolation(
      () => root.approve(decision('a', 2)),
      'APPROVAL_ALREADY_RECORDED',
    );
    expectViolation(
      () => root.approve(decision('b', 2)),
      'APPROVAL_ALREADY_RECORDED',
    );
    expectViolation(
      () => root.reject({ ...decision('b', 2), reason: '判断変更' }),
      'APPROVAL_ALREADY_RECORDED',
    );
    expect(root.approvals.map((x) => x.decision)).toEqual([
      'Approved',
      'Approved',
    ]);
  });
  it.each(['', ' \n\t '])(
    'rejects empty reason %j without consuming the approval',
    (reason) => {
      const root = submit();
      expectViolation(
        () => root.reject({ ...decision(), reason }),
        'REJECTION_REASON_EMPTY',
      );
      expect(root.approve(decision()).status).toBe('PaymentActive');
    },
  );
  it('invalid decision dates fail both approve/reject without partial recording', () => {
    const root = submit();
    const input = { ...decision(), decidedAt: new Date(NaN) };
    expectViolation(() => root.approve(input), 'UTC_INSTANT_INVALID');
    expectViolation(
      () => root.reject({ ...input, reason: '確認' }),
      'UTC_INSTANT_INVALID',
    );
    expect(root.approvals).toHaveLength(1);
    expect(root.status).toBe('AwaitingApproval');
  });
  it.each(['PaymentActive', 'Rejected', 'Archived'] as const)(
    'cannot add any approval after %s',
    (state) => {
      const root =
        state === 'Archived'
          ? submit(balancedContent()).approve(decision())
          : state === 'Rejected'
            ? submit().reject({ ...decision(), reason: '確認' })
            : submit().approve(decision());
      const original = root.approvals;
      expect(root.status).toBe(state);
      expectViolation(
        () => root.approve(decision('b', root.version)),
        'CASE_NOT_AWAITING_APPROVAL',
      );
      expectViolation(
        () => root.reject({ ...decision('b', root.version), reason: '変更' }),
        'CASE_NOT_AWAITING_APPROVAL',
      );
      expect(root.approvals).toBe(original);
    },
  );
  it('exposed root, nested snapshot, candidates, approvals and active arrays are frozen', () => {
    const root = submit().approve(decision());
    for (const value of [
      root,
      root.targetExpenseIds,
      root.snapshot,
      root.snapshot.applicant,
      root.snapshot.content,
      root.snapshot.paymentInstructionCandidates,
      root.snapshot.paymentInstructionCandidates[0],
      root.approvals,
      root.approvals[0],
      root.activePaymentInstructions,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(() => Reflect.set(root, 'status', 'Rejected')).not.toThrow();
    expect(Reflect.set(root, 'status', 'Rejected')).toBe(false);
    expect(
      Reflect.set(root.snapshot.applicant, 'participantId', 'rejoined-a'),
    ).toBe(false);
    expect(Reflect.set(root.approvals[0], 'decision', 'Rejected')).toBe(false);
    expect(Reflect.set(root.activePaymentInstructions[0], 'amount', 1n)).toBe(
      false,
    );
    expect(() => (root.approvals as unknown[]).push({})).toThrow(TypeError);
    expect(root.status).toBe('PaymentActive');
    expect(root.activePaymentInstructions[0].amount).toBe(50n);
  });
});
