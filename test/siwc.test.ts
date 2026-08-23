// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';

import {
  SIGN_MESSAGE_DOMAIN,
  signingBytes,
  buildSignInMessage,
  parseSignInMessage,
  verifySignIn,
  type NonceBinding,
} from '../src/siwc.ts';
import { NonceStore } from '../src/nonceStore.ts';

// Mirrors the shared golden vector canton-mobile-sdk/testdata/dapp/signmessage.json
// (kept in sync by hand; the SDK's own tests enforce the cross-language side).
// signingBytesHex is the exact bytes a signMessage request signs: the 38-byte
// domain prefix, then the UTF-8 message. Byte-for-byte agreement here is what
// lets this server verify a signature a Kotlin or Swift wallet produced.
const GOLDEN = {
  domain: 'CantonNetwork:CIP-0103:signMessage:v1\n',
  domainByteLength: 38,
  message: 'Sign in to Example dApp\nnonce: 7f3a9c2e',
  signingBytesHex:
    '43616e746f6e4e6574776f726b3a4349502d303130333a7369676e4d6573736167653a76310a5369676e20696e20746f204578616d706c6520644170700a6e6f6e63653a203766336139633265',
};

test('domain constant matches the shared golden vector', () => {
  assert.equal(SIGN_MESSAGE_DOMAIN, GOLDEN.domain);
  assert.equal(Buffer.byteLength(SIGN_MESSAGE_DOMAIN, 'utf8'), GOLDEN.domainByteLength);
  // Longer than a 32-byte prepared-transaction hash, so signing bytes can
  // never coincide with a tx-hash signature.
  assert.ok(GOLDEN.domainByteLength > 32);
});

test('signingBytes reproduces the golden vector byte-for-byte', () => {
  assert.equal(signingBytes(GOLDEN.message).toString('hex'), GOLDEN.signingBytesHex);
});

// --- message build / parse round-trips -------------------------------------

const baseFields = {
  domain: 'pay.example.com',
  party:
    'alice::12206e297fb60b09f7a0ae0cc6f81b672c69ca04a72fc34042f5a6364967ab87d7d0',
  uri: 'https://pay.example.com/login',
  networkId: 'canton:da-mainnet',
  nonce: '7f3a9c2e1b8d4a06',
  issuedAt: '2026-08-12T18:30:00Z',
};

test('build → parse round-trips with a statement and expiration', () => {
  const fields = { ...baseFields, statement: 'Sign in to Example Pay.', expirationTime: '2026-08-12T18:35:00Z' };
  const message = buildSignInMessage(fields);
  // Matches the concrete example in spec §7.2.
  assert.equal(
    message,
    [
      'pay.example.com wants you to sign in with your Canton account:',
      baseFields.party,
      '',
      'Sign in to Example Pay.',
      '',
      'URI: https://pay.example.com/login',
      'Version: 1',
      'Network: canton:da-mainnet',
      'Nonce: 7f3a9c2e1b8d4a06',
      'Issued At: 2026-08-12T18:30:00Z',
      'Expiration Time: 2026-08-12T18:35:00Z',
    ].join('\n'),
  );
  assert.deepEqual(parseSignInMessage(message), fields);
});

test('build → parse round-trips without a statement (blank lines collapse)', () => {
  const message = buildSignInMessage(baseFields);
  assert.equal(message.split('\n')[2], ''); // single blank line after the party
  assert.equal(message.split('\n')[3], 'URI: https://pay.example.com/login');
  assert.deepEqual(parseSignInMessage(message), { ...baseFields, statement: undefined, expirationTime: undefined });
});

test('parse rejects an unsupported version rather than guessing', () => {
  const message = buildSignInMessage(baseFields).replace('Version: 1', 'Version: 2');
  assert.throws(() => parseSignInMessage(message), /unsupported Version/);
});

// --- full verification, both key algorithms --------------------------------

interface Wallet {
  publicKeyHex: string;
  sign: (bytes: Buffer) => Buffer;
}

/** An Ed25519 wallet, signs the raw bytes; SPKI public key, as listAccounts publishes. */
function ed25519Wallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyHex: spkiHex(publicKey),
    sign: (bytes) => cryptoSign(null, bytes, privateKey),
  };
}

