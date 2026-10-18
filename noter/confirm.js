/**
 * When unchanged stake has to be confirmed again.
 *
 * The People chain counts a staking duration only up to the last confirmation of the stake
 * plus `MaxDataAge` (fourteen days): a noter that stops reporting must not leave scores
 * climbing on data nobody checks. The other side of that rule is this one -- a healthy noter
 * re-confirms stake that has not changed, well inside the allowance, so an account whose
 * stake simply stays put never reaches it.
 *
 * Only resubmitting identical data is new; resubmitting it too often is the old bug
 * (every submission restarts the dispute window). So: never while a submission is still
 * pending, and only once the last confirmation is `everyBlocks` old.
 */

// Three days of six-second blocks: four or five confirmations inside the fourteen-day
// allowance, so a missed day or two costs nothing.
export const DEFAULT_CONFIRM_EVERY_BLOCKS = 3 * 24 * 600;

/**
 * @param {object} p
 * @param {boolean} p.supported   the chain keeps confirmations (`stakingScore.lastConfirmed`)
 * @param {boolean} p.changed     the fresh data differs from what is recorded
 * @param {boolean} p.pending     a submission for this source is still in its dispute window
 * @param {boolean} p.queryFailed part of the fresh data could not be read
 * @param {bigint|null} p.recordedStake what the chain holds for this source, or null
 * @param {number|null} p.lastConfirmedAt block of the last confirmation, or null if none
 * @param {number} p.currentBlock
 * @param {number} p.everyBlocks
 */
export function needsReconfirmation(p) {
  if (!p.supported || p.changed || p.pending || p.queryFailed) return false;
  if (p.recordedStake === null || p.recordedStake === 0n) return false;
  // Stake recorded before the chain kept confirmations has none on record: confirm it.
  if (p.lastConfirmedAt === null) return true;
  return p.currentBlock - p.lastConfirmedAt >= p.everyBlocks;
}
