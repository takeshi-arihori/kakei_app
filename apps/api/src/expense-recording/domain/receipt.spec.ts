import { describe, expect, it } from 'vitest';

import {
  Receipt,
  type ConfirmReceipt,
  type ReceiptDraftInput,
} from './receipt.js';
import { ReceiptInvariantViolation } from './receipt-invariant-violation.js';

const draftInput = (
  overrides: Partial<ReceiptDraftInput> = {},
): ReceiptDraftInput => ({
  id: 'receipt-1',
  uploaderSubject: 'uploader-1',
  occurredOn: '2026-10-01',
  declaredTotal: 350,
  items: [
    { id: 'item-a', name: 'Tea', amount: 100, categoryId: 'category-food' },
    { id: 'item-b', name: 'Cup', amount: 200, categoryId: 'category-tools' },
  ],
  adjustments: [{ kind: 'Tax', amount: 50, target: { scope: 'Receipt' } }],
  ...overrides,
});

const confirmation = (
  overrides: Partial<ConfirmReceipt> = {},
): ConfirmReceipt => ({
  expectedVersion: 1,
  actorSubject: 'uploader-1',
  confirmedAt: new Date('2026-10-02T00:00:00.000Z'),
  occurredOn: '2026-10-01',
  declaredTotal: 350,
  items: [
    { id: 'item-a', name: 'Tea', amount: 100, categoryId: 'category-food' },
    { id: 'item-b', name: 'Cup', amount: 200, categoryId: 'category-tools' },
  ],
  adjustments: [{ kind: 'Tax', amount: 50, target: { scope: 'Receipt' } }],
  ...overrides,
});

const createDraft = (overrides: Partial<ReceiptDraftInput> = {}): Receipt =>
  Receipt.createDraft(draftInput(overrides));

const expectReceiptFailure = (action: () => unknown, code: string): void => {
  try {
    action();
    throw new Error('Expected ReceiptInvariantViolation');
  } catch (error) {
    expect(error).toBeInstanceOf(ReceiptInvariantViolation);
    expect((error as ReceiptInvariantViolation).code).toBe(code);
    expect((error as Error).message).toBe('Receipt invariant violated');
  }
};

