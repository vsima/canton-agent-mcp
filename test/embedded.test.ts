// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The embedded wallet with a fake ledger gateway and REAL Ed25519 keys: the
// sign-in path generates a genuine keypair, signs the domain-separated bytes,
// and verifies with the same verifier the dapp-server uses, so "the agent can
// authenticate as its party" is proven by real crypto, not by a stub agreeing
// with itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EmbeddedWallet } from '../src/embedded/wallet.ts';
import { EmbeddedLink } from '../src/embedded/link.ts';
import type { CantonGateway, TransferRequest } from '../src/canton.ts';

/** Real Ed25519 keys in the SDK's base64-raw shape (seed-first secret). */
function realKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  const seed = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32);
  return { publicKey: rawPub.toString('base64'), privateKey: seed.toString('base64') };
}

class FakeGateway implements CantonGateway {
  onboarded = 0;
  submitted: TransferRequest[] = [];
  tapped: string[] = [];

  async onboardParty(_pub: string, _priv: string, hint: string): Promise<string> {
    this.onboarded += 1;
    return `${hint}::1220feed`;
  }
  async buildTransfer(request: TransferRequest) {
    return { command: { marker: request }, disclosedContracts: [] };
  }
  async submit(built: { command: unknown }): Promise<{ updateId: string }> {
    this.submitted.push((built.command as { marker: TransferRequest }).marker);
    return { updateId: `upd-${this.submitted.length}` };
  }
  async tap(_party: string, amount: string): Promise<{ updateId: string }> {
    this.tapped.push(amount);
    return { updateId: 'tap-1' };
  }
}

function config(gateway: FakeGateway, dir: string, overrides: Record<string, unknown> = {}) {
  return {
    dir,
    networkId: 'canton:localnet',
    partyHint: 'agent',
    policy: { maxPerTx: '5', dailyCap: '10', allowedInstruments: ['Amulet'] },
    gateway,
    generateKeys: async () => realKeys(),
    allowTap: true,
    domain: 'test.local',
    ...overrides,
  };
}

test('open creates once, persists, and restores without re-onboarding', async () => {
  const gateway = new FakeGateway();
  const d = mkdtempSync(join(tmpdir(), 'embedded-test-'));
  const first = await EmbeddedWallet.open(config(gateway, d));
  assert.equal(first.partyId, 'agent::1220feed');
  assert.equal(gateway.onboarded, 1);
  const second = await EmbeddedWallet.open(config(gateway, d));
  assert.equal(second.partyId, first.partyId);
  assert.equal(gateway.onboarded, 1, 'restore must not allocate a second party');
});

test('a store from another network is refused', async () => {
  const gateway = new FakeGateway();
  const d = mkdtempSync(join(tmpdir(), 'embedded-test-'));
  await EmbeddedWallet.open(config(gateway, d));
  await assert.rejects(
    EmbeddedWallet.open(config(gateway, d, { networkId: 'canton:devnet' })),
    /refusing to reuse its key across networks/,
  );
});

test('pay enforces policy before the gateway is touched, and records receipts', async () => {
  const gateway = new FakeGateway();
  const d = mkdtempSync(join(tmpdir(), 'embedded-test-'));
  const wallet = await EmbeddedWallet.open(config(gateway, d));
  const { updateId } = await wallet.pay({ to: 'bob::1', amount: '2', memo: 'coffee' });
  assert.equal(updateId, 'upd-1');
  assert.equal(wallet.receipts().length, 1);
  await assert.rejects(wallet.pay({ to: 'bob::1', amount: '6' }), /refused by spend policy/);
  await assert.rejects(wallet.pay({ to: 'bob::1', amount: '1', instrument: 'USDCx' }), /refused by spend policy/);
  assert.equal(gateway.submitted.length, 1, 'refused payments must never reach the ledger');
  assert.equal(wallet.budget().spentToday, '2');
});

test('funding is tap-gated', async () => {
  const gateway = new FakeGateway();
  const d = mkdtempSync(join(tmpdir(), 'embedded-test-'));
  const wallet = await EmbeddedWallet.open(config(gateway, d));
  await wallet.fund('25');
  assert.deepEqual(gateway.tapped, ['25']);
  const gated = await EmbeddedWallet.open(config(gateway, mkdtempSync(join(tmpdir(), 'embedded-test-')), { allowTap: false }));
  await assert.rejects(gated.fund('25'), /test networks/);
});

test('the embedded link signs in with real, verifiable crypto', async () => {
  const gateway = new FakeGateway();
  const d = mkdtempSync(join(tmpdir(), 'embedded-test-'));
  const link = new EmbeddedLink(config(gateway, d) as ConstructorParameters<typeof EmbeddedLink>[0]);
  const { party } = await link.signIn('test statement');
  assert.equal(party, 'agent::1220feed');
  const [account] = await link.accounts();
  assert.equal(account?.signingProviderId, 'embedded');
  assert.match(account?.publicKey ?? '', /^302a300506032b6570032100/);
  const status = await link.status();
  assert.equal(status.connected, true);
  assert.match(status.detail ?? '', /Budget \(Amulet\)/);
});
