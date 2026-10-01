import {
  CategoryInvariantViolation,
  type CategoryInvariantViolationCode,
} from './category-invariant-violation.js';
import { CategoryId } from './value-objects/category-id.js';

/** 新Itemへの利用判断に使う定義状態。Sourceとの同時照合はApplication PRE。 */
export type CategoryStatus = 'Active' | 'Inactive';

/** 共有標準をGroup配下の削除・変更へ混ぜない所有範囲。 */
export type CategoryScope =
  | {
      /** Groupの寿命から分離するSystem共有定義。 */
      readonly kind: 'System';
    }
  | {
      /** 対象Groupだけに属する分類定義。 */
      readonly kind: 'Group';
      /** ADR85のcanonical参照。実認可やGroup状態の証拠ではない。 */
      readonly groupId: string;
    };

/** 公開受付や保存Schemaに使わない内部作成facts。 */
export type CreateGroupCategory = {
  /** 発番済みopaque参照。一意保存は別責務。 */
  readonly id: string;
  /** Group専用の保持・削除・変更をScopeする参照。 */
  readonly groupId: string;
  /** 前段で検証したstring fact。命名Validation・正規化・重複は別Gate。 */
  readonly name: string;
  /** 信頼済み本人の安定参照。再参加Participant IDと混同しない。 */
  readonly actorSubject: string;
  /** 同判断点のSource現在Owner。Client claimを直接渡さない。 */
  readonly currentOwnerSubject: string;
  /** 有限DateからUTCコピーする作成時刻。 */
  readonly createdAt: Date;
};

/** System現在定義の読取facts。System管理操作の入力ではない。 */
export type SystemCategoryDefinition = {
  /** Groupを割り当てず参照する標準定義ID。 */
  readonly id: string;
  /** Sourceの検証済み名前。表示・正規化Ruleを追加しない。 */
  readonly name: string;
  /** Sourceの状態。許可集合だけを確認する。 */
  readonly status: CategoryStatus;
};

/** 実Group状態・fence・認可・CASを前段に委ねる内部変更入力。 */
export type ChangeGroupCategory = {
  /** Source対象Group。Rootの専用Scopeと一致すること。 */
  readonly groupId: string;
  /** 本人性確認済みの安定参照。旧Ownerや必要承認者を資格としない。 */
  readonly actorSubject: string;
  /** 同判断点の現在Owner参照。実照会の証拠ではない。 */
  readonly currentOwnerSubject: string;
  /** Rootと照合する期待版。保存の先着確認は別責務。 */
  readonly expectedVersion: number;
  /** 履歴へUTC文字列としてコピーする有限Timestamp。 */
  readonly changedAt: Date;
};

/** 現在定義の不変facts。過去名称の表示方式・公開Readを定めない。 */
export type CategorySnapshot = {
  /** 名前と独立して保持するカテゴリ参照。 */
  readonly id: CategoryId;
  /** System共有とGroup専用を区別する不変Scope。 */
  readonly scope: CategoryScope;
  /** この版の検証済み名前fact。 */
  readonly name: string;
  /** Inactiveでも参照・定義を削除しない状態。 */
  readonly status: CategoryStatus;
  /** Group専用の最初の無効化UTC。Systemの管理履歴はここで生成しない。 */
  readonly deactivatedAt: string | null;
};

/** 実状態変化の業務履歴。Audit Logや保護保存Recordではない。 */
export type CategoryChange = {
  /** 再有効化・削除を持たない作成／名称変更／無効化。 */
  readonly action: 'Created' | 'Renamed' | 'Deactivated';
  /** 変更時の本人の安定参照。認可の代替証拠ではない。 */
  readonly actorSubject: string;
  /** Dateの後続変異が伝播しないUTC時刻。 */
  readonly at: string;
  /** 作成前は0、以降は直前Rootの内部版。 */
  readonly previousVersion: number;
  /** 実状態変化を記録した内部新版。 */
  readonly version: number;
  /** 作成前はnull、以降は変更前の不変定義。 */
  readonly before: CategorySnapshot | null;
  /** 変更後の不変定義。 */
  readonly after: CategorySnapshot;
};

const assertCategory = (
  condition: boolean,
  code: CategoryInvariantViolationCode,
): void => {
  if (!condition) throw new CategoryInvariantViolation(code);
};
const checkGroupId = (value: string): void => {
  assertCategory(
    typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      ),
    'GROUP_ID_INVALID',
  );
};
const checkOwner = (actor: string, owner: string): void => {
  assertCategory(
    typeof actor === 'string' &&
      actor.trim().length > 0 &&
      typeof owner === 'string' &&
      owner.trim().length > 0,
    'ACTOR_REFERENCE_INVALID',
  );
  assertCategory(actor === owner, 'ACTOR_NOT_OWNER');
};
const nameFact = (name: string): string => {
  // 未決のProduct命名Validationを内部factoryの成功で置き換えない。
  assertCategory(typeof name === 'string', 'NAME_FACT_INVALID');
  return name;
};
const utcInstant = (value: Date): string => {
  assertCategory(
    value instanceof Date && Number.isFinite(value.getTime()),
    'UTC_INSTANT_INVALID',
  );
  return value.toISOString();
};

