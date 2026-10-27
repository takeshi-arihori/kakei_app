import { expectTypeOf, it } from 'vitest';

import type { AuthenticationSerializedValue } from './authentication-transaction-scope.js';
import type {
  RecipientCodeCommitEvidence,
  RecipientCodeConsumptionHandle,
  RecipientCodeInspectResult,
  RecipientCodeReplay,
  RecipientCodeStatus,
} from './recipient-code-ports.js';
import type { RecipientCodeBytes } from './recipient-code-record.js';

it('通常DTO・別用途の値・再送と消費の証跡を型上で取り違えない（registryの実行時保証は後続）', () => {
  expectTypeOf<object>().not.toExtend<RecipientCodeConsumptionHandle>();
  expectTypeOf<object>().not.toExtend<RecipientCodeCommitEvidence>();
  expectTypeOf<RecipientCodeCommitEvidence>().not.toExtend<RecipientCodeConsumptionHandle>();
  expectTypeOf<RecipientCodeConsumptionHandle>().not.toExtend<AuthenticationSerializedValue>();
  expectTypeOf<RecipientCodeBytes<'lookup'>>().not.toExtend<
    RecipientCodeBytes<'record-mac'>
  >();
  expectTypeOf<RecipientCodeBytes<'audit'>>().not.toExtend<
    RecipientCodeBytes<'lookup'>
  >();
  expectTypeOf<keyof RecipientCodeStatus>().toEqualTypeOf<
    'codeId' | 'state' | 'expiresAt'
  >();
  expectTypeOf<
    Extract<RecipientCodeInspectResult, { status: 'found' }>['code']
  >().toEqualTypeOf<RecipientCodeStatus>();
  expectTypeOf<
    Extract<
      RecipientCodeReplay<AuthenticationSerializedValue>,
      { status: 'no-replay' }
    >
  >().toEqualTypeOf<Readonly<{ status: 'no-replay' }>>();
});
