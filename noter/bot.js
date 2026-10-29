/**
 * Pezkuwi Noter Bot
 *
 * Collects staking data from Asset Hub (direct staking + nomination pools),
 * then submits to People Chain via receive_staking_details() as a noter-authorized account.
 *
 * NOTE: NPoS staking moved from Relay Chain to Asset Hub.
 * RC no longer has pallet_staking (removed via RemovePallet migration).
 * Direct staking (bond/nominate/unbond) is now on AH as pallet_staking_async.
 *
 * Workflow:
 * 1. Listen for ScoreTrackingStarted events on People Chain
 * 2. On event → query staking data from Asset Hub (direct staking + pools)
 * 3. Submit receive_staking_details() signed by noter account
 * 4. Periodically scan all tracked accounts for staking changes
 *
 * Security: noter mnemonic is read from Docker Secret (/run/secrets/noter_mnemonic)
 * or NOTER_MNEMONIC env var as fallback for development.
 */

import { ApiPromise, WsProvider } from '@pezkuwi/api';
import { Keyring } from '@pezkuwi/keyring';
import { cryptoWaitReady } from '@pezkuwi/util-crypto';
import fs from 'fs';
import { watchSubmission, isStale, failedBatchItems } from './submit.js';
import { needsReconfirmation, DEFAULT_CONFIRM_EVERY_BLOCKS } from './confirm.js';
import { buildStakeProof } from './prove.js';

// ========================================
// CONFIGURATION
// ========================================

const RELAY_RPC    = process.env.RELAY_RPC    || 'wss://rpc.pezkuwichain.io';
const ASSET_HUB_RPC = process.env.ASSET_HUB_RPC || 'wss://asset-hub-rpc.pezkuwichain.io';
const PEOPLE_RPC   = process.env.PEOPLE_RPC   || 'wss://people-rpc.pezkuwichain.io';
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_MS || '300000', 10); // 5 min
const UNITS = BigInt('1000000000000'); // 10^12
// How old a confirmation of unchanged stake may get before it is sent again (see confirm.js).
const CONFIRM_EVERY_BLOCKS = parseInt(
  process.env.CONFIRM_EVERY_BLOCKS || String(DEFAULT_CONFIRM_EVERY_BLOCKS), 10);

// Liveness. A scan that throws is logged and retried, which is right — a chain can
// be briefly unreachable. What is not right is doing that forever in silence: this
// bot once spent three weeks reconnecting to endpoints that had been closed, while
// every tracked account's staking score sat at zero. `staking_score` gates the whole
// trust score, so a mute noter is not a degraded service, it is a wrong answer for
// every citizen.
//
// The heartbeat records the last time a scan made progress: a group of accounts read and,
// if it had anything to report, reported. Not the last scan to finish -- a scan's length
// grows with the citizens it tracks, and on 2026-10-19 the first scan after the People
// upgrade, re-confirming all 98 Zagros accounts, ran past the window and was killed halfway
// as if it had hung. Progress is what a stall lacks. The container healthcheck reads the
// heartbeat, and the watchdog below exits once it goes stale, so the restart policy turns a
// silent stall into a visibly crash-looping container.
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/noter-heartbeat';
const STALE_AFTER = SCAN_INTERVAL * 3;
const STARTED_AT = Date.now();
// How long one submission may wait for a block before it is given up on. Every submission
// waits behind the previous one, so this bounds how long a single lost extrinsic can hold
// up all the reports queued after it.
const SUBMIT_TIMEOUT = parseInt(process.env.SUBMIT_TIMEOUT_MS || '120000', 10);

// ========================================
// LOGGING
// ========================================

function touchHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch (err) {
    log('WARN', 'Could not write heartbeat', { error: err.message });
  }
}

/// When the last scan completed, or `NaN` if none has — a missing or unreadable heartbeat.
/// A heartbeat left by an earlier process in the same container is older than
/// `STARTED_AT`, so `isStale` does not let it count for this one.
function lastScanAt() {
  try {
    return Number(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
  } catch {
    return NaN;
  }
}

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const entry = data ? `${ts} [${level}] ${msg} ${JSON.stringify(data)}` : `${ts} [${level}] ${msg}`;
  console.log(entry);
}

