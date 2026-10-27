import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { RecipientCodeSecret } from './recipient-code-input.js';
import { snapshotRecipientCodeRecord } from './recipient-code-record.js';
import {
  planRecipientCodeConsume,
  planRecipientCodeIssue,
  planRecipientCodeRevoke,
  recipientCodeExpiry,
  recipientCodeState,
} from './recipient-code-policy.js';

const actorId = randomUUID();
const epoch = randomUUID();
const facts = { actorId, active: true, epoch, now: 1000 };
const row = (patch: Record<string, unknown> = {}) => ({
  codeId: randomUUID(),
  recipientActorId: actorId,
  recordVersion: 1,
  epoch,
  createdAt: 1000,
  expiresAt: 601000,
  status: 'issued',
  terminalAt: null,
  lookupKeyVersion: 'lookup-1',
  lookupDigest: randomBytes(32),
  macKeyVersion: 'mac-1',
  mac: randomBytes(32),
  ...patch,
});

describe('招待コード入力 V01 / IC-PRE-2', () => {
  it('独立Base64url実装との256個の合成入力でdecode/reencodeが一致する', () => {
    for (let n = 0; n < 256; n++) {
      const value = randomBytes(32).toString('base64url');
      const secret = RecipientCodeSecret.parse(value)!;
      expect(Buffer.from(secret.copyBytes()).toString('base64url')).toBe(value);
    }
  });
  it('その場で生成した32-byte値だけを正規形で受理し、返す配列を共有しない', () => {
    const bytes = randomBytes(32);
    const input = RecipientCodeSecret.parse(bytes.toString('base64url'));
    expect(input).not.toBeNull();
    expect(input?.copyBytes()).toEqual(new Uint8Array(bytes));
    const copy = input!.copyBytes();
    copy.fill(0);
    expect(input?.copyBytes()).toEqual(new Uint8Array(bytes));
  });
  it('大小文字を変換せず、それぞれ別の32-byte値として扱う', () => {
    const value = randomBytes(32).toString('base64url');
    const first = value[0] === 'A' ? 'a' : 'A';
    const changed = first + value.slice(1);
    expect(RecipientCodeSecret.parse(changed)?.copyBytes()).not.toEqual(
      RecipientCodeSecret.parse(value)?.copyBytes(),
    );
  });
  it('入力Objectの後続変更から同期的に秘密値を切り離し、JSONや文字列表現に出さない', async () => {
    const input = { code: randomBytes(32).toString('base64url') };
    const before = input.code;
    const secret = RecipientCodeSecret.parse(input.code)!;
    input.code = randomBytes(32).toString('base64url');
    await Promise.resolve();
    expect(secret.copyBytes()).toEqual(
      new Uint8Array(Buffer.from(before, 'base64url')),
    );
    expect(JSON.stringify(secret)).toBe('{}');
    expect(String(secret)).not.toContain(before);
  });
  it('padding・空白・Unicode・長さ・非canonical末尾bitを拒否する', () => {
    const value = randomBytes(32).toString('base64url');
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const badTail = alphabet[alphabet.indexOf(value[42]) + 1];
    for (const invalid of [
      undefined,
      null,
      1,
      {},
      `${value}=`,
      ` ${value}`,
      `${value}\n`,
      value.slice(1),
      `${value}A`,
      `あ${value.slice(1)}`,
      value.slice(0, 42) + badTail,
    ])
      expect(RecipientCodeSecret.parse(invalid)).toBeNull();
  });
});

describe('招待コードの構造検証 / R4', () => {
  it('最小Inventoryをcopyし、入力配列の後続変更を反映しない', () => {
    const input = row();
    const record = snapshotRecipientCodeRecord(input);
    const digest = record.lookupDigest.slice();
    input.lookupDigest.fill(0);
    expect(record.lookupDigest).toEqual(digest);
    expect(Object.keys(record).sort()).toEqual(Object.keys(input).sort());
    expect(Object.isFrozen(record)).toBe(true);
  });
  it.each([
    { extra: true },
    { status: 'expired' },
    { status: 'unknown' },
    { terminalAt: 1001 },
    { status: 'consumed', terminalAt: null },
    { status: 'revoked', terminalAt: 999 },
    { recordVersion: 0 },
    { recordVersion: 1.5 },
    { expiresAt: 601001 },
    { createdAt: -1 },
    { codeId: 'not-an-id' },
    { recipientActorId: '' },
    { epoch: '' },
    { lookupKeyVersion: ' v1' },
    { macKeyVersion: '' },
    { lookupDigest: new Uint8Array(31) },
    { mac: new Uint8Array(33) },
    { status: { toString: (): string => 'issued' } },
  ])('未知fieldや不整合Metadataを汎用失敗にする: %j', (patch) => {
    expect(() => snapshotRecipientCodeRecord(row(patch))).toThrow(
      'Recipient code unavailable',
    );
  });
});

