import {
  derivePaymentInstructionCandidates,
  type PaymentInstructionCandidate,
} from '../payment-instruction-derivation.js';
import { SettlementInvariantViolation } from '../settlement-invariant-violation.js';
import {
  SnapshotContentInvariantViolation,
  type SnapshotContentInvariantViolationCode,
} from '../snapshot-content-invariant-violation.js';
import { ParticipantBalance } from './participant-balance.js';

/** ERで配賦済みの過去事実。現在membershipや現在Actorの証拠にしない。 */
export type SnapshotExpenseAllocation = {
  /** 再参加時の新IDへ置き換えないParticipant参照。 */
  readonly participantId: string;
  /** 固定Group内で一意な履歴上の参加順。 */
  readonly joinOrder: number;
  /** 10%刻みの負担割合。必要承認者は負担額でなく割合で判断する。 */
  readonly percentage: number;
  /** ERで最大剰余配賦済みの非負JPY整数。本Contextで再配賦しない。 */
  readonly burden: bigint;
};

/** 明示選択した支出の算術facts。公開Port／保存Schemaの採用ではない。 */
export type SnapshotExpenseFact = {
  /** 同じ支出を追跡する参照。選択集合内で一意とする。 */
  readonly expenseId: string;
  /** Source取得時に照合するcanonical Group参照。 */
  readonly groupId: string;
  /** 固定JPY整数総額。0円でも必要承認者のRuleを維持する。 */
  readonly amount: bigint;
  /** 固定allocation内に存在する、実支払者の過去Participant参照。 */
  readonly payerParticipantId: string;
  /** 登録時の1〜4人と配賦。歴史上のunion人数上限とは区別する。 */
  readonly allocations: readonly SnapshotExpenseAllocation[];
};

const requireCondition = (
  condition: boolean,
  code: SnapshotContentInvariantViolationCode,
): void => {
  if (!condition) throw new SnapshotContentInvariantViolation(code);
};

const nonnegativeInteger = (amount: bigint): boolean =>
  typeof amount === 'bigint' && amount >= 0n;

type AccumulatedBalance = { joinOrder: number; amount: bigint };

/** Case配下のRevisionへ渡す不変な算術内容。ID・承認状態・保存を所有しない。 */
export class SettlementSnapshotContent {
  /** 内部集計額の通貨。公開ScalarやJSON表現を決めない。 */
  readonly currency = 'JPY' as const;

  private constructor(
    /** 全選択Expenseが属するcanonical Group参照。認可証拠ではない。 */
    readonly groupId: string,
    /** 明示選択のみをcopyして固定した、ID順の配賦済み支出facts。 */
    readonly expenses: readonly SnapshotExpenseFact[],
    /** 実支払額−負担額の合算。0額と旧Participantも保持する。 */
    readonly balances: readonly ParticipantBalance[],
    /** 未承認の最少送金候補。全員0なら空であり承認不要を意味しない。 */
    readonly candidates: readonly PaymentInstructionCandidate[],
    /** payerまたは正割合のParticipant unionを参加順で固定した必要承認者。 */
    readonly requiredApproverIds: readonly string[],
  ) {
    Object.freeze(this);
  }

  /**
   * 選択factsを固定し、残高と必要承認者を算出する。ERの端数Ruleは再実装しない。
   * @param groupId Source取得で照合したcanonical Group参照。
   * @param expenses 認可・固定判断点を後続Applicationで確認する配賦済みfacts。
   * @returns 入力や現在membershipの変更を伝播させない不変な算術内容。
   * @throws SnapshotContentInvariantViolation 選択、Group、配賦の値・保存則・参加順対応が矛盾する場合。
   * @throws SettlementInvariantViolation Participant参照・参加順が無効または支出内で重複する場合。
   */
  static from(
    groupId: string,
    expenses: readonly SnapshotExpenseFact[],
  ): SettlementSnapshotContent {
    requireCondition(
      typeof groupId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          groupId,
        ),
      'GROUP_REFERENCE_INVALID',
    );
    requireCondition(expenses.length > 0, 'SELECTION_EMPTY');
    const expenseIds = new Set<string>();
    const participants = new Map<string, AccumulatedBalance>();
    const participantByOrder = new Map<number, string>();
    const approvers = new Set<string>();
    const fixedExpenses: SnapshotExpenseFact[] = [];

