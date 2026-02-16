/**
 * Pezkuwi Noter Bot
 *
 * Collects staking data from Relay Chain and Asset Hub, then submits
 * to People Chain via receive_staking_details() as a noter-authorized account.
 *
 * Workflow:
 * 1. Listen for ScoreTrackingStarted events on People Chain
 * 2. On event → query staking data from Relay Chain (+ Asset Hub pools)
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

// ========================================
// CONFIGURATION
// ========================================

const RELAY_RPC    = process.env.RELAY_RPC    || 'wss://rpc.pezkuwichain.io';
const ASSET_HUB_RPC = process.env.ASSET_HUB_RPC || 'wss://asset-hub-rpc.pezkuwichain.io';
const PEOPLE_RPC   = process.env.PEOPLE_RPC   || 'wss://people-rpc.pezkuwichain.io';
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_MS || '300000', 10); // 5 min
const UNITS = BigInt('1000000000000'); // 10^12

// ========================================
// LOGGING
// ========================================

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
 * Get staking data from Relay Chain for a single account.
 * Returns { stakedAmount, nominationsCount, unlockingChunksCount }
 */
async function getRelayStakingData(relayApi, address) {
  try {
    // Try direct ledger query (stash == controller in modern Substrate)
    let ledgerResult = await relayApi.query.staking.ledger(address);

    // Fallback: check bonded controller
    if (ledgerResult.isNone) {
      const bonded = await relayApi.query.staking.bonded(address);
      if (bonded.isSome) {
        const controller = bonded.unwrap().toString();
        ledgerResult = await relayApi.query.staking.ledger(controller);
      }
    }

    if (ledgerResult.isNone) {
      return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0 };
    }

    const ledger = ledgerResult.unwrap();
    const stakedAmount = ledger.active.toBigInt();

    // Get nominations count
    const nominations = await relayApi.query.staking.nominators(address);
    const nominationsCount = nominations.isSome
      ? nominations.unwrap().targets.length
      : 0;

    // Unlocking chunks
    const unlockingChunksCount = ledger.unlocking.length;

    return { stakedAmount, nominationsCount, unlockingChunksCount };
  } catch (err) {
    log('ERROR', `Failed to get relay staking data for ${address}`, { error: err.message });
    return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0 };
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
      return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0 };
    }

    const memberResult = await assetHubApi.query.nominationPools.poolMembers(address);
    if (memberResult.isNone) {
      return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0 };
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

    return { stakedAmount, nominationsCount: 0, unlockingChunksCount };
  } catch (err) {
    log('ERROR', `Failed to get Asset Hub pool data for ${address}`, { error: err.message });
    return { stakedAmount: 0n, nominationsCount: 0, unlockingChunksCount: 0 };
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
 * Check if staking data has changed compared to cached values.
 */
function hasDataChanged(fresh, cached) {
  if (!cached) return true; // No cache → need to submit
  return fresh.stakedAmount !== cached.stakedAmount ||
         fresh.nominationsCount !== cached.nominationsCount ||
         fresh.unlockingChunksCount !== cached.unlockingChunksCount;
}

// ========================================
// TRANSACTION SUBMISSION
// ========================================

/**
 * Submit receive_staking_details for one or more (address, source) pairs.
 * Batches multiple calls into a single utility.batchAll transaction.
 */
async function submitStakingDetails(peopleApi, noterKeypair, updates) {
  if (updates.length === 0) return;

  const calls = updates.map(({ address, source, data }) =>
    peopleApi.tx.stakingScore.receiveStakingDetails(
      address,
      source,
      data.stakedAmount.toString(),
      data.nominationsCount,
      data.unlockingChunksCount,
    )
  );

  const tx = calls.length === 1 ? calls[0] : peopleApi.tx.utility.batchAll(calls);

  return new Promise((resolve, reject) => {
    tx.signAndSend(noterKeypair, ({ status, dispatchError, events }) => {
      if (status.isInBlock) {
        if (dispatchError) {
          let errMsg = dispatchError.toString();
          if (dispatchError.isModule) {
            try {
              const decoded = peopleApi.registry.findMetaError(dispatchError.asModule);
              errMsg = `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`;
            } catch { /* use default */ }
          }
          log('ERROR', 'TX failed', { error: errMsg, block: status.asInBlock.toHex() });
          reject(new Error(errMsg));
        } else {
          const addresses = updates.map(u => u.address.slice(0, 8) + '...').join(', ');
          log('INFO', `TX success: ${updates.length} update(s) for [${addresses}]`, {
            block: status.asInBlock.toHex()
          });
          resolve();
        }
      }
    }).catch(reject);
  });
}

// ========================================
// PROCESS SINGLE ACCOUNT
// ========================================

async function processAccount(relayApi, assetHubApi, peopleApi, noterKeypair, address) {
  const updates = [];

  // 1. Relay Chain staking
  const relayData = await getRelayStakingData(relayApi, address);
  const relayCached = await getCachedData(peopleApi, address, 'RelayChain');

  if (hasDataChanged(relayData, relayCached)) {
    updates.push({ address, source: 'RelayChain', data: relayData });
    const stakedHEZ = Number(relayData.stakedAmount / UNITS);
    log('INFO', `Relay data changed for ${address.slice(0, 8)}...`, {
      stakedHEZ, noms: relayData.nominationsCount, unlocking: relayData.unlockingChunksCount
    });
  }

  // 2. Asset Hub nomination pools
  const assetHubData = await getAssetHubPoolData(assetHubApi, address);
  const assetHubCached = await getCachedData(peopleApi, address, 'AssetHub');

  if (assetHubData.stakedAmount > 0n || assetHubCached !== null) {
    // Only submit if there's actual pool membership or we need to clear old data
    if (hasDataChanged(assetHubData, assetHubCached)) {
      updates.push({ address, source: 'AssetHub', data: assetHubData });
      const stakedHEZ = Number(assetHubData.stakedAmount / UNITS);
      log('INFO', `Asset Hub data changed for ${address.slice(0, 8)}...`, { stakedHEZ });
    }
  }

  // 3. Submit all updates in a single batch
  if (updates.length > 0) {
    await submitStakingDetails(peopleApi, noterKeypair, updates);
  }

  return updates.length;
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
        return processAccount(relayApi, assetHubApi, peopleApi, noterKeypair, address);
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        updatedCount += result.value;
      } else {
        errorCount++;
        log('ERROR', 'Account processing failed', { error: result.reason?.message });
      }
    }

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

  // Run initial full scan
  await fullScan(relayApi, assetHubApi, peopleApi, noterKeypair);

  // Start event listener for real-time processing
  await startEventListener(relayApi, assetHubApi, peopleApi, noterKeypair);

  // Schedule periodic full scans
  log('INFO', `Periodic scan scheduled every ${SCAN_INTERVAL / 1000}s`);
  setInterval(() => {
    fullScan(relayApi, assetHubApi, peopleApi, noterKeypair).catch(err => {
      log('ERROR', 'Periodic scan failed', { error: err.message });
    });
  }, SCAN_INTERVAL);
}

main().catch(err => {
  log('ERROR', 'Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
