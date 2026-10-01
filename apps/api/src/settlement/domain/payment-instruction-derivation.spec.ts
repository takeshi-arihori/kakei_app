import { describe, expect, it } from 'vitest';

import { derivePaymentInstructionCandidates } from './payment-instruction-derivation.js';
import { SettlementInvariantViolation } from './settlement-invariant-violation.js';
import { ParticipantBalance } from './value-objects/participant-balance.js';

describe('最少送金候補', () => {
  it('参加順greedyが3回となる残高も2回で精算する', () => {
    const candidates = derivePaymentInstructionCandidates([
      ParticipantBalance.from('a', 1, 4n),
      ParticipantBalance.from('b', 2, 6n),
      ParticipantBalance.from('c', 3, -6n),
      ParticipantBalance.from('d', 4, -4n),
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates).toEqual([
      {
        payerParticipantId: 'c',
        payeeParticipantId: 'b',
        amount: 6n,
        currency: 'JPY',
      },
      {
        payerParticipantId: 'd',
        payeeParticipantId: 'a',
        amount: 4n,
        currency: 'JPY',
      },
    ]);
  });
});

const balancesFrom = (amounts: readonly bigint[]) =>
  amounts.map((amount, i) =>
    ParticipantBalance.from(`p${i + 1}`, (i + 1) * 7, amount),
  );
const pairs = (amounts: readonly bigint[]) =>
  derivePaymentInstructionCandidates(balancesFrom(amounts)).map((candidate) => [
    candidate.payerParticipantId,
    candidate.payeeParticipantId,
    candidate.amount,
  ]);

// 送金探索とは独立のoracle。最大zero-sum partitionは各連結成分に必要なn-1本を最少化する。
const leastEdgeCount = (amounts: readonly number[]): number => {
  const nonzero = amounts.filter((amount) => amount !== 0);
  const maximumPartitions = (mask: number): number => {
    if (mask === 0) return 0;
    const first = mask & -mask;
    let best = 0;
    for (let subset = mask; subset > 0; subset = (subset - 1) & mask) {
      if ((subset & first) === 0) continue;
      const sum = nonzero.reduce(
        (total, amount, i) => total + (subset & (1 << i) ? amount : 0),
        0,
      );
      if (sum === 0)
        best = Math.max(best, 1 + maximumPartitions(mask ^ subset));
    }
    return best;
  };
  return nonzero.length - maximumPartitions((1 << nonzero.length) - 1);
};

const smallVectors = (count: number): number[][] => {
  if (count === 0) return [[]];
  return [-2, -1, 0, 1, 2].flatMap((amount) =>
    smallVectors(count - 1).map((tail) => [amount, ...tail]),
  );
};

const expectRefusal = (action: () => unknown, code: string) => {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SettlementInvariantViolation);
  expect(failure).toMatchObject({ code });
};

