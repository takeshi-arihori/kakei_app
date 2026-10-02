import {
  ReceiptAdjustmentViolation,
  type ReceiptAdjustmentViolationCode,
} from './receipt-adjustment-violation.js';

/** 調整前Receipt Itemを識別し、元金額を保持する計算入力。 */
export type ReceiptAdjustmentItemInput = {
  /** この計算内で一意なReceipt Item参照。 */
  readonly id: string;
  /** Adjustment前の0以上のJPY整数額。 */
  readonly amount: number;
};

/** 税・送料・値引き・Point利用を表すReceipt Adjustment種別。 */
export type ReceiptAdjustmentKind = 'Tax' | 'Shipping' | 'Discount' | 'Point';

/** Receipt全体へ比例配賦するAdjustment対象。 */
export type ReceiptAdjustmentReceiptTarget = {
  /** 対象がReceipt全体であることを示す識別値。 */
  readonly scope: 'Receipt';
};

/** 特定のReceipt Itemだけへ適用するAdjustment対象。 */
export type ReceiptAdjustmentItemTarget = {
  /** 対象が単一Itemであることを示す識別値。 */
  readonly scope: 'Item';
  /** 入力Item内に存在する対象Item参照。 */
  readonly itemId: string;
};

/** 種別・符号・対象を一体にしたAdjustment計算入力。 */
export type ReceiptAdjustmentInput = {
  /** Adjustmentの業務種別。 */
  readonly kind: ReceiptAdjustmentKind;
  /** 税・送料は正、値引き・Pointは負の非0 safe integer。 */
  readonly amount: number;
  /** Receipt全体、または特定Itemの適用範囲。 */
  readonly target: ReceiptAdjustmentReceiptTarget | ReceiptAdjustmentItemTarget;
};

/** 1 Adjustmentが各入力Itemへ適用した符号付き整数額。 */
export type ReceiptAdjustmentAllocationResult = {
  /** 結果内のAdjustment順で参照できる種別。 */
  readonly kind: ReceiptAdjustmentKind;
  /** 検証済みの符号付きAdjustment合計額。 */
  readonly amount: number;
  /** 入力Item順に対応する配賦JPY額。非対象Itemは0円。 */
  readonly amounts: readonly number[];
};

/** 元Itemと全Adjustmentを反映した不変の1行結果。 */
export type AdjustedReceiptItem = {
  /** 入力順で維持するReceipt Item参照。 */
  readonly id: string;
  /** Adjustment計算へ使った未調整JPY額。 */
  readonly originalAmount: number;
  /** 全Adjustmentを加算した非負safe integerのJPY額。 */
  readonly adjustedAmount: number;
};

/** Adjustment明細と調整後Itemを一括して返す不変計算結果。 */
export type ReceiptAdjustmentCalculation = {
  /** Receipt Item入力順を維持した調整後Item値。 */
  readonly items: readonly AdjustedReceiptItem[];
  /** Adjustment入力順で各Itemへの円配賦を示す。 */
  readonly allocations: readonly ReceiptAdjustmentAllocationResult[];
};

const reject = (
  code: ReceiptAdjustmentViolationCode,
  message: string,
): never => {
  throw new ReceiptAdjustmentViolation(code, message);
};

const immutableAllocation = (
  adjustment: ReceiptAdjustmentInput,
  amounts: readonly number[],
): ReceiptAdjustmentAllocationResult =>
  Object.freeze({
    kind: adjustment.kind,
    amount: adjustment.amount,
    amounts: Object.freeze([...amounts]),
  });

/** Receipt Adjustmentを元金額から独立に配賦するstateless Domain Service。 */
export class ReceiptAdjustmentAllocation {
  private constructor() {}

