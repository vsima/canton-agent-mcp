// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The embedded wallet's key store: one JSON file holding the party and its
// Ed25519 keypair. This is a HOT wallet by design (an agent's spending
// allowance, not a vault): the file is mode 0600, optionally encrypted with a
// passphrase (scrypt + AES-256-GCM), and an unreadable or tampered store
// fails loud rather than silently minting a fresh wallet. A silently
// recreated wallet would orphan the party and whatever funds it holds.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StoredWallet {
  version: 1;
  networkId: string;
  partyId: string;
  partyHint: string;
  /** Base64 raw Ed25519 public key, as the SDK's keys.generate() returns. */
  publicKey: string;
  /** Base64 Ed25519 secret key (seed-first), as keys.generate() returns. */
  privateKey: string;
  createdAt: string;
}

interface EncryptedEnvelope {
  version: 1;
  encrypted: true;
  kdf: 'scrypt';
  saltB64: string;
  ivB64: string;
  tagB64: string;
  dataB64: string;
}

/** Thrown when a store exists but cannot be read. Never swallowed into a
 *  fresh wallet: losing the key means losing the party. */
export class WalletUnreadableError extends Error {}

const FILE = 'wallet.json';

function keyFor(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

export function walletFilePath(dir: string): string {
  return join(dir, FILE);
}

export function loadWallet(dir: string, passphrase?: string): StoredWallet | null {
  const path = walletFilePath(dir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new WalletUnreadableError(`wallet store at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const envelope = parsed as Partial<EncryptedEnvelope>;
  if (envelope.encrypted === true) {
    if (passphrase === undefined) {
      throw new WalletUnreadableError(`wallet store at ${path} is encrypted; set AGENT_WALLET_PASSPHRASE`);
    }
    try {
      const salt = Buffer.from(envelope.saltB64 as string, 'base64');
      const iv = Buffer.from(envelope.ivB64 as string, 'base64');
      const tag = Buffer.from(envelope.tagB64 as string, 'base64');
      const data = Buffer.from(envelope.dataB64 as string, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', keyFor(passphrase, salt), iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]);
      parsed = JSON.parse(plain.toString('utf8'));
    } catch {
      throw new WalletUnreadableError(
        `wallet store at ${path} could not be decrypted (wrong passphrase, or the file was tampered with)`,
      );
    }
  }
  const wallet = parsed as Partial<StoredWallet>;
  if (
    wallet.version !== 1 ||
    typeof wallet.partyId !== 'string' ||
    typeof wallet.publicKey !== 'string' ||
    typeof wallet.privateKey !== 'string' ||
    typeof wallet.networkId !== 'string'
  ) {
    throw new WalletUnreadableError(`wallet store at ${path} has an unrecognized shape`);
  }
  return wallet as StoredWallet;
}

/** Writes a freshly-created wallet. Refuses to overwrite: an existing store
 *  is someone's party. */
export function saveNewWallet(dir: string, wallet: StoredWallet, passphrase?: string): void {
  mkdirSync(dir, { recursive: true });
  const path = walletFilePath(dir);
  if (existsSync(path)) {
    throw new Error(`a wallet store already exists at ${path}; refusing to overwrite it`);
  }
  let payload: string;
  if (passphrase !== undefined) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyFor(passphrase, salt), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(wallet), 'utf8'), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      encrypted: true,
      kdf: 'scrypt',
      saltB64: salt.toString('base64'),
      ivB64: iv.toString('base64'),
      tagB64: cipher.getAuthTag().toString('base64'),
      dataB64: data.toString('base64'),
    };
    payload = JSON.stringify(envelope);
  } else {
    payload = JSON.stringify(wallet, null, 2);
  }
  writeFileSync(path, payload, { mode: 0o600 });
}
