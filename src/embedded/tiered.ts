// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// Two-tier custody: small payments go through the embedded wallet
// autonomously (bounded by its spend policy); anything above the escalation
// threshold, or anything the policy refuses, goes to the human's phone over
// WalletConnect for an approval and a hardware signature. The agent sees one
// wallet; the human keeps the decisions that matter.

import type { AgentWalletLink } from '../tools.ts';
import type { LinkStatus, PayRequest, PayResult } from '../link.ts';
import type { DappAccount } from '../wc/protocol.ts';
import { scaled } from './policy.ts';
import type { EmbeddedLink } from './link.ts';

export class TieredLink implements AgentWalletLink {
  private readonly embedded: EmbeddedLink;
  private readonly phone: AgentWalletLink;
  private readonly escalateAbove: string;

  constructor(embedded: EmbeddedLink, phone: AgentWalletLink, escalateAbove: string) {
    scaled(escalateAbove);
    this.embedded = embedded;
    this.phone = phone;
    this.escalateAbove = escalateAbove;
  }

  async status(): Promise<LinkStatus> {
    const [embedded, phone] = await Promise.all([this.embedded.status(), this.phone.status()]);
    return {
      connected: true,
      walletName: 'Tiered custody',
      pairingPending: phone.pairingPending,
      networkId: embedded.networkId,
      detail: [
        `Autonomous up to ${this.escalateAbove} per payment; above that the phone approves.`,
        embedded.detail ?? '',
        phone.connected
          ? `Phone: connected to ${phone.walletName ?? 'a wallet'}.`
          : 'Phone: not connected (connect with canton_connect_wallet to enable larger payments).',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    };
  }

  startPairing(): Promise<{ uri: string }> {
    return this.phone.startPairing();
  }

  async accounts(): Promise<DappAccount[]> {
    const embedded = await this.embedded.accounts();
    const phoneStatus = await this.phone.status();
    if (!phoneStatus.connected) return embedded;
    try {
      return [...(await this.phone.accounts()), ...embedded];
    } catch {
      return embedded;
    }
  }

  /** Sign-in means the human when a phone is connected; otherwise the agent
   *  authenticates as its own embedded party. */
  async signIn(statement?: string): Promise<{ party: string }> {
    const phoneStatus = await this.phone.status();
    return phoneStatus.connected ? this.phone.signIn(statement) : this.embedded.signIn(statement);
  }

  async pay(request: PayRequest): Promise<PayResult> {
    const withinTier = scaled(request.amount) <= scaled(this.escalateAbove);
    if (withinTier) {
      const decision = await this.embedded.canPay(request);
      if (decision.ok) return this.embedded.pay(request);
      return this.escalate(request, `the embedded wallet refused (${decision.reason})`);
    }
    return this.escalate(request, `${request.amount} is above the autonomous cap of ${this.escalateAbove}`);
  }

  private async escalate(request: PayRequest, why: string): Promise<PayResult> {
    const phoneStatus = await this.phone.status();
    if (!phoneStatus.connected) {
      throw new Error(
        `this payment needs the human's phone: ${why}, and no phone wallet is connected. Ask the human to connect one with canton_connect_wallet.`,
      );
    }
    const result = await this.phone.pay(request);
    return { ...result, route: 'phone', note: `escalated to the phone: ${why}` };
  }

  disconnect(): Promise<boolean> {
    return this.phone.disconnect();
  }
}