describe('招待コードLifecycle V02/V03/V07/V11', () => {
  it.each([
    [600999, 'issued'],
    [601000, 'expired'],
    [601001, 'expired'],
  ] as const)('期限の直前・等値・後: %s -> %s', (now, expected) => {
    expect(
      recipientCodeState(snapshotRecipientCodeRecord(row()), { ...facts, now }),
    ).toBe(expected);
  });
  it.each(['consumed', 'replaced', 'revoked'] as const)(
    '終端%sを消費せず、取消は冪等',
    (status) => {
      const record = snapshotRecipientCodeRecord(
        row({ status, terminalAt: 1000 }),
      );
      expect(recipientCodeState(record, facts)).toBe(status);
      expect(planRecipientCodeConsume(record, facts)).toEqual({
        status: 'unavailable-to-actor',
      });
      expect(planRecipientCodeRevoke(record, facts)).toEqual({
        status: 'already-inactive',
      });
    },
  );
  it.each([
    { active: false },
    { actorId: randomUUID() },
    { epoch: randomUUID() },
    { now: 999 },
  ])('Actor無効・別本人・別epoch・未来Recordを許可しない: %j', (patch) => {
    const record = snapshotRecipientCodeRecord(row());
    expect(recipientCodeState(record, { ...facts, ...patch })).toBe(
      'unavailable-to-actor',
    );
    expect(
      planRecipientCodeConsume(record, { ...facts, ...patch }).status,
    ).toBe('unavailable-to-actor');
  });
  it('再発行計画は旧IssuedだけをReplacedにし、保存失敗でも入力Recordは変わらない', () => {
    const record = snapshotRecipientCodeRecord(row());
    const before = structuredClone(record);
    expect(planRecipientCodeIssue(record, { ...facts, now: 2000 })).toEqual({
      status: 'planned',
      createdAt: 2000,
      expiresAt: 602000,
      replaced: {
        codeId: record.codeId,
        expectedRecordVersion: 1,
        recordVersion: 2,
        status: 'replaced',
        terminalAt: 2000,
      },
    });
    expect(record).toEqual(before);
    expect(recipientCodeState(record, { ...facts, now: 2000 })).toBe('issued');
  });
  it('期限超過Issuedも置換し、既存の終端Recordと不在では新Issuedだけを計画する', () => {
    expect(
      planRecipientCodeIssue(snapshotRecipientCodeRecord(row()), {
        ...facts,
        now: 601000,
      }).status,
    ).toBe('planned');
    for (const previous of [
      null,
      snapshotRecipientCodeRecord(
        row({ status: 'consumed', terminalAt: 1000 }),
      ),
    ])
      expect(planRecipientCodeIssue(previous, facts)).toEqual({
        status: 'planned',
        createdAt: 1000,
        expiresAt: 601000,
        replaced: null,
      });
  });
  it('消費と本人取消の計画は版を進め、元Recordを変更しない', () => {
    const record = snapshotRecipientCodeRecord(row());
    for (const [plan, status] of [
      [planRecipientCodeConsume, 'consumed'],
      [planRecipientCodeRevoke, 'revoked'],
    ] as const) {
      expect(plan(record, facts)).toEqual({
        status,
        transition: {
          codeId: record.codeId,
          expectedRecordVersion: 1,
          recordVersion: 2,
          status,
          terminalAt: 1000,
        },
      });
      expect(record.status).toBe('issued');
    }
  });
  it('期限切れ取消はAlreadyInactive、初回消費は拒否し、成功再送はPolicyで判定しない', () => {
    const record = snapshotRecipientCodeRecord(row());
    const expired = { ...facts, now: record.expiresAt };
    expect(planRecipientCodeRevoke(record, expired)).toEqual({
      status: 'already-inactive',
    });
    expect(planRecipientCodeRevoke(null, facts)).toEqual({
      status: 'already-inactive',
    });
    expect(planRecipientCodeConsume(record, expired)).toEqual({
      status: 'unavailable-to-actor',
    });
  });
  it('本人・epoch不一致の取消や再発行でも元Recordを変えない', () => {
    const record = snapshotRecipientCodeRecord(row());
    const wrong = { ...facts, actorId: randomUUID() };
    expect(planRecipientCodeRevoke(record, wrong)).toEqual({
      status: 'unavailable-to-actor',
    });
    expect(planRecipientCodeIssue(record, wrong)).toEqual({
      status: 'unavailable-to-actor',
    });
  });
  it.each([-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    '不正・overflow Clockを汎用拒否する: %s',
    (now) => {
      expect(() => recipientCodeExpiry(now)).toThrow(
        'Recipient code unavailable',
      );
    },
  );
  it('版overflowを丸めず拒否する', () => {
    const record = snapshotRecipientCodeRecord(
      row({ recordVersion: Number.MAX_SAFE_INTEGER }),
    );
    expect(() => planRecipientCodeConsume(record, facts)).toThrow(
      'Recipient code unavailable',
    );
  });
});