// CAL-INV1/INV2/POST1: 符号と保存則・最少性・参加順を業務契約として観測する。
describe('決定的なJPY送金候補', () => {
  it('4000/1000/-5000の残高を2回の全額支払へ相殺する', () => {
    expect(pairs([4000n, 1000n, -5000n])).toEqual([
      ['p3', 'p1', 4000n],
      ['p3', 'p2', 1000n],
    ]);
  });
  it('5000同率の最少候補では支払側と受取側の参加順を優先する', () => {
    expect(pairs([5000n, 5000n, -5000n, -5000n])).toEqual([
      ['p3', 'p1', 5000n],
      ['p4', 'p2', 5000n],
    ]);
  });
  it('対応する4/6/-4/-6の残高も2回で全額精算できる', () => {
    expect(pairs([4n, 6n, -4n, -6n])).toEqual([
      ['p3', 'p1', 4n],
      ['p4', 'p2', 6n],
    ]);
  });
  it('送金数が同じなら一部相殺を含む候補もedge列の辞書順で選ぶ', () => {
    expect(pairs([2n, 2n, -3n, -1n])).toEqual([
      ['p3', 'p1', 1n],
      ['p3', 'p2', 2n],
      ['p4', 'p1', 1n],
    ]);
  });
  it('2人なら同額の正負を1回で相殺する', () => {
    expect(pairs([-37n, 37n])).toEqual([['p1', 'p2', 37n]]);
  });
  it.each([{ amounts: [] }, { amounts: [0n] }, { amounts: [0n, 0n, 0n, 0n] }])(
    '送金不要の入力には候補を作らない: $amounts',
    ({ amounts }) => {
      expect(pairs(amounts)).toEqual([]);
    },
  );
  it('0残高Participantを送金へ含めない', () => {
    expect(pairs([0n, 41n, 0n, -41n])).toEqual([['p4', 'p2', 41n]]);
  });
  it('安全整数を超える合算も1円を丸めず計算する', () => {
    const amount = BigInt(Number.MAX_SAFE_INTEGER) * 4n + 1n;
    expect(pairs([-amount, amount])).toEqual([['p1', 'p2', amount]]);
  });
  it('入力順が逆でも同じ参加順候補を返し入力を変更しない', () => {
    const balances = balancesFrom([2n, 2n, -3n, -1n]);
    const original = [...balances];
    const reversed = [...balances].reverse();
    expect(derivePaymentInstructionCandidates(balances)).toEqual(
      derivePaymentInstructionCandidates(reversed),
    );
    expect(balances).toEqual(original);
    expect(reversed).toEqual([...original].reverse());
  });
  it('IDの辞書順ではなく、非連続のGroup参加順を使う', () => {
    const candidates = derivePaymentInstructionCandidates([
      ParticipantBalance.from('payee-a', 99, 5n),
      ParticipantBalance.from('payer-a', 199, -5n),
      ParticipantBalance.from('payee-z', 7, 5n),
      ParticipantBalance.from('payer-z', 100, -5n),
    ]);
    expect(
      candidates.map((p) => [p.payerParticipantId, p.payeeParticipantId]),
    ).toEqual([
      ['payer-z', 'payee-z'],
      ['payer-a', 'payee-a'],
    ]);
  });
  it('旧Participantや再参加IDを置き換えず8人の過去unionも相殺する', () => {
    const amounts = [5n, 7n, 11n, 13n, -13n, -11n, -7n, -5n];
    const balances = amounts.map((amount, i) =>
      ParticipantBalance.from(
        i === 7 ? 'rejoined' : `past-${i}`,
        i + 1,
        amount,
      ),
    );
    const candidates = derivePaymentInstructionCandidates(balances);
    expect(candidates).toHaveLength(4);
    expect(
      candidates.map((p) => [
        p.payerParticipantId,
        p.payeeParticipantId,
        p.amount,
      ]),
    ).toEqual([
      ['past-4', 'past-3', 13n],
      ['past-5', 'past-2', 11n],
      ['past-6', 'past-1', 7n],
      ['rejoined', 'past-0', 5n],
    ]);
  });
  it('全110個の小整数zero-sum vectorで保存則と独立oracleによる最少性を守る', () => {
    let checked = 0;
    for (let count = 1; count <= 4; count++)
      for (const vector of smallVectors(count)) {
        if (vector.reduce((sum, amount) => sum + amount, 0) !== 0) continue;
        checked++;
        const balances = balancesFrom(vector.map(BigInt));
        const instructions = derivePaymentInstructionCandidates(balances);
        expect(instructions).toHaveLength(leastEdgeCount(vector));
        const byId = new Map(
          balances.map((balance) => [balance.participantId, balance]),
        );
        const net = new Map(
          balances.map((balance) => [balance.participantId, 0n]),
        );
        const edges = new Set<string>();
        for (const candidate of instructions) {
          expect(candidate.amount > 0n).toBe(true);
          expect(candidate.currency).toBe('JPY');
          expect(byId.get(candidate.payerParticipantId)!.amount < 0n).toBe(
            true,
          );
          expect(byId.get(candidate.payeeParticipantId)!.amount > 0n).toBe(
            true,
          );
          const edge = `${candidate.payerParticipantId}/${candidate.payeeParticipantId}`;
          expect(edges.has(edge)).toBe(false);
          edges.add(edge);
          net.set(
            candidate.payerParticipantId,
            net.get(candidate.payerParticipantId)! - candidate.amount,
          );
          net.set(
            candidate.payeeParticipantId,
            net.get(candidate.payeeParticipantId)! + candidate.amount,
          );
        }
        for (const balance of balances)
          expect(net.get(balance.participantId)).toBe(balance.amount);
      }
    expect(checked).toBe(110);
  });
});

