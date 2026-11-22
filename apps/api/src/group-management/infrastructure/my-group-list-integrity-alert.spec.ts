import { describe, expect, it } from 'vitest';

import { GroupId } from '../domain/group.js';
import {
  createMyGroupListIntegrityAlert,
  type MyGroupListIntegritySignal,
} from './my-group-list-integrity-alert.js';

const groupId = GroupId.from('00000000-0000-4000-8000-000000000310');

describe('createMyGroupListIntegrityAlert', () => {
  it('固定の種別とgroupIdだけを通知先へ渡す', async () => {
    const signals: MyGroupListIntegritySignal[] = [];
    const alert = createMyGroupListIntegrityAlert((signal) => {
      signals.push(signal);
    });

    await alert.reportDeniedIndexHit({ groupId });

    expect(signals).toEqual([
      { kind: 'MyGroupListDeniedIndexHit', groupId: groupId.value },
    ]);
    expect(Object.isFrozen(signals[0])).toBe(true);
  });

  it('通知先の失敗を握り潰さず、Use Caseに一覧全体の失敗として扱わせる', async () => {
    const alert = createMyGroupListIntegrityAlert(() => {
      throw new Error('sink down');
    });

    await expect(alert.reportDeniedIndexHit({ groupId })).rejects.toThrow(
      'sink down',
    );
  });
});