  /**
   * Adjustmentを検証し、各Itemへ整数配賦した新しい不変結果を作る。
   * @param items 調整前のReceipt Item。配列順が端数同率時の優先順となる。
   * @param adjustments 入力順で保持するAdjustment。各Receipt全体配賦は同じ元金額を重みにする。
   * @returns Adjustment配賦と調整後Item。どの行も負額またはsafe integer外にならない。
   * @throws ReceiptAdjustmentViolation 入力、対象、符号、配賦基準または最終金額が不正な場合。
   */
  static calculate(
    items: readonly ReceiptAdjustmentItemInput[],
    adjustments: readonly ReceiptAdjustmentInput[],
  ): ReceiptAdjustmentCalculation {
    const itemIds = new Set<string>();
    const itemAmounts: bigint[] = [];
    for (const item of items) {
      if (typeof item.id !== 'string' || item.id.trim().length === 0) {
        reject('ITEM_REFERENCE_INVALID', 'Receipt Item reference is invalid');
      }
      if (itemIds.has(item.id)) {
        reject(
          'ITEM_REFERENCE_DUPLICATED',
          'Receipt Item references must be unique',
        );
      }
      itemIds.add(item.id);
      if (!Number.isSafeInteger(item.amount) || item.amount < 0) {
        reject('ITEM_AMOUNT_INVALID', 'Receipt Item amount is invalid');
      }
      itemAmounts.push(BigInt(item.amount));
    }

    const originalTotal = itemAmounts.reduce(
      (total, amount) => total + amount,
      0n,
    );
    const adjustedAmounts = [...itemAmounts];
    const allocations: ReceiptAdjustmentAllocationResult[] = [];

    for (const adjustment of adjustments) {
      const { kind, amount, target } = adjustment;
      if (
        kind !== 'Tax' &&
        kind !== 'Shipping' &&
        kind !== 'Discount' &&
        kind !== 'Point'
      ) {
        reject('ADJUSTMENT_KIND_INVALID', 'Receipt Adjustment kind is invalid');
      }
      if (!Number.isSafeInteger(amount) || amount === 0) {
        reject(
          'ADJUSTMENT_AMOUNT_INVALID',
          'Receipt Adjustment amount must be a non-zero safe integer',
        );
      }
      const mustBePositive = kind === 'Tax' || kind === 'Shipping';
      if ((mustBePositive && amount < 0) || (!mustBePositive && amount > 0)) {
        reject('ADJUSTMENT_SIGN_INVALID', 'Receipt Adjustment sign is invalid');
      }

      const allocated = Array<number>(items.length).fill(0);
      if (target?.scope === 'Item') {
        if (
          typeof target.itemId !== 'string' ||
          target.itemId.trim().length === 0
        ) {
          reject(
            'ADJUSTMENT_TARGET_INVALID',
            'Receipt Adjustment target is invalid',
          );
        }
        const itemIndex = items.findIndex((item) => item.id === target.itemId);
        if (itemIndex < 0) {
          reject(
            'ADJUSTMENT_ITEM_NOT_FOUND',
            'Receipt Adjustment Item target does not exist',
          );
        }
        allocated[itemIndex] = amount;
      } else if (target?.scope === 'Receipt') {
        if (originalTotal === 0n) {
          reject(
            'RECEIPT_ADJUSTMENT_BASIS_ZERO',
            'Receipt-wide Adjustment requires a positive original Item total',
          );
        }
        const absoluteAmount = BigInt(Math.abs(amount));
        const remainders: { readonly index: number; readonly value: bigint }[] =
          [];
        let floorTotal = 0n;
        for (let index = 0; index < itemAmounts.length; index += 1) {
          const weight = itemAmounts[index];
          const product = absoluteAmount * weight;
          const quotient = product / originalTotal;
          const remainder = product % originalTotal;
          allocated[index] = Number(quotient);
          floorTotal += quotient;
          remainders.push({ index, value: remainder });
        }
        let remaining = absoluteAmount - floorTotal;
        remainders.sort((left, right) => {
          if (left.value === right.value) return left.index - right.index;
          return left.value > right.value ? -1 : 1;
        });
        for (const { index } of remainders) {
          if (remaining === 0n) break;
          if (itemAmounts[index] === 0n) continue;
          allocated[index] = allocated[index] + 1;
          remaining -= 1n;
        }
        if (remaining !== 0n) {
          reject(
            'ADJUSTMENT_AMOUNT_INVALID',
            'Receipt Adjustment could not be allocated',
          );
        }
        if (amount < 0) {
          for (let index = 0; index < allocated.length; index += 1) {
            allocated[index] = -allocated[index];
          }
        }
      } else {
        reject(
          'ADJUSTMENT_TARGET_INVALID',
          'Receipt Adjustment target is invalid',
        );
      }

      for (let index = 0; index < allocated.length; index += 1) {
        adjustedAmounts[index] =
          adjustedAmounts[index] + BigInt(allocated[index]);
      }
      allocations.push(immutableAllocation(adjustment, allocated));
    }

    const resultItems = items.map((item, index) => {
      const amount = adjustedAmounts[index];
      if (amount < 0n) {
        reject(
          'ADJUSTED_AMOUNT_NEGATIVE',
          'Adjusted Receipt Item amount is negative',
        );
      }
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        reject(
          'ADJUSTED_AMOUNT_UNSAFE',
          'Adjusted Receipt Item amount is unsafe',
        );
      }
      return Object.freeze({
        id: item.id,
        originalAmount: item.amount,
        adjustedAmount: Number(amount),
      });
    });

    return Object.freeze({
      items: Object.freeze(resultItems),
      allocations: Object.freeze(allocations),
    });
  }
}
