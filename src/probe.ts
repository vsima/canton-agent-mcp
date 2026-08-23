// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// Relay probe: opens a real WalletConnect session and prints the pairing QR,
// proving the stack reaches the relay and that stdout stays silent (it
// belongs to MCP framing; the probe writes only to stderr). Scan the QR with
// a wallet to take it all the way to a live pairing, or let it time out.
//
//   WC_PROJECT_ID=… npm run probe

import { WalletLink } from './link.ts';
import { terminalQr } from './qr.ts';

const projectId = process.env['WC_PROJECT_ID'];
if (projectId === undefined || projectId === '') {
  console.error('probe: WC_PROJECT_ID is required');
  process.exit(1);
}

const waitSecs = Number(process.env['PROBE_WAIT'] ?? '20');
const link = new WalletLink({
  projectId,
  networkId: process.env['CANTON_NETWORK_ID'] ?? 'canton:localnet',
  domain: 'canton-agent-mcp.local',
  agentName: 'Canton Agent (probe)',
  requestExpirySecs: 3600,
});

const { uri } = await link.startPairing();
console.error(await terminalQr(uri));
console.error(`URI: ${uri}`);
console.error(`probe: session open, waiting ${waitSecs}s for a wallet to pair…`);

const deadline = Date.now() + waitSecs * 1000;
let connected = false;
while (Date.now() < deadline) {
  const s = await link.status();
  if (s.connected) {
    connected = true;
    console.error(`probe: PAIRED with ${s.walletName ?? 'a wallet'} (topic ${s.topic?.slice(0, 12)}…)`);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!connected) console.error('probe: no wallet paired (fine for a smoke test), relay reachable, URI issued.');
process.exit(0);
