import { expect, it } from 'vitest';

import { importProtectedRecordKey } from './protected-record-codec.js';
import {
  importPurposeSeparatedDigest,
  type PurposeSeparatedDigest,
} from './purpose-separated-digest.js';

it('Protected record keyと用途分離digestを別のbranded typeにする', () => {
  const key = importProtectedRecordKey(new Uint8Array(32));
  const digest = importPurposeSeparatedDigest(Uint8Array.from([1]));

  const acceptsDigest = (value: PurposeSeparatedDigest): Uint8Array => value;
  expect(acceptsDigest(digest)).toEqual(Uint8Array.from([1]));

  // @ts-expect-error Protected record encryption keys are not digest values.
  acceptsDigest(key);
});
