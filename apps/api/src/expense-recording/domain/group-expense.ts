import { Money } from '../../shared/domain/money.js';

import { ExpenseInvariantViolation } from './expense-invariant-violation.js';
import { ExpenseId } from './value-objects/expense-id.js';
import { OccurredOn } from './value-objects/occurred-on.js';

/** Applicationが登録判断時に取得する参加者事実。現在の認可の証拠にはしない。 */
export type ExpenseParticipantInput = {
  /** 再参加で再利用しない、登録時点のParticipant参照。 */
  readonly participantId: string;
  /** GMが付与する1以上の一意な参加順。配列順から推測しない。 */
  readonly joinOrder: number;
  /** 0〜100の10%刻み。全Participantで合計100%とする。 */
  readonly percentage: number;
};

/** 内部Domain生成用の事実。信頼Actor・Active判定・fence確認はApplicationが担う。 */
export type RegisterGroupExpenseInput = {
  /** 前段で発番した支出識別子。ここでは発番・再送判定を行わない。 */
  readonly id: string;
  /** ADR #85のcanonical Group IDを値として参照する。 */
  readonly groupId: string;
  /** 手入力の登録者。Participant寿命と別の安定Actor参照で本人性は証明しない。 */
  readonly sourceOwnerSubject: string;
  /** 購入の暦日。登録Timestampと混同しない。 */
  readonly occurredOn: string;
  /** JPY整数額。非負safe integerは実装制限でありProduct上限ではない。 */
  readonly amount: number;
  /** 実支払者の登録時Participant参照。固定集合内に存在すること。 */
  readonly payerParticipantId: string;
  /** 登録時点の全対象Participantと配賦。後からMembershipを反映しない。 */
  readonly participants: readonly ExpenseParticipantInput[];
};

/** 登録時のParticipant参照・割合・負担を一体として固定した値。 */
export type ExpenseAllocation = {
  /** 過去の支払責務を保持するParticipant参照。 */
  readonly participantId: string;
  /** 最大剰余の同率時に使う、登録時の参加順。 */
  readonly joinOrder: number;
  /** 登録時の10%刻みの割合。0%は0円のまま保持する。 */
  readonly percentage: number;
  /** 合計額と整数配賦から導出する、変更できないJPY負担。 */
  readonly burden: Money;
};

/** 精算への入力となる不変な登録事実。公開APIや保存Schemaを定める型ではない。 */
export type GroupExpenseSnapshot = {
  /** 同じ支出を追跡する不変な識別子。 */
  readonly id: ExpenseId;
  /** この支出が所属するGroupのcanonical参照。 */
  readonly groupId: string;
  /** 手入力のSource Ownerとして保持する登録Actor参照。 */
  readonly sourceOwnerSubject: string;
  /** 購入月の根拠となる購入暦日。 */
  readonly occurredOn: OccurredOn;
  /** 登録時のJPY総額。外部から額・通貨を変更できない。 */
  readonly total: Money;
  /** 途中脱退しても書き換えない実支払者のParticipant参照。 */
  readonly payerParticipantId: string;
  /** 参加順で固定する全Participantの割合と負担。 */
  readonly allocations: readonly ExpenseAllocation[];
};

const requireReference = (value: string): void => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExpenseInvariantViolation(
      'IDENTIFIER_EMPTY',
      'Participant and source owner references must not be empty',
    );
  }
};

const immutableMoney = (amount: number): Money =>
  Object.freeze(Money.jpy(amount));

/** 個別の手入力支出をRootとし、固定登録事実と整数配賦のInvariantを守る。 */
export class GroupExpense {
  private constructor(private readonly state: GroupExpenseSnapshot) {
    Object.freeze(this);
  }

  /**
   * 訂正やCase選択で維持する支出の同一性を返す。
   * @returns このRootの変更できないExpense ID。
   */
  get id(): ExpenseId {
    return this.state.id;
  }

