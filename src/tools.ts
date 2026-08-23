// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The MCP tool surface. Every tool is a thin wrapper over the wallet link:
// the agent can look, ask, and wait, it can never sign, hold a key, or reach
// the ledger with the wallet's identity. Registration takes the link as an
// interface so tests drive the tools without a relay.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DappAccount } from './wc/protocol.ts';
import type { LinkStatus, PayRequest, PayResult } from './link.ts';
import { terminalQr } from './qr.ts';

/** What the tools need from the wallet link (see WalletLink). */
export interface AgentWalletLink {
  status(): Promise<LinkStatus>;
  startPairing(): Promise<{ uri: string }>;
  accounts(): Promise<DappAccount[]>;
  signIn(statement?: string): Promise<{ party: string }>;
  pay(request: PayRequest): Promise<PayResult>;
  disconnect(): Promise<boolean>;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(e: unknown): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
}

const AMOUNT = /^\d+(\.\d{1,10})?$/;

export function registerTools(server: McpServer, link: AgentWalletLink): void {
  server.registerTool(
    'canton_wallet_status',
    {
      title: 'Wallet connection status',
      description:
        'Whether a mobile wallet is connected over WalletConnect, and on which Canton network. Call after canton_connect_wallet to see if the human has approved the pairing.',
      inputSchema: {},
    },
    async () => {
      try {
        const s = await link.status();
        const lines = [
          s.connected
            ? `Connected to ${s.walletName ?? 'a wallet'} (session ${s.topic?.slice(0, 12)}…).`
            : 'No wallet connected.',
          s.pairingPending ? 'A pairing QR is out, waiting for the wallet to scan and approve.' : '',
          `Network: ${s.networkId}.`,
        ].filter((l) => l !== '');
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'canton_connect_wallet',
    {
      title: 'Connect a mobile wallet',
      description:
        "Starts pairing with the human's Canton mobile wallet. Returns a QR code and a wc: URI; the human scans it from their wallet's Connect tab and approves on the phone. Poll canton_wallet_status until connected.",
      inputSchema: {},
    },
    async () => {
      try {
        const s = await link.status();
        if (s.connected) {
          return ok(`Already connected to ${s.walletName ?? 'a wallet'}. Call canton_wallet_status for details.`);
        }
        const { uri } = await link.startPairing();
        const qr = await terminalQr(uri);
        return ok(
          [
            'Show this to the human: scan the QR from the wallet app (Connect tab), or paste the URI.',
            '',
            qr,
            `URI: ${uri}`,
            '',
            'Then poll canton_wallet_status until it reports connected.',
          ].join('\n'),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'canton_accounts',
    {
      title: 'List granted accounts',
      description:
        'The Canton parties the wallet has granted this agent, with their public keys. The first call prompts the human to approve the connection on their phone.',
      inputSchema: {},
    },
    async () => {
      try {
        const accounts = await link.accounts();
        if (accounts.length === 0) return ok('The wallet granted no accounts.');
        const lines = accounts.map(
          (a) => `${a.primary ? '* ' : '  '}${a.partyId} (${a.hint}, ${a.status}, network ${a.networkId})`,
        );
        return ok(['Granted accounts (* = primary):', ...lines].join('\n'));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'canton_sign_in',
    {
      title: 'Sign in with the wallet',
      description:
        "Proves the human controls their Canton party: the wallet signs a structured Sign-In with Canton challenge (approved on the phone) and the signature is verified against the party's published key. Returns the verified party id.",
      inputSchema: {
        statement: z.string().max(200).optional().describe('Shown to the human on the approval sheet.'),
      },
    },
    async ({ statement }) => {
      try {
        const { party } = await link.signIn(statement);
        return ok(`Signed in. Verified party: ${party}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'canton_request_payment',
    {
      title: 'Request a payment',
      description:
        'Asks the wallet to pay: builds a Canton Token Standard transfer and pushes it to the phone, where the human reviews and approves it and the device key signs. Blocks until the human decides (they may take a while), then returns the result.',
      inputSchema: {
        to: z.string().min(3).describe('Recipient party id.'),
        amount: z.string().regex(AMOUNT).describe('Decimal amount as a string, e.g. "2" or "12.5".'),
        instrument: z.string().optional().describe('Instrument id; defaults to Amulet (Canton Coin).'),
        memo: z.string().max(140).optional().describe('Shown to the human and recorded on the transfer.'),
      },
    },
    async ({ to, amount, instrument, memo }) => {
      try {
        const result = await link.pay({ to, amount, ...(instrument !== undefined ? { instrument } : {}), ...(memo !== undefined ? { memo } : {}) });
        return ok(
          [
            `Payment ${result.status}.`,
            result.updateId !== undefined ? `Update id: ${result.updateId}` : '',
            `Sender: ${result.sender}`,
          ]
            .filter((l) => l !== '')
            .join('\n'),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'canton_disconnect',
    {
      title: 'Disconnect the wallet',
      description: 'Ends the WalletConnect session with the wallet.',
      inputSchema: {},
    },
    async () => {
      try {
        const had = await link.disconnect();
        return ok(had ? 'Disconnected.' : 'No session to disconnect.');
      } catch (e) {
        return fail(e);
      }
    },
  );
}
