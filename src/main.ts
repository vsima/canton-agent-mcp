#!/usr/bin/env node
// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// Entry point: an MCP server over stdio. stdout carries the MCP JSON-RPC
// stream and nothing else; every log goes to stderr. Configuration is
// env-only so `claude mcp add` needs a single line.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WalletLink } from './link.ts';
import { registerTools } from './tools.ts';
import type { AgentWalletLink, ToolExtras } from './tools.ts';
import { EmbeddedLink } from './embedded/link.ts';
import { TieredLink } from './embedded/tiered.ts';
import { generateKeys, sdkGateway } from './canton.ts';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

const projectId = env('WC_PROJECT_ID');
if (projectId === undefined) {
  console.error('canton-agent-mcp: WC_PROJECT_ID is required (a free WalletConnect Cloud project id).');
  process.exit(1);
}

const storageDir = env('AGENT_MCP_STORAGE') ?? join(homedir(), '.canton-agent-mcp', 'wc-store');
mkdirSync(storageDir, { recursive: true });

const requestExpirySecs = Number(env('AGENT_MCP_REQUEST_EXPIRY') ?? '3600');
const networkId = env('CANTON_NETWORK_ID') ?? 'canton:localnet';
const domain = env('AGENT_MCP_DOMAIN') ?? 'canton-agent-mcp.local';

const phone = new WalletLink({
  projectId,
  ...(env('WC_RELAY_URL') !== undefined ? { relayUrl: env('WC_RELAY_URL') as string } : {}),
  networkId,
  storageDir,
  domain,
  agentName: env('AGENT_MCP_NAME') ?? 'Canton Agent',
  requestExpirySecs,
});

// Custody mode: 'linked' is the phone wallet over WalletConnect; 'embedded'
// is an agent-held allowance bounded by a spend policy; 'tiered' pays small
// amounts from the allowance and escalates the rest to the phone.
const mode = env('AGENT_WALLET_MODE') ?? 'linked';
let link: AgentWalletLink = phone;
const extras: ToolExtras = {};
if (mode === 'embedded' || mode === 'tiered') {
  const embedded = new EmbeddedLink({
    dir: env('AGENT_WALLET_DIR') ?? join(homedir(), '.canton-agent-mcp', 'embedded-wallet'),
    ...(env('AGENT_WALLET_PASSPHRASE') !== undefined ? { passphrase: env('AGENT_WALLET_PASSPHRASE') as string } : {}),
    networkId,
    partyHint: env('AGENT_WALLET_HINT') ?? 'agent',
    policy: {
      maxPerTx: env('AGENT_WALLET_MAX_PER_TX') ?? '5',
      dailyCap: env('AGENT_WALLET_DAILY_CAP') ?? '25',
      allowedInstruments: (env('AGENT_WALLET_INSTRUMENTS') ?? 'Amulet').split(','),
      ...(env('AGENT_WALLET_RECEIVERS') !== undefined
        ? { allowedReceivers: (env('AGENT_WALLET_RECEIVERS') as string).split(',') }
        : {}),
    },
    gateway: sdkGateway,
    generateKeys,
    allowTap: networkId === 'canton:localnet' || env('AGENT_WALLET_ALLOW_TAP') === '1',
    domain,
  });
  extras.fund = (amount) => embedded.fund(amount);
  link =
    mode === 'tiered'
      ? new TieredLink(embedded, phone, env('AGENT_WALLET_ESCALATE_ABOVE') ?? env('AGENT_WALLET_MAX_PER_TX') ?? '5')
      : embedded;
} else if (mode !== 'linked') {
  console.error(`canton-agent-mcp: unknown AGENT_WALLET_MODE ${JSON.stringify(mode)} (use linked, embedded, or tiered)`);
  process.exit(1);
}

const server = new McpServer({ name: 'canton-agent-mcp', version: '0.1.0' });
registerTools(server, link, extras);

await server.connect(new StdioServerTransport());
console.error(`canton-agent-mcp ready (mode ${mode}, network ${networkId}, sessions in ${storageDir})`);
