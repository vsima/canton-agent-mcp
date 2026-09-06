// Copyright (c) 2026 Victor Sima
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { withTransportNudges, type NudgeableTransport } from '../src/wc/nudge.ts';

class FakeTransport implements NudgeableTransport {
  connected = true;
  opens = 0;
  restarts = 0;
  async transportOpen(): Promise<void> {
    this.opens += 1;
    this.connected = true;
  }
  async restartTransport(): Promise<void> {
    this.restarts += 1;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a closed socket is reopened while the answer is pending', async () => {
  const transport = new FakeTransport();
  transport.connected = false;
  const answer = deferred<string>();
  const waiting = withTransportNudges(answer.promise, transport, { intervalMs: 5, restartEveryTicks: 100 });
  await sleep(30);
  assert.ok(transport.opens >= 1, 'transportOpen should have been called');
  answer.resolve('ok');
  assert.equal(await waiting, 'ok');
});

test('a quiet open socket is restarted every few ticks to refetch the mailbox', async () => {
  const transport = new FakeTransport();
  const answer = deferred<string>();
  const waiting = withTransportNudges(answer.promise, transport, { intervalMs: 5, restartEveryTicks: 2 });
  await sleep(40);
  assert.ok(transport.restarts >= 1, 'restartTransport should have been called');
  assert.equal(transport.opens, 0, 'an open socket is never reopened');
  answer.resolve('ok');
  assert.equal(await waiting, 'ok');
});

test('nudging stops once the answer lands, and rejections pass through', async () => {
  const transport = new FakeTransport();
  const answer = deferred<string>();
  const waiting = withTransportNudges(answer.promise, transport, { intervalMs: 5, restartEveryTicks: 1 });
  await sleep(20);
  answer.reject(new Error('declined'));
  await assert.rejects(waiting, /declined/);
  const restartsAtSettle = transport.restarts;
  await sleep(30);
  assert.equal(transport.restarts, restartsAtSettle, 'no nudges after the promise settled');
});
