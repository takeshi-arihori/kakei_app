import {
  SettlementCaseInvariantViolation,
  type SettlementCaseInvariantViolationCode,
} from './settlement-case-invariant-violation.js';

/**
 * Case内のInvariant拒否を固定分類へ揃える。
 * @param condition 満たすべき内部条件。
 * @param code 条件不成立の内部分類。
 * @throws SettlementCaseInvariantViolation 条件が成立しない場合。
 */
export const requireCondition = (
  condition: boolean,
  code: SettlementCaseInvariantViolationCode,
): void => {
  if (!condition) throw new SettlementCaseInvariantViolation(code);
};
/**
 * 発番済み参照のcanonical UUID表現だけを検証する。
 * @param value 内部参照。発番のRandom性は別PRE。
 * @returns canonical表現ならtrue。
 */
export const canonicalUuid = (value: string): boolean =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
/**
 * 履歴文字列の空白だけの値を拒否する。
 * @param value 検証する内部文字列。
 * @returns 非空白の文字列ならtrue。
 */
export const nonempty = (value: string): boolean =>
  typeof value === 'string' && value.trim().length > 0;
/**
 * Callerの有効な時刻をUTC文字列へコピーする。
 * @param date 信頼するCaller時計の値。時刻順Policyを追加しない。
 * @returns 変更不能なUTC ISO文字列。
 * @throws SettlementCaseInvariantViolation 無効なDateの場合。
 */
export const copyUtc = (date: Date): string => {
  requireCondition(
    date instanceof Date && Number.isFinite(date.getTime()),
    'UTC_INSTANT_INVALID',
  );
  return date.toISOString();
};
