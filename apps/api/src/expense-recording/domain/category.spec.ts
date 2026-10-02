import { describe, expect, it } from 'vitest';
import {
  Category,
  type ChangeGroupCategory,
  type CreateGroupCategory,
} from './category.js';
import {
  CategoryInvariantViolation,
  type CategoryInvariantViolationCode,
} from './category-invariant-violation.js';
import { CategoryId } from './value-objects/category-id.js';

const groupId = '11111111-1111-4111-8111-111111111111';
const createdAt = new Date('2026-10-02T00:00:00.000Z');
const changedAt = new Date('2026-10-02T00:01:00.000Z');

const createInput = (
  overrides: Partial<CreateGroupCategory> = {},
): CreateGroupCategory => ({
  id: 'category-1',
  groupId,
  name: '食品',
  actorSubject: 'owner-1',
  currentOwnerSubject: 'owner-1',
  createdAt,
  ...overrides,
});
const changeInput = (
  overrides: Partial<ChangeGroupCategory> = {},
): ChangeGroupCategory => ({
  groupId,
  actorSubject: 'owner-1',
  currentOwnerSubject: 'owner-1',
  expectedVersion: 1,
  changedAt,
  ...overrides,
});
const rejects = (
  operation: () => unknown,
  code: CategoryInvariantViolationCode,
): void => {
  expect(operation).toThrow(CategoryInvariantViolation);
  expect(operation).toThrow(
    expect.objectContaining({ code, message: 'Category invariant violated' }),
  );
};