/** ERが分類定義の同一性・変更・不変履歴を所有する個別Root。 */
export class Category {
  private constructor(
    private readonly state: CategorySnapshot,
    /** Group作成時またはSystem読取時のfacts。変更後も保持する。 */
    readonly initialSnapshot: CategorySnapshot = state,
    /** Groupの実変化で進める内部版。System読取の初期1はSource保存版ではない。 */
    readonly version: number = 1,
    /** 作成と全変更を保持する不変配列。System管理履歴を偽造しない。 */
    readonly changes: readonly CategoryChange[] = Object.freeze([]),
  ) {
    Object.freeze(this);
  }

  /**
   * 名前変更でも維持する同一カテゴリの参照を返す。
   * @returns Rootの不変ID。
   */
  get id(): CategoryId {
    return this.state.id;
  }

  /**
   * 同Groupの現在Ownerという内部判断からGroup専用を作る。
   * @param input Source認可・名前Validation・fenceを前段で確認した内部facts。
   * @returns Activeの定義と作成履歴を持つ不変Root。
   * @throws CategoryInvariantViolation ID・Group・本人／Owner・時刻・名前fact型の不正。
   */
  static createGroup(input: CreateGroupCategory): Category {
    const id = CategoryId.from(input.id);
    checkGroupId(input.groupId);
    checkOwner(input.actorSubject, input.currentOwnerSubject);
    const at = utcInstant(input.createdAt);
    const scope: CategoryScope = Object.freeze({
      kind: 'Group',
      groupId: input.groupId,
    });
    const state: CategorySnapshot = Object.freeze({
      id,
      scope,
      name: nameFact(input.name),
      status: 'Active',
      deactivatedAt: null,
    });
    const created: CategoryChange = Object.freeze({
      action: 'Created',
      actorSubject: input.actorSubject,
      at,
      previousVersion: 0,
      version: 1,
      before: null,
      after: state,
    });
    return new Category(state, state, 1, Object.freeze([created]));
  }

  /**
   * System定義を内部判断用に読む。System管理操作を提供しない。
   * @param input 信頼されたSystem Sourceから取得した現在定義。
   * @returns Groupを持たずGroup Ownerの変更を拒否するRoot。
   * @throws CategoryInvariantViolation ID・名前fact型・状態集合の不正。
   */
  static fromSystemDefinition(input: SystemCategoryDefinition): Category {
    const id = CategoryId.from(input.id);
    assertCategory(
      input.status === 'Active' || input.status === 'Inactive',
      'STATUS_INVALID',
    );
    const scope: CategoryScope = Object.freeze({ kind: 'System' });
    return new Category(
      Object.freeze({
        id,
        scope,
        name: nameFact(input.name),
        status: input.status,
        deactivatedAt: null,
      }),
    );
  }

  /**
   * 同ID・Scope・状態を保って、名称の実変化だけを履歴化する。
   * @param name 前段で検証済みの名前fact。ここで正規化しない。
   * @param change 現在Owner・Group・期待版・UTCの内部判断。
   * @returns 実変化なら新版、同値なら元Root。公開再送Successの証拠ではない。
   * @throws CategoryInvariantViolation System、別Group、非Owner、版・時刻・名前fact型の不正。
   */
  rename(name: string, change: ChangeGroupCategory): Category {
    const at = this.validateChange(change);
    const nextName = nameFact(name);
    if (nextName === this.state.name) return this;
    return this.record(
      'Renamed',
      change.actorSubject,
      at,
      Object.freeze({ ...this.state, name: nextName }),
    );
  }

  /**
   * Group専用をInactiveへ移し、参照と最初の無効化時刻を保持する。
   * @param change 現在Owner・Group・期待版・UTCの内部判断。
   * @returns Activeなら新版、既にInactiveなら元Root。再有効化しない。
   * @throws CategoryInvariantViolation System、別Group、非Owner、版・時刻の不正。
   */
  deactivate(change: ChangeGroupCategory): Category {
    const at = this.validateChange(change);
    if (this.state.status === 'Inactive') return this;
    return this.record(
      'Deactivated',
      change.actorSubject,
      at,
      Object.freeze({ ...this.state, status: 'Inactive', deactivatedAt: at }),
    );
  }

  /**
   * 現在の不変factsを返す。公開Read認可・保護保存Schemaではない。
   * @returns ID・Scope・名称・状態・Group専用無効化時刻。
   */
  snapshot(): CategorySnapshot {
    return this.state;
  }

  private validateChange(change: ChangeGroupCategory): string {
    const scope = this.state.scope;
    if (scope.kind !== 'Group')
      throw new CategoryInvariantViolation('SYSTEM_CATEGORY_IMMUTABLE');
    checkGroupId(change.groupId);
    assertCategory(change.groupId === scope.groupId, 'GROUP_MISMATCH');
    checkOwner(change.actorSubject, change.currentOwnerSubject);
    assertCategory(
      Number.isSafeInteger(change.expectedVersion) &&
        change.expectedVersion === this.version,
      'VERSION_CONFLICT',
    );
    return utcInstant(change.changedAt);
  }

  private record(
    action: 'Renamed' | 'Deactivated',
    actorSubject: string,
    at: string,
    after: CategorySnapshot,
  ): Category {
    const version = this.version + 1;
    assertCategory(Number.isSafeInteger(version), 'VERSION_CONFLICT');
    const record: CategoryChange = Object.freeze({
      action,
      actorSubject,
      at,
      previousVersion: this.version,
      version,
      before: this.state,
      after,
    });
    return new Category(
      after,
      this.initialSnapshot,
      version,
      Object.freeze([...this.changes, record]),
    );
  }
}
