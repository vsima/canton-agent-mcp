// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The routing rules of tiered custody: within-cap payments run on the
// embedded allowance, everything else escalates to the phone, and with no
// phone connected the escalation is a clear instruction, not a silent retry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EmbeddedLink } from '../src/embedded/link.ts';
import { TieredLink } from '../src/embedded/tiered.ts';
import type { AgentWalletLink } from '../src/tools.ts';
import type { LinkStatus, PayRequest, PayResult } from '../src/link.ts';
import type { CantonGateway, TransferRequest } from '../src/canton.ts';

function realKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64'),
    privateKey: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32).toString('base64'),
  };
}

class FakeGateway implements CantonGateway {
  submitted: TransferRequest[] = [];
  async onboardParty(): Promise<string> {
    return 'agent::1220feed';
  }
  async buildTransfer(request: TransferRequest) {
    return { command: { marker: request }, disclosedContracts: [] };
  }
  async submit(built: { command: unknown }): Promise<{ updateId: string }> {
    this.submitted.push((built.command as { marker: TransferRequest }).marker);
    return { updateId: 'upd-embedded' };
  }
  async tap(): Promise<{ updateId: string }> {
    return { updateId: 'tap-1' };
  }
}

class FakePhone implements AgentWalletLink {
  connected = false;
  paid: PayRequest[] = [];
  async status(): Promise<LinkStatus> {
    return { connected: this.connected, pairingPending: false, networkId: 'canton:localnet' };
  }
  async startPairing(): Promise<{ uri: string }> {
    return { uri: 'wc:phone@2' };
  }
  async accounts() {
    return [];
  }
  async signIn(): Promise<{ party: string }> {
    return { party: 'human::1220cafe' };
  }
  async pay(request: PayRequest): Promise<PayResult> {
    this.paid.push(request);
    return { status: 'executed', updateId: 'upd-phone', sender: 'human::1220cafe' };
  }
  async disconnect(): Promise<boolean> {
    return this.connected;
  }
}

function embedded(gateway: FakeGateway): EmbeddedLink {
  return new EmbeddedLink({
    dir: mkdtempSync(join(tmpdir(), 'tiered-test-')),
    networkId: 'canton:localnet',
    partyHint: 'agent',
    policy: { maxPerTx: '5', dailyCap: '10', allowedInstruments: ['Amulet'] },
    gateway,
    generateKeys: async () => realKeys(),
    allowTap: true,
    domain: 'test.local',
  });
}

test('a payment within the cap runs on the embedded wallet', async () => {
  const gateway = new FakeGateway();
  const phone = new FakePhone();
  const tiered = new TieredLink(embedded(gateway), phone, '5');
  const result = await tiered.pay({ to: 'bob::1', amount: '2' });
  assert.equal(result.route, 'embedded');
  assert.equal(gateway.submitted.length, 1);
  assert.equal(phone.paid.length, 0);
});

test('a payment above the cap escalates to a connected phone', async () => {
  const gateway = new FakeGateway();
  const phone = new FakePhone();
  phone.connected = true;
  const tiered = new TieredLink(embedded(gateway), phone, '5');
  const result = await tiered.pay({ to: 'bob::1', amount: '50' });
  assert.equal(result.route, 'phone');
  assert.match(result.note ?? '', /above the autonomous cap/);
  assert.equal(gateway.submitted.length, 0);
  assert.deepEqual(phone.paid, [{ to: 'bob::1', amount: '50' }]);
});

test('a policy refusal within the cap also escalates', async () => {
  const gateway = new FakeGateway();
  const phone = new FakePhone();
  phone.connected = true;
  const tiered = new TieredLink(embedded(gateway), phone, '5');
  // Daily cap is 10: two 5s fit, the third must escalate even though 5 <= cap.
  await tiered.pay({ to: 'bob::1', amount: '5' });
  await tiered.pay({ to: 'bob::1', amount: '5' });
  const result = await tiered.pay({ to: 'bob::1', amount: '5' });
  assert.equal(result.route, 'phone');
  assert.match(result.note ?? '', /refused/);
  assert.equal(gateway.submitted.length, 2);
});

test('escalation without a phone is a clear instruction', async () => {
  const gateway = new FakeGateway();
  const tiered = new TieredLink(embedded(gateway), new FakePhone(), '5');
  await assert.rejects(tiered.pay({ to: 'bob::1', amount: '50' }), /connect one with canton_connect_wallet/);
});

test('sign-in prefers the human when a phone is connected', async () => {
  const gateway = new FakeGateway();
  const phone = new FakePhone();
  const tiered = new TieredLink(embedded(gateway), phone, '5');
  assert.equal((await tiered.signIn()).party, 'agent::1220feed');
  phone.connected = true;
  assert.equal((await tiered.signIn()).party, 'human::1220cafe');
});
