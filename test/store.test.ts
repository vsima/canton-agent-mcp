// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WalletUnreadableError, loadWallet, saveNewWallet, walletFilePath } from '../src/embedded/store.ts';
import type { StoredWallet } from '../src/embedded/store.ts';

const WALLET: StoredWallet = {
  version: 1,
  networkId: 'canton:localnet',
  partyId: 'agent::1220aa',
  partyHint: 'agent',
  publicKey: Buffer.alloc(32, 1).toString('base64'),
  privateKey: Buffer.alloc(64, 2).toString('base64'),
  createdAt: '2026-08-23T00:00:00Z',
};

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'store-test-'));
}

test('plain store round-trips and is created mode 0600', () => {
  const d = dir();
  saveNewWallet(d, WALLET);
  assert.deepEqual(loadWallet(d), WALLET);
  const mode = statSync(walletFilePath(d)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('missing store loads as null; existing store refuses overwrite', () => {
  const d = dir();
  assert.equal(loadWallet(d), null);
  saveNewWallet(d, WALLET);
  assert.throws(() => saveNewWallet(d, WALLET), /refusing to overwrite/);
});

test('encrypted store round-trips with the passphrase', () => {
  const d = dir();
  saveNewWallet(d, WALLET, 'correct horse');
  assert.deepEqual(loadWallet(d, 'correct horse'), WALLET);
  const onDisk = readFileSync(walletFilePath(d), 'utf8');
  assert.ok(!onDisk.includes(WALLET.privateKey), 'private key must not appear in the encrypted file');
});

test('wrong passphrase, missing passphrase, and tampering all fail loud', () => {
  const d = dir();
  saveNewWallet(d, WALLET, 'correct horse');
  assert.throws(() => loadWallet(d, 'wrong'), WalletUnreadableError);
  assert.throws(() => loadWallet(d), WalletUnreadableError);
  const envelope = JSON.parse(readFileSync(walletFilePath(d), 'utf8')) as { dataB64: string };
  const bytes = Buffer.from(envelope.dataB64, 'base64');
  bytes[0] = (bytes[0] as number) ^ 0xff;
  envelope.dataB64 = bytes.toString('base64');
  writeFileSync(walletFilePath(d), JSON.stringify(envelope));
  assert.throws(() => loadWallet(d, 'correct horse'), WalletUnreadableError);
});

test('garbage and unrecognized shapes fail loud, never as a fresh wallet', () => {
  const d = dir();
  writeFileSync(walletFilePath(d), 'not json');
  assert.throws(() => loadWallet(d), WalletUnreadableError);
  writeFileSync(walletFilePath(d), JSON.stringify({ version: 99 }));
  assert.throws(() => loadWallet(d), WalletUnreadableError);
});
