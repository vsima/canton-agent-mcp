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

const link = new WalletLink({
  projectId,
  ...(env('WC_RELAY_URL') !== undefined ? { relayUrl: env('WC_RELAY_URL') as string } : {}),
  networkId: env('CANTON_NETWORK_ID') ?? 'canton:localnet',
  storageDir,
  domain: env('AGENT_MCP_DOMAIN') ?? 'canton-agent-mcp.local',
  agentName: env('AGENT_MCP_NAME') ?? 'Canton Agent',
  requestExpirySecs,
});

const server = new McpServer({ name: 'canton-agent-mcp', version: '0.1.0' });
registerTools(server, link);

await server.connect(new StdioServerTransport());
console.error(`canton-agent-mcp ready (network ${env('CANTON_NETWORK_ID') ?? 'canton:localnet'}, sessions in ${storageDir})`);
