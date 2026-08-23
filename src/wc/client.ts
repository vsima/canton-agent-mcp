// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The WalletConnect Sign client factory. The dApp end of the round-trip is a
// Sign client talking to a wallet through the public relay. Each client in a
// process must have its own Core, or clients share one relay subscription and
// each other's storage; `customStoragePrefix` gives each its own. A projectId
// (free, from cloud.reown.com) authenticates to the public relay.

import { Core } from '@walletconnect/core';
import { SignClient } from '@walletconnect/sign-client';
import { pino, destination } from 'pino';

/** A ready WalletConnect Sign client, whatever `SignClient.init` resolves to. */
export type WcSignClient = Awaited<ReturnType<typeof SignClient.init>>;

export interface WcConfig {
  /** WalletConnect Cloud project id, authenticates to the relay. */
  projectId: string;
  /** Relay WebSocket URL. Defaults to the public relay. */
  relayUrl?: string;
  /**
   * Directory for the client's session store (the fs driver treats it as a
   * base directory and writes its keys inside). When set, pairings and
   * sessions survive restarts: pair the wallet once, keep the session. When
   * unset, storage is in-memory.
   */
  storageDir?: string;
}

export const DEFAULT_RELAY_URL = 'wss://relay.walletconnect.org';

export interface WcMetadata {
  name: string;
  description: string;
  url: string;
  icons: string[];
}

/**
 * Creates an isolated Sign client. `storagePrefix` must be distinct per client
 * in the same process (e.g. `dapp` vs `wallet`) so their Cores don't collide.
 */
export async function makeSignClient(config: WcConfig, storagePrefix: string, metadata: WcMetadata): Promise<WcSignClient> {
  const relayUrl = config.relayUrl ?? DEFAULT_RELAY_URL;
  // stdout belongs to the MCP stdio transport, so WalletConnect's pino logger
  // is pointed at stderr: one stray log line on stdout corrupts the JSON-RPC
  // framing between the agent and this server.
  const logger = pino({ level: 'warn' }, destination({ dest: 2, sync: true }));
  const core = new Core({
    projectId: config.projectId,
    relayUrl,
    customStoragePrefix: storagePrefix,
    logger,
    ...(config.storageDir !== undefined ? { storageOptions: { database: config.storageDir } } : {}),
  });
  return SignClient.init({ core, metadata });
}
