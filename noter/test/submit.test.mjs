// node --test noter/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchSubmission, isStale } from '../submit.js';

// A stand-in for an api-derive submittable: it hands the status callback to the test and
// records whether the subscription was released.
function fakeTx() {
  const t = { emit: null, unsubscribed: false };
  t.signAndSend = (_signer, cb) => {
    t.emit = (flags, extra = {}) => cb({ status: { type: flags.type, ...flags }, ...extra });
    return Promise.resolve(() => { t.unsubscribed = true; });
  };
  return t;
}
const opts = { decodeError: (e) => `decoded ${e}`, timeoutMs: 1_000 };
const tick = () => new Promise((r) => setImmediate(r));

for (const flag of ['isDropped', 'isInvalid', 'isUsurped', 'isFinalityTimeout']) {
  test(`a submission that ends ${flag.slice(2)} settles instead of waiting forever`, async () => {
    const tx = fakeTx();
    const p = watchSubmission(tx, {}, opts);
    await tick();
    tx.emit({ isReady: true, type: 'Ready' });
    tx.emit({ [flag]: true, type: flag.slice(2) });
    await assert.rejects(p, new RegExp(flag.slice(2)));
    assert.equal(tx.unsubscribed, true);
  });
}

test('a submission that never reaches a block is given up after the timeout', async () => {
  const tx = fakeTx();
  const p = watchSubmission(tx, {}, { ...opts, timeoutMs: 50 });
  await tick();
  tx.emit({ isReady: true, type: 'Ready' });
  await assert.rejects(p, /no block after 50 ms/);
  assert.equal(tx.unsubscribed, true);
});

test('a submission in a block resolves with that block', async () => {
  const tx = fakeTx();
  const p = watchSubmission(tx, {}, opts);
  await tick();
  tx.emit({ isInBlock: true, type: 'InBlock', asInBlock: { toHex: () => '0xabc' } });
  assert.equal(await p, '0xabc');
  assert.equal(tx.unsubscribed, true);
});

test('a dispatch error in a block rejects with the decoded error', async () => {
  const tx = fakeTx();
  const p = watchSubmission(tx, {}, opts);
  await tick();
  tx.emit({ isInBlock: true, type: 'InBlock', asInBlock: { toHex: () => '0xabc' } }, { dispatchError: 'E' });
  await assert.rejects(p, /decoded E/);
});

test('a submission the node refuses outright rejects', async () => {
  const tx = { signAndSend: () => Promise.reject(new Error('1014: Priority is too low')) };
  await assert.rejects(watchSubmission(tx, {}, opts), /Priority is too low/);
});

test('a later status cannot settle a submission twice', async () => {
  const tx = fakeTx();
  const p = watchSubmission(tx, {}, opts);
  await tick();
  tx.emit({ isInBlock: true, type: 'InBlock', asInBlock: { toHex: () => '0x1' } });
  tx.emit({ isDropped: true, type: 'Dropped' });
  assert.equal(await p, '0x1');
});

test('a first scan that hangs goes stale, counted from the process start', () => {
  assert.equal(isStale({ lastScanAt: NaN, startedAt: 0, now: 901, staleAfter: 900 }), true);
  assert.equal(isStale({ lastScanAt: NaN, startedAt: 0, now: 899, staleAfter: 900 }), false);
});

test("an earlier process's heartbeat does not keep this one alive", () => {
  // Heartbeat from long before this process started: still counted from the start.
  assert.equal(isStale({ lastScanAt: 10, startedAt: 1_000, now: 1_500, staleAfter: 900 }), false);
  assert.equal(isStale({ lastScanAt: 10, startedAt: 1_000, now: 1_901, staleAfter: 900 }), true);
});

test('a recent scan keeps the bot alive', () => {
  assert.equal(isStale({ lastScanAt: 5_000, startedAt: 0, now: 5_500, staleAfter: 900 }), false);
  assert.equal(isStale({ lastScanAt: 5_000, startedAt: 0, now: 5_901, staleAfter: 900 }), true);
});