// ========================================
// NOTER KEY LOADING
// ========================================

function loadNoterMnemonic() {
  // Priority 1: Docker Secret
  const secretPath = '/run/secrets/noter_mnemonic';
  try {
    if (fs.existsSync(secretPath)) {
      const mnemonic = fs.readFileSync(secretPath, 'utf8').trim();
      if (mnemonic) {
        log('INFO', 'Noter mnemonic loaded from Docker secret');
        return mnemonic;
      }
    }
  } catch { /* ignore */ }

  // Priority 2: Environment variable (dev only)
  if (process.env.NOTER_MNEMONIC) {
    log('WARN', 'Noter mnemonic loaded from env var — use Docker secrets in production');
    return process.env.NOTER_MNEMONIC.trim();
  }

  log('ERROR', 'No noter mnemonic found. Set /run/secrets/noter_mnemonic or NOTER_MNEMONIC env var.');
  process.exit(1);
}

// ========================================
// API CONNECTION WITH AUTO-RECONNECT
// ========================================

async function connectApi(endpoint, name) {
  const provider = new WsProvider(endpoint);
  const api = await ApiPromise.create({ provider });
  const chain = await api.rpc.system.chain();
  const version = api.runtimeVersion.specVersion.toNumber();
  log('INFO', `Connected to ${name}`, { chain: chain.toString(), specVersion: version });

  // Auto-reconnect logging
  provider.on('disconnected', () => log('WARN', `${name} disconnected, reconnecting...`));
  provider.on('connected', () => log('INFO', `${name} reconnected`));
  provider.on('error', (err) => log('ERROR', `${name} provider error`, { error: err.message }));

  return api;
}

// ========================================
// STAKING DATA COLLECTION
// ========================================

/**
 * Get direct staking data from Asset Hub for a single account.
 * NPoS staking moved from Relay Chain to Asset Hub (pallet_staking_async).
 * Returns { stakedAmount, nominationsCount, unlockingChunksCount }
 */
async function getAssetHubStakingData(assetHubApi, address) {
  try {
    if (!assetHubApi.query.staking) {
      return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0 };
    }

    // Try direct ledger query (stash == controller in modern Substrate)
    let ledgerResult = await assetHubApi.query.staking.ledger(address);

    // Fallback: check bonded controller
    if (ledgerResult.isNone) {
      const bonded = await assetHubApi.query.staking.bonded(address);
      if (bonded.isSome) {
        const controller = bonded.unwrap().toString();
        ledgerResult = await assetHubApi.query.staking.ledger(controller);
      }
    }

    if (ledgerResult.isNone) {
      return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0 };
    }

    const ledger = ledgerResult.unwrap();
    const stakedAmount = ledger.active.toBigInt();

    // Get nominations count
    const nominations = await assetHubApi.query.staking.nominators(address);
    const nominationsCount = nominations.isSome
      ? nominations.unwrap().targets.length
      : 0;

    // Unlocking chunks
    const unlockingChunksCount = ledger.unlocking.length;

    return { stakedAmount, nominationsCount, unlockingChunksCount };
  } catch (err) {
    log('ERROR', `Failed to get AH staking data for ${address}`, { error: err.message });
    return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0, queryFailed: true };
  }
}

/**
 * Get nomination pool membership from Asset Hub for a single account.
 * Returns { stakedAmount, nominationsCount: 0, unlockingChunksCount }
 *
 * NOTE: pool points are not directly equal to balance. For accuracy,
 * we should convert via pool's total_balance / total_points ratio.
 * For v1 we use points as a reasonable approximation.
 */
