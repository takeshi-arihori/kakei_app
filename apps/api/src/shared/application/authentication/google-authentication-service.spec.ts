import { describe, expect, it, vi } from 'vitest';

import type { GoogleIdTokenVerification } from '../google-id-token-verification.js';
import {
  authenticationLifetime as ttl,
  type AttemptBinding,
  type AttemptSnapshot,
  type AuthenticatedActor,
  type AuthenticatedActorResult,
  type AuthenticationClock,
  type AuthenticationSecretPurpose,
  type AuthenticationStore,
  type BeginAttemptCommand,
  type BeginAttemptResult,
  type CompleteAttemptCommand,
  type CompleteAttemptResult,
  type LogoutResult,
  type ReadAttemptResult,
  type SessionUsage,
} from './authentication-ports.js';
import { GoogleAuthenticationService } from './google-authentication-service.js';
import type {
  AuthenticationSerializedValue,
  AuthenticationTransactionScope,
} from './authentication-transaction-scope.js';

// すべて合成値。実Cookie・Token・個人情報はFixtureへ保存しない。
const secret = (n: number) => n.toString(16).padStart(42, '0') + 'A';
const subject = 'synthetic-google-subject';
const identity = () => ({
  issuer: 'https://accounts.google.com' as const,
  subject,
});
const unavailable = { status: 'unavailable' };
const restart = { status: 'restart-required' };
const unauthenticated = { status: 'unauthenticated' };

type Attempt = {
  -readonly [K in keyof AttemptSnapshot]: AttemptSnapshot[K];
} & AttemptBinding & { consumed: boolean };
type Session = AuthenticatedActor & { idleExpiresAt: number; revoked: boolean };

// Portの契約を観測する決定的な境界Fake。暗号・永続化・実DB排他の証明には使わない。
class ContractStore implements AuthenticationStore {
  // ここでは橋渡しだけを観測する。leaseの生存期間と実体の所有検証はAdapter Testの責務。
  readonly scope = Object.freeze({
    serialize: (value: unknown) =>
      Object.freeze({
        body: JSON.stringify(value),
      }) as AuthenticationSerializedValue,
  }) as AuthenticationTransactionScope;
  readonly attempts = new Map<string, Attempt>();
  readonly actors = new Map<string, { subject: string; active: boolean }>();
  readonly sessions = new Map<string, Session>();
  readonly audits: string[] = [];
  failure: 'before' | 'after' | undefined;
  private queue = Promise.resolve();

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private activeSession(token: string | undefined, now: number) {
    const s = token ? this.sessions.get(token) : undefined;
    return s &&
      !s.revoked &&
      now < s.absoluteExpiresAt &&
      now < s.idleExpiresAt &&
      [...this.actors.values()].some(
        (a) => a.subject === s.actorSubject && a.active,
      )
      ? s
      : undefined;
  }

  private ready(binding: AttemptBinding, now: number) {
    const a = this.attempts.get(binding.attemptSecret);
    return a && !a.consumed && a.csrf === binding.csrf && now < a.expiresAt
      ? a
      : undefined;
  }

  async begin(
    c: BeginAttemptCommand,
    clock: AuthenticationClock,
  ): Promise<BeginAttemptResult> {
    return this.exclusive<BeginAttemptResult>(() => {
      const now = clock.now();
      if (this.failure === 'before')
        throw new Error('synthetic-private-detail');
      if (this.activeSession(c.currentSessionSecret, now))
        return Promise.resolve({ status: 'already-authenticated' });
      if (this.attempts.has(c.attemptSecret))
        return Promise.resolve({ status: 'unavailable' });
      const expiresAt = now + ttl.attempt;
      const old =
        c.previousAttemptSecret && this.attempts.get(c.previousAttemptSecret);
      if (old && !old.consumed) old.consumed = true;
      this.attempts.set(c.attemptSecret, {
        ...c,
        recordId: `attempt-${this.attempts.size}`,
        version: 1,
        expiresAt,
        consumed: false,
      });
      if (this.failure === 'after') throw new Error('synthetic-response-lost');
      return Promise.resolve({ status: 'started', expiresAt });
    });
  }