describe('Receipt Draft manual confirmation', () => {
  it('keeps the same Receipt identity and advances exactly one version on confirmation', () => {
    const draft = createDraft();
    const confirmed = draft.confirm(confirmation());

    expect(draft.snapshot().status).toBe('Draft');
    expect(confirmed.snapshot().status).toBe('Confirmed');
    expect(confirmed.id.value).toBe('receipt-1');
    expect(confirmed.version).toBe(draft.version + 1);
    expect(confirmed.changes).toHaveLength(1);
    expect(confirmed.changes[0]).toMatchObject({
      action: 'Confirmed',
      actorSubject: 'uploader-1',
      previousVersion: draft.version,
      version: confirmed.version,
      before: draft.snapshot(),
    });
    expect(confirmed.changes[0]?.at).toBe('2026-10-02T00:00:00.000Z');
    expect(Object.isFrozen(confirmed)).toBe(true);
  });

  it('confirms only the manually reviewed facts and their adjusted amounts', () => {
    const draft = createDraft();
    const confirmed = draft.confirm(
      confirmation({
        declaredTotal: 360,
        items: [
          {
            id: 'item-a',
            name: 'Green Tea',
            amount: 110,
            categoryId: 'category-food',
          },
          {
            id: 'item-b',
            name: 'Cup',
            amount: 200,
            categoryId: 'category-tools',
          },
        ],
        adjustments: [
          { kind: 'Tax', amount: 50, target: { scope: 'Receipt' } },
        ],
      }),
    );
    const snapshot = confirmed.snapshot();

    expect(snapshot.status).toBe('Confirmed');
    if (snapshot.status !== 'Confirmed') throw new Error('Expected Confirmed');
    expect(snapshot.items.map((item) => item.name)).toEqual([
      'Green Tea',
      'Cup',
    ]);
    expect(snapshot.items.map((item) => item.adjustedAmount)).toEqual([
      128, 232,
    ]);
    expect(snapshot.declaredTotal).toBe(360);
    expect(draft.snapshot().status).toBe('Draft');
  });

  it('allows a reviewed adjustment to be removed instead of promoting the candidate', () => {
    const draft = createDraft();
    const confirmed = draft.confirm(
      confirmation({
        declaredTotal: 300,
        adjustments: [],
      }),
    );
    const snapshot = confirmed.snapshot();

    expect(snapshot.status).toBe('Confirmed');
    if (snapshot.status !== 'Confirmed') throw new Error('Expected Confirmed');
    expect(snapshot.adjustments).toEqual([]);
    expect(snapshot.items.map((item) => item.adjustedAmount)).toEqual([
      100, 200,
    ]);
  });

  it('rejects a declared total that differs from the adjusted Item sum without changing the Draft', () => {
    const draft = createDraft();
    const before = draft.snapshot();

    expectReceiptFailure(
      () => draft.confirm(confirmation({ declaredTotal: 351 })),
      'RECEIPT_TOTAL_MISMATCH',
    );
    expect(draft.snapshot()).toBe(before);
    expect(draft.version).toBe(1);
    expect(draft.changes).toEqual([]);
  });

  it.each([null, '', '2026-02-29', '2026-13-01'])(
    'rejects missing or invalid occurredOn %s',
    (occurredOn) => {
      const draft = createDraft({ occurredOn });

      expectReceiptFailure(
        () => draft.confirm(confirmation({ occurredOn: occurredOn as string })),
        'OCCURRED_ON_INVALID',
      );
    },
  );

  it('rejects a caller that is not the recorded Uploader', () => {
    const draft = createDraft();

    expectReceiptFailure(
      () => draft.confirm(confirmation({ actorSubject: 'other-user' })),
      'ACTOR_NOT_UPLOADER',
    );
  });

  it('rejects a stale expected version and keeps the previous Root unchanged', () => {
    const draft = createDraft();

    expectReceiptFailure(
      () => draft.confirm(confirmation({ expectedVersion: 2 })),
      'VERSION_CONFLICT',
    );
    expect(draft.version).toBe(1);
    expect(draft.snapshot().status).toBe('Draft');
  });

  it('rejects confirmation after the Root has already transitioned', () => {
    const confirmed = createDraft().confirm(confirmation());

    expectReceiptFailure(
      () =>
        confirmed.confirm(confirmation({ expectedVersion: confirmed.version })),
      'RECEIPT_NOT_DRAFT',
    );
  });

  it('deeply freezes transition history and keeps caller-owned input independent', () => {
    const input = confirmation();
    const draft = createDraft();
    const confirmed = draft.confirm(input);
    Reflect.set(input.items[0], 'name', 'Changed later');
    Reflect.set(input.adjustments[0].target, 'scope', 'Item');

    const change = confirmed.changes[0];
    expect(change.after.items[0]?.name).toBe('Tea');
    expect(change.after.adjustments[0]?.target).toEqual({ scope: 'Receipt' });
    expect(Object.isFrozen(confirmed.changes)).toBe(true);
    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(change.before)).toBe(true);
    expect(Object.isFrozen(change.after.items)).toBe(true);
    expect(Object.isFrozen(change.after.items[0])).toBe(true);
    expect(Object.isFrozen(change.after.adjustments[0]?.target)).toBe(true);
  });

  it('rejects invalid Adjustment facts without exposing partial confirmation', () => {
    const draft = createDraft();

    expectReceiptFailure(
      () =>
        draft.confirm(
          confirmation({
            adjustments: [
              { kind: 'Discount', amount: 1, target: { scope: 'Receipt' } },
            ],
          }),
        ),
      'ADJUSTMENT_INVALID',
    );
    expect(draft.snapshot().status).toBe('Draft');
  });
});
