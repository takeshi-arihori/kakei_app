import type { MyGroupListIntegrityAlertPort } from '../application/my-group-list-read-port.js';

/**
 * 索引にhitしたが再認可で否となったGroupの通知。Actor、Group本文、鍵版、digestは含めない。
 * `groupId`はRandom UUIDで、索引の不整合を調べる運用者が対象Groupを特定するためだけに渡す。
 */
export type MyGroupListIntegritySignal = Readonly<{
  kind: 'MyGroupListDeniedIndexHit';
  groupId: string;
}>;

/**
 * `MyGroupListIntegrityAlertPort`を、Compositionが渡す通知先へ適合する（#310）。
 * 通知先の失敗は握り潰さない。Use Caseが一覧全体を`UNAVAILABLE`にする（#308 LG-FAIL-1）。
 * @param sink 監視・Logへの通知先。同期・非同期のどちらでもよい。
 */
export const createMyGroupListIntegrityAlert = (
  sink: (signal: MyGroupListIntegritySignal) => void | Promise<void>,
): MyGroupListIntegrityAlertPort => ({
  async reportDeniedIndexHit({ groupId }) {
    await sink(
      Object.freeze({
        kind: 'MyGroupListDeniedIndexHit',
        groupId: groupId.value,
      }),
    );
  },
});
