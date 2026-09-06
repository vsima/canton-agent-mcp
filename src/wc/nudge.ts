// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

// Keeps a long wait for a wallet's answer honest about the relay socket.
//
// A wallet's answer is published to the relay and delivered on this client's
// subscription. If the socket has gone half-open in the meantime (an idle NAT
// mapping, a laptop nap, the relay dropping a quiet connection), the answer
// sits in the relay's mailbox and nothing on this side notices: the request
// promise just waits, up to its expiry. So while a request is pending this
// reopens a transport the client reports closed and, every few ticks,
// restarts it outright, which resubscribes and fetches the mailbox.

export interface NudgeableTransport {
  readonly connected: boolean;
  transportOpen(): Promise<void>;
  restartTransport(): Promise<void>;
}

export interface NudgeOptions {
  /** How often to look at the socket while waiting. */
  intervalMs?: number;
  /** Restart the transport every this many ticks even when it reports connected. */
  restartEveryTicks?: number;
  log?: (line: string) => void;
}

/** Resolves or rejects exactly as `pending` does; the nudging is a side effect. */
export async function withTransportNudges<T>(
  pending: Promise<T>,
  transport: NudgeableTransport,
  opts: NudgeOptions = {},
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 30_000;
  const restartEvery = opts.restartEveryTicks ?? 4;
  const log = opts.log ?? (() => {});
  let ticks = 0;
  let settled = false;
  let busy = false;
  const timer = setInterval(() => {
    if (settled || busy) return;
    ticks += 1;
    let nudge: Promise<void>;
    if (!transport.connected) {
      log(`relay: socket closed while waiting (tick ${ticks}), reopening`);
      nudge = transport.transportOpen();
    } else if (ticks % restartEvery === 0) {
      log(`relay: still waiting after ${ticks} ticks, restarting the transport to refetch the mailbox`);
      nudge = transport.restartTransport();
    } else {
      return;
    }
    busy = true;
    nudge
      .catch((e: unknown) => log(`relay: nudge failed: ${(e as Error).message}`))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  try {
    return await pending;
  } finally {
    settled = true;
    clearInterval(timer);
  }
}