  async readAttempt(
    binding: AttemptBinding,
    clock: AuthenticationClock,
  ): Promise<ReadAttemptResult> {
    const a = this.ready(binding, clock.now());
    return Promise.resolve(
      a
        ? {
            status: 'ready',
            snapshot: {
              recordId: a.recordId,
              version: a.version,
              nonce: a.nonce,
              expiresAt: a.expiresAt,
            },
          }
        : { status: 'restart-required' },
    );
  }

  async complete(
    c: CompleteAttemptCommand,
    clock: AuthenticationClock,
  ): Promise<CompleteAttemptResult> {
    return this.exclusive<CompleteAttemptResult>(() => {
      const now = clock.now();
      if (this.failure === 'before')
        throw new Error('synthetic-private-detail');
      const a = this.ready(c, now);
      if (
        !a ||
        a.recordId !== c.snapshot.recordId ||
        a.version !== c.snapshot.version ||
        a.nonce !== c.snapshot.nonce ||
        a.expiresAt !== c.snapshot.expiresAt
      )
        return Promise.resolve({ status: 'restart-required' });
      if (this.activeSession(c.currentSessionSecret, now))
        return Promise.resolve({ status: 'already-authenticated' });
      const key = `${c.identity.issuer}|${c.identity.subject}`;
      let actor = this.actors.get(key);
      if (actor && !actor.active)
        return Promise.resolve({ status: 'restart-required' });
      if (this.sessions.has(c.sessionSecret))
        return Promise.resolve({ status: 'unavailable' });
      actor ??= {
        subject: `00000000-0000-4000-8000-${(this.actors.size + 1).toString().padStart(12, '0')}`,
        active: true,
      };
      const absoluteExpiresAt = now + ttl.absolute;
      this.actors.set(key, actor);
      this.sessions.set(c.sessionSecret, {
        actorSubject: actor.subject,
        csrf: c.sessionCsrf,
        absoluteExpiresAt,
        idleExpiresAt: now + ttl.idle,
        revoked: false,
      });
      a.consumed = true;
      a.version += 1;
      this.audits.push(actor.subject);
      if (this.failure === 'after') throw new Error('synthetic-response-lost');
      return Promise.resolve({ status: 'authenticated', absoluteExpiresAt });
    });
  }

  async withSession<T extends AuthenticationSerializedValue>(
    token: string,
    usage: SessionUsage,
    clock: AuthenticationClock,
    callback: (
      actor: AuthenticatedActor,
      scope: AuthenticationTransactionScope,
    ) => Promise<T>,
  ): Promise<AuthenticatedActorResult<T>> {
    return this.exclusive(async () => {
      const now = clock.now();
      const s = this.activeSession(token, now);
      if (!s) return { status: 'unauthenticated' };
      const value = await callback(
        {
          actorSubject: s.actorSubject,
          csrf: s.csrf,
          absoluteExpiresAt: s.absoluteExpiresAt,
        },
        this.scope,
      );
      if (this.failure === 'before')
        throw new Error('synthetic-private-detail');
      if (usage === 'activity')
        s.idleExpiresAt = Math.min(now + ttl.idle, s.absoluteExpiresAt);
      if (this.failure === 'after') throw new Error('synthetic-response-lost');
      return { status: 'authenticated', value };
    });
  }

  async revoke(
    token: string,
    clock: AuthenticationClock,
  ): Promise<LogoutResult> {
    return this.exclusive(() => {
      if (this.failure === 'before')
        throw new Error('synthetic-private-detail');
      const s = this.activeSession(token, clock.now());
      if (s) s.revoked = true;
      if (this.failure === 'after') throw new Error('synthetic-response-lost');
      return Promise.resolve({ status: 'logged-out' });
    });
  }
}

