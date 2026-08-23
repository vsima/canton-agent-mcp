// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// Builds the Token Standard transfer a payment pushes to the wallet. The dApp
// authors the command and fetches the registry choice context (the ecosystem's
// standard split); the wallet decides whether to sign it. Uses the official
// @canton-network/wallet-sdk, loaded lazily so a sign-in-only server never
// pays its startup cost. Targets a Splice LocalNet by default; the URLs are
// env-overridable for other networks.

export interface TransferRequest {
  sender: string;
  recipient: string;
  amount: string;
  instrumentId: string;
  memo?: string;
}

export interface BuiltTransfer {
  command: unknown;
  disclosedContracts: unknown[];
}

type TokenSdk = {
  token: {
    transfer: {
      create(opts: {
        sender: string;
        recipient: string;
        amount: string;
        instrumentId: string;
        registryUrl: URL;
        memo?: string;
      }): Promise<[unknown, unknown[]]>;
    };
  };
};

let sdkPromise: Promise<{ sdk: TokenSdk; registryUrl: URL }> | null = null;

async function tokenSdk(): Promise<{ sdk: TokenSdk; registryUrl: URL }> {
  if (sdkPromise === null) {
    sdkPromise = (async () => {
      const { SDK, localNetStaticConfig, CustomLogAdapter } = await import('@canton-network/wallet-sdk');
      const ledgerUrl = process.env['CANTON_LEDGER_URL'] ?? String(localNetStaticConfig.LOCALNET_APP_USER_LEDGER_URL);
      const registryApi = process.env['CANTON_REGISTRY_URL'] ?? String(localNetStaticConfig.LOCALNET_REGISTRY_API_URL);
      const validatorUrl = process.env['CANTON_VALIDATOR_URL'] ?? String(localNetStaticConfig.LOCALNET_APP_VALIDATOR_URL);
      const auth = {
        method: 'self_signed' as const,
        issuer: 'unsafe-auth',
        credentials: {
          clientId: process.env['CANTON_USER_ID'] ?? String(localNetStaticConfig.LOCALNET_USER_ID),
          clientSecret: process.env['CANTON_CLIENT_SECRET'] ?? 'unsafe',
          audience: 'https://canton.network.global',
          scope: '',
        },
      };
      const quiet = new CustomLogAdapter((level: string, _ctx: unknown, message?: string) => {
        if (level === 'error') console.error(`[sdk] ${message ?? ''}`);
      });
      const base = await SDK.create({ auth, ledgerClientUrl: ledgerUrl, logAdapter: quiet });
      const sdk = (await base.extend({
        token: { auth, registries: [registryApi], validatorUrl },
      })) as unknown as TokenSdk;
      return { sdk, registryUrl: new URL(registryApi) };
    })();
  }
  return sdkPromise;
}

/** Builds the transfer command and its disclosed contracts. */
export async function buildTransferCommand(request: TransferRequest): Promise<BuiltTransfer> {
  const { sdk, registryUrl } = await tokenSdk();
  const [command, disclosedContracts] = await sdk.token.transfer.create({
    sender: request.sender,
    recipient: request.recipient,
    amount: request.amount,
    instrumentId: request.instrumentId,
    registryUrl,
    ...(request.memo !== undefined ? { memo: request.memo } : {}),
  });
  return { command, disclosedContracts };
}
