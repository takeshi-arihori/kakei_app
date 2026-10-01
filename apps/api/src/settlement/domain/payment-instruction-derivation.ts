import { SettlementInvariantViolation } from './settlement-invariant-violation.js';
import type { ParticipantBalance } from './value-objects/participant-balance.js';

/** 全員承認前の不変な送金候補。支払指示の有効化・発番は行わない。 */
export type PaymentInstructionCandidate = {
  /** 負の残高から導出した支払責務のParticipant参照。 */
  readonly payerParticipantId: string;
  /** 正の残高から導出した受取責務のParticipant参照。 */
  readonly payeeParticipantId: string;
  /** 全額相殺に使う正のJPY整数。安全整数を超える合算も丸めない。 */
  readonly amount: bigint;
  /** 計算の通貨単位。公開APIや保護Recordの表現とは独立。 */
  readonly currency: 'JPY';
};

type CandidateEdge = {
  readonly payer: number;
  readonly payee: number;
  readonly amount: bigint;
};

const compareEdge = (left: CandidateEdge, right: CandidateEdge): number =>
  left.payer - right.payer || left.payee - right.payee;

const compareCandidates = (
  left: readonly CandidateEdge[],
  right: readonly CandidateEdge[],
): number => {
  if (left.length !== right.length) return left.length - right.length;
  for (let i = 0; i < left.length; i++) {
    const order = compareEdge(left[i], right[i]);
    if (order !== 0) return order;
  }
  return 0;
};

/**
 * 集計済み残高から最少送金数・参加順で一意な候補を導出する純Domain Rule。
 * @param balances 同じ精算入力に属する検証済み残高。現在認可の証拠にはしない。
 * @returns 参加順で並んだ不変候補。全員0または空の計算入力は空配列。
 * @throws SettlementInvariantViolation Participant／参加順の重複、残高総和が0以外の場合。
 */
export const derivePaymentInstructionCandidates = (
  balances: readonly ParticipantBalance[],
): readonly PaymentInstructionCandidate[] => {
  const participantIds = new Set<string>();
  const joinOrders = new Set<number>();
  for (const balance of balances) {
    if (participantIds.has(balance.participantId)) {
      throw new SettlementInvariantViolation(
        'PARTICIPANT_DUPLICATED',
        'Settlement participants must be unique',
      );
    }
    participantIds.add(balance.participantId);
    if (joinOrders.has(balance.joinOrder)) {
      throw new SettlementInvariantViolation(
        'JOIN_ORDER_DUPLICATED',
        'Settlement join orders must be unique',
      );
    }
    joinOrders.add(balance.joinOrder);
  }
  if (balances.reduce((sum, balance) => sum + balance.amount, 0n) !== 0n) {
    throw new SettlementInvariantViolation(
      'BALANCE_TOTAL_NOT_ZERO',
      'Participant balances must total zero',
    );
  }

  const ordered = [...balances].sort(
    (left, right) => left.joinOrder - right.joinOrder,
  );
  // keyはこの呼出しの固定参加順vectorであり、他Groupや他Revisionとcacheを共有しない。
  const memo = new Map<string, readonly CandidateEdge[]>();
  const solve = (remaining: readonly bigint[]): readonly CandidateEdge[] => {
    if (remaining.every((amount) => amount === 0n)) return [];
    const key = remaining.map((amount) => amount.toString()).join(',');
    const saved = memo.get(key);
    if (saved) return saved;
    let best: readonly CandidateEdge[] = [];
    for (let payer = 0; payer < remaining.length; payer++) {
      if (remaining[payer] >= 0n) continue;
      for (let payee = 0; payee < remaining.length; payee++) {
        if (remaining[payee] <= 0n) continue;
        const debt = -remaining[payer];
        const credit = remaining[payee];
        const amount = debt < credit ? debt : credit;
        const next = [...remaining];
        next[payer] += amount;
        next[payee] -= amount;
        // 最少supportはforestにでき、そのleafを消すmin相殺の順序を全pair探索が含む。
        const candidate = [{ payer, payee, amount }, ...solve(next)].sort(
          compareEdge,
        );
        if (best.length === 0 || compareCandidates(candidate, best) < 0)
          best = candidate;
      }
    }
    memo.set(key, best);
    return best;
  };

  return Object.freeze(
    solve(ordered.map((balance) => balance.amount)).map((edge) =>
      Object.freeze({
        payerParticipantId: ordered[edge.payer].participantId,
        payeeParticipantId: ordered[edge.payee].participantId,
        amount: edge.amount,
        currency: 'JPY' as const,
      }),
    ),
  );
};
