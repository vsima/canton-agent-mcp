// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// Sign-in with Canton, the dApp-server side of the flow specified in the
// dApp implementation spec §7.2. A convention over CIP-0103 `signMessage`,
// modelled on Sign-In with Ethereum (ERC-4361): the dApp builds a structured,
// human-readable challenge; the wallet signs the domain-separated bytes in its
// enclave; this server verifies the signature against the party's public key.
//
// The dApp authors the message string once and no one re-serializes it: the
// wallet signs the bytes it received, and the verifier checks the bytes it
// received. That removes SIWE's whole canonicalization failure surface.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Domain-separation prefix, byte-identical to the SDK's `DappSignMessage`
 * (canton-dapp / CantonDappKit). It is 38 bytes, deliberately longer than a
 * 32-byte prepared-transaction hash, so a sign-in signature can never also be
 * a valid transaction signature. Shared golden vector:
 * `canton-mobile-sdk/testdata/dapp/signmessage.json`.
 */
export const SIGN_MESSAGE_DOMAIN = 'CantonNetwork:CIP-0103:signMessage:v1\n';

/** The exact bytes a `signMessage` request signs: the domain prefix, then the
 *  UTF-8 message. Byte-for-byte agreement with the wallet is what lets a Swift
 *  or Kotlin wallet and this server interoperate. */
export function signingBytes(message: string): Buffer {
  return Buffer.concat([Buffer.from(SIGN_MESSAGE_DOMAIN, 'utf8'), Buffer.from(message, 'utf8')]);
}

export interface SignInFields {
  domain: string;
  party: string;
  statement?: string;
  uri: string;
  networkId: string;
  nonce: string;
  issuedAt: string; // RFC 3339 UTC, e.g. 2026-08-12T18:30:00Z
  expirationTime?: string; // RFC 3339 UTC
}

const HEADER_SUFFIX = ' wants you to sign in with your Canton account:';

/**
 * Renders the strict line-based template from spec §7.2: LF line endings, no
 * trailing newline, fields in exactly this order. The statement, when present,
 * sits between blank lines; when absent those collapse to a single blank line
 * before `URI:`. `Expiration Time` is omitted entirely when not given.
 */
