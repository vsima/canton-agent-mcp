// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';

/**
 * A sign-in challenge the server issued: the party it authenticates and the
 * public key the wallet claimed for that party at connect time. Verification
 * checks the signature against exactly this key, so the key is bound to the
 * challenge rather than trusted from the verify request.
 */
export interface NonceBinding {
  party: string;
  publicKey: string;
  expiresAt: Date;
}

/**
 * Single-use, time-bounded sign-in nonces, held in memory. A real deployment
 * would back this with Redis or a database so nonces survive a restart and are
 * shared across instances; the contract (issue once, consume at most once)
 * is the part that matters and is what the verifier depends on.
 */
export class NonceStore {
  private readonly nonces = new Map<string, NonceBinding>();
  private readonly ttlSeconds: number;

  constructor(ttlSeconds: number) {
    this.ttlSeconds = ttlSeconds;
  }

  /** Issues a fresh 128-bit nonce bound to the party and its public key. */
  issue(party: string, publicKey: string, now: Date = new Date()): { nonce: string; expiresAt: Date } {
    const nonce = randomBytes(16).toString('hex'); // 32 hex chars, ≥ 8 per the spec
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);
    this.nonces.set(nonce, { party, publicKey, expiresAt });
    return { nonce, expiresAt };
  }

  /**
   * Removes and returns the binding for `nonce`, or null if it was never
   * issued, already consumed, or has expired. Removal happens either way, so a
   * nonce is spent by the first verify attempt that reaches it, a captured
   * sign-in message cannot be replayed.
   */
  consume(nonce: string, now: Date = new Date()): NonceBinding | null {
    const found = this.nonces.get(nonce);
    if (found === undefined) return null;
    this.nonces.delete(nonce);
    if (found.expiresAt.getTime() < now.getTime()) return null;
    return found;
  }

  /** Drops expired nonces; call periodically so the map doesn't grow unbounded. */
  sweep(now: Date = new Date()): void {
    for (const [nonce, binding] of this.nonces) {
      if (binding.expiresAt.getTime() < now.getTime()) this.nonces.delete(nonce);
    }
  }

  /** Number of live (issued, unconsumed) nonces, for /health and tests. */
  get size(): number {
    return this.nonces.size;
  }
}
