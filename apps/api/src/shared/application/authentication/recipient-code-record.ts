declare const bytesPurpose: unique symbol;

/** Owner採用済みの10分期限。Record検証と発行計画で同じmillisecondsを使う。 */
export const recipientCodeLifetime = 600_000;

/** 検索値・Record MAC・Audit仮名を別用途として型検査する。鍵やGM再送proofではない。 */
export type RecipientCodeBytes<P extends 'lookup' | 'record-mac' | 'audit'> =
  Uint8Array & {
    /** 目的違いのbyte列を暗黙に転用しない非公開Brand。 */
    readonly [bytesPurpose]: P;
  };

/** ExpiredはClockから導出し、永続状態として書き込まない。 */
export type RecipientCodeStoredState =
  'issued' | 'consumed' | 'replaced' | 'revoked';

/** R4の最小Inventory。構造検証だけでMAC認証済みとは扱わない。 */
export interface RecipientCodeRecord {
  /** 原コードとは独立したServer生成UUIDv4。 */
  readonly codeId: string;
  /** 発行本人のActor参照。GroupやSessionへのFKではない。 */
  readonly recipientActorId: string;
  /** 更新ごとの正のsafe integer。 */
  readonly recordVersion: number;
  /** Restore後の旧Recordを受理しない認証epoch。 */
  readonly epoch: string;
  /** 発行判断点のUTC milliseconds。 */
  readonly createdAt: number;
  /** createdAtから正確に600000ms。延長しない。 */
  readonly expiresAt: number;
  /** Issuedまたは一方向の終端状態。 */
  readonly status: RecipientCodeStoredState;
  /** Issuedならnull、終端ならcreatedAt以降のUTC。 */
  readonly terminalAt: number | null;
  /** 検索用HMACの独立世代。 */
  readonly lookupKeyVersion: string;
  /** 原コードを保存しない用途別32-byte索引。 */
  readonly lookupDigest: RecipientCodeBytes<'lookup'>;
  /** Record別MAC鍵の世代。検索/再送proof鍵と共有しない。 */
  readonly macKeyVersion: string;
  /** 全Metadataを認証する32-byte MAC。暗号検証は後続Adapterが担当する。 */
  readonly mac: RecipientCodeBytes<'record-mac'>;
}

/** 形式・Clock・版の不整合に秘密値や入力を含めない固定失敗。 */
export class RecipientCodeUnavailable extends Error {
  /** 原因を公開せず固定失敗を生成する。 */
  constructor() {
    super('Recipient code unavailable');
    this.name = 'RecipientCodeUnavailable';
  }
}

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const reference = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 255 &&
  value.trim() === value;
const fields = [
  'codeId',
  'recipientActorId',
  'recordVersion',
  'epoch',
  'createdAt',
  'expiresAt',
  'status',
  'terminalAt',
  'lookupKeyVersion',
  'lookupDigest',
  'macKeyVersion',
  'mac',
];

/**
 * 未知field/accessorを拒否し、Recordとbyte列を同期Copyする。MACの検証はしない。
 * @param input Adapterが選択した未検証Metadata。原コードやProfileを追加しない。
 * @returns 最小Inventoryの構造検証済みCopy。認証済みRecordとは区別する。
 * @throws RecipientCodeUnavailable 形式・日時・状態・byte長が不正な場合。
 */
export const snapshotRecipientCodeRecord = (
  input: unknown,
): RecipientCodeRecord => {
  try {
    if (!input || typeof input !== 'object')
      throw new RecipientCodeUnavailable();
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      throw new RecipientCodeUnavailable();
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== fields.length ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !fields.includes(key) ||
          !Object.getOwnPropertyDescriptor(input, key)?.enumerable ||
          !('value' in Object.getOwnPropertyDescriptor(input, key)!),
      )
    )
      throw new RecipientCodeUnavailable();
    const row = input as Record<string, unknown>;
    if (
      !uuid(row.codeId) ||
      !uuid(row.recipientActorId) ||
      !uuid(row.epoch) ||
      !Number.isSafeInteger(row.recordVersion) ||
      Number(row.recordVersion) < 1 ||
      !time(row.createdAt) ||
      !time(row.expiresAt) ||
      row.expiresAt - row.createdAt !== recipientCodeLifetime ||
      typeof row.status !== 'string' ||
      !['issued', 'consumed', 'replaced', 'revoked'].includes(row.status) ||
      (row.status === 'issued'
        ? row.terminalAt !== null
        : !time(row.terminalAt) || row.terminalAt < row.createdAt) ||
      !reference(row.lookupKeyVersion) ||
      !reference(row.macKeyVersion) ||
      !(row.lookupDigest instanceof Uint8Array) ||
      row.lookupDigest.length !== 32 ||
      !(row.mac instanceof Uint8Array) ||
      row.mac.length !== 32
    )
      throw new RecipientCodeUnavailable();
    return Object.freeze({
      codeId: row.codeId,
      recipientActorId: row.recipientActorId,
      recordVersion: Number(row.recordVersion),
      epoch: row.epoch,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      status: row.status as RecipientCodeStoredState,
      terminalAt: row.terminalAt as number | null,
      lookupKeyVersion: row.lookupKeyVersion,
      lookupDigest: new Uint8Array(
        row.lookupDigest,
      ) as RecipientCodeBytes<'lookup'>,
      macKeyVersion: row.macKeyVersion,
      mac: new Uint8Array(row.mac) as RecipientCodeBytes<'record-mac'>,
    });
  } catch {
    throw new RecipientCodeUnavailable();
  }
};
