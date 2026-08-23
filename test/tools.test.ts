// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// Drives the MCP tool surface end to end through the SDK's in-memory
// transport: a real client calls the real server; only the wallet link is
// fake. What the agent sees is exactly what these tests assert.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerTools, type AgentWalletLink } from '../src/tools.ts';
import type { DappAccount } from '../src/wc/protocol.ts';
import type { LinkStatus, PayRequest, PayResult } from '../src/link.ts';

const ACCOUNT: DappAccount = {
  primary: true,
  partyId: 'alice::1220aa',
  status: 'active',
  hint: 'alice',
  publicKey: '302a300506032b6570032100' + '00'.repeat(32),
  namespace: '1220aa',
  networkId: 'canton:localnet',
  signingProviderId: 'enclave',
};

class FakeLink implements AgentWalletLink {
  connected = false;
  pairings = 0;
  payRequests: PayRequest[] = [];
  failPayWith: string | null = null;

  async status(): Promise<LinkStatus> {
    return {
      connected: this.connected,
      ...(this.connected ? { topic: 'topic-1234567890ab', walletName: 'Canton Wallet' } : {}),
      pairingPending: this.pairings > 0 && !this.connected,
      networkId: 'canton:localnet',
    };
  }
  async startPairing(): Promise<{ uri: string }> {
    this.pairings += 1;
    return { uri: 'wc:abc123@2?relay-protocol=irn&symKey=deadbeef' };
  }
  async accounts(): Promise<DappAccount[]> {
    return [ACCOUNT];
  }
  async signIn(): Promise<{ party: string }> {
    return { party: ACCOUNT.partyId };
  }
  async pay(request: PayRequest): Promise<PayResult> {
    if (this.failPayWith !== null) throw new Error(this.failPayWith);
    this.payRequests.push(request);
    return { status: 'executed', updateId: 'upd-42', sender: ACCOUNT.partyId };
  }
  async disconnect(): Promise<boolean> {
    const had = this.connected;
    this.connected = false;
    return had;
  }
}

async function connectedPair(link: FakeLink): Promise<Client> {
  const server = new McpServer({ name: 'canton-agent-mcp-test', version: '0.0.0' });
  registerTools(server, link);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((c) => c.text ?? '').join('\n');
}

test('all six canton tools are listed', async () => {
  const client = await connectedPair(new FakeLink());
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'canton_accounts',
    'canton_connect_wallet',
    'canton_disconnect',
    'canton_request_payment',
    'canton_sign_in',
    'canton_wallet_status',
  ]);
});

test('status reports no wallet before pairing', async () => {
  const client = await connectedPair(new FakeLink());
  const result = await client.callTool({ name: 'canton_wallet_status', arguments: {} });
  assert.match(textOf(result), /No wallet connected/);
});

test('connect_wallet hands back the pairing URI and a QR', async () => {
  const link = new FakeLink();
  const client = await connectedPair(link);
  const result = await client.callTool({ name: 'canton_connect_wallet', arguments: {} });
  const text = textOf(result);
  assert.match(text, /URI: wc:abc123@2/);
  assert.match(text, /canton_wallet_status/);
  assert.equal(link.pairings, 1);
});

test('connect_wallet short-circuits when already connected', async () => {
  const link = new FakeLink();
  link.connected = true;
  const client = await connectedPair(link);
  const result = await client.callTool({ name: 'canton_connect_wallet', arguments: {} });
  assert.match(textOf(result), /Already connected to Canton Wallet/);
  assert.equal(link.pairings, 0);
});

test('accounts lists the granted party and marks the primary', async () => {
  const client = await connectedPair(new FakeLink());
  const result = await client.callTool({ name: 'canton_accounts', arguments: {} });
  assert.match(textOf(result), /\* alice::1220aa \(alice, active, network canton:localnet\)/);
});

test('sign_in returns the verified party', async () => {
  const client = await connectedPair(new FakeLink());
  const result = await client.callTool({ name: 'canton_sign_in', arguments: {} });
  assert.match(textOf(result), /Verified party: alice::1220aa/);
});

test('request_payment passes the request through and reports the result', async () => {
  const link = new FakeLink();
  const client = await connectedPair(link);
  const result = await client.callTool({
    name: 'canton_request_payment',
    arguments: { to: 'bob::1220bb', amount: '12.5', memo: 'Coffee' },
  });
  const text = textOf(result);
  assert.match(text, /Payment executed/);
  assert.match(text, /Update id: upd-42/);
  assert.deepEqual(link.payRequests, [{ to: 'bob::1220bb', amount: '12.5', memo: 'Coffee' }]);
});

test('request_payment rejects a malformed amount before it reaches the link', async () => {
  const link = new FakeLink();
  const client = await connectedPair(link);
  let failed = false;
  try {
    const result = await client.callTool({
      name: 'canton_request_payment',
      arguments: { to: 'bob::1220bb', amount: '12,50' },
    });
    failed = (result as { isError?: boolean }).isError === true;
  } catch {
    failed = true;
  }
  assert.ok(failed, 'a malformed amount must be rejected');
  assert.equal(link.payRequests.length, 0);
});

test('a link failure surfaces as a tool error, not a crash', async () => {
  const link = new FakeLink();
  link.failPayWith = 'the wallet declined';
  const client = await connectedPair(link);
  const result = await client.callTool({
    name: 'canton_request_payment',
    arguments: { to: 'bob::1220bb', amount: '1' },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(textOf(result), /the wallet declined/);
});

test('disconnect reports whether a session existed', async () => {
  const link = new FakeLink();
  link.connected = true;
  const client = await connectedPair(link);
  assert.match(textOf(await client.callTool({ name: 'canton_disconnect', arguments: {} })), /Disconnected/);
  assert.match(textOf(await client.callTool({ name: 'canton_disconnect', arguments: {} })), /No session/);
});
