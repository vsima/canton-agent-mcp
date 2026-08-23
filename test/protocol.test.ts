// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chainId, decodePartyAddress, encodePartyAddress, partyFromAccount, toAccount } from '../src/wc/protocol.ts';

test('party ids round-trip through a CAIP-10 address (:: and _ are encoded)', () => {
  const party = 'droid_wallet::1220ab34cd56ef';
  const address = encodePartyAddress(party);
  assert.ok(!address.includes('::'), 'no raw colon in the address segment');
  assert.ok(!address.includes('_'), 'no raw underscore in the address segment');
  assert.equal(decodePartyAddress(address), party);
});

test('toAccount / partyFromAccount round-trip against the chain', () => {
  const chain = chainId('canton:localnet');
  const party = 'alice::1220ff00';
  const account = toAccount(chain, party);
  assert.ok(account.startsWith('canton:localnet:'));
  assert.equal(partyFromAccount(account), party);
});

test('chainId rejects a non-CAIP-2 network id', () => {
  assert.throws(() => chainId('not a chain'));
  assert.throws(() => chainId('canton'));
  assert.equal(chainId('canton:localnet'), 'canton:localnet');
});