async function getAssetHubPoolData(assetHubApi, address) {
  try {
    if (!assetHubApi.query.nominationPools?.poolMembers) {
      return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0, queryFailed: false };
    }

    const memberResult = await assetHubApi.query.nominationPools.poolMembers(address);
    if (memberResult.isNone) {
      return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0, queryFailed: false };
    }

    const member = memberResult.unwrap();
    const points = member.points.toBigInt();

    // Try to convert points to actual balance using pool ratio
    let stakedAmount = points; // fallback: points ≈ stake
    try {
      const poolId = member.poolId.toNumber();
      const bondedPool = await assetHubApi.query.nominationPools.bondedPools(poolId);
      if (bondedPool.isSome) {
        const pool = bondedPool.unwrap();
        const totalPoints = pool.points.toBigInt();
        if (totalPoints > 0n) {
          // Get pool's stash account to query actual balance
          // stash = poolId-based deterministic account
          // For simplicity, use points directly if we can't get the balance
          // The ratio is usually very close to 1:1 anyway
        }
      }
    } catch { /* use points as fallback */ }

    // Unlocking chunks from unbonding eras
    let unlockingChunksCount = 0;
    try {
      const unbondingEras = member.unbondingEras;
      if (unbondingEras) {
        unlockingChunksCount = unbondingEras.size || 0;
      }
    } catch { /* ignore */ }

    return { stakedAmount, nominationsCount: 0, unlockingChunksCount, queryFailed: false };
  } catch (err) {
    log('ERROR', `Failed to get Asset Hub pool data for ${address}`, { error: err.message });
    return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0, queryFailed: true };
  }
}

// ========================================
// CACHED DATA COMPARISON
// ========================================

/**
 * Get current cached staking details from People Chain for comparison.
 */