export function buildSignInMessage(f: SignInFields): string {
  const lines: string[] = [`${f.domain}${HEADER_SUFFIX}`, f.party, ''];
  if (f.statement !== undefined && f.statement !== '') {
    lines.push(f.statement, '');
  }
  lines.push(
    `URI: ${f.uri}`,
    'Version: 1',
    `Network: ${f.networkId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
  );
  if (f.expirationTime !== undefined) lines.push(`Expiration Time: ${f.expirationTime}`);
  return lines.join('\n');
}

export class SignInParseError extends Error {}

/**
 * Reads the fields back out of a received sign-in message for validation and
 * display. It never re-emits the signed bytes, those are always the exact
 * string received. A future field a verifier does not understand must cause a
 * rejection, not be ignored, so the version gate stays meaningful; this parser
 * rejects unknown or misordered lines rather than skipping them.
 */
export function parseSignInMessage(text: string): SignInFields {
  const lines = text.split('\n');

  const header = lines[0];
  if (header === undefined || !header.endsWith(HEADER_SUFFIX)) {
    throw new SignInParseError('missing or malformed header line');
  }
  const domain = header.slice(0, header.length - HEADER_SUFFIX.length);
  if (domain === '') throw new SignInParseError('empty domain');

  const party = lines[1];
  if (party === undefined || party === '') throw new SignInParseError('missing party');
  if (lines[2] !== '') throw new SignInParseError('expected a blank line after the party');

  let i = 3;
  let statement: string | undefined;
  const afterBlank = lines[i];
  if (afterBlank !== undefined && !afterBlank.startsWith('URI: ')) {
    statement = afterBlank;
    i++;
    if (lines[i] !== '') throw new SignInParseError('expected a blank line after the statement');
    i++;
  }

  const field = (label: string): string => {
    const line = lines[i++];
    const prefix = `${label}: `;
    if (line === undefined || !line.startsWith(prefix)) {
      throw new SignInParseError(`expected "${label}:" line`);
    }
    return line.slice(prefix.length);
  };

  const uri = field('URI');
  const version = field('Version');
  if (version !== '1') throw new SignInParseError(`unsupported Version ${JSON.stringify(version)}`);
  const networkId = field('Network');
  const nonce = field('Nonce');
  const issuedAt = field('Issued At');

  let expirationTime: string | undefined;
  const maybeExp = lines[i];
  if (maybeExp !== undefined && maybeExp.startsWith('Expiration Time: ')) {
    expirationTime = maybeExp.slice('Expiration Time: '.length);
    i++;
  }

  if (i !== lines.length) throw new SignInParseError('unexpected trailing content');

  return { domain, party, statement, uri, networkId, nonce, issuedAt, expirationTime };
}

/**
 * Verifies `signature` over `signingBytes(message)` against an SPKI public key
 * (DER, hex-encoded, the shape `listAccounts` publishes). Ed25519 keys verify
 * over the raw message bytes; P-256 keys verify an ECDSA/SHA-256 signature in
 * DER encoding, exactly what the SDK's signing drivers produce.
 */
export function verifySignature(message: string, publicKeyHex: string, signature: Buffer): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
  const data = signingBytes(message);
  switch (key.asymmetricKeyType) {
    case 'ed25519':
      return cryptoVerify(null, data, key, signature);
    case 'ec':
      return cryptoVerify('sha256', data, { key, dsaEncoding: 'der' }, signature);
    default:
      throw new Error(`unsupported key algorithm: ${String(key.asymmetricKeyType)}`);
  }
}

export interface NonceBinding {
  party: string;
  publicKey: string;
}

export interface VerifyInput {
  /** The exact message string the wallet signed. */
  message: string;
  /** The signature bytes returned by `signMessage`. */
  signature: Buffer;
  /** This verifier's own domain, the signed message must name it. */
  expectedDomain: string;
  /** If set, the signed message's `Network:` must equal it. */
  expectedNetworkId?: string;
  clockSkewSeconds: number;
  now?: Date;
  /** Consumes the challenge nonce (single-use) and returns what it was bound
   *  to, the party and the public key claimed for it at challenge time. */
  consumeNonce: (nonce: string, now: Date) => NonceBinding | null;
}

export type VerifyReason =
  | 'ok'
  | 'domain-mismatch'
  | 'network-mismatch'
  | 'unknown-or-consumed-nonce'
  | 'party-nonce-mismatch'
  | 'bad-signature'
  | 'bad-issued-at'
  | 'issued-in-future'
  | 'bad-expiration'
  | 'expired';

export interface VerifyResult {
  ok: boolean;
  party?: string;
  reason: VerifyReason | `parse: ${string}` | `key: ${string}`;
}

/**
 * The full sign-in check (spec §7.2 step 3): the signature is valid over the
 * domain-separated bytes against the party's key; the message names this
 * verifier's domain (and network, if enforced); the nonce was issued here and
 * is single-use; the party matches what the nonce was issued for; and the
 * timestamps are fresh. All must pass to authenticate as `party`.
 *
 * Cheap structural checks (domain, network) run before the nonce is consumed,
 * so an unrelated cross-site attempt cannot burn a legitimate nonce; anything
 * from the nonce onward has already presented a valid challenge.
 */
export function verifySignIn(input: VerifyInput): VerifyResult {
  const now = input.now ?? new Date();

  let fields: SignInFields;
  try {
    fields = parseSignInMessage(input.message);
  } catch (e) {
    return { ok: false, reason: `parse: ${(e as Error).message}` };
  }

  if (fields.domain !== input.expectedDomain) return { ok: false, reason: 'domain-mismatch' };
  if (input.expectedNetworkId !== undefined && fields.networkId !== input.expectedNetworkId) {
    return { ok: false, reason: 'network-mismatch' };
  }

  const binding = input.consumeNonce(fields.nonce, now);
  if (binding === null) return { ok: false, reason: 'unknown-or-consumed-nonce' };
  if (binding.party !== fields.party) return { ok: false, reason: 'party-nonce-mismatch' };

  let signatureOk: boolean;
  try {
    signatureOk = verifySignature(input.message, binding.publicKey, input.signature);
  } catch (e) {
    return { ok: false, reason: `key: ${(e as Error).message}` };
  }
  if (!signatureOk) return { ok: false, reason: 'bad-signature' };

  const issuedAt = Date.parse(fields.issuedAt);
  if (Number.isNaN(issuedAt)) return { ok: false, reason: 'bad-issued-at' };
  const skewMs = input.clockSkewSeconds * 1000;
  if (issuedAt - skewMs > now.getTime()) return { ok: false, reason: 'issued-in-future' };

  if (fields.expirationTime !== undefined) {
    const expiration = Date.parse(fields.expirationTime);
    if (Number.isNaN(expiration)) return { ok: false, reason: 'bad-expiration' };
    if (now.getTime() > expiration + skewMs) return { ok: false, reason: 'expired' };
  }

  return { ok: true, party: fields.party, reason: 'ok' };
}