/** A P-256 wallet, ECDSA/SHA-256, DER signature; SPKI public key. */
function p256Wallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKeyHex: spkiHex(publicKey),
    sign: (bytes) => cryptoSign('sha256', bytes, { key: privateKey, dsaEncoding: 'der' }),
  };
}

function spkiHex(key: KeyObject): string {
  return key.export({ format: 'der', type: 'spki' }).toString('hex');
}

const VERIFY_OPTS = { expectedDomain: 'pay.example.com', expectedNetworkId: 'canton:da-mainnet', clockSkewSeconds: 60 };

/** Issues a challenge for the wallet and returns the signed message + a live NonceStore. */
function challenge(wallet: Wallet, overrides: Partial<typeof baseFields> = {}) {
  const store = new NonceStore(300);
  const { nonce } = store.issue(baseFields.party, wallet.publicKeyHex);
  const fields = { ...baseFields, nonce, expirationTime: '2026-08-12T18:35:00Z', ...overrides };
  const message = buildSignInMessage(fields);
  const signature = wallet.sign(signingBytes(message));
  return { store, message, signature };
}

const AT_ISSUE = new Date('2026-08-12T18:30:30Z'); // 30s after issuedAt, before expiry

for (const [name, make] of [['Ed25519', ed25519Wallet], ['P-256', p256Wallet]] as const) {
  test(`${name}: a genuine signature authenticates the party`, () => {
    const wallet = make();
    const { store, message, signature } = challenge(wallet);
    const result = verifySignIn({ message, signature, ...VERIFY_OPTS, now: AT_ISSUE, consumeNonce: (n, t) => store.consume(n, t) });
    assert.equal(result.reason, 'ok');
    assert.equal(result.party, baseFields.party);
  });

  test(`${name}: a tampered signature is rejected`, () => {
    const wallet = make();
    const { store, message, signature } = challenge(wallet);
    const last = signature.length - 1;
    signature[last] = signature[last]! ^ 0x01;
    const result = verifySignIn({ message, signature, ...VERIFY_OPTS, now: AT_ISSUE, consumeNonce: (n, t) => store.consume(n, t) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad-signature');
  });
}

test("a signature from a different key does not authenticate the party (key is bound to the nonce)", () => {
  const wallet = ed25519Wallet();
  const attacker = ed25519Wallet();
  // The server issued the nonce for the real wallet's key; the attacker signs
  // the same message with their own key.
  const store = new NonceStore(300);
  const { nonce } = store.issue(baseFields.party, wallet.publicKeyHex);
  const message = buildSignInMessage({ ...baseFields, nonce, expirationTime: '2026-08-12T18:35:00Z' });
  const signature = attacker.sign(signingBytes(message));
  const result = verifySignIn({ message, signature, ...VERIFY_OPTS, now: AT_ISSUE, consumeNonce: (n, t) => store.consume(n, t) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-signature');
});

test('a wrong domain is rejected before the nonce is consumed', () => {
  const wallet = ed25519Wallet();
  const { store, message, signature } = challenge(wallet, { domain: 'evil.example.com' });
  const before = store.size;
  const result = verifySignIn({ message, signature, ...VERIFY_OPTS, now: AT_ISSUE, consumeNonce: (n, t) => store.consume(n, t) });
  assert.equal(result.reason, 'domain-mismatch');
  assert.equal(store.size, before, 'the nonce must survive a cross-site attempt');
});

test('an expired message is rejected', () => {
  const wallet = ed25519Wallet();
  const { store, message, signature } = challenge(wallet);
  const wellPastExpiry = new Date('2026-08-12T19:00:00Z');
  const result = verifySignIn({ message, signature, ...VERIFY_OPTS, now: wellPastExpiry, consumeNonce: (n, t) => store.consume(n, t) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('a nonce cannot be replayed', () => {
  const wallet = ed25519Wallet();
  const { store, message, signature } = challenge(wallet);
  const consume = (n: string, t: Date): NonceBinding | null => store.consume(n, t);
  const first = verifySignIn({ message, signature, ...VERIFY_OPTS, now: AT_ISSUE, consumeNonce: consume });
  assert.equal(first.ok, true);
  const second = verifySignIn({ message, signature, ...VERIFY_OPTS, now: AT_ISSUE, consumeNonce: consume });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'unknown-or-consumed-nonce');
});