// CAL-FAIL1: 拒否で業務状態と入力を変更せず、無効な集合から候補を出さない。
describe('残高値と集合の拒否', () => {
  it.each(['', ' ', '\t'])('空のParticipant参照%sを拒否する', (id) => {
    expectRefusal(
      () => ParticipantBalance.from(id, 1, 0n),
      'PARTICIPANT_ID_EMPTY',
    );
  });
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('無効な参加順%sを拒否する', (joinOrder) => {
    expectRefusal(
      () => ParticipantBalance.from('p1', joinOrder, 0n),
      'JOIN_ORDER_INVALID',
    );
  });
  it.each([1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined])(
    'BigInt以外の残高%sを拒否する',
    (amount) => {
      expectRefusal(
        () =>
          Reflect.apply(
            ParticipantBalance.from.bind(ParticipantBalance),
            ParticipantBalance,
            ['p1', 1, amount],
          ),
        'BALANCE_NOT_INTEGER',
      );
    },
  );
  it('同じParticipantを別の参加順として重複計上しない', () => {
    const balances = [
      ParticipantBalance.from('p1', 1, -1n),
      ParticipantBalance.from('p1', 2, 1n),
    ];
    const original = [...balances];
    expectRefusal(
      () => derivePaymentInstructionCandidates(balances),
      'PARTICIPANT_DUPLICATED',
    );
    expect(balances).toEqual(original);
  });
  it('別IDの参加順重複でTie-breakを捏造しない', () => {
    const balances = [
      ParticipantBalance.from('p1', 1, -1n),
      ParticipantBalance.from('p2', 1, 1n),
    ];
    const original = [...balances];
    expectRefusal(
      () => derivePaymentInstructionCandidates(balances),
      'JOIN_ORDER_DUPLICATED',
    );
    expect(balances).toEqual(original);
  });
  it.each([{ amounts: [1n] }, { amounts: [-1n] }, { amounts: [3n, -2n] }])(
    '残高の総和が0でなければ候補を作らない: $amounts',
    ({ amounts }) => {
      const balances = balancesFrom(amounts);
      const original = [...balances];
      expectRefusal(
        () => derivePaymentInstructionCandidates(balances),
        'BALANCE_TOTAL_NOT_ZERO',
      );
      expect(balances).toEqual(original);
    },
  );
});

describe('残高・候補の不変値', () => {
  it('残高のParticipant、参加順、金額、通貨をRuntimeでも変更させない', () => {
    const balance = ParticipantBalance.from('past-participant', 19, -73n);
    expect(Reflect.set(balance, 'participantId', 'rejoined')).toBe(false);
    expect(Reflect.set(balance, 'joinOrder', 20)).toBe(false);
    expect(Reflect.set(balance, 'amount', 0n)).toBe(false);
    expect(Reflect.set(balance, 'currency', 'USD')).toBe(false);
    expect(balance.amount).toBe(-73n);
  });
  it('同じ額でもParticipantや参加順が異なれば同じ値ではない', () => {
    const balance = ParticipantBalance.from('p1', 1, 2n);
    expect(balance.equals(ParticipantBalance.from('p1', 1, 2n))).toBe(true);
    expect(balance.equals(ParticipantBalance.from('p2', 1, 2n))).toBe(false);
    expect(balance.equals(ParticipantBalance.from('p1', 2, 2n))).toBe(false);
    expect(balance.equals(ParticipantBalance.from('p1', 1, 3n))).toBe(false);
  });
  it('生成済みの候補と配列を書き換えられず呼出し間でcacheを共有しない', () => {
    const balances = balancesFrom([-31n, 31n]);
    const candidates = derivePaymentInstructionCandidates(balances);
    expect(Reflect.set(candidates, '0', {})).toBe(false);
    expect(Reflect.set(candidates[0], 'amount', 1n)).toBe(false);
    expect(Reflect.set(candidates[0], 'payerParticipantId', 'other')).toBe(
      false,
    );
    balances.reverse();
    expect(derivePaymentInstructionCandidates(balances)).toEqual(candidates);
    expect(pairs([-99n, 99n])).toEqual([['p1', 'p2', 99n]]);
    expect(candidates[0].amount).toBe(31n);
  });
});
