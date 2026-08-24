// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpendLog, formatScaledForDisplay, scaled } from '../src/embedded/policy.ts';
import type { SpendPolicy } from '../src/embedded/policy.ts';

const POLICY: SpendPolicy = {
  maxPerTx: '5',
  dailyCap: '10',
  allowedInstruments: ['Amulet'],
};

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'policy-test-'));
}

test('scaled parses plain decimals and rejects everything else', () => {
  assert.equal(scaled('1'), 10_000_000_000n);
  assert.equal(scaled('0.0000000001'), 1n);
  assert.equal(scaled('12.5'), 125_000_000_000n);
  for (const bad of ['12,5', '-1', '1e3', '.5', '1.', '1.00000000001', 'abc', '']) {
    assert.throws(() => scaled(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('formatScaledForDisplay round-trips scaled amounts', () => {
  for (const s of ['0', '1', '12.5', '0.0000000001', '100.25']) {
    assert.equal(formatScaledForDisplay(scaled(s)), s);
  }
});

test('per-payment cap, instruments, and receivers are enforced', () => {
  const log = new SpendLog(dir());
  assert.deepEqual(log.check(POLICY, { to: 'bob::1', amount: '5', instrument: 'Amulet' }), { ok: true });
  assert.equal(log.check(POLICY, { to: 'bob::1', amount: '5.0000000001', instrument: 'Amulet' }).ok, false);
  assert.equal(log.check(POLICY, { to: 'bob::1', amount: '1', instrument: 'USDCx' }).ok, false);
  assert.equal(log.check(POLICY, { to: 'bob::1', amount: '0', instrument: 'Amulet' }).ok, false);
  assert.equal(log.check(POLICY, { to: 'bob::1', amount: 'nope', instrument: 'Amulet' }).ok, false);
  const restricted: SpendPolicy = { ...POLICY, allowedReceivers: ['carol::2'] };
  assert.equal(log.check(restricted, { to: 'bob::1', amount: '1', instrument: 'Amulet' }).ok, false);
  assert.equal(log.check(restricted, { to: 'carol::2', amount: '1', instrument: 'Amulet' }).ok, true);
});

test('the daily cap accumulates from receipts and rolls over at UTC midnight', () => {
  let now = new Date('2026-08-23T10:00:00Z');
  const log = new SpendLog(dir(), () => now);
  log.record({ to: 'bob::1', amount: '4', instrument: 'Amulet', updateId: 'u1' });
  log.record({ to: 'bob::1', amount: '4', instrument: 'Amulet', updateId: 'u2' });
  // 8 spent of 10: a 3 would breach, a 2 fits.
  assert.equal(log.check(POLICY, { to: 'bob::1', amount: '3', instrument: 'Amulet' }).ok, false);
  assert.equal(log.check(POLICY, { to: 'bob::1', amount: '2', instrument: 'Amulet' }).ok, true);
  // Next UTC day the budget resets.
  now = new Date('2026-08-24T00:00:01Z');
  assert.equal(log.check(POLICY, { to: 'bob::1', amount: '5', instrument: 'Amulet' }).ok, true);
  assert.equal(log.spentToday('Amulet'), 0n);
});

test('receipts persist: a new SpendLog over the same dir sees prior spend', () => {
  const d = dir();
  const now = () => new Date('2026-08-23T10:00:00Z');
  new SpendLog(d, now).record({ to: 'bob::1', amount: '9', instrument: 'Amulet', updateId: 'u1' });
  const reloaded = new SpendLog(d, now);
  assert.equal(reloaded.check(POLICY, { to: 'bob::1', amount: '2', instrument: 'Amulet' }).ok, false);
  assert.equal(reloaded.receipts().length, 1);
});
