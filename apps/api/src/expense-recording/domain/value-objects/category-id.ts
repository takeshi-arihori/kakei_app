import { CategoryInvariantViolation } from '../category-invariant-violation.js';

/** 名称変更・無効化を通して維持するopaqueな同一性。 */
export class CategoryId {
  private constructor(
    /** 発番方式・保存形式を確定しない前段の参照。 */
    readonly value: string,
  ) {
    Object.freeze(this);
  }

  /**
   * 空参照だけを拒否し、発番・正規化をしない。
   * @param value 空白だけではないカテゴリ識別子。
   * @returns 名称と独立した不変参照。
   * @throws CategoryInvariantViolation 空またはstring以外の場合。
   */
  static from(value: string): CategoryId {
    if (typeof value !== 'string' || value.trim().length === 0)
      throw new CategoryInvariantViolation('CATEGORY_ID_EMPTY');
    return new CategoryId(value);
  }

  /**
   * 値で同じカテゴリの参照か比較する。
   * @param other 比較対象の参照。
   * @returns 同じIDの場合true。
   */
  equals(other: CategoryId): boolean {
    return this.value === other.value;
  }
}
