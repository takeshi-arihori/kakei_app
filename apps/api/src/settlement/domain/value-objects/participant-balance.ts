import { SettlementInvariantViolation } from '../settlement-invariant-violation.js';

/** 過去Participantの精算残高。正は受取、負は支払、0は送金不要。 */
export class ParticipantBalance {
  /** 精算の計算単位はJPYの整数。公開APIのScalarや保存表現を定めない。 */
  readonly currency = 'JPY' as const;

  private constructor(
    /** 脱退・再参加で置き換えない、支払責務を持つParticipant参照。 */
    readonly participantId: string,
    /** 候補の同率判定に使うGroup参加順。配列順を使わない。 */
    readonly joinOrder: number,
    /** 実支払額合計−負担額合計のsigned JPY整数。合算の丸めを避ける。 */
    readonly amount: bigint,
  ) {
    Object.freeze(this);
  }

  /**
   * 集計済みの残高を値として固定する。Group所属・本人性・集計は判断しない。
   * @param participantId 空白だけではない、履歴上のParticipant参照。
   * @param joinOrder GMの1以上のsafe integer参加順。
   * @param amount BigIntで集計したsigned JPY額。Product上限を追加しない。
   * @returns 金額・Participant・参加順が外部から変わらない残高。
   * @throws SettlementInvariantViolation 空参照、無効な参加順、BigInt以外の額の場合。
   */
  static from(
    participantId: string,
    joinOrder: number,
    amount: bigint,
  ): ParticipantBalance {
    if (
      typeof participantId !== 'string' ||
      participantId.trim().length === 0
    ) {
      throw new SettlementInvariantViolation(
        'PARTICIPANT_ID_EMPTY',
        'Participant reference must not be empty',
      );
    }
    if (!Number.isSafeInteger(joinOrder) || joinOrder < 1) {
      throw new SettlementInvariantViolation(
        'JOIN_ORDER_INVALID',
        'Join order must be a positive safe integer',
      );
    }
    if (typeof amount !== 'bigint') {
      throw new SettlementInvariantViolation(
        'BALANCE_NOT_INTEGER',
        'JPY balance must be represented by a bigint',
      );
    }
    return new ParticipantBalance(participantId, joinOrder, amount);
  }

  /**
   * 残高の全構成値で比較する。現在membershipと同一視しない。
   * @param other 比較対象のParticipant残高。
   * @returns 同じParticipant参照・参加順・額であればtrue。
   */
  equals(other: ParticipantBalance): boolean {
    return (
      this.participantId === other.participantId &&
      this.joinOrder === other.joinOrder &&
      this.amount === other.amount
    );
  }
}
