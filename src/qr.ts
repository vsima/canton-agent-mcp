// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// Renders a WalletConnect pairing URI as a scannable text QR. Returned to the
// agent as tool output so the human can scan it straight from the terminal or
// chat; the raw URI rides along for wallets that paste instead of scan.
// The utf8 renderer, not terminal: pure block characters with no ANSI escape
// codes, so the QR survives being relayed through an agent's chat output.

import QRCode from 'qrcode';

export async function terminalQr(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: 'utf8', errorCorrectionLevel: 'L' });
}