    for (const expense of expenses) {
      requireCondition(
        typeof expense.expenseId === 'string' &&
          expense.expenseId.trim().length > 0,
        'EXPENSE_REFERENCE_EMPTY',
      );
      requireCondition(
        !expenseIds.has(expense.expenseId),
        'EXPENSE_DUPLICATED',
      );
      expenseIds.add(expense.expenseId);
      requireCondition(expense.groupId === groupId, 'EXPENSE_GROUP_MISMATCH');
      requireCondition(
        nonnegativeInteger(expense.amount),
        'EXPENSE_AMOUNT_INVALID',
      );
      requireCondition(
        expense.allocations.length >= 1 && expense.allocations.length <= 4,
        'ALLOCATION_COUNT_INVALID',
      );
      const ids = new Set<string>();
      const orders = new Set<number>();
      let percentageTotal = 0;
      let burdenTotal = 0n;
      let payer: AccumulatedBalance | undefined;
      const fixedAllocations: SnapshotExpenseAllocation[] = [];

      for (const allocation of expense.allocations) {
        ParticipantBalance.from(
          allocation.participantId,
          allocation.joinOrder,
          0n,
        );
        if (ids.has(allocation.participantId))
          throw new SettlementInvariantViolation(
            'PARTICIPANT_DUPLICATED',
            'Expense participants must be unique',
          );
        if (orders.has(allocation.joinOrder))
          throw new SettlementInvariantViolation(
            'JOIN_ORDER_DUPLICATED',
            'Expense join orders must be unique',
          );
        ids.add(allocation.participantId);
        orders.add(allocation.joinOrder);
        const existing = participants.get(allocation.participantId);
        const reference = participantByOrder.get(allocation.joinOrder);
        requireCondition(
          (!existing || existing.joinOrder === allocation.joinOrder) &&
            (reference === undefined || reference === allocation.participantId),
          'PARTICIPANT_ORDER_CONFLICT',
        );
        requireCondition(
          Number.isInteger(allocation.percentage) &&
            allocation.percentage >= 0 &&
            allocation.percentage <= 100 &&
            allocation.percentage % 10 === 0,
          'ALLOCATION_PERCENTAGE_INVALID',
        );
        requireCondition(
          nonnegativeInteger(allocation.burden),
          'ALLOCATION_BURDEN_INVALID',
        );
        requireCondition(
          allocation.percentage !== 0 || allocation.burden === 0n,
          'ZERO_SHARE_BURDEN_INVALID',
        );
        percentageTotal += allocation.percentage;
        burdenTotal += allocation.burden;
        const participant = existing ?? {
          joinOrder: allocation.joinOrder,
          amount: 0n,
        };
        participant.amount -= allocation.burden;
        participants.set(allocation.participantId, participant);
        participantByOrder.set(allocation.joinOrder, allocation.participantId);
        if (allocation.percentage > 0) approvers.add(allocation.participantId);
        if (allocation.participantId === expense.payerParticipantId)
          payer = participant;
        fixedAllocations.push(
          Object.freeze({
            participantId: allocation.participantId,
            joinOrder: allocation.joinOrder,
            percentage: allocation.percentage,
            burden: allocation.burden,
          }),
        );
      }
      requireCondition(
        percentageTotal === 100,
        'ALLOCATION_PERCENTAGE_TOTAL_INVALID',
      );
      requireCondition(
        burdenTotal === expense.amount,
        'ALLOCATION_BURDEN_TOTAL_INVALID',
      );
      if (!payer)
        throw new SnapshotContentInvariantViolation('PAYER_NOT_PARTICIPANT');
      payer.amount += expense.amount;
      approvers.add(expense.payerParticipantId);
      fixedExpenses.push(
        Object.freeze({
          expenseId: expense.expenseId,
          groupId: expense.groupId,
          amount: expense.amount,
          payerParticipantId: expense.payerParticipantId,
          allocations: Object.freeze(
            fixedAllocations.sort((a, b) => a.joinOrder - b.joinOrder),
          ),
        }),
      );
    }
    const balances = Object.freeze(
      [...participants]
        .map(([id, balance]) =>
          ParticipantBalance.from(id, balance.joinOrder, balance.amount),
        )
        .sort((a, b) => a.joinOrder - b.joinOrder),
    );
    return new SettlementSnapshotContent(
      groupId,
      Object.freeze(
        fixedExpenses.sort((a, b) =>
          a.expenseId < b.expenseId ? -1 : a.expenseId > b.expenseId ? 1 : 0,
        ),
      ),
      balances,
      derivePaymentInstructionCandidates(balances),
      Object.freeze(
        balances
          .filter((p) => approvers.has(p.participantId))
          .map((p) => p.participantId),
      ),
    );
  }

  /**
   * canonicalな元factsで値比較する。残高・候補・承認者は同じfactsから決定される。
   * @param other 比較する固定算術内容。
   * @returns 同じGroup・選択Expense・固定配賦内容ならtrue。
   */
  equals(other: SettlementSnapshotContent): boolean {
    return (
      this.groupId === other.groupId &&
      this.expenses.length === other.expenses.length &&
      this.expenses.every((expense, i) => {
        const target = other.expenses[i];
        return (
          expense.expenseId === target.expenseId &&
          expense.amount === target.amount &&
          expense.payerParticipantId === target.payerParticipantId &&
          expense.allocations.length === target.allocations.length &&
          expense.allocations.every((allocation, j) => {
            const candidate = target.allocations[j];
            return (
              allocation.participantId === candidate.participantId &&
              allocation.joinOrder === candidate.joinOrder &&
              allocation.percentage === candidate.percentage &&
              allocation.burden === candidate.burden
            );
          })
        );
      })
    );
  }
}