describe('Group専用Category', () => {
  it('現在Ownerの名称変更は同じカテゴリの現在名を更新する', () => {
    const original = Category.createGroup({
      id: 'category-1',
      groupId,
      name: '食品',
      actorSubject: 'owner-1',
      currentOwnerSubject: 'owner-1',
      createdAt,
    });
    const changed = original.rename('食費', {
      groupId,
      actorSubject: 'owner-1',
      currentOwnerSubject: 'owner-1',
      expectedVersion: 1,
      changedAt,
    });
    expect(changed.snapshot().name).toBe('食費');
    expect(original.snapshot().name).toBe('食品');
  });

  it('作成はActiveの定義と本人・UTC・初回版を保持する', () => {
    const category = Category.createGroup(createInput());
    expect(category.snapshot()).toEqual({
      id: CategoryId.from('category-1'),
      scope: { kind: 'Group', groupId },
      name: '食品',
      status: 'Active',
      deactivatedAt: null,
    });
    expect(category.initialSnapshot).toBe(category.snapshot());
    expect(category.version).toBe(1);
    expect(category.changes).toEqual([
      {
        action: 'Created',
        actorSubject: 'owner-1',
        at: createdAt.toISOString(),
        previousVersion: 0,
        version: 1,
        before: null,
        after: category.snapshot(),
      },
    ]);
  });

  it('名称変更は同一ID・Scopeを保ち前後の定義を履歴化する', () => {
    const original = Category.createGroup(createInput());
    const renamed = original.rename('食費', changeInput());
    expect(renamed.id).toBe(original.id);
    expect(renamed.snapshot().scope).toBe(original.snapshot().scope);
    expect(renamed.version).toBe(2);
    expect(renamed.initialSnapshot).toBe(original.snapshot());
    expect(renamed.changes[1]).toEqual({
      action: 'Renamed',
      actorSubject: 'owner-1',
      at: changedAt.toISOString(),
      previousVersion: 1,
      version: 2,
      before: original.snapshot(),
      after: renamed.snapshot(),
    });
    expect(original.changes).toHaveLength(1);
  });

  it('無効化後も元参照と初回定義・全履歴を保持し名称だけを変更できる', () => {
    const original = Category.createGroup(createInput());
    const historicalItem = {
      categoryId: original.id,
      categorySnapshot: original.snapshot(),
    };
    const renamed = original.rename('食費', changeInput());
    const inactive = renamed.deactivate(changeInput({ expectedVersion: 2 }));
    const final = inactive.rename(
      '旧食費',
      changeInput({
        expectedVersion: 3,
        changedAt: new Date('2026-10-02T00:02:00Z'),
      }),
    );
    expect(final.id).toBe(historicalItem.categoryId);
    expect(historicalItem.categorySnapshot.name).toBe('食品');
    expect(final.snapshot()).toEqual({
      ...original.snapshot(),
      name: '旧食費',
      status: 'Inactive',
      deactivatedAt: changedAt.toISOString(),
    });
    expect(final.version).toBe(4);
    expect(final.initialSnapshot).toBe(original.snapshot());
    expect(
      final.changes.map(({ action, previousVersion, version }) => ({
        action,
        previousVersion,
        version,
      })),
    ).toEqual([
      { action: 'Created', previousVersion: 0, version: 1 },
      { action: 'Renamed', previousVersion: 1, version: 2 },
      { action: 'Deactivated', previousVersion: 2, version: 3 },
      { action: 'Renamed', previousVersion: 3, version: 4 },
    ]);
    expect(final.changes[2]?.before).toBe(renamed.snapshot());
    expect(final.changes[2]?.after).toBe(inactive.snapshot());
    expect(inactive.snapshot().name).toBe('食費');
    expect(renamed.snapshot().status).toBe('Active');
  });

  it('同値名称と既にInactiveの変更は版・履歴・最初の無効化時刻を増やさない', () => {
    const original = Category.createGroup(createInput());
    expect(original.rename('食品', changeInput())).toBe(original);
    const inactive = original.deactivate(changeInput());
    expect(
      inactive.deactivate(
        changeInput({
          expectedVersion: 2,
          changedAt: new Date('2026-10-03T00:00:00Z'),
        }),
      ),
    ).toBe(inactive);
    expect(inactive.rename('食品', changeInput({ expectedVersion: 2 }))).toBe(
      inactive,
    );
    expect(inactive.version).toBe(2);
    expect(inactive.changes).toHaveLength(2);
    expect(inactive.snapshot().deactivatedAt).toBe(changedAt.toISOString());
  });

  it('Owner交代後は旧Ownerを拒否し現在Ownerの安定参照を履歴に記録する', () => {
    const original = Category.createGroup(createInput());
    rejects(
      () =>
        original.rename(
          '変更',
          changeInput({ currentOwnerSubject: 'owner-2' }),
        ),
      'ACTOR_NOT_OWNER',
    );
    const renamed = original.rename(
      '変更',
      changeInput({ actorSubject: 'owner-2', currentOwnerSubject: 'owner-2' }),
    );
    expect(renamed.changes[1]?.actorSubject).toBe('owner-2');
    expect(renamed.changes[0]?.actorSubject).toBe('owner-1');
    rejects(
      () =>
        original.deactivate(
          changeInput({ actorSubject: 'rejoined-participant-2' }),
        ),
      'ACTOR_NOT_OWNER',
    );
    expect(original.version).toBe(1);
  });

  it('callerのDate・入力を書き換えても履歴・Scope・現在定義へ伝播しない', () => {
    const createDate = new Date('2026-10-02T09:00:00+09:00');
    const changeDate = new Date('2026-10-02T09:01:00+09:00');
    const input = { ...createInput(), createdAt: createDate };
    const operation = { ...changeInput(), changedAt: changeDate };
    const original = Category.createGroup(input);
    const inactive = original.deactivate(operation);
    createDate.setTime(0);
    changeDate.setTime(0);
    input.groupId = '22222222-2222-4222-8222-222222222222';
    input.name = '変更済み';
    operation.actorSubject = 'other';
    expect(inactive.changes[0]?.at).toBe('2026-10-02T00:00:00.000Z');
    expect(inactive.changes[1]?.at).toBe('2026-10-02T00:01:00.000Z');
    expect(inactive.snapshot().deactivatedAt).toBe('2026-10-02T00:01:00.000Z');
    expect(inactive.snapshot().scope).toEqual({ kind: 'Group', groupId });
    expect(inactive.snapshot().name).toBe('食品');
    expect(inactive.changes[1]?.actorSubject).toBe('owner-1');
  });

  it('公開したRoot・snapshot・履歴のネストも変更を拒否する', () => {
    const category =
      Category.createGroup(createInput()).deactivate(changeInput());
    for (const value of [
      category,
      category.id,
      category.initialSnapshot,
      category.initialSnapshot.scope,
      category.snapshot(),
      category.snapshot().scope,
      category.changes,
      ...category.changes,
      ...category.changes.flatMap(({ before, after }) =>
        before ? [before, after] : [after],
      ),
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() =>
      Reflect.set(category.snapshot(), 'name', '変更'),
    ).not.toThrow();
    expect(Reflect.set(category.snapshot(), 'name', '変更')).toBe(false);
    expect(Reflect.set(category.changes, '0', {})).toBe(false);
    expect(Reflect.set(category.id, 'value', '別参照')).toBe(false);
    expect(category.snapshot().name).toBe('食品');
  });

  it('同じ読取版の代替Rootを作れても新版へ古い期待版を適用できない', () => {
    const original = Category.createGroup(createInput());
    const first = original.rename('食費', changeInput());
    const alternative = original.deactivate(changeInput());
    expect(first.version).toBe(2);
    expect(alternative.version).toBe(2);
    expect(original.version).toBe(1);
    rejects(() => first.deactivate(changeInput()), 'VERSION_CONFLICT');
    expect(first.snapshot().status).toBe('Active');
    expect(alternative.snapshot().status).toBe('Inactive');
  });

  it.each([' 食費 ', 'か\u3099', ''])(
    '内部名前fact「%s」は命名Validationを追加せず無変換で保持する',
    (name) => {
      const original = Category.createGroup(createInput({ name }));
      expect(original.snapshot().name).toBe(name);
      const renamed = original.rename(`${name}別`, changeInput());
      expect(renamed.snapshot().name).toBe(`${name}別`);
      expect(renamed.changes[1]?.before?.name).toBe(name);
    },
  );

  it.each(['', ' ', '\n', 1])('空またはstring以外のID %s を拒否する', (id) => {
    rejects(
      () => Category.createGroup(createInput({ id: id as string })),
      'CATEGORY_ID_EMPTY',
    );
  });
  it.each([
    '11111111111141118111111111111111',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    ' 11111111-1111-4111-8111-111111111111',
    1,
  ])('canonicalではないGroup %s を拒否する', (id) => {
    rejects(
      () => Category.createGroup(createInput({ groupId: id as string })),
      'GROUP_ID_INVALID',
    );
  });
  it('他Groupの現在OwnerであってもこのGroup定義を変更できない', () => {
    const category = Category.createGroup(createInput());
    const otherGroup = changeInput({
      groupId: '22222222-2222-4222-8222-222222222222',
    });
    rejects(() => category.rename('他Group名', otherGroup), 'GROUP_MISMATCH');
    rejects(() => category.deactivate(otherGroup), 'GROUP_MISMATCH');
  });
  it('非Ownerによる追加も拒否する', () => {
    rejects(
      () => Category.createGroup(createInput({ actorSubject: 'member-1' })),
      'ACTOR_NOT_OWNER',
    );
  });
  it.each([
    { actorSubject: '' },
    { actorSubject: ' ' },
    { currentOwnerSubject: '' },
    { currentOwnerSubject: ' ' },
    { actorSubject: 1 as unknown as string },
  ])('本人・現在Ownerの空参照を作成・変更とも拒否する %j', (invalid) => {
    rejects(
      () => Category.createGroup(createInput(invalid)),
      'ACTOR_REFERENCE_INVALID',
    );
    const category = Category.createGroup(createInput());
    rejects(
      () => category.rename('別名', changeInput(invalid)),
      'ACTOR_REFERENCE_INVALID',
    );
    rejects(
      () => category.deactivate(changeInput(invalid)),
      'ACTOR_REFERENCE_INVALID',
    );
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2])(
    '不正・不一致の期待版 %s は両操作で拒否する',
    (expectedVersion) => {
      const category = Category.createGroup(createInput());
      rejects(
        () => category.rename('別名', changeInput({ expectedVersion })),
        'VERSION_CONFLICT',
      );
      rejects(
        () => category.deactivate(changeInput({ expectedVersion })),
        'VERSION_CONFLICT',
      );
      expect(category.snapshot().status).toBe('Active');
    },
  );
  it.each([new Date(NaN), '2026-10-02T00:00:00Z' as unknown as Date])(
    '有限Date以外は作成・両変更で拒否する',
    (date) => {
      rejects(
        () => Category.createGroup(createInput({ createdAt: date })),
        'UTC_INSTANT_INVALID',
      );
      const category = Category.createGroup(createInput());
      rejects(
        () => category.rename('別名', changeInput({ changedAt: date })),
        'UTC_INSTANT_INVALID',
      );
      rejects(
        () => category.deactivate(changeInput({ changedAt: date })),
        'UTC_INSTANT_INVALID',
      );
    },
  );
  it('同値操作でも資格・Group・版・UTCを省略しない', () => {
    const category = Category.createGroup(createInput());
    const inactive = category.deactivate(changeInput());
    for (const [overrides, code] of [
      [{ actorSubject: 'member-1' }, 'ACTOR_NOT_OWNER'],
      [{ groupId: '22222222-2222-4222-8222-222222222222' }, 'GROUP_MISMATCH'],
      [{ expectedVersion: 99 }, 'VERSION_CONFLICT'],
      [{ changedAt: new Date(NaN) }, 'UTC_INSTANT_INVALID'],
    ] as const) {
      rejects(() => category.rename('食品', changeInput(overrides)), code);
      rejects(
        () =>
          inactive.deactivate(
            changeInput({ expectedVersion: 2, ...overrides }),
          ),
        code,
      );
    }
  });
  it('名前fact型違反を固定Errorで拒否し入力値をmessageへ出さない', () => {
    rejects(
      () => Category.createGroup(createInput({ name: 1 as unknown as string })),
      'NAME_FACT_INVALID',
    );
    const category = Category.createGroup(createInput());
    rejects(
      () => category.rename(1 as unknown as string, changeInput()),
      'NAME_FACT_INVALID',
    );
    try {
      category.rename(
        '秘密fixture名',
        changeInput({ actorSubject: 'fixture-actor' }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(CategoryInvariantViolation);
      expect((error as Error).message).toBe('Category invariant violated');
      expect(String(error)).not.toContain('fixture');
      expect(String(error)).not.toContain('秘密');
    }
  });
});

describe('System標準Category', () => {
  it.each(['Active', 'Inactive'] as const)(
    '%s定義はGroupなしで読み、Group Ownerの両変更を拒否する',
    (status) => {
      const category = Category.fromSystemDefinition({
        id: 'system-category',
        name: '標準',
        status,
      });
      expect(category.snapshot()).toEqual({
        id: CategoryId.from('system-category'),
        scope: { kind: 'System' },
        name: '標準',
        status,
        deactivatedAt: null,
      });
      expect(category.changes).toEqual([]);
      expect(category.initialSnapshot).toBe(category.snapshot());
      rejects(
        () => category.rename('標準', changeInput()),
        'SYSTEM_CATEGORY_IMMUTABLE',
      );
      rejects(
        () => category.deactivate(changeInput()),
        'SYSTEM_CATEGORY_IMMUTABLE',
      );
      expect(category.snapshot().status).toBe(status);
    },
  );
  it('System読取にGroupActorやGroupScopeを混ぜず入力の後続変異を遮断する', () => {
    const definition = {
      id: 'system-category',
      name: '標準',
      status: 'Active' as const,
      groupId,
      actorSubject: 'owner-1',
    };
    const category = Category.fromSystemDefinition(definition);
    definition.name = '変更済み';
    expect(category.snapshot().name).toBe('標準');
    expect(category.snapshot().scope).toEqual({ kind: 'System' });
    expect(category.changes).toHaveLength(0);
    expect(Object.isFrozen(category.snapshot().scope)).toBe(true);
  });
  it('不正状態や名前fact型・空IDをimportしない', () => {
    rejects(
      () =>
        Category.fromSystemDefinition({
          id: 'system',
          name: '標準',
          status: 'Deleted' as 'Active',
        }),
      'STATUS_INVALID',
    );
    rejects(
      () =>
        Category.fromSystemDefinition({
          id: 'system',
          name: 1 as unknown as string,
          status: 'Active',
        }),
      'NAME_FACT_INVALID',
    );
    rejects(
      () =>
        Category.fromSystemDefinition({
          id: ' ',
          name: '標準',
          status: 'Active',
        }),
      'CATEGORY_ID_EMPTY',
    );
  });
});

describe('Category同一性', () => {
  it('opaque IDを無変換で保持し名称ではなくID値で比較する', () => {
    const first = CategoryId.from(' opaque-ref ');
    const second = CategoryId.from(' opaque-ref ');
    expect(first).not.toBe(second);
    expect(first.equals(second)).toBe(true);
    expect(first.equals(CategoryId.from('opaque-ref'))).toBe(false);
    expect(first.value).toBe(' opaque-ref ');
  });
});
