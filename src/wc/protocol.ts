// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The WalletConnect ⇄ Canton contract. WalletConnect is not a new capability:
// it is a live-session *transport* for the CIP-0103 requests the wallet already
// answers (the same `signMessage` and transfer the scan-to-pay QR carries as a
// one-shot payload). This module is the transport-agnostic half: the namespace,
// the method names, the CAIP identifiers, and the request/result shapes. It
// imports neither the WalletConnect SDK nor the Canton SDK, so both ends, and
// the tests, share one definition of what crosses the wire.

/** WalletConnect namespace for Canton. WalletConnect groups a session's chains,
 *  methods and accounts under a namespace key (`eip155` for Ethereum); for
 *  Canton it is `canton`, the namespace WalletConnect's published Canton chain
 *  support defines (`canton:<network-id>`). */
export const CANTON_NAMESPACE = 'canton';

/** The methods this reference carries over a session, as JSON-RPC method names.
 *  All are **real CIP-0103** (OpenRPC 0.5.0), the exact bare names the SDK's
 *  provider engine answers, so a native wallet interoperates. */
export const CANTON_METHODS = {
  /** Request a connection; the wallet grants accounts (usually via the user). */
  connect: 'connect',
  /** End the session. */
  disconnect: 'disconnect',
  /** Whether a connection exists, without prompting. */
  isConnected: 'isConnected',
  /** The accounts granted this dApp, each carries its `publicKey`. */
  listAccounts: 'listAccounts',
  /** The primary granted account. */
  getPrimaryAccount: 'getPrimaryAccount',
  /** Sign a structured message (Sign-In with Canton). {@link SignMessageParams}
   *  → {@link SignMessageResult}. */
  signMessage: 'signMessage',
  /** Submit prepared commands and wait for execution, the wallet prepares on
   *  its participant, verifies the hash, signs in its enclave, and executes.
   *  {@link PrepareSubmission} → {@link ExecutedResult}. This is the standard
   *  Canton one-tap payment (a Token Standard transfer, pushed to the wallet). */
  prepareExecuteAndWait: 'prepareExecuteAndWait',
} as const;

export type CantonMethod = (typeof CANTON_METHODS)[keyof typeof CANTON_METHODS];

/** Every method a session advertises. A wallet approves only the subset it
 *  supports. */
export const ALL_METHODS: readonly string[] = Object.values(CANTON_METHODS);

// --- CAIP identifiers -------------------------------------------------------
//
// WalletConnect speaks CAIP: a chain is `namespace:reference` (CAIP-2) and an
// account is `namespace:reference:address` (CAIP-10). Our network id is already
// CAIP-2 shaped (`canton:localnet`), so it *is* the chain id. The catch is the
// account address: a Canton party id (`hint::1220<fingerprint>`) contains `::`,
// which the CAIP-10 address segment forbids, so it must be percent-encoded.

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/** Validates a CAIP-2 chain id and returns it. Our `networkId` config value is
 *  already CAIP-2 (`canton:localnet`), so it doubles as the chain id; this just
 *  guards a mis-typed override before it reaches the relay. */
export function chainId(networkId: string): string {
  if (!CAIP2.test(networkId)) {
    throw new Error(`networkId ${JSON.stringify(networkId)} is not a CAIP-2 chain id (namespace:reference)`);
  }
  return networkId;
}

const CAIP10_ADDRESS_SAFE = /[A-Za-z0-9.\-]/;

/**
 * Encodes a Canton party id into a CAIP-10 address segment. The CAIP-10 address
 * charset is `[-.%a-zA-Z0-9]`, so every other byte, notably the `:` in `::`
 * and any `_` in a party hint, is percent-encoded (upper-case, UTF-8 bytes).
 * The inverse is a plain `decodeURIComponent`.
 */
export function encodePartyAddress(party: string): string {
  return [...new TextEncoder().encode(party)]
    .map((b) => (CAIP10_ADDRESS_SAFE.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

/** Recovers a party id from a CAIP-10 address segment. */
export function decodePartyAddress(address: string): string {
  return decodeURIComponent(address);
}

/** Builds the CAIP-10 account (`chain:encodedParty`) a session advertises. */
export function toAccount(chain: string, party: string): string {
  return `${chain}:${encodePartyAddress(party)}`;
}

/** Extracts the party id from a CAIP-10 account. The address segment carries no
 *  literal `:` (they are percent-encoded), so the last `:` splits chain from
 *  address unambiguously. */
export function partyFromAccount(account: string): string {
  const cut = account.lastIndexOf(':');
  if (cut < 0) throw new Error(`not a CAIP-10 account: ${JSON.stringify(account)}`);
  return decodePartyAddress(account.slice(cut + 1));
}

// --- request / result payloads ----------------------------------------------

/** `signMessage` params: the exact string the wallet signs. */
export interface SignMessageParams {
  message: string;
}

/** `signMessage` result, the CIP-0103 shape: just the signature (hex). The
 *  public key to verify it against comes from {@link DappAccount.publicKey} via
 *  `listAccounts`, not from this result. */
export interface SignMessageResult {
  signature: string;
}

/** `connect` / `isConnected` result (OpenRPC `ConnectResult`). */
export interface ConnectResult {
  isConnected: boolean;
  isNetworkConnected: boolean;
  reason?: string;
}

/** `prepareExecuteAndWait` params (OpenRPC `JsPrepareSubmissionRequest`). The
 *  wallet supplies `actAs`'s synchronizer and signing; the dApp supplies the
 *  commands and their disclosed contracts. */
export interface PrepareSubmission {
  /** JSON Ledger API commands (e.g. a Token Standard `ExerciseCommand`). */
  commands: unknown[];
  /** The party to act as, must be one the wallet granted this dApp. */
  actAs: string[];
  /** Disclosed contracts the commands reference (e.g. the registry factory). */
  disclosedContracts?: unknown[];
}

/** `prepareExecuteAndWait` result, the executed transaction (`txChanged`). */
export interface ExecutedResult {
  tx: { commandId: string; status: string; payload?: { updateId?: string } };
}

/** One account `listAccounts` returns (OpenRPC `Wallet`). `publicKey` is the
 *  SPKI-DER hex a Sign-In signature verifies against. */
export interface DappAccount {
  primary: boolean;
  partyId: string;
  status: string;
  hint: string;
  publicKey: string;
  namespace: string;
  networkId: string;
  signingProviderId: string;
}


