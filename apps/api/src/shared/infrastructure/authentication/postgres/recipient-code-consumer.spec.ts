import type { AuthenticationDigest } from '../../../application/authentication/authentication-crypto-keys.js';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticationTransactionScope } from '../../../application/authentication/authentication-transaction-scope.js';
import type { RecipientCodeCrypto } from '../../../application/authentication/recipient-code-crypto-ports.js';
import type { AuthenticationTransactionParticipants } from './authentication-transaction-scopes.js';
import type {
  RecipientCodeRecord,
  RecipientCodeBytes,
} from '../../../application/authentication/recipient-code-record.js';
import { createPostgresRecipientCodeConsumer } from './postgres-recipient-code-consumer.js';

describe('実コード消費Writerの同Scope保存契約', () => {
  it('Issuedの一回CAS・新MAC・caller/コードAuditを借用queryで保存する', async () => {
    const actorId = '10000000-0000-4000-8000-000000000010';
    const callerId = '10000000-0000-4000-8000-000000000020';
    const epoch = '10000000-0000-4000-8000-000000000001';
    const row: RecipientCodeRecord = {
      codeId: '10000000-0000-4000-8000-000000000030',
      recipientActorId: actorId,
      recordVersion: 1,
      epoch,
      createdAt: 0,
      expiresAt: 600000,
      status: 'issued',
      terminalAt: null,
      lookupKeyVersion: 'v1',
      lookupDigest: new Uint8Array(32).fill(1) as RecipientCodeBytes<'lookup'>,
      macKeyVersion: 'v1',
      mac: new Uint8Array(32).fill(2) as RecipientCodeBytes<'record-mac'>,
    };
    const scope = Object.freeze({}) as AuthenticationTransactionScope;
    const purposes = [
      'google-identity-search',
      'login-attempt-cookie',
      'session-cookie',
      'actor-state-mac',
      'audit-actor',
      'audit-attempt',
      'audit-session',
      'deleted-actor',
      'deletion-ledger-mac',
      'recipient-code-lookup',
      'recipient-code-state-mac',
    ];
    const query = vi.fn<AuthenticationTransactionParticipants['query']>(
      (received, sql) => {
        expect(received).toBe(scope);
        if (sql.includes('FROM authentication.key_state'))
          return Promise.resolve({
            command: 'SELECT',
            rowCount: 1,
            oid: 0,
            fields: [],
            rows: [
              { state_id: 1, status: 'active', generation_version: 1, epoch },
            ],
          });
        if (sql.includes('FROM authentication.key_generation'))
          return Promise.resolve({
            command: 'SELECT',
            rowCount: 1,
            oid: 0,
            fields: [],
            rows: purposes.map((purpose, i) => ({
              generation_id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
              purpose,
              key_version: 'v1',
              epoch: purpose.endsWith('cookie') ? epoch : null,
              searchable: true,
              write_required: true,
              retired_at_ms: null,
            })),
          });
        return Promise.resolve({
          command: 'UPDATE',
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [{ code_id: row.codeId }],
        });
      },
    );
    const recordMac = vi.fn<RecipientCodeCrypto['recordMac']>((fields) =>
      Promise.resolve({
        purpose: 'auth-recipient-code-state/v1' as const,
        scopeId: fields.codeId,
        epoch: null,
        keyVersion: 'v1',
        bytes: new Uint8Array(32).fill(3) as RecipientCodeBytes<'record-mac'>,
      }),
    );
    const audit = vi.fn<RecipientCodeCrypto['audit']>(() =>
      Promise.resolve({
        purpose: 'auth-audit-recipient-code/v1' as const,
        scopeId: 'authentication',
        epoch: null,
        keyVersion: 'v1',
        bytes: new Uint8Array(32).fill(4) as RecipientCodeBytes<'audit'>,
      }),
    );
    const actorAudit = vi.fn(() =>
      Promise.resolve({
        purpose: 'auth-audit-actor/v1' as const,
        keyVersion: 'v1',
        bytes: new Uint8Array(32).fill(
          5,
        ) as AuthenticationDigest<'auth-audit-actor/v1'>['bytes'],
      }),
    );
    const consume = createPostgresRecipientCodeConsumer({
      participants: { query },
      crypto: {
        verifyRecord: vi.fn(() => Promise.resolve(true)),
        recordMac,
        audit,
      },
      digests: {
        auditActor: actorAudit,
        auditAttempt: () => Promise.reject(new Error('unexpected attempt')),
        auditSession: () => Promise.reject(new Error('unexpected session')),
      },
      stateKeys: {
        allocate: vi.fn(() =>
          Promise.resolve({ status: 'unavailable' as const }),
        ),
      },
    });
    await consume(scope, row, 1000, {
      actorSubject: callerId,
      absoluteExpiresAt: 604800000,
      csrf: '',
    });
    expect(recordMac).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'consumed',
        recordVersion: 2,
        terminalAt: 1000,
      }),
    );
    expect(actorAudit).toHaveBeenCalledWith({
      subjectId: callerId,
      keyVersion: 'v1',
    });
    expect(audit).toHaveBeenCalledWith({
      codeId: row.codeId,
      keyVersion: 'v1',
    });
    expect(
      query.mock.calls.some(([, sql]) =>
        sql.includes('UPDATE authentication.recipient_code'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([, sql]) =>
        /\b(BEGIN|COMMIT|ROLLBACK)\b/.test(sql),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(
        ([, sql]) => sql.includes('FOR SHARE') || sql.includes('FOR UPDATE'),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(([, sql]) =>
        sql.includes('INSERT INTO authentication.audit_event'),
      ),
    ).toBe(true);
    expect(row.status).toBe('issued');
  });
});
