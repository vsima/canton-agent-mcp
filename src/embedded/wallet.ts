// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The embedded wallet: a spending allowance the agent's process holds itself.
// It is deliberately the opposite trust model from the linked phone wallet,
// and it is bounded accordingly: every payment passes the spend policy before
// anything is signed, refusals are final (the caller escalates to the human's
// phone instead), and the wallet is funded FROM the human's wallet, so a
// compromise loses the allowance, never the vault.

import { formatScaledForDisplay, SpendLog, scaled } from './policy.ts';
import type { PolicyDecision, Receipt, SpendPolicy } from './policy.ts';
import { loadWallet, saveNewWallet } from './store.ts';
import type { StoredWallet } from './store.ts';
import { publicKeyToSpkiHex, signDomainMessageHex } from './crypto.ts';
import type { CantonGateway } from '../canton.ts';

export interface EmbeddedConfig {
  dir: string;
  passphrase?: string;
  networkId: string;
  partyHint: string;
  policy: SpendPolicy;
  gateway: CantonGateway;
  generateKeys: () => Promise<{ publicKey: string; privateKey: string }>;
  /** DevNet/LocalNet test-fund minting; refuse everywhere else. */
  allowTap: boolean;
  now?: () => Date;
}

export interface EmbeddedPayRequest {
  to: string;
  amount: string;
  instrument?: string;
  memo?: string;
}

export interface Budget {
  instrument: string;
  maxPerTx: string;
  dailyCap: string;
  spentToday: string;
}

export class EmbeddedWallet {
  private readonly config: EmbeddedConfig;
  private readonly wallet: StoredWallet;
  private readonly log: SpendLog;

  private constructor(config: EmbeddedConfig, wallet: StoredWallet, log: SpendLog) {
    this.config = config;
    this.wallet = wallet;
    this.log = log;
  }

  /** Loads the stored wallet, or creates one: generate keys, allocate the
   *  external party on the ledger, persist. Never recreates over an existing
   *  store, and refuses a store from a different network. */
  static async open(config: EmbeddedConfig): Promise<EmbeddedWallet> {
    let wallet = loadWallet(config.dir, config.passphrase);
    if (wallet !== null && wallet.networkId !== config.networkId) {
      throw new Error(
        `the wallet in ${config.dir} belongs to ${wallet.networkId}, not ${config.networkId}; refusing to reuse its key across networks`,
      );
    }
    if (wallet === null) {
      const keys = await config.generateKeys();
      const partyId = await config.gateway.onboardParty(keys.publicKey, keys.privateKey, config.partyHint);
      wallet = {
        version: 1,
        networkId: config.networkId,
        partyId,
        partyHint: config.partyHint,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        createdAt: new Date().toISOString(),
      };
      saveNewWallet(config.dir, wallet, config.passphrase);
    }
    return new EmbeddedWallet(config, wallet, new SpendLog(config.dir, config.now));
  }

  get partyId(): string {
    return this.wallet.partyId;
  }

  get partyHint(): string {
    return this.wallet.partyHint;
  }

  publicKeySpkiHex(): string {
    return publicKeyToSpkiHex(this.wallet.publicKey);
  }

  budget(): Budget {
    const instrument = this.config.policy.allowedInstruments[0] ?? 'Amulet';
    return {
      instrument,
      maxPerTx: this.config.policy.maxPerTx,
      dailyCap: this.config.policy.dailyCap,
      spentToday: formatScaledForDisplay(this.log.spentToday(instrument)),
    };
  }

  receipts(): Receipt[] {
    return this.log.receipts();
  }

  canPay(request: EmbeddedPayRequest): PolicyDecision {
    return this.log.check(this.config.policy, {
      to: request.to,
      amount: request.amount,
      instrument: request.instrument ?? 'Amulet',
    });
  }

  /** Pays within policy: check, build, sign, execute, record. A refusal
   *  throws with the policy's reason so the caller can escalate. */
  async pay(request: EmbeddedPayRequest): Promise<{ updateId: string; receipt: Receipt }> {
    const instrument = request.instrument ?? 'Amulet';
    const decision = this.canPay(request);
    if (!decision.ok) throw new Error(`refused by spend policy: ${decision.reason}`);
    const built = await this.config.gateway.buildTransfer({
      sender: this.wallet.partyId,
      recipient: request.to,
      amount: request.amount,
      instrumentId: instrument,
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
    });
    const { updateId } = await this.config.gateway.submit(built, this.wallet.partyId, this.wallet.privateKey);
    const receipt = this.log.record({
      to: request.to,
      amount: request.amount,
      instrument,
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
      updateId,
    });
    return { updateId, receipt };
  }

  /** Mints test funds into the allowance. Test networks only. */
  async fund(amount: string): Promise<{ updateId: string }> {
    if (!this.config.allowTap) {
      throw new Error('funding by tap is only available on test networks; fund this wallet with a transfer instead');
    }
    scaled(amount);
    return this.config.gateway.tap(this.wallet.partyId, amount, this.wallet.privateKey);
  }

  /** Signs the CIP-0103 domain-separated bytes of `message` with the
   *  wallet's key; hex signature, verifiable against publicKeySpkiHex(). */
  signMessage(message: string): string {
    return signDomainMessageHex(message, this.wallet.privateKey);
  }
}