async function getCachedData(peopleApi, address, source) {
  try {
    const result = await peopleApi.query.stakingScore.cachedStakingDetails(address, source);
    if (result.isNone || result.isEmpty) {
      return null;
    }
    const json = result.unwrap().toJSON();
    return {
      stakedAmount: BigInt(json.stakedAmount ?? json.staked_amount ?? '0'),
      nominationsCount: json.nominationsCount ?? json.nominations_count ?? 0,
      unlockingChunksCount: json.unlockingChunksCount ?? json.unlocking_chunks_count ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Get an already-pending (not yet finalized) submission for comparison. Without this, every
 * scan compares fresh data only against CachedStakingDetails - which stays empty until a
 * submission actually matures and gets finalized - so a stable account with genuinely unchanged
 * stake looked "changed" on every single scan, and each resubmission reset submitted_at to the
 * current block. That kept the dispute window perpetually restarting: real accounts (Serok,
 * QaziM) never matured because a fresh scan always arrived and re-submitted before finalize ever
 * got a chance.
 */
async function getPendingData(peopleApi, address, source) {
  try {
    const result = await peopleApi.query.stakingScore.pendingStakingDetails(address, source);
    if (result.isNone || result.isEmpty) {
      return null;
    }
    const json = result.unwrap().toJSON().details;
    return {
      stakedAmount: BigInt(json.stakedAmount ?? json.staked_amount ?? '0'),
      nominationsCount: json.nominationsCount ?? json.nominations_count ?? 0,
      unlockingChunksCount: json.unlockingChunksCount ?? json.unlocking_chunks_count ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * The block this source's stake was last confirmed at on People Chain. `supported` is false on
 * a runtime that does not keep confirmations yet, and the bot then never re-confirms.
 */
async function getLastConfirmed(peopleApi, address, source) {
  const query = peopleApi.query.stakingScore.lastConfirmed;
  if (!query) return { supported: false, at: null };
  const result = await query(address, source);
  return { supported: true, at: result.isNone ? null : result.unwrap().toNumber() };
}

/**
 * Check if staking data has changed compared to the most recent known value for this account -
 * whichever is more recent, an unmatured pending submission or (once nothing is pending) the
 * finalized cache. Resubmitting identical data to what's already pending would only reset its
 * dispute-window clock for no reason.
 */
function hasDataChanged(fresh, baseline) {
  if (!baseline) return true; // Nothing recorded yet at all → need to submit
  return fresh.stakedAmount !== baseline.stakedAmount ||
         fresh.nominationsCount !== baseline.nominationsCount ||
         fresh.unlockingChunksCount !== baseline.unlockingChunksCount;
}

// ========================================
// TRANSACTION SUBMISSION
// ========================================

/**
 * Serializes every real submission through this queue. fullScan() fires up to BATCH_SIZE
 * processAccount() calls concurrently (by design, for the read-only data-gathering they start
 * with), and the live event listener can also submit at any time - without this, multiple
 * signAndSend() calls from the same noter keypair can land close enough together that the API's
 * nonce bookkeeping races, producing duplicate-nonce transactions the pool then rejects as
 * "Priority is too low ... already in the pool" (observed: 37 of 50 accounts silently dropped in
 * a single scan). One in-flight submission at a time, in call order, removes the race entirely
 * regardless of which caller is submitting.
 */
let submitQueue = Promise.resolve();

/**
 * Routes a signAndSend through the shared serialization queue, with the standard
 * dispatch-error decoding/logging both callers below need.
 */
function queueSubmit(peopleApi, noterKeypair, tx, description, onInBlock) {
  const task = submitQueue.then(() => doSignAndSend(peopleApi, noterKeypair, tx, description, onInBlock));
  // Never let one caller's failure poison the queue for the next caller's submission.
  submitQueue = task.catch(() => {});
  return task;
}

function doSignAndSend(peopleApi, noterKeypair, tx, description, onInBlock) {
  const decodeError = (dispatchError) => {
    if (dispatchError.isModule) {
      try {
        const decoded = peopleApi.registry.findMetaError(dispatchError.asModule);
        return `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`;
      } catch { /* use default */ }
    }
    return dispatchError.toString();
  };
  return watchSubmission(tx, noterKeypair, { decodeError, timeoutMs: SUBMIT_TIMEOUT, onInBlock }).then(
    (block) => log('INFO', `TX success: ${description}`, { block }),
    (err) => {
      log('ERROR', 'TX failed', { description, error: err.message });
      throw err;
    },
  );
}

/**
 * The call for one update: a stake proof when there is one, otherwise a noter's report.
 */
function updateCall(peopleApi, { address, source, data, proof }) {
  if (proof) {
    return peopleApi.tx.stakingScore.proveStake(address, proof.relayBlock, proof.relayProof, proof.hubProof);
  }
  return peopleApi.tx.stakingScore.receiveStakingDetails(
    address,
    source,
    data.stakedAmount.toString(),
    data.nominationsCount,
    data.unlockingChunksCount,
  );
}

/**
 * Submit receive_staking_details for one or more (address, source) pairs.
 * Batches multiple calls into a single utility.batchAll transaction.
 */
function submitStakingDetails(peopleApi, noterKeypair, updates) {
  if (updates.length === 0) return Promise.resolve();

  const calls = updates.map((u) => updateCall(peopleApi, u));
  const tx = calls.length === 1 ? calls[0] : peopleApi.tx.utility.batchAll(calls);
  const addresses = updates.map(u => u.address.slice(0, 8) + '...').join(', ');

  return queueSubmit(peopleApi, noterKeypair, tx, `${updates.length} update(s) for [${addresses}]`);
}

/**
 * Submit a scan group's updates -- several accounts' -- as one `utility.forceBatch`, and
 * return how many of them failed.
 *
 * One transaction per account made a scan's length the number of accounts with something to
 * report times a block: every re-confirmation falls due in the same scan, so on mainnet that
 * would be every tracked citizen at once, every few days. `forceBatch` rather than `batchAll`
 * because the accounts are unrelated: one refused report must not take the others back with
 * it, or the same refusal would block the whole group in every scan.
 */
async function submitScanGroup(peopleApi, noterKeypair, updates) {
  if (updates.length === 1) {
    await submitStakingDetails(peopleApi, noterKeypair, updates);
    return 0;
  }
  const calls = updates.map((u) => updateCall(peopleApi, u));
  let failed = [];
  await queueSubmit(
    peopleApi,
    noterKeypair,
    peopleApi.tx.utility.forceBatch(calls),
    `${updates.length} update(s) for ${new Set(updates.map(u => u.address)).size} account(s)`,
    (events) => { failed = failedBatchItems(events); },
  );
  for (const { index, error } of failed) {
    const { address, source } = updates[index];
    let reason = error?.toString?.() ?? String(error);
    if (error?.isModule) {
      try {
        const decoded = peopleApi.registry.findMetaError(error.asModule);
        reason = `${decoded.section}.${decoded.name}`;
      } catch { /* keep the raw error */ }
    }
    log('ERROR', `Report refused for ${address.slice(0, 8)}... (${source})`, { error: reason });
  }
  return failed.length;
}

/**
 * finalize_staking_details() is the permissionless step that promotes a matured
 * PendingStakingDetails entry into CachedStakingDetails (see the pallet's
 * DisputeWindow doc comment) - nothing in this codebase called it before this fix,
 * so entries sat in Pending forever even after their dispute window elapsed.
 * Scans all pending entries once per periodic cycle and finalizes whichever have matured.
 */
async function finalizeMaturedPending(peopleApi, noterKeypair) {
  const disputeWindow = peopleApi.consts.stakingScore.disputeWindow.toNumber();
  const currentBlock = (await peopleApi.rpc.chain.getHeader()).number.toNumber();

  const entries = await peopleApi.query.stakingScore.pendingStakingDetails.entries();
  const matured = entries.filter(([, value]) => {
    const submittedAt = value.unwrap().submittedAt.toNumber();
    return currentBlock >= submittedAt + disputeWindow;
  });

  if (matured.length === 0) return;

  log('INFO', `Finalizing ${matured.length} matured pending submission(s)`);

  const calls = matured.map(([key]) => {
    const [who, source] = key.args;
    return peopleApi.tx.stakingScore.finalizeStakingDetails(who, source);
  });
  const tx = calls.length === 1 ? calls[0] : peopleApi.tx.utility.batchAll(calls);

  try {
    await queueSubmit(peopleApi, noterKeypair, tx, `finalize ${matured.length} matured entrie(s)`);
  } catch (err) {
    log('ERROR', 'Finalize batch failed', { error: err.message });
  }
}

// ========================================
// PROCESS SINGLE ACCOUNT
// ========================================

/**
 * Work out what to report for one account, and report it unless `submit` is false -- a scan
 * collects a whole group's updates and sends them together. Returns the updates.
 */
async function processAccount(relayApi, assetHubApi, peopleApi, noterKeypair, address, { submit = true } = {}) {
  if (proofMode(peopleApi)) {
    return processAccountByProof(relayApi, assetHubApi, peopleApi, noterKeypair, address, { submit });
  }
  // The chain refuses a noter's report about themselves (`NoterCannotAttestSelf`), so a
  // noter that has opted in itself failed on that account in every scan. Its stake has to
  // come from another noter; compared as account ids, since the address format may differ.
  if (peopleApi.createType('AccountId', address).eq(noterKeypair.publicKey)) return [];

  const updates = [];

  // 1. Collect ALL staking data first (direct + pool) before comparing
  const ahStakingData = await getAssetHubStakingData(assetHubApi, address);
  const poolData = await getAssetHubPoolData(assetHubApi, address);

  // 2. Combine direct staking + pool into a single total
  const combinedData = {
    stakedAmount: ahStakingData.stakedAmount + poolData.stakedAmount,
    nominationsCount: ahStakingData.nominationsCount,
    unlockingChunksCount: ahStakingData.unlockingChunksCount + poolData.unlockingChunksCount,
  };

  // 3. Compare the COMBINED total against whichever is more recent - an already-pending
  // (not yet matured) submission, or failing that, the finalized cache. Never submit partial
  // data, and never resubmit unchanged data just because the cache itself is still empty.
  const ahStakingPending = await getPendingData(peopleApi, address, 'AssetHub');
  const ahStakingCached = ahStakingPending ?? await getCachedData(peopleApi, address, 'AssetHub');

  const changed = hasDataChanged(combinedData, ahStakingCached);
  if (!changed) {
    const confirmed = await getLastConfirmed(peopleApi, address, 'AssetHub');
    const currentBlock = (await peopleApi.rpc.chain.getHeader()).number.toNumber();
    if (needsReconfirmation({
      supported: confirmed.supported,
      changed,
      pending: ahStakingPending !== null,
      queryFailed: ahStakingData.queryFailed || poolData.queryFailed,
      recordedStake: ahStakingCached ? ahStakingCached.stakedAmount : null,
      lastConfirmedAt: confirmed.at,
      currentBlock,
      everyBlocks: CONFIRM_EVERY_BLOCKS,
    })) {
      updates.push({ address, source: 'AssetHub', data: combinedData });
      log('INFO', `Re-confirming unchanged AH stake for ${address.slice(0, 8)}...`, {
        lastConfirmedAt: confirmed.at,
        currentBlock,
      });
    }
  }

  if (changed) {
    // A total with a failed half in it is not a measurement. The direct-staking query used to
    // fail silently into zeros, and a zero that lands clears the account's stake clock on
    // chain -- a dropped RPC call cost a citizen the duration they had held. Either half
    // failing skips the account this cycle; the next scan reads it again.
    const failed = ahStakingData.queryFailed || poolData.queryFailed;
    if (failed) {
      log('WARN', `Skipping update for ${address.slice(0, 8)}... — a staking query failed, the total is partial`, {
        cached: ahStakingCached ? Number(ahStakingCached.stakedAmount / UNITS) : null,
        wouldSubmit: Number(combinedData.stakedAmount / UNITS),
      });
    } else {
      updates.push({ address, source: 'AssetHub', data: combinedData });
      const stakedHEZ = Number(combinedData.stakedAmount / UNITS);
      log('INFO', `AH staking update for ${address.slice(0, 8)}...`, {
        stakedHEZ,
        direct: Number(ahStakingData.stakedAmount / UNITS),
        pool: Number(poolData.stakedAmount / UNITS),
        noms: combinedData.nominationsCount,
        unlocking: combinedData.unlockingChunksCount,
      });
    }
  }

  // 4. Clear old RelayChain cache if it exists (staking moved to AH) - same pending-first check
  // as step 3, so an already-submitted (unmatured) clear isn't resubmitted every cycle either.
  const relayPending = await getPendingData(peopleApi, address, 'RelayChain');
  const relayCached = relayPending ?? await getCachedData(peopleApi, address, 'RelayChain');
  if (relayCached !== null && relayCached.stakedAmount > 0n) {
    updates.push({
      address,
      source: 'RelayChain',
      data: { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0 }
    });
    log('INFO', `Clearing old RC cache for ${address.slice(0, 8)}...`);
  }

  // 5. Submit all updates in a single batch
  if (submit && updates.length > 0) {
    await submitStakingDetails(peopleApi, noterKeypair, updates);
  }

  return updates;
}

/**
 * Whether the People chain takes stake proofs (`prove_stake`). Once it does, a stake is proven
 * from the hub's own state rather than reported, and nothing unchanged is ever re-confirmed:
 * a change can be proven by anyone, free, so no proof means no change.
 */
function proofMode(peopleApi) {
  return Boolean(peopleApi.tx.stakingScore?.proveStake);
}

/**
 * Prove `address`'s stake when it differs from what the People chain holds, or when what it
 * holds was never proven (a noter's figure from before proofs). Unchanged and proven: nothing.
 */
async function processAccountByProof(relayApi, assetHubApi, peopleApi, noterKeypair, address, { submit = true } = {}) {
  const ahStakingData = await getAssetHubStakingData(assetHubApi, address);
  const poolData = await getAssetHubPoolData(assetHubApi, address);
  if (ahStakingData.queryFailed || poolData.queryFailed) {
    log('WARN', `Skipping ${address.slice(0, 8)}... — a staking query failed`);
    return [];
  }
  const combinedData = {
    stakedAmount: ahStakingData.stakedAmount + poolData.stakedAmount,
    nominationsCount: ahStakingData.nominationsCount,
    unlockingChunksCount: ahStakingData.unlockingChunksCount + poolData.unlockingChunksCount,
  };
  const cached = await getCachedData(peopleApi, address, 'AssetHub');
  const proven = (await peopleApi.query.stakingScore.reportedByChain(address)).isSome;
  // The bot's own reading is only a trigger; what lands is what the proof says.
  if (!hasDataChanged(combinedData, cached) && (proven || combinedData.stakedAmount === 0n)) return [];

  const proof = await buildStakeProof({ relayApi, assetHubApi, peopleApi, address });
  if (!proof) return [];
  log('INFO', `Proving AH stake for ${address.slice(0, 8)}...`, {
    stakedHEZ: Number(combinedData.stakedAmount / UNITS),
    relayBlock: proof.relayBlock,
  });
  const updates = [{ address, source: 'AssetHub', proof }];
  if (submit) await submitStakingDetails(peopleApi, noterKeypair, updates);
  return updates;
}

/**
 * Watch the Asset Hub for stake changes and prove the tracked accounts they touch, as they
 * happen. The periodic scan stays behind it as a safety net.
 */
async function startHubListener(relayApi, assetHubApi, peopleApi, noterKeypair) {
  if (!proofMode(peopleApi)) return;
  log('INFO', 'Watching the Asset Hub for stake changes...');
  await assetHubApi.rpc.chain.subscribeFinalizedHeads(async (header) => {
    try {
      const events = await (await assetHubApi.at(header.hash)).query.system.events();
      const touched = new Set();
      for (const { event } of events) {
        if (event.section !== 'staking' && event.section !== 'nominationPools') continue;
        for (const value of event.data) {
          if (value?.toRawType?.() === 'AccountId32') touched.add(value.toString());
        }
      }
      for (const address of touched) {
        if ((await peopleApi.query.stakingScore.trackingOptIn(address)).isNone) continue;
        await processAccount(relayApi, assetHubApi, peopleApi, noterKeypair, address);
      }
    } catch (err) {
      log('ERROR', 'Hub event processing error', { error: err.message });
    }
  });
}

// ========================================
// FULL SCAN
// ========================================

/**
 * Scan all accounts that have started score tracking.
 * Query StakingStartBlock.entries() on People Chain.
 */
async function fullScan(relayApi, assetHubApi, peopleApi, noterKeypair) {
  log('INFO', 'Starting full scan...');

  const entries = await peopleApi.query.stakingScore.stakingStartBlock.entries();
  log('INFO', `Found ${entries.length} tracked account(s)`);

  let updatedCount = 0;
  let errorCount = 0;

  // Process in batches of 10 to avoid overwhelming RPC
  const BATCH_SIZE = 10;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(([key]) => {
        const address = key.args[0].toString();
        return processAccount(relayApi, assetHubApi, peopleApi, noterKeypair, address, { submit: false });
      })
    );

    const groupUpdates = [];
    let read = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        read++;
        groupUpdates.push(...result.value);
      } else {
        errorCount++;
        log('ERROR', 'Account processing failed', { error: result.reason?.message });
      }
    }

    // Progress means the group was read and, if it had anything to say, said it. A group that
    // could not be read, or whose report was refused outright, is not progress: a noter that
    // reads everything and lands nothing is as mute as one that reads nothing.
    let reported = groupUpdates.length === 0;
    if (groupUpdates.length > 0) {
      try {
        const refused = await submitScanGroup(peopleApi, noterKeypair, groupUpdates);
        updatedCount += groupUpdates.length - refused;
        errorCount += refused;
        reported = refused < groupUpdates.length;
      } catch (err) {
        errorCount += groupUpdates.length;
        log('ERROR', 'Group submission failed', { updates: groupUpdates.length, error: err.message });
      }
    }
    if (read > 0 && reported) touchHeartbeat();

    // Small delay between batches to be gentle on RPC
    if (i + BATCH_SIZE < entries.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  log('INFO', `Full scan complete`, { tracked: entries.length, updated: updatedCount, errors: errorCount });
}

// ========================================
// EVENT LISTENER
// ========================================

/**
 * Subscribe to finalized blocks on People Chain and watch for
 * ScoreTrackingStarted events.
 */
async function startEventListener(relayApi, assetHubApi, peopleApi, noterKeypair) {
  log('INFO', 'Starting event listener on People Chain...');

  await peopleApi.rpc.chain.subscribeFinalizedHeads(async (header) => {
    try {
      const blockHash = header.hash;
      const apiAt = await peopleApi.at(blockHash);
      const events = await apiAt.query.system.events();

      for (const { event } of events) {
        if (event.section === 'stakingScore' && event.method === 'ScoreTrackingStarted') {
          const address = event.data[0].toString();
          log('INFO', `ScoreTrackingStarted event for ${address.slice(0, 8)}...`, {
            block: header.number.toNumber()
          });

          // Process this account immediately
          try {
            await processAccount(relayApi, assetHubApi, peopleApi, noterKeypair, address);
          } catch (err) {
            log('ERROR', `Failed to process new tracking for ${address.slice(0, 8)}...`, {
              error: err.message
            });
          }
        }
      }
    } catch (err) {
      log('ERROR', 'Event processing error', { error: err.message });
    }
  });

  log('INFO', 'Event listener active');
}

// ========================================
// MAIN
// ========================================

async function main() {
  log('INFO', '=== Pezkuwi Noter Bot starting ===');

  // Wait for crypto WASM to be ready
  await cryptoWaitReady();

  // Exiting is the point. Reconnecting forever looks like the bot is coping; a
  // container that keeps dying does not, and the restart policy makes that
  // visible in `docker ps` without anyone having to read the logs.
  //
  // Armed before anything that can hang — connecting, the first scan — and counted
  // from the start of this process until a scan completes. Armed after the first
  // scan, it never ran on a process whose first scan hung.
  setInterval(() => {
    const last = lastScanAt();
    if (isStale({ lastScanAt: last, startedAt: STARTED_AT, now: Date.now(), staleAfter: STALE_AFTER })) {
      log('ERROR', 'No scan progress within the staleness window — exiting so the restart policy takes over', {
        last_scan_at: Number.isFinite(last) && last >= STARTED_AT ? new Date(last).toISOString() : null,
        stale_after_ms: STALE_AFTER,
      });
      process.exit(1);
    }
  }, Math.min(SCAN_INTERVAL, 60_000)).unref?.();

  // Load noter keypair
  const mnemonic = loadNoterMnemonic();
  const keyring = new Keyring({ type: 'sr25519' });
  const noterKeypair = keyring.addFromMnemonic(mnemonic);
  log('INFO', `Noter account: ${noterKeypair.address}`);

  // Connect to all 3 chains
  const [relayApi, assetHubApi, peopleApi] = await Promise.all([
    connectApi(RELAY_RPC, 'Relay Chain'),
    connectApi(ASSET_HUB_RPC, 'Asset Hub'),
    connectApi(PEOPLE_RPC, 'People Chain'),
  ]);

  // Verify noter has the Noter tiki on People Chain
  try {
    if (peopleApi.query.tiki?.userTikis) {
      const tikis = await peopleApi.query.tiki.userTikis(noterKeypair.address);
      const tikiList = tikis.toJSON();
      const hasNoter = Array.isArray(tikiList) && tikiList.some(
        t => (typeof t === 'string' ? t : t?.name || t?.role || '').toLowerCase() === 'noter'
      );
      if (!hasNoter) {
        log('WARN', 'Noter account does NOT have the Noter tiki! TX submissions will fail with NotAuthorized.');
      } else {
        log('INFO', 'Noter tiki verified');
      }
    }
  } catch (err) {
    log('WARN', 'Could not verify noter tiki', { error: err.message });
  }

  // Finalize any already-matured entries BEFORE scanning - so a fresh scan's comparison (now
  // pending-aware, see getPendingData) never has a chance to touch something that should have
  // already been promoted to CachedStakingDetails this cycle.
  await finalizeMaturedPending(peopleApi, noterKeypair);
  await fullScan(relayApi, assetHubApi, peopleApi, noterKeypair);
  touchHeartbeat();

  // Start event listener for real-time processing
  await startEventListener(relayApi, assetHubApi, peopleApi, noterKeypair);
  await startHubListener(relayApi, assetHubApi, peopleApi, noterKeypair);

  // Schedule periodic full scans
  log('INFO', `Periodic scan scheduled every ${SCAN_INTERVAL / 1000}s`);
  // One scan at a time. A scan that outlasts the interval used to have the next one start
  // beside it, reading the same accounts before the first one's reports landed and sending
  // them again: 124 submissions for 98 accounts on 2026-10-19.
  let scanning = false;
  setInterval(() => {
    if (scanning) {
      log('INFO', 'Previous scan still running; this interval is skipped');
      return;
    }
    scanning = true;
    finalizeMaturedPending(peopleApi, noterKeypair)
      .then(() => fullScan(relayApi, assetHubApi, peopleApi, noterKeypair))
      .then(() => touchHeartbeat())
      .catch(err => {
        log('ERROR', 'Periodic scan failed', { error: err.message });
      })
      .finally(() => { scanning = false; });
  }, SCAN_INTERVAL);

}

main().catch(err => {
  log('ERROR', 'Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
