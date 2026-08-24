// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The embedded wallet's spend policy: hard caps evaluated before anything is
// signed, plus a receipts log the caps are computed from. The embedded wallet
// exists to spend autonomously, so the caps ARE the security boundary; every
// check fails closed, and a payment that cannot be evaluated is refused, not
// guessed at. Amounts are decimal strings compared at 10 decimal places
// (Canton's amount precision) via bigint, never floats.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SpendPolicy {
  /** Largest single payment, decimal string. */
  maxPerTx: string;
  /** Total across payments in one UTC day, decimal string. */
  dailyCap: string;
  /** Instruments payments may use. Anything else is refused. */
  allowedInstruments: string[];
  /** When set, only these receiver party ids may be paid. */
  allowedReceivers?: string[];
}

export interface SpendRequest {
  to: string;
  amount: string;
  instrument: string;
}

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

export interface Receipt {
  at: string;
  to: string;
  amount: string;
  instrument: string;
  memo?: string;
  updateId: string;
}

const SCALE = 10n ** 10n;
const AMOUNT = /^\d+(\.\d{1,10})?$/;

/** Renders a 10-dp scaled bigint back to a trimmed decimal string. */
export function formatScaledForDisplay(value: bigint): string {
  const whole = value / SCALE;
  const frac = (value % SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/** Parses a decimal amount string into a 10-dp scaled bigint. Throws on any
 *  shape it does not fully recognize. */
export function scaled(amount: string): bigint {
  if (!AMOUNT.test(amount)) throw new Error(`not a decimal amount: ${JSON.stringify(amount)}`);
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole as string) * SCALE + BigInt(frac.padEnd(10, '0'));
}

const RECEIPTS = 'receipts.jsonl';

/**
 * Receipts on disk plus the policy math over them. The daily total is
 * recomputed from the log on each check, so it survives restarts and there is
 * exactly one source of truth for what was spent.
 */
export class SpendLog {
  private readonly path: string;
  private readonly now: () => Date;

  constructor(dir: string, now: () => Date = () => new Date()) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, RECEIPTS);
    this.now = now;
  }

  receipts(): Receipt[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Receipt);
  }

  /** Scaled total spent today (UTC) in `instrument`. */
  spentToday(instrument: string): bigint {
    const today = this.now().toISOString().slice(0, 10);
    return this.receipts()
      .filter((r) => r.instrument === instrument && r.at.slice(0, 10) === today)
      .reduce((sum, r) => sum + scaled(r.amount), 0n);
  }

  record(receipt: Omit<Receipt, 'at'>): Receipt {
    const full: Receipt = { at: this.now().toISOString(), ...receipt };
    appendFileSync(this.path, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    return full;
  }

  /** Evaluates `request` against `policy` and what the log says was already
   *  spent. Fails closed: malformed input is a refusal, not an exception path
   *  the caller might forget. */
  check(policy: SpendPolicy, request: SpendRequest): PolicyDecision {
    let amount: bigint;
    try {
      amount = scaled(request.amount);
    } catch {
      return { ok: false, reason: `amount ${JSON.stringify(request.amount)} is not a plain decimal` };
    }
    if (amount <= 0n) return { ok: false, reason: 'amount must be positive' };
    if (!policy.allowedInstruments.includes(request.instrument)) {
      return { ok: false, reason: `instrument ${request.instrument} is not allowed (allowed: ${policy.allowedInstruments.join(', ')})` };
    }
    if (policy.allowedReceivers !== undefined && !policy.allowedReceivers.includes(request.to)) {
      return { ok: false, reason: `receiver ${request.to} is not on the allowlist` };
    }
    if (amount > scaled(policy.maxPerTx)) {
      return { ok: false, reason: `amount ${request.amount} exceeds the per-payment cap of ${policy.maxPerTx}` };
    }
    const spent = this.spentToday(request.instrument);
    if (spent + amount > scaled(policy.dailyCap)) {
      return {
        ok: false,
        reason: `payment would exceed the daily cap of ${policy.dailyCap} (already spent today at this cap's precision)`,
      };
    }
    return { ok: true };
  }
}
