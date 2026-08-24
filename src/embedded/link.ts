// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The embedded wallet presented through the same interface the MCP tools use
// for the linked phone wallet, so the tool surface stays one thing. The
// wallet opens lazily on first use (creation touches the ledger to allocate
// the party) and there is no pairing: the "connection" is the wallet itself.

import { randomUUID } from 'node:crypto';
import type { AgentWalletLink } from '../tools.ts';
import type { LinkStatus, PayRequest, PayResult } from '../link.ts';
import type { DappAccount } from '../wc/protocol.ts';
import { buildSignInMessage, verifySignature } from '../siwc.ts';
import { EmbeddedWallet } from './wallet.ts';
import type { EmbeddedConfig, EmbeddedPayRequest } from './wallet.ts';
import type { PolicyDecision } from './policy.ts';

export interface EmbeddedLinkConfig extends EmbeddedConfig {
  /** The Sign-In challenge domain (the agent authenticates as itself). */
  domain: string;
}

export class EmbeddedLink implements AgentWalletLink {
  private readonly config: EmbeddedLinkConfig;
  private walletPromise: Promise<EmbeddedWallet> | null = null;

  constructor(config: EmbeddedLinkConfig) {
    this.config = config;
  }

  wallet(): Promise<EmbeddedWallet> {
    if (this.walletPromise === null) this.walletPromise = EmbeddedWallet.open(this.config);
    return this.walletPromise;
  }

  async status(): Promise<LinkStatus> {
    const wallet = await this.wallet();
    const budget = wallet.budget();
    return {
      connected: true,
      walletName: 'Embedded wallet',
      pairingPending: false,
      networkId: this.config.networkId,
      detail: [
        `Party: ${wallet.partyId}`,
        `Budget (${budget.instrument}): up to ${budget.maxPerTx} per payment, ${budget.dailyCap} per day, ${budget.spentToday} spent today.`,
      ].join('\n'),
    };
  }

  async startPairing(): Promise<{ uri: string }> {
    throw new Error('the embedded wallet needs no pairing; it is always available');
  }

  async accounts(): Promise<DappAccount[]> {
    const wallet = await this.wallet();
    return [
      {
        primary: true,
        partyId: wallet.partyId,
        status: 'active',
        hint: wallet.partyHint,
        publicKey: wallet.publicKeySpkiHex(),
        namespace: wallet.partyId.split('::')[1] ?? '',
        networkId: this.config.networkId,
        signingProviderId: 'embedded',
      },
    ];
  }

  async signIn(statement?: string): Promise<{ party: string }> {
    const wallet = await this.wallet();
    const message = buildSignInMessage({
      domain: this.config.domain,
      party: wallet.partyId,
      statement: statement ?? 'Authorize this embedded agent wallet.',
      uri: `https://${this.config.domain}/agent`,
      networkId: this.config.networkId,
      nonce: randomUUID().replace(/-/g, ''),
      issuedAt: new Date().toISOString(),
    });
    const signature = wallet.signMessage(message);
    if (!verifySignature(message, wallet.publicKeySpkiHex(), Buffer.from(signature, 'hex'))) {
      throw new Error('self-check failed: the signature did not verify against the wallet key');
    }
    return { party: wallet.partyId };
  }

  async canPay(request: EmbeddedPayRequest): Promise<PolicyDecision> {
    return (await this.wallet()).canPay(request);
  }

  async pay(request: PayRequest): Promise<PayResult> {
    const wallet = await this.wallet();
    const { updateId } = await wallet.pay(request);
    return {
      status: 'executed',
      updateId,
      sender: wallet.partyId,
      route: 'embedded',
      note: 'paid autonomously by the embedded wallet, within its spend policy',
    };
  }

  async fund(amount: string): Promise<{ updateId: string }> {
    return (await this.wallet()).fund(amount);
  }

  async disconnect(): Promise<boolean> {
    return false;
  }
}
