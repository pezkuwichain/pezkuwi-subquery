// Watching one extrinsic, and the liveness rule for the scan loop.
//
// Kept apart from bot.js, which connects to three chains the moment it is imported, so that
// both can be tested without a chain.

/**
 * Statuses after which an extrinsic will never reach a block. Each of them used to be ignored:
 * the promise below only settled on `isInBlock`, so a submission the pool dropped, rejected
 * or replaced left it pending forever, and since every submission waits its turn behind the
 * previous one, one lost extrinsic stopped every report after it.
 */
const TERMINAL = ['isDropped', 'isInvalid', 'isUsurped', 'isFinalityTimeout'];

/**
 * Sign and submit `tx`, settling once it is in a block or can never be.
 *
 * Resolves on `isInBlock` without a dispatch error, as before: an extrinsic on a fork that is
 * later retracted is not lost, because the next scan finds neither a pending nor a cached
 * entry and submits again. Rejects on a dispatch error, on a terminal status, and when nothing
 * has settled after `timeoutMs`, which also covers a status subscription the node stopped
 * answering. `onInBlock`, if given, sees the block's events for this extrinsic first.
 */
export function watchSubmission(tx, signer, { decodeError, timeoutMs, onInBlock }) {
  return new Promise((resolve, reject) => {
    let unsub = null;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof unsub === 'function') unsub();
      fn(value);
    };
    const timer = setTimeout(
      () => settle(reject, new Error(`no block after ${timeoutMs} ms`)),
      timeoutMs,
    );

    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (status.isInBlock) {
        if (dispatchError) {
          settle(reject, new Error(decodeError(dispatchError)));
        } else {
          if (!settled && onInBlock) onInBlock(events ?? []);
          settle(resolve, status.asInBlock.toHex());
        }
        return;
      }
      const terminal = TERMINAL.find((flag) => status[flag]);
      if (terminal) settle(reject, new Error(`extrinsic ${status.type ?? terminal.slice(2)}`));
    })
      .then((u) => {
        unsub = u;
        if (settled) u();
      })
      .catch((err) => settle(reject, err));
  });
}

/**
 * Whether the bot has gone too long without completing a scan.
 *
 * Counted from the later of the last completed scan and the process start. Counting only from
 * the last scan left a process whose *first* scan hung with no watchdog at all, because the
 * watchdog was armed after that scan returned: on 2026-10-13 the production container stopped
 * logging one minute after it started and stayed up, silent, for more than a day.
 */
export function isStale({ lastScanAt, startedAt, now, staleAfter }) {
  const since = Math.max(Number.isFinite(lastScanAt) ? lastScanAt : 0, startedAt);
  return now - since > staleAfter;
}

/**
 * Which calls of a `utility.forceBatch` failed, by their position in the batch.
 *
 * `forceBatch` runs every call whatever the others do and reports each one, in call order, as
 * `ItemCompleted` or `ItemFailed`. A failed item does not fail the transaction, so nothing else
 * would ever surface it.
 */
export function failedBatchItems(events) {
  const failed = [];
  let index = 0;
  for (const { event } of events) {
    if (event.section !== 'utility') continue;
    if (event.method === 'ItemCompleted') {
      index++;
    } else if (event.method === 'ItemFailed') {
      failed.push({ index, error: event.data[0] });
      index++;
    }
  }
  return failed;
}
