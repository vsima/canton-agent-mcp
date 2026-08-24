// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The headless wallet's signing, in the same shape a real enclave produces.
//
// The Canton SDK's keys are Ed25519 (tweetnacl): a base64 raw 32-byte public
// key and a base64 secret key whose first 32 bytes are the seed. Node's crypto
// wants DER, and the sign-in verifier (siwc.ts) wants an SPKI public key and a
// signature over the CIP-0103 *domain-separated* bytes, not the raw message
// the SDK's low-level `signMessage` would sign. Ed25519 has fixed DER framings,
// so wrapping raw keys into SPKI / PKCS#8 is a constant-prefix concat. The wc
// unit test round-trips these against siwc's own verifier and node's own DER.

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { signingBytes } from '../siwc.ts';

// Fixed DER framings for Ed25519 (RFC 8410): the AlgorithmIdentifier is the same
// for every key, so only the 32 raw bytes differ.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // 12 bytes, then 32-byte pubkey
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex'); // 16 bytes, then 32-byte seed

/** Wraps a base64 raw Ed25519 public key (as `sdk.keys.generate()` returns) into
 *  an SPKI-DER hex string, the shape `siwc.verifySignature` and `listAccounts`
 *  use. */
export function publicKeyToSpkiHex(publicKeyBase64: string): string {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`expected a 32-byte Ed25519 public key, got ${raw.length} bytes`);
  }
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]).toString('hex');
}

/**
 * Signs the CIP-0103 domain-separated bytes of `message` with a base64 Ed25519
 * private key (the SDK's secret key or a bare 32-byte seed, the first 32 bytes
 * are the seed either way), returning the signature as hex. This is what a
 * `canton_signMessage` request answers with, verifiable by `siwc.verifySignature`.
 */
export function signDomainMessageHex(message: string, privateKeyBase64: string): string {
  const seed = Buffer.from(privateKeyBase64, 'base64').subarray(0, 32);
  if (seed.length !== 32) {
    throw new Error(`expected at least a 32-byte Ed25519 seed, got ${seed.length} bytes`);
  }
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return cryptoSign(null, signingBytes(message), key).toString('hex');
}