const fixture = () => {
  let now = 1_000_000;
  let sequence = 0;
  const clock = { now: vi.fn(() => now) };
  const entropy = {
    generate: vi.fn((purpose: AuthenticationSecretPurpose) => {
      void purpose;
      return secret(++sequence);
    }),
  };
  const verifier = {
    verify: vi.fn<GoogleIdTokenVerification['verify']>(() =>
      Promise.resolve({ status: 'verified', identity: identity() }),
    ),
  };
  const store = new ContractStore();
  const service = new GoogleAuthenticationService(
    verifier,
    store,
    entropy,
    clock,
  );
  return {
    service,
    store,
    verifier,
    clock,
    entropy,
    time: (value: number) => {
      now = value;
    },
  };
};

const start = async (f: ReturnType<typeof fixture>) => {
  const result = await f.service.beginGoogleLogin();
  if (result.status !== 'started') throw new Error('試行開始が必要');
  return result;
};
const login = async (f: ReturnType<typeof fixture>) => {
  const attempt = await start(f);
  const result = await f.service.completeGoogleLogin({
    ...attempt,
    credential: 'synthetic-credential',
  });
  expect(result.status).toBe('authenticated');
  if (result.status !== 'authenticated') throw new Error('Session発行が必要');
  return result;
};

describe('Google認証内部Lifecycle', () => {
  it('独立した秘密値でBrowser試行を保存し5分の期限を返す', async () => {
    const f = fixture();
    const result = await f.service.beginGoogleLogin();
    expect(result).toEqual({
      status: 'started',
      attemptSecret: secret(1),
      nonce: secret(2),
      csrf: secret(3),
      expiresAt: 1_300_000,
    });
    expect(f.store.attempts.get(secret(1))).toMatchObject({
      nonce: secret(2),
      csrf: secret(3),
      consumed: false,
    });
    expect(f.entropy.generate.mock.calls).toEqual([
      ['attempt'],
      ['nonce'],
      ['login-csrf'],
    ]);
  });

  it('Server保持nonceで検証し、内部Actor・Session・消費・Auditを確定する', async () => {
    const f = fixture();
    const result = await login(f);
    expect(result).toEqual({
      status: 'authenticated',
      sessionSecret: secret(4),
      absoluteExpiresAt: 1_000_000 + ttl.absolute,
    });
    expect(f.verifier.verify).toHaveBeenCalledWith({
      idToken: 'synthetic-credential',
      expectedNonce: secret(2),
    });
    expect(f.store.actors.size).toBe(1);
    expect(f.store.sessions.get(secret(4))).toMatchObject({
      csrf: secret(5),
      idleExpiresAt: 1_000_000 + ttl.idle,
    });
    expect(f.store.attempts.get(secret(1))?.consumed).toBe(true);
    expect(f.store.audits).toEqual(['00000000-0000-4000-8000-000000000001']);
  });

  it('Sessionから内部Actorだけを渡し、inspectでは期限を延長しない', async () => {
    const f = fixture();
    const session = await login(f);
    f.time(2_000_000);
    const callback = vi.fn(
      (actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
        Promise.resolve(scope.serialize(actor.actorSubject)),
    );
    expect(
      await f.service.withAuthenticatedActor(
        session.sessionSecret,
        'inspect',
        callback,
      ),
    ).toEqual({
      status: 'authenticated',
      value: { body: '"00000000-0000-4000-8000-000000000001"' },
    });
    expect(callback.mock.calls[0]?.[0]).toEqual({
      actorSubject: '00000000-0000-4000-8000-000000000001',
      absoluteExpiresAt: 1_000_000 + ttl.absolute,
      csrf: secret(5),
    });
    expect(f.store.sessions.get(session.sessionSecret)?.idleExpiresAt).toBe(
      1_000_000 + ttl.idle,
    );
  });

  it('Storeが発行した同一ScopeをCallbackへ渡して確定本文handleを保持する', async () => {
    const f = fixture();
    const session = await login(f);
    const handle = f.store.scope.serialize({ allowed: true });
    const callback = vi.fn(
      (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
        Promise.resolve().then(() => {
          expect(scope).toBe(f.store.scope);
          return handle;
        }),
    );
    const result = await f.service.withAuthenticatedActor(
      session.sessionSecret,
      'inspect',
      callback,
    );
    expect(result.status).toBe('authenticated');
    if (result.status === 'authenticated') expect(result.value).toBe(handle);
  });

  it('現在Sessionを失効し、同じActorの別Sessionを維持する', async () => {
    const f = fixture();
    const first = await login(f);
    const second = await login(f);
    expect(f.store.actors.size).toBe(1);
    expect(f.store.sessions.size).toBe(2);
    expect(await f.service.logoutCurrentSession(first.sessionSecret)).toEqual({
      status: 'logged-out',
    });
    expect(
      await f.service.withAuthenticatedActor(
        first.sessionSecret,
        'inspect',
        (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
          Promise.resolve(scope.serialize('forbidden')),
      ),
    ).toEqual(unauthenticated);
    expect(
      await f.service.withAuthenticatedActor(
        second.sessionSecret,
        'inspect',
        (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
          Promise.resolve(scope.serialize('ok')),
      ),
    ).toEqual({ status: 'authenticated', value: { body: '"ok"' } });
    expect(await f.service.logoutCurrentSession(first.sessionSecret)).toEqual({
      status: 'logged-out',
    });
  });

  it.each([
    undefined,
    null,
    42,
    {},
    '',
    'x'.repeat(43),
    secret(1) + '=',
    'A'.repeat(42) + 'B',
  ])(
    '不正秘密値 %j では試行／Sessionを照合せずCallbackも呼ばない',
    async (value) => {
      const f = fixture();
      const read = vi.spyOn(f.store, 'readAttempt');
      const guard = vi.spyOn(f.store, 'withSession');
      const revoke = vi.spyOn(f.store, 'revoke');
      const callback = vi.fn(
        (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
          Promise.resolve(scope.serialize('forbidden')),
      );
      expect(
        await f.service.completeGoogleLogin({
          credential: 'synthetic',
          attemptSecret: value,
          csrf: secret(3),
        }),
      ).toEqual(restart);
      expect(
        await f.service.completeGoogleLogin({
          credential: 'synthetic',
          attemptSecret: secret(1),
          csrf: value,
        }),
      ).toEqual(restart);
      expect(
        await f.service.withAuthenticatedActor(value, 'inspect', callback),
      ).toEqual(unauthenticated);
      expect(await f.service.logoutCurrentSession(value)).toEqual({
        status: 'logged-out',
      });
      expect(read).not.toHaveBeenCalled();
      expect(guard).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(f.verifier.verify).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it.each(['short', 'A'.repeat(42) + 'B', secret(1) + '='])(
    'Entropy不正形式 %s を保存しない',
    async (value) => {
      const f = fixture();
      f.entropy.generate.mockReturnValue(value);
      expect(await f.service.beginGoogleLogin()).toEqual(unavailable);
      expect(f.store.attempts.size).toBe(0);
    },
  );

  it('Entropyの重複または例外を秘密値なし障害にする', async () => {
    const f = fixture();
    f.entropy.generate.mockReturnValue(secret(9));
    expect(await f.service.beginGoogleLogin()).toEqual(unavailable);
    f.entropy.generate.mockImplementation(() => {
      throw new Error('synthetic-private-detail');
    });
    expect(await f.service.beginGoogleLogin()).toEqual(unavailable);
    expect(f.store.attempts.size).toBe(0);
  });

  it('同じBrowserの旧試行だけを無効にし、不正な任意Cookieを本人性に使わない', async () => {
    const f = fixture();
    const first = await start(f);
    const other = await start(f);
    await f.service.beginGoogleLogin({
      previousAttemptSecret: first.attemptSecret,
      currentSessionSecret: 'invalid',
    });
    expect(f.store.attempts.get(first.attemptSecret)?.consumed).toBe(true);
    expect(f.store.attempts.get(other.attemptSecret)?.consumed).toBe(false);
    expect(
      (
        await f.service.beginGoogleLogin({
          previousAttemptSecret: {},
          currentSessionSecret: {},
        })
      ).status,
    ).toBe('started');
    expect(f.store.attempts.get(other.attemptSecret)?.consumed).toBe(false);
  });

  it('有効現在Sessionでは開始／完了ともAccountを暗黙に切り替えない', async () => {
    const f = fixture();
    const current = await login(f);
    const attempt = await start(f);
    expect(
      await f.service.beginGoogleLogin({
        currentSessionSecret: current.sessionSecret,
      }),
    ).toEqual({ status: 'already-authenticated' });
    expect(
      await f.service.completeGoogleLogin({
        ...attempt,
        credential: 'synthetic',
        currentSessionSecret: current.sessionSecret,
      }),
    ).toEqual({ status: 'already-authenticated' });
    expect(f.store.sessions.size).toBe(1);
    expect(f.store.actors.size).toBe(1);
    expect(f.store.attempts.get(attempt.attemptSecret)?.consumed).toBe(false);
  });

  it('試行秘密値とCSRFの組が違えばGoogle検証も消費も行わない', async () => {
    const f = fixture();
    const first = await start(f);
    const other = await start(f);
    expect(
      await f.service.completeGoogleLogin({
        ...first,
        csrf: other.csrf,
        credential: 'synthetic',
      }),
    ).toEqual(restart);
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect([...f.store.attempts.values()].every((a) => !a.consumed)).toBe(true);
  });

  it.each(['invalid-credential', 'unavailable'] as const)(
    'Verifierの%sでは登録／消費／Session発行をしない',
    async (status) => {
      const f = fixture();
      const a = await start(f);
      vi.mocked(f.verifier.verify).mockResolvedValue({ status });
      expect(
        await f.service.completeGoogleLogin({ ...a, credential: {} }),
      ).toEqual({ status });
      expect(f.store.actors.size).toBe(0);
      expect(f.store.sessions.size).toBe(0);
      expect(f.store.audits).toEqual([]);
      expect(f.store.attempts.get(a.attemptSecret)?.consumed).toBe(false);
    },
  );

  it('Verifier例外とStore読取り障害の詳細を返さない', async () => {
    const f = fixture();
    const a = await start(f);
    vi.mocked(f.verifier.verify).mockRejectedValue(
      new Error('synthetic-private-detail'),
    );
    expect(
      await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
    ).toEqual(unavailable);
    vi.spyOn(f.store, 'readAttempt').mockRejectedValue(
      new Error('synthetic-query-detail'),
    );
    expect(
      await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
    ).toEqual(unavailable);
    expect(f.store.actors.size).toBe(0);
    expect(f.store.attempts.get(a.attemptSecret)?.consumed).toBe(false);
  });

  it.each(['before-verification', 'during-verification'] as const)(
    '期限等値を%sで迎えた試行は部分登録せず拒否する',
    async (point) => {
      const f = fixture();
      const a = await start(f);
      if (point === 'before-verification') f.time(a.expiresAt);
      else
        vi.mocked(f.verifier.verify).mockImplementation(() => {
          f.time(a.expiresAt);
          return Promise.resolve({ status: 'verified', identity: identity() });
        });
      expect(
        await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
      ).toEqual(restart);
      expect(f.store.actors.size).toBe(0);
      expect(f.store.sessions.size).toBe(0);
      expect(f.store.audits).toEqual([]);
      expect(f.store.attempts.get(a.attemptSecret)?.consumed).toBe(false);
      if (point === 'before-verification')
        expect(f.verifier.verify).not.toHaveBeenCalled();
    },
  );

  it('検証中の試行版変更をcommit時に拒否する', async () => {
    const f = fixture();
    const a = await start(f);
    vi.mocked(f.verifier.verify).mockImplementation(() => {
      const stored = f.store.attempts.get(a.attemptSecret);
      if (stored) stored.version += 1;
      return Promise.resolve({ status: 'verified', identity: identity() });
    });
    expect(
      await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
    ).toEqual(restart);
    expect(f.store.actors.size).toBe(0);
    expect(f.store.sessions.size).toBe(0);
  });

  it('読取りsnapshotをCopyし、await中のPort側Object変更に影響されない', async () => {
    const f = fixture();
    const a = await start(f);
    const snapshot = {
      recordId: 'attempt-0',
      version: 1,
      nonce: a.nonce,
      expiresAt: a.expiresAt,
    };
    vi.spyOn(f.store, 'readAttempt').mockResolvedValue({
      status: 'ready',
      snapshot,
    });
    vi.mocked(f.verifier.verify).mockImplementation(() => {
      snapshot.recordId = 'mutated';
      snapshot.nonce = secret(90);
      return Promise.resolve({ status: 'verified', identity: identity() });
    });
    expect(
      (await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }))
        .status,
    ).toBe('authenticated');
    expect(f.verifier.verify).toHaveBeenCalledWith({
      idToken: 'synthetic',
      expectedNonce: a.nonce,
    });
  });

  it.each([
    { recordId: '' },
    { version: -1 },
    { nonce: 'invalid' },
    { expiresAt: NaN },
  ])('不正snapshot %j をGoogle検証へ渡さない', async (overrides) => {
    const f = fixture();
    const a = await start(f);
    vi.spyOn(f.store, 'readAttempt').mockResolvedValue({
      status: 'ready',
      snapshot: {
        recordId: 'attempt-0',
        version: 1,
        nonce: a.nonce,
        expiresAt: a.expiresAt,
        ...overrides,
      },
    });
    expect(
      await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
    ).toEqual(unavailable);
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.store.sessions.size).toBe(0);
  });

  it.each(['', ' whitespace', 'x'.repeat(256)])(
    'Verifierが契約外sub %s を返したら保存しない',
    async (badSubject) => {
      const f = fixture();
      const a = await start(f);
      vi.mocked(f.verifier.verify).mockResolvedValue({
        status: 'verified',
        identity: { ...identity(), subject: badSubject },
      });
      expect(
        await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
      ).toEqual(unavailable);
      expect(f.store.actors.size).toBe(0);
      expect(f.store.sessions.size).toBe(0);
    },
  );

  it('検証済みIdentityを最小Copyにし、Entropy中の変更やProfileを保存へ伝播しない', async () => {
    const f = fixture();
    const a = await start(f);
    const verifiedIdentity = { ...identity(), email: 'fictional@example.test' };
    vi.mocked(f.verifier.verify).mockResolvedValue({
      status: 'verified',
      identity: verifiedIdentity,
    });
    const complete = vi.spyOn(f.store, 'complete');
    f.entropy.generate.mockImplementation((purpose) => {
      if (purpose === 'session') verifiedIdentity.subject = 'mutated';
      return purpose === 'session' ? secret(40) : secret(50);
    });
    expect(
      (await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }))
        .status,
    ).toBe('authenticated');
    expect(complete.mock.calls[0]?.[0].identity).toEqual(identity());
    expect([...f.store.actors.keys()]).toEqual([
      `https://accounts.google.com|${subject}`,
    ]);
  });

  it.each(['attempt', 'nonce', 'csrf', 'duplicate'] as const)(
    'Session秘密値の%s再利用を保存前に拒否する',
    async (reuse) => {
      const f = fixture();
      const a = await start(f);
      const old =
        reuse === 'attempt'
          ? a.attemptSecret
          : reuse === 'nonce'
            ? a.nonce
            : a.csrf;
      f.entropy.generate.mockImplementation((purpose) =>
        reuse === 'duplicate'
          ? secret(90)
          : purpose === 'session'
            ? old
            : secret(90),
      );
      expect(
        await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
      ).toEqual(unavailable);
      expect(f.store.actors.size).toBe(0);
      expect(f.store.attempts.get(a.attemptSecret)?.consumed).toBe(false);
    },
  );

  it('同試行の並行再送は1回だけ成功し、再送でもActorやAuditを増やさない', async () => {
    const f = fixture();
    const a = await start(f);
    const input = { ...a, credential: 'synthetic' };
    const results = await Promise.all([
      f.service.completeGoogleLogin(input),
      f.service.completeGoogleLogin(input),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'authenticated',
      'restart-required',
    ]);
    expect(await f.service.completeGoogleLogin(input)).toEqual(restart);
    expect(f.store.actors.size).toBe(1);
    expect(f.store.sessions.size).toBe(1);
    expect(f.store.audits).toHaveLength(1);
  });

  it('無効化されたActorには新Sessionを発行せず既存SessionのCallbackも拒否する', async () => {
    const f = fixture();
    const session = await login(f);
    for (const actor of f.store.actors.values()) actor.active = false;
    const a = await start(f);
    expect(
      await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
    ).toEqual(restart);
    const callback = vi.fn(
      (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
        Promise.resolve(scope.serialize('forbidden')),
    );
    expect(
      await f.service.withAuthenticatedActor(
        session.sessionSecret,
        'inspect',
        callback,
      ),
    ).toEqual(unauthenticated);
    expect(callback).not.toHaveBeenCalled();
    expect(f.store.sessions.size).toBe(1);
  });

  it.each(['idle', 'absolute'] as const)(
    'Session %s期限等値でCallbackを実行しない',
    async (expiry) => {
      const f = fixture();
      const session = await login(f);
      const s = f.store.sessions.get(session.sessionSecret);
      if (!s) throw new Error('Sessionが必要');
      if (expiry === 'absolute') s.idleExpiresAt = s.absoluteExpiresAt + 1;
      f.time(expiry === 'idle' ? s.idleExpiresAt : s.absoluteExpiresAt);
      const callback = vi.fn(
        (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
          Promise.resolve(scope.serialize('forbidden')),
      );
      expect(
        await f.service.withAuthenticatedActor(
          session.sessionSecret,
          'activity',
          callback,
        ),
      ).toEqual(unauthenticated);
      expect(callback).not.toHaveBeenCalled();
      expect(
        await f.service.logoutCurrentSession(session.sessionSecret),
      ).toEqual({ status: 'logged-out' });
    },
  );

  it('activityだけをidle延長し、活動を繰り返してもabsoluteを超えない', async () => {
    const f = fixture();
    const session = await login(f);
    const initial = 1_000_000;
    for (let day = 1; day <= 7; day++) {
      const now = initial + day * (ttl.idle - 1);
      f.time(now);
      expect(
        await f.service.withAuthenticatedActor(
          session.sessionSecret,
          'activity',
          (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
            Promise.resolve(scope.serialize('ok')),
        ),
      ).toEqual({ status: 'authenticated', value: { body: '"ok"' } });
      expect(f.store.sessions.get(session.sessionSecret)?.idleExpiresAt).toBe(
        Math.min(now + ttl.idle, session.absoluteExpiresAt),
      );
    }
    f.time(session.absoluteExpiresAt);
    expect(
      await f.service.withAuthenticatedActor(
        session.sessionSecret,
        'activity',
        (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
          Promise.resolve(scope.serialize('forbidden')),
      ),
    ).toEqual(unauthenticated);
  });

  it('Callback例外を漏らさずidle更新をrollbackする', async () => {
    const f = fixture();
    const session = await login(f);
    f.time(2_000_000);
    expect(
      await f.service.withAuthenticatedActor(
        session.sessionSecret,
        'activity',
        () => {
          throw new Error('synthetic-private-detail');
        },
      ),
    ).toEqual(unavailable);
    expect(f.store.sessions.get(session.sessionSecret)?.idleExpiresAt).toBe(
      1_000_000 + ttl.idle,
    );
  });

  it.each(['before', 'after'] as const)(
    'completeの%s障害では秘密値なし、保存状態は故障位置によって異なる',
    async (point) => {
      const f = fixture();
      const a = await start(f);
      f.store.failure = point;
      expect(
        await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
      ).toEqual(unavailable);
      expect(f.store.actors.size).toBe(point === 'after' ? 1 : 0);
      expect(f.store.sessions.size).toBe(point === 'after' ? 1 : 0);
      expect(f.store.attempts.get(a.attemptSecret)?.consumed).toBe(
        point === 'after',
      );
      f.store.failure = undefined;
      if (point === 'after')
        expect(
          await f.service.completeGoogleLogin({
            ...a,
            credential: 'synthetic',
          }),
        ).toEqual(restart);
    },
  );

  it.each(['before', 'after'] as const)(
    'withSessionの%s障害ではCallback値を返さず、確定済みidleをrollback扱いしない',
    async (point) => {
      const f = fixture();
      const session = await login(f);
      f.time(2_000_000);
      f.store.failure = point;
      expect(
        await f.service.withAuthenticatedActor(
          session.sessionSecret,
          'activity',
          (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
            Promise.resolve(scope.serialize('synthetic-private-value')),
        ),
      ).toEqual(unavailable);
      expect(f.store.sessions.get(session.sessionSecret)?.idleExpiresAt).toBe(
        (point === 'after' ? 2_000_000 : 1_000_000) + ttl.idle,
      );
    },
  );

  it.each(['before', 'after'] as const)(
    'begin／revokeの%s障害も成功扱いせず状態変更済みの可能性を残す',
    async (point) => {
      const f = fixture();
      f.store.failure = point;
      expect(await f.service.beginGoogleLogin()).toEqual(unavailable);
      expect(f.store.attempts.size).toBe(point === 'after' ? 1 : 0);
      f.store.failure = undefined;
      const session = await login(f);
      f.store.failure = point;
      expect(
        await f.service.logoutCurrentSession(session.sessionSecret),
      ).toEqual(unavailable);
      expect(f.store.sessions.get(session.sessionSecret)?.revoked).toBe(
        point === 'after',
      );
      f.store.failure = undefined;
      expect(
        await f.service.logoutCurrentSession(session.sessionSecret),
      ).toEqual({ status: 'logged-out' });
    },
  );

  it('実行中Callbackが先に完了してからLogoutし、次のCallbackを拒否する', async () => {
    const f = fixture();
    const session = await login(f);
    let finish = () => {};
    let entered = () => {};
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const guarded = f.service.withAuthenticatedActor(
      session.sessionSecret,
      'activity',
      async (_actor, scope) => {
        entered();
        await pending;
        return scope.serialize('first');
      },
    );
    await running;
    const logout = f.service.logoutCurrentSession(session.sessionSecret);
    finish();
    expect(await guarded).toEqual({
      status: 'authenticated',
      value: { body: '"first"' },
    });
    expect(await logout).toEqual({ status: 'logged-out' });
    const callback = vi.fn(
      (_actor: AuthenticatedActor, scope: AuthenticationTransactionScope) =>
        Promise.resolve(scope.serialize('forbidden')),
    );
    expect(
      await f.service.withAuthenticatedActor(
        session.sessionSecret,
        'inspect',
        callback,
      ),
    ).toEqual(unauthenticated);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])(
    'Clock契約外 %s を機密なし障害へ変換する',
    async (now) => {
      const f = fixture();
      f.time(now);
      expect(await f.service.beginGoogleLogin()).toEqual(unavailable);
      expect(f.store.attempts.size).toBe(0);
    },
  );

  it('Portが返す障害Objectの追加診断FieldをResultへ伝播しない', async () => {
    const f = fixture();
    const a = await start(f);
    const detail = {
      status: 'unavailable' as const,
      cause: 'synthetic-private-detail',
    };
    vi.spyOn(f.store, 'begin').mockResolvedValue(detail);
    expect(await f.service.beginGoogleLogin()).toEqual(unavailable);
    vi.mocked(f.verifier.verify).mockResolvedValue(
      Object.assign(
        { status: 'invalid-credential' as const },
        { cause: 'synthetic-private-detail' },
      ),
    );
    expect(
      await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
    ).toEqual({ status: 'invalid-credential' });
    vi.spyOn(f.store, 'readAttempt').mockResolvedValue(detail);
    expect(
      await f.service.completeGoogleLogin({ ...a, credential: 'synthetic' }),
    ).toEqual(unavailable);
    vi.spyOn(f.store, 'withSession').mockResolvedValue(detail);
    expect(
      await f.service.withAuthenticatedActor(
        secret(90),
        'inspect',
        (_actor, scope) => Promise.resolve(scope.serialize('forbidden')),
      ),
    ).toEqual(unavailable);
    vi.spyOn(f.store, 'revoke').mockResolvedValue(detail);
    expect(await f.service.logoutCurrentSession(secret(90))).toEqual(
      unavailable,
    );
  });
});