  /**
   * 入力を検証・copyして登録事実を固定する。認可・予約・commitは行わない。
   * @param input Applicationから渡す登録時の事実。
   * @returns 割合の合計と負担額の合計を保証する不変な支出Root。
   * @throws ExpenseInvariantViolation 識別子、暦日、金額、参加者、配賦が無効の場合。
   */
  static register(input: RegisterGroupExpenseInput): GroupExpense {
    const id = ExpenseId.from(input.id);
    // ADR #85の公開ID値だけを参照し、GMのEntityやDomain型へ依存しない。
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        input.groupId,
      )
    ) {
      throw new ExpenseInvariantViolation(
        'GROUP_ID_INVALID',
        'Group reference must be a lowercase canonical UUID',
      );
    }
    requireReference(input.sourceOwnerSubject);
    requireReference(input.payerParticipantId);
    const occurredOn = OccurredOn.from(input.occurredOn);
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
      throw new ExpenseInvariantViolation(
        'AMOUNT_INVALID',
        'JPY amount must be a non-negative safe integer',
      );
    }
    if (input.participants.length < 1 || input.participants.length > 4) {
      throw new ExpenseInvariantViolation(
        'PARTICIPANT_COUNT_INVALID',
        'Expense must contain one to four participants',
      );
    }

    const participantIds = new Set<string>();
    const joinOrders = new Set<number>();
    let percentageTotal = 0;
    for (const participant of input.participants) {
      requireReference(participant.participantId);
      if (participantIds.has(participant.participantId)) {
        throw new ExpenseInvariantViolation(
          'PARTICIPANT_DUPLICATED',
          'Expense participants must be unique',
        );
      }
      participantIds.add(participant.participantId);
      if (
        !Number.isSafeInteger(participant.joinOrder) ||
        participant.joinOrder < 1
      ) {
        throw new ExpenseInvariantViolation(
          'JOIN_ORDER_INVALID',
          'Join order must be a positive safe integer',
        );
      }
      if (joinOrders.has(participant.joinOrder)) {
        throw new ExpenseInvariantViolation(
          'JOIN_ORDER_DUPLICATED',
          'Expense join orders must be unique',
        );
      }
      joinOrders.add(participant.joinOrder);
      if (
        !Number.isInteger(participant.percentage) ||
        participant.percentage < 0 ||
        participant.percentage > 100 ||
        participant.percentage % 10 !== 0
      ) {
        throw new ExpenseInvariantViolation(
          'PERCENTAGE_INVALID',
          'Split percentages must be zero to one hundred in steps of ten',
        );
      }
      percentageTotal += participant.percentage;
    }
    if (percentageTotal !== 100) {
      throw new ExpenseInvariantViolation(
        'PERCENTAGE_TOTAL_INVALID',
        'Split percentages must total one hundred',
      );
    }
    if (!participantIds.has(input.payerParticipantId)) {
      throw new ExpenseInvariantViolation(
        'PAYER_NOT_PARTICIPANT',
        'Payer must be an expense participant',
      );
    }

    // safe integerでも割合との積は範囲外になり得るため、積から端数まで整数演算する。
    const total = BigInt(input.amount);
    const shares = input.participants.map((participant) => {
      const product = total * BigInt(participant.percentage);
      return {
        participantId: participant.participantId,
        joinOrder: participant.joinOrder,
        percentage: participant.percentage,
        burden: product / 100n,
        remainder: product % 100n,
      };
    });
    const remaining = Number(
      total - shares.reduce((sum, share) => sum + share.burden, 0n),
    );
    shares.sort((left, right) => {
      const remainderOrder = Number(right.remainder - left.remainder);
      if (remainderOrder !== 0) return remainderOrder;
      const payerOrder =
        Number(right.participantId === input.payerParticipantId) -
        Number(left.participantId === input.payerParticipantId);
      return payerOrder || left.joinOrder - right.joinOrder;
    });
    // 最大剰余では追加は各人1円まで。残りがあるとき0%は配布先にならない。
    for (const share of shares.slice(0, remaining)) share.burden += 1n;
    const allocations = shares
      .sort((left, right) => left.joinOrder - right.joinOrder)
      .map((share): ExpenseAllocation =>
        Object.freeze({
          participantId: share.participantId,
          joinOrder: share.joinOrder,
          percentage: share.percentage,
          burden: immutableMoney(Number(share.burden)),
        }),
      );

    return new GroupExpense(
      Object.freeze({
        id,
        groupId: input.groupId,
        sourceOwnerSubject: input.sourceOwnerSubject,
        occurredOn,
        total: immutableMoney(input.amount),
        payerParticipantId: input.payerParticipantId,
        allocations: Object.freeze(allocations),
      }),
    );
  }

  /**
   * 後続計算用の登録事実を返す。金額・配列・各値も変更できない。
   * @returns callerの入力や現在Membershipに追随しない固定facts。
   */
  snapshot(): GroupExpenseSnapshot {
    return this.state;
  }
}
