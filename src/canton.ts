// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// The one place this server touches the Canton ledger, behind an interface so
// everything above it is testable without a network. The real implementation
// wraps the official @canton-network/wallet-sdk, loaded lazily; it targets a
// Splice LocalNet by default with env-overridable URLs.

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

/** What the embedded wallet needs from the ledger. */
export interface CantonGateway {
  /** Allocates an external party for the given Ed25519 keypair (base64). */
  onboardParty(publicKey: string, privateKey: string, partyHint: string): Promise<string>;
  /** Builds a Token Standard transfer command with its disclosed contracts. */
  buildTransfer(request: TransferRequest): Promise<BuiltTransfer>;
  /** Prepare, sign with the given key, and execute a built command. */
  submit(built: BuiltTransfer, partyId: string, privateKey: string): Promise<{ updateId: string }>;
  /** Mints test funds (DevNet/LocalNet only). */
  tap(partyId: string, amount: string, privateKey: string): Promise<{ updateId: string }>;
}

type WalletSdk = {
  keys: { generate(): { publicKey: string; privateKey: string } };
  party: {
    external: {
      create(publicKey: string, opts: { partyHint: string }): {
        sign(privateKey: string): { execute(): Promise<{ partyId: string }> };
      };
    };
  };
  ledger: {
    prepare(opts: { partyId: string; commands: unknown; disclosedContracts: unknown }): {
      sign(privateKey: string): { execute(opts: { partyId: string }): Promise<{ updateId: unknown }> };
    };
  };
  amulet: { tap(partyId: string, amount: string): Promise<readonly [unknown, unknown[]]> };
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

let sdkPromise: Promise<{ sdk: WalletSdk; registryUrl: URL }> | null = null;

async function loadSdk(): Promise<{ sdk: WalletSdk; registryUrl: URL }> {
  if (sdkPromise === null) {
    sdkPromise = (async () => {
      const { SDK, localNetStaticConfig, CustomLogAdapter } = await import('@canton-network/wallet-sdk');
      const ledgerUrl = process.env['CANTON_LEDGER_URL'] ?? String(localNetStaticConfig.LOCALNET_APP_USER_LEDGER_URL);
      const registryApi = process.env['CANTON_REGISTRY_URL'] ?? String(localNetStaticConfig.LOCALNET_REGISTRY_API_URL);
      const validatorUrl = process.env['CANTON_VALIDATOR_URL'] ?? String(localNetStaticConfig.LOCALNET_APP_VALIDATOR_URL);
      const scanApiUrl = process.env['CANTON_SCAN_URL'] ?? String(localNetStaticConfig.LOCALNET_SCAN_API_URL);
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
        amulet: { auth, scanApiUrl, registryUrl: registryApi, validatorUrl },
      })) as unknown as WalletSdk;
      return { sdk, registryUrl: new URL(registryApi) };
    })();
  }
  return sdkPromise;
}

export function generateKeys(): Promise<{ publicKey: string; privateKey: string }> {
  return loadSdk().then(({ sdk }) => sdk.keys.generate());
}

/** The real gateway over the official wallet SDK. */
export const sdkGateway: CantonGateway = {
  async onboardParty(publicKey, privateKey, partyHint) {
    const { sdk } = await loadSdk();
    const { partyId } = await sdk.party.external.create(publicKey, { partyHint }).sign(privateKey).execute();
    return partyId;
  },
  async buildTransfer(request) {
    const { sdk, registryUrl } = await loadSdk();
    const [command, disclosedContracts] = await sdk.token.transfer.create({
      sender: request.sender,
      recipient: request.recipient,
      amount: request.amount,
      instrumentId: request.instrumentId,
      registryUrl,
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
    });
    return { command, disclosedContracts };
  },
  async submit(built, partyId, privateKey) {
    const { sdk } = await loadSdk();
    const prepared = sdk.ledger.prepare({
      partyId,
      commands: built.command,
      disclosedContracts: built.disclosedContracts,
    });
    const res = await prepared.sign(privateKey).execute({ partyId });
    return { updateId: String(res.updateId) };
  },
  async tap(partyId, amount, privateKey) {
    const { sdk } = await loadSdk();
    const [command, disclosedContracts] = await sdk.amulet.tap(partyId, amount);
    return this.submit({ command, disclosedContracts: disclosedContracts as unknown[] }, partyId, privateKey);
  },
};
