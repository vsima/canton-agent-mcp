# canton-agent-mcp

**Your agent asks. You approve. Hardware signs.**

[![ci](https://github.com/vsima/canton-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vsima/canton-agent-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent use the
[Canton Network](https://www.canton.network/) through a human's mobile wallet.
The agent can ask to sign in and to pay; every request lands as an approval
sheet on the human's phone, and what gets signed is signed by the device key
(Secure Enclave or Android StrongBox), never by the agent.

This server is a [CIP-0103](https://github.com/global-synchronizer-foundation/cips)
dApp client over WalletConnect. It holds **no keys and no ledger tokens**. It
can only ask, and the wallet's owner can see, approve, or refuse every request.

## How it works

1. The agent calls `canton_connect_wallet`; a WalletConnect pairing QR appears.
2. The human scans it from their wallet's Connect tab and approves on the phone.
3. From then on the agent can request sign-in (`canton_sign_in`) or a payment
   (`canton_request_payment`). Each request pops an approval sheet on the phone;
   the wallet prepares the transaction on its participant, re-verifies the
   prepared-transaction hash on device, and signs in hardware.
4. Sessions persist on disk, so the wallet is paired once and reused.

The reference wallet on the other end is
[canton-mobile-app](https://github.com/vsima/canton-mobile-app) (iOS and
Android, built on the native
[canton-mobile-sdk](https://github.com/vsima/canton-mobile-sdk)), but any
CIP-0103 wallet that speaks WalletConnect works.

## Install

Requires Node 22.6+ and a free WalletConnect project id from
[dashboard.reown.com](https://dashboard.reown.com). The id is a public client
key, not a secret.

The server is on npm, so every harness below runs it with `npx` and nothing
to clone. Then ask the agent to connect your wallet and pay someone. A payment
request blocks until the human decides, so raise your MCP client's tool
timeout if it cuts long calls short (in Claude Code: the `MCP_TIMEOUT`
environment variable).

### Claude Code

```sh
claude mcp add canton-agent --env WC_PROJECT_ID=<your-project-id> \
  -- npx -y canton-agent-mcp
```

### Claude Desktop

Settings → Developer → Edit Config, then add the server to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "canton-agent": {
      "command": "npx",
      "args": ["-y", "canton-agent-mcp"],
      "env": { "WC_PROJECT_ID": "<your-project-id>" }
    }
  }
}
```

### Cursor

The same JSON shape in `~/.cursor/mcp.json` (global) or the project's
`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "canton-agent": {
      "command": "npx",
      "args": ["-y", "canton-agent-mcp"],
      "env": { "WC_PROJECT_ID": "<your-project-id>" }
    }
  }
}
```

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.canton-agent]
command = "npx"
args = ["-y", "canton-agent-mcp"]
env = { "WC_PROJECT_ID" = "<your-project-id>" }
```

### From source

The repo runs TypeScript directly on Node 22.6+, no build step:

```sh
git clone https://github.com/vsima/canton-agent-mcp
cd canton-agent-mcp && npm install
claude mcp add canton-agent --env WC_PROJECT_ID=<your-project-id> \
  -- node <path-to>/canton-agent-mcp/src/main.ts
```

## Custody modes: linked, embedded, tiered

Set `AGENT_WALLET_MODE` to choose who holds the keys:

- **`linked`** (default): the human's phone wallet over WalletConnect. The
  agent holds nothing; every action is approved on the phone and signed by
  the device key.
- **`embedded`**: an agent-held allowance. The server creates its own Canton
  party and keeps the key locally (mode 0600, optionally
  passphrase-encrypted). Every payment passes a hard spend policy before
  anything is signed: a per-payment cap, a daily cap, an instrument
  allowlist, and an optional receiver allowlist, all fail-closed, with a
  receipts log the caps are computed from. This is a hot wallet by design:
  fund it from your real wallet with only what you are willing to delegate.
- **`tiered`**: both. Payments at or under `AGENT_WALLET_ESCALATE_ABOVE` run
  autonomously on the embedded allowance; anything larger, and anything the
  policy refuses, escalates to the phone for a human approval and a hardware
  signature. The agent sees one wallet; the human keeps the decisions that
  matter.

Embedded-mode settings: `AGENT_WALLET_DIR`, `AGENT_WALLET_PASSPHRASE`,
`AGENT_WALLET_HINT`, `AGENT_WALLET_MAX_PER_TX` (default 5),
`AGENT_WALLET_DAILY_CAP` (default 25), `AGENT_WALLET_INSTRUMENTS` (default
`Amulet`), `AGENT_WALLET_RECEIVERS` (comma-separated allowlist), and
`AGENT_WALLET_ESCALATE_ABOVE` for tiered routing. On test networks the
`canton_fund_wallet` tool mints the allowance; `npm run embedded-demo` runs
the whole loop live against a LocalNet.

## Tools

| Tool | What it does |
|---|---|
| `canton_connect_wallet` | Starts pairing; returns the QR the human scans |
| `canton_wallet_status` | Whether a wallet is connected, and to which network |
| `canton_accounts` | The parties the wallet granted, with public keys |
| `canton_sign_in` | Sign-In with Canton: a signed, verified proof of the party |
| `canton_request_payment` | Pushes a Token Standard transfer for approval on the phone |
| `canton_disconnect` | Ends the session |
| `canton_fund_wallet` | Mints test funds into the embedded allowance (test networks, embedded/tiered modes only) |

## Configuration

All by environment variable:

| Variable | Default | Meaning |
|---|---|---|
| `WC_PROJECT_ID` | required | WalletConnect Cloud project id |
| `WC_RELAY_URL` | public relay | Relay WebSocket URL |
| `CANTON_NETWORK_ID` | `canton:localnet` | CAIP-2 network id |
| `AGENT_MCP_NAME` | `Canton Agent` | Shown on the wallet's approval sheets |
| `AGENT_MCP_DOMAIN` | `canton-agent-mcp.local` | Sign-In challenge domain |
| `AGENT_MCP_STORAGE` | `~/.canton-agent-mcp/wc-store` | Session store directory |
| `AGENT_MCP_REQUEST_EXPIRY` | `3600` | Seconds a pushed request stays answerable (300 to 604800) |
| `CANTON_LEDGER_URL` / `CANTON_REGISTRY_URL` / `CANTON_VALIDATOR_URL` | Splice LocalNet | Where payment commands are built |

Payments default to a local [Splice LocalNet](https://github.com/digital-asset/decentralized-canton-sync)
(boot one via the SDK repo's `integration/run-localnet.sh`).

## Security model

- The server can **ask**, never act: no keys, no ledger tokens, no signing.
- Every sign-in and payment needs an explicit approval on the phone.
- The wallet re-derives and verifies the prepared-transaction hash on device
  before its hardware key signs, so the phone can only sign what it showed.
- Requests expire (an hour by default); the relay stores them encrypted.
- Wallet-side spend policy (per-agent caps and allowlists, enforced by the
  wallet before signing) is the next milestone in the
  [native SDK](https://github.com/vsima/canton-mobile-sdk).

## Development

```sh
npm test        # typecheck + unit tests (no network)
npm run probe   # opens a real relay session and prints the pairing QR
```

An independent, community-built open-source project, licensed Apache-2.0. Not
affiliated with or endorsed by Digital Asset, the Canton Foundation, or the
Global Synchronizer Foundation.
