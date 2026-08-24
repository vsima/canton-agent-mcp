// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The wallet link: one WalletConnect session between this MCP server (a
// CIP-0103 dApp) and the human's mobile wallet. The link never holds a key or
// a ledger token; every operation below is a request the wallet's owner can
// see, approve, or refuse on their phone. Sessions persist across restarts via
// the client store, so a wallet is paired once and reused.

import { randomUUID } from 'node:crypto';
import { DappConnector } from './wc/dapp.ts';
import type { WcMetadata } from './wc/client.ts';
import type { DappAccount } from './wc/protocol.ts';
import { buildSignInMessage, verifySignature } from './siwc.ts';
import { sdkGateway } from './canton.ts';

export interface LinkConfig {
  projectId: string;
  relayUrl?: string;
  /** CAIP-2 network id, e.g. `canton:localnet`. */
  networkId: string;
  /** Session-store directory; undefined keeps sessions in memory only. */
  storageDir?: string;
  /** The dApp identity a Sign-In challenge names. */
  domain: string;
  /** Shown on the wallet's approval sheets and Connect screen. */
  agentName: string;
  /** How long a pushed request stays answerable (300 to 604800 seconds). */
  requestExpirySecs: number;
}

export interface LinkStatus {
  connected: boolean;
  /** Session topic (truncated is fine for display; full here). */
  topic?: string;
  /** The wallet peer's self-reported name, when connected. */
  walletName?: string;
  /** Set while a pairing URI is out and no wallet has approved yet. */
  pairingPending: boolean;
  networkId: string;
  /** Extra display lines a backend wants shown (budget, routing, party). */
  detail?: string;
}

export interface PayRequest {
  to: string;
  amount: string;
  instrument?: string;
  memo?: string;
}

export interface PayResult {
  status: string;
  updateId?: string;
  sender: string;
  /** Which custody path executed the payment, when the backend routes. */
  route?: 'embedded' | 'phone';
  /** A backend's one-line explanation of the routing decision. */
  note?: string;
}

export class WalletLink {
  private readonly config: LinkConfig;
  private connectorPromise: Promise<DappConnector> | null = null;
  private pendingUri: string | null = null;

  constructor(config: LinkConfig) {
    this.config = config;
  }

  private metadata(): WcMetadata {
    return {
      name: this.config.agentName,
      description: 'An AI agent that asks this wallet to sign in and pay. Every request needs approval on this phone.',
      url: 'https://github.com/vsima/canton-agent-mcp',
      icons: [],
    };
  }

  private connector(): Promise<DappConnector> {
    if (this.connectorPromise === null) {
      this.connectorPromise = DappConnector.create(
        {
          projectId: this.config.projectId,
          ...(this.config.relayUrl !== undefined ? { relayUrl: this.config.relayUrl } : {}),
          ...(this.config.storageDir !== undefined ? { storageDir: this.config.storageDir } : {}),
        },
        this.config.networkId,
        this.metadata(),
        this.config.requestExpirySecs,
      );
    }
    return this.connectorPromise;
  }

  /** The newest live session's topic, or null. */
  private async topic(): Promise<string | null> {
    const dapp = await this.connector();
    const sessions = dapp.sessions();
    const last = sessions[sessions.length - 1];
    return last?.topic ?? null;
  }

  async status(): Promise<LinkStatus> {
    const dapp = await this.connector();
    const sessions = dapp.sessions();
    const last = sessions[sessions.length - 1];
    return {
      connected: last !== undefined,
      ...(last !== undefined ? { topic: last.topic, walletName: last.peer.metadata.name } : {}),
      pairingPending: this.pendingUri !== null,
      networkId: this.config.networkId,
    };
  }

  /**
   * Opens a new session and returns the pairing URI immediately. The wallet
   * owner scans it; approval lands in the background and from then on
   * `status()` reports connected. Calling again while a pairing is out
   * returns the same URI.
   */
  async startPairing(): Promise<{ uri: string }> {
    if (this.pendingUri !== null) return { uri: this.pendingUri };
    const dapp = await this.connector();
    const { uri, approved } = await dapp.createSession();
    this.pendingUri = uri;
    void approved
      .then(() => {
        this.pendingUri = null;
      })
      .catch(() => {
        this.pendingUri = null;
      });
    return { uri };
  }

  /** The accounts the wallet granted. Prompts the wallet owner on first use. */
  async accounts(): Promise<DappAccount[]> {
    const dapp = await this.connector();
    const topic = await this.topic();
    if (topic === null) throw new Error('no wallet is connected; call canton_connect_wallet first');
    const status = await dapp.connect(topic);
    if (!status.isConnected) {
      throw new Error(`the wallet declined the connection${status.reason !== undefined ? `: ${status.reason}` : ''}`);
    }
    return dapp.listAccounts(topic);
  }

  /**
   * Sign-In with Canton over the live session: build the structured
   * challenge, have the wallet sign it (the owner approves on the phone), and
   * verify the signature against the account's published key.
   */
  async signIn(statement?: string): Promise<{ party: string }> {
    const dapp = await this.connector();
    const topic = await this.topic();
    if (topic === null) throw new Error('no wallet is connected; call canton_connect_wallet first');
    const accounts = await this.accounts();
    const account = accounts.find((a) => a.primary) ?? accounts[0];
    if (account === undefined) throw new Error('the wallet shared no accounts');
    const message = buildSignInMessage({
      domain: this.config.domain,
      party: account.partyId,
      statement: statement ?? `Authorize the agent "${this.config.agentName}".`,
      uri: `https://${this.config.domain}/agent`,
      networkId: this.config.networkId,
      nonce: randomUUID().replace(/-/g, ''),
      issuedAt: new Date().toISOString(),
    });
    const { signature } = await dapp.requestSignMessage(topic, message);
    if (!verifySignature(message, account.publicKey, Buffer.from(signature, 'hex'))) {
      throw new Error('the signature did not verify against the account key');
    }
    return { party: account.partyId };
  }

  /**
   * Ask the wallet to pay: build the Token Standard transfer, push it as a
   * CIP-0103 `prepareExecuteAndWait`, and wait while the wallet's owner
   * approves on the phone. The wallet prepares on its own participant,
   * re-verifies the prepared-transaction hash on device, and signs in
   * hardware; this side only names the recipient, amount, and memo.
   */
  async pay(request: PayRequest): Promise<PayResult> {
    const dapp = await this.connector();
    const topic = await this.topic();
    if (topic === null) throw new Error('no wallet is connected; call canton_connect_wallet first');
    const accounts = await this.accounts();
    const account = accounts.find((a) => a.primary) ?? accounts[0];
    if (account === undefined) throw new Error('the wallet shared no accounts');
    const { command, disclosedContracts } = await sdkGateway.buildTransfer({
      sender: account.partyId,
      recipient: request.to,
      amount: request.amount,
      instrumentId: request.instrument ?? 'Amulet',
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
    });
    const result = await dapp.prepareExecuteAndWait(topic, {
      commands: [command],
      actAs: [account.partyId],
      disclosedContracts,
    });
    return {
      status: result.tx.status,
      ...(result.tx.payload?.updateId !== undefined ? { updateId: result.tx.payload.updateId } : {}),
      sender: account.partyId,
    };
  }

  /** Ends the current session. Returns whether one existed. */
  async disconnect(): Promise<boolean> {
    const dapp = await this.connector();
    const topic = await this.topic();
    if (topic === null) return false;
    await dapp.disconnect(topic);
    return true;
  }
}
