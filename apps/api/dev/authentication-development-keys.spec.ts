import { describe, expect, it } from 'vitest';
import { createAuthenticationDevelopmentKeys } from './authentication-development-keys.js';

const scope = {
  recordKind: 'login-attempt' as const,
  keyScopeId: '00000000-0000-4000-8000-000000000218',
};
describe('使い捨て開発鍵のprocess境界', () => {
  it('同一Scopeの並行割当でもNonceを戻さず、別Scopeは別DEKを発行する', async () => {
    const provider = createAuthenticationDevelopmentKeys();
    const values = await Promise.all(
      Array.from({ length: 20 }, () =>
        provider.dataKeys.allocateForSeal(scope),
      ),
    );
    expect(values.every((v) => v.status === 'allocated')).toBe(true);
    const allocations = values.filter((v) => v.status === 'allocated');
    expect(
      new Set(allocations.map((v) => Buffer.from(v.nonce).toString('hex')))
        .size,
    ).toBe(20);
    expect(allocations.map((v) => v.sealCount)).toEqual(
      Array.from({ length: 20 }, (_, n) => BigInt(n + 1)),
    );
    const other = await provider.dataKeys.allocateForSeal({
      ...scope,
      recordKind: 'session',
    });
    expect(other.status).toBe('allocated');
    if (other.status !== 'allocated') throw new Error('独立鍵の割当が必要');
    expect(Buffer.from(other.key).equals(Buffer.from(allocations[0].key))).toBe(
      false,
    );
  });
  it('Provider再生成は旧世代を読まず、用途別HMACを混用しない', async () => {
    const a = createAuthenticationDevelopmentKeys(),
      b = createAuthenticationDevelopmentKeys();
    expect(a.epoch).not.toBe(b.epoch);
    const allocation = await a.dataKeys.allocateForSeal(scope);
    if (allocation.status !== 'allocated') throw new Error('割当が必要');
    expect(
      await b.dataKeys.readKey({ scope, keyVersion: allocation.keyVersion }),
    ).toEqual({ status: 'unavailable' });
    const ports = [
      a.macKeys.identity,
      a.macKeys.attemptCookie,
      a.macKeys.sessionCookie,
      a.macKeys.auditActor,
      a.macKeys.auditAttempt,
      a.macKeys.auditSession,
      a.macKeys.deletedActor,
      a.macKeys.actorState,
    ];
    const material = [];
    for (const port of ports) {
      const cookie =
        port === a.macKeys.attemptCookie || port === a.macKeys.sessionCookie;
      const value = await port.readKey({
        keyVersion: a.keyVersion,
        epoch: cookie ? a.epoch : null,
      });
      if (value.status !== 'available') throw new Error('用途鍵が必要');
      material.push(Buffer.from(value.key.material).toString('hex'));
    }
    material.push(
      Buffer.from(a.rateKey).toString('hex'),
      Buffer.from(allocation.key).toString('hex'),
    );
    expect(new Set(material).size).toBe(10);
    expect(
      await a.macKeys.attemptCookie.readKey({
        keyVersion: a.keyVersion,
        epoch: b.epoch,
      }),
    ).toEqual({ status: 'unavailable' });
  });
  it('終了後は新規割当・読取・HMACを再開せず、返却配列の変更は元鍵を変えない', async () => {
    const a = createAuthenticationDevelopmentKeys();
    const allocated = await a.dataKeys.allocateForSeal(scope);
    if (allocated.status !== 'allocated') throw new Error('割当が必要');
    const original = Buffer.from(allocated.key);
    allocated.key.fill(0);
    const read = await a.dataKeys.readKey({
      scope,
      keyVersion: allocated.keyVersion,
    });
    expect(read.status).toBe('available');
    if (read.status === 'available')
      expect(Buffer.from(read.key).equals(original)).toBe(true);
    a.dispose();
    expect(
      await a.dataKeys.readKey({ scope, keyVersion: allocated.keyVersion }),
    ).toEqual({ status: 'unavailable' });
    expect(
      await a.macKeys.identity.readKey({
        keyVersion: a.keyVersion,
        epoch: null,
      }),
    ).toEqual({ status: 'unavailable' });
    expect((await a.dataKeys.allocateForSeal(scope)).status).not.toBe(
      'allocated',
    );
  });
});
