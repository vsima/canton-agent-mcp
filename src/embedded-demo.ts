// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// Live proof of the embedded wallet against a running LocalNet, one command,
// no phone: create the allowance wallet (fresh party on the ledger), tap test
// funds, pay within policy, then show a payment the policy refuses. Point
// RECEIVER at any party; the default is the SDK-test party with an active
// transfer preapproval, so the payment settles directly.
//
//   npm run embedded-demo

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EmbeddedWallet } from './embedded/wallet.ts';
import { generateKeys, sdkGateway } from './canton.ts';

const RECEIVER =
  process.env['RECEIVER'] ?? 'preapproved::1220b3d98dd0362a19385d6878be4bafb2f12f13531ee7abcb8f32bdb2d764bac9be';

const step = (n: string, msg: string) => console.error(`\x1b[36m${n}\x1b[0m ${msg}`);
const note = (msg: string) => console.error(`   ${msg}`);

step('①', 'opening a fresh embedded wallet (allocates a party on LocalNet)…');
const wallet = await EmbeddedWallet.open({
  dir: process.env['AGENT_WALLET_DIR'] ?? mkdtempSync(join(tmpdir(), 'embedded-demo-')),
  networkId: 'canton:localnet',
  partyHint: 'agent-demo',
  policy: { maxPerTx: '5', dailyCap: '25', allowedInstruments: ['Amulet'] },
  gateway: sdkGateway,
  generateKeys,
  allowTap: true,
  now: () => new Date(),
});
note(`party = ${wallet.partyId.slice(0, 44)}…`);

step('②', 'funding the allowance with a 30 CC tap…');
const tap = await wallet.fund('30');
note(`tap update ${tap.updateId.slice(0, 12)}…`);

step('③', `paying 2 CC to ${RECEIVER.slice(0, 24)}… (within policy)…`);
const paid = await wallet.pay({ to: RECEIVER, amount: '2', memo: 'Embedded wallet demo' });
note(`payment update ${paid.updateId.slice(0, 12)}…`);

step('④', 'asking for 100 CC (the policy must refuse)…');
try {
  await wallet.pay({ to: RECEIVER, amount: '100' });
  console.error('✗ POLICY FAILED TO REFUSE');
  process.exit(1);
} catch (e) {
  note(`refused as expected: ${(e as Error).message}`);
}

const budget = wallet.budget();
step('✓', `done. Budget: ${budget.spentToday} of ${budget.dailyCap} spent today, ${wallet.receipts().length} receipt(s).`);
process.exit(0);
