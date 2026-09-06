// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The dApp end of the WalletConnect round-trip, the side a shop's front-end
// runs. It opens a session (the QR/URI a wallet scans), then pushes CIP-0103
// requests over it: `requestSignMessage` to authenticate a party (Sign-In with
// Canton, over a live session instead of a scanned challenge) and
// `prepareExecuteAndWait` to push a prepared payment. The wallet holds the keys;
// this side only asks and reads the reply.

import type { SessionTypes } from '@walletconnect/types';
import { makeSignClient, stderrLog } from './client.ts';
import { withTransportNudges } from './nudge.ts';
import type { WcConfig, WcMetadata, WcSignClient } from './client.ts';
import { ALL_METHODS, CANTON_METHODS, CANTON_NAMESPACE, chainId } from './protocol.ts';
import type {
  ConnectResult,
  DappAccount,
  ExecutedResult,
  PrepareSubmission,
  SignMessageResult,
} from './protocol.ts';

export class DappConnector {
  private readonly client: WcSignClient;
  private readonly chain: string;
  private readonly requestExpirySecs: number;

  private constructor(client: WcSignClient, chain: string, requestExpirySecs: number) {
    this.client = client;
    this.chain = chain;
    this.requestExpirySecs = requestExpirySecs;
  }

  /**
   * `requestExpirySecs` is how long a pushed request stays answerable: the
   * human's phone may be in a pocket, so the default is a generous hour (the
   * relay stores the request and delivers it when the wallet next connects;
   * WalletConnect allows 300 to 604800 seconds).
   */
  static async create(
    config: WcConfig,
    networkId: string,
    metadata: WcMetadata,
    requestExpirySecs = 3600,
  ): Promise<DappConnector> {
    if (requestExpirySecs < 300 || requestExpirySecs > 604800) {
      throw new Error(`requestExpirySecs must be within [300, 604800], got ${requestExpirySecs}`);
    }
    const client = await makeSignClient(config, 'dapp', metadata);
    return new DappConnector(client, chainId(networkId), requestExpirySecs);
  }

  /** Sessions this client currently holds (restored from storage on init). */
  sessions(): SessionTypes.Struct[] {
    return this.client.session.getAll();
  }

  /**
   * Opens a session. Returns the pairing `uri` (render it as the QR a wallet
   * scans) and `approved`, which resolves once a wallet has paired and
   * approved. Advertised as optional namespaces, the modern WalletConnect
   * shape; a wallet approves the subset it supports.
   */
  async createSession(): Promise<{ uri: string; approved: Promise<SessionTypes.Struct> }> {
    const { uri, approval } = await this.client.connect({
      optionalNamespaces: {
        [CANTON_NAMESPACE]: { chains: [this.chain], methods: [...ALL_METHODS], events: [] },
      },
    });
    if (uri === undefined) throw new Error('WalletConnect returned no pairing URI');
    return { uri, approved: approval() };
  }

  /**
   * One request to the wallet. The wallet's answer may take as long as the
   * human takes, so the wait is nudged: a relay socket that closes meanwhile
   * is reopened, and a quiet one is restarted now and then so an answer
   * parked in the relay's mailbox is fetched rather than waited on forever.
   */
  private async ask<T>(topic: string, label: string, request: { method: string; params: unknown }): Promise<T> {
    const relayer = this.client.core.relayer;
    stderrLog(`relay: sending ${label} (socket ${relayer.connected ? 'open' : 'closed'})`);
    const pending = this.client.request<T>({
      topic,
      chainId: this.chain,
      request,
      expiry: this.requestExpirySecs,
    });
    try {
      const answer = await withTransportNudges(pending, relayer, { log: stderrLog });
      stderrLog(`relay: ${label} answered`);
      return answer;
    } catch (e) {
      stderrLog(`relay: ${label} failed: ${(e as Error).message}`);
      throw e;
    }
  }

  /** Request a connection, the wallet grants accounts (prompts the user). */
  async connect(topic: string): Promise<ConnectResult> {
    return this.ask<ConnectResult>(topic, 'connect', { method: CANTON_METHODS.connect, params: {} });
  }

  /** The accounts the wallet granted this dApp, each carries its `publicKey`,
   *  which a Sign-In signature verifies against. */
  async listAccounts(topic: string): Promise<DappAccount[]> {
    return this.ask<DappAccount[]>(topic, 'listAccounts', { method: CANTON_METHODS.listAccounts, params: {} });
  }

  /** Ask the wallet to sign a message (Sign-In with Canton over the session).
   *  The result carries only the signature, verify it against the account's
   *  `publicKey` from {@link listAccounts}. */
  async requestSignMessage(topic: string, message: string): Promise<SignMessageResult> {
    return this.ask<SignMessageResult>(topic, 'signMessage', { method: CANTON_METHODS.signMessage, params: { message } });
  }

  /** Push prepared commands (a Token Standard transfer) to the wallet as a
   *  CIP-0103 `prepareExecuteAndWait`, the standard one-tap payment. The wallet
   *  prepares on its participant, verifies the prepared-tx hash, signs in its
   *  enclave, and executes; this resolves with the executed transaction. */
  async prepareExecuteAndWait(topic: string, submission: PrepareSubmission): Promise<ExecutedResult> {
    return this.ask<ExecutedResult>(topic, 'prepareExecuteAndWait', {
      method: CANTON_METHODS.prepareExecuteAndWait,
      params: submission,
    });
  }

  /** Close a session and release the relay connection. */
  async disconnect(topic: string): Promise<void> {
    await this.client.disconnect({ topic, reason: { code: 6000, message: 'done' } });
  }
}
