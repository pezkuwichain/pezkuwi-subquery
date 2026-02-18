import { SubstrateEvent, SubstrateBlock } from "@subql/types";
import { ActiveStaker, StakingApy } from "../types";
import { Option } from "@pezkuwi/types";
import {
  PEZKUWI_ASSET_HUB_GENESIS,
  STAKING_TYPE_RELAYCHAIN,
  STAKING_TYPE_NOMINATION_POOL,
  INFLATION_FALLOFF,
  INFLATION_MAX,
  INFLATION_MIN,
  INFLATION_STAKE_TARGET,
  PERBILL_DIVISOR,
} from "./constants";

let poolStakersInitialized = false;

/**
 * Derive the bonded (stash) account for a nomination pool.
 * Formula: PalletId("py/nopls") + encode((AccountType::Bonded=0, poolId)) padded to 32 bytes
 * This matches Substrate's PalletId::into_sub_account_truncating
 */
function derivePoolStash(poolId: number): string {
  const buf = new Uint8Array(32);
  // Substrate's PalletId::into_sub_account_truncating:
  // "modl" (4 bytes) + PalletId (8 bytes) + sub_account encoding
  // "modl" prefix
  buf[0] = 0x6d; // m
  buf[1] = 0x6f; // o
  buf[2] = 0x64; // d
  buf[3] = 0x6c; // l
  // PalletId: "py/nopls" (8 bytes)
  const palletId = [0x70, 0x79, 0x2f, 0x6e, 0x6f, 0x70, 0x6c, 0x73];
  for (let i = 0; i < 8; i++) buf[4 + i] = palletId[i];
  // AccountType::Bonded = 0
  buf[12] = 0;
  // Pool ID as u32 LE
  buf[13] = poolId & 0xff;
  buf[14] = (poolId >> 8) & 0xff;
  buf[15] = (poolId >> 16) & 0xff;
  buf[16] = (poolId >> 24) & 0xff;
  // Remaining bytes are already 0 (padding to 32 bytes)
  // Convert to hex string - createType doesn't accept Uint8Array directly
  let hex = "0x";
  for (let i = 0; i < 32; i++) {
    hex += buf[i].toString(16).padStart(2, "0");
  }
  return api.registry.createType("AccountId", hex).toString();
}

/**
 * Block handler: on the FIRST block processed, query the live chain state
 * for all bonded pools and save their stash accounts as ActiveStakers.
 *
 * The wallet queries activeStakers with:
 *   - address: pool stash (bonded) account
 *   - stakingType: "relaychain" (unwrapped from nomination-pool)
 *   - networkId: AH genesis
 */
export async function handleBlock(block: SubstrateBlock): Promise<void> {
  if (poolStakersInitialized) return;
  poolStakersInitialized = true;

  logger.info("Initializing pool stash accounts from live chain state...");

  const pools = await api.query.nominationPools.bondedPools.entries();
  let count = 0;

  for (const [key, poolOpt] of pools) {
    const pool = poolOpt as Option<any>;
    if (pool.isNone) continue;

    const unwrapped = pool.unwrap();
    if (unwrapped.points.toBigInt() === BigInt(0)) continue;

    const poolId = (key.args[0] as any).toNumber();
    const stashAddress = derivePoolStash(poolId);

    const stakerId = `${PEZKUWI_ASSET_HUB_GENESIS}-${STAKING_TYPE_RELAYCHAIN}-${stashAddress}`;
    const staker = ActiveStaker.create({
      id: stakerId,
      networkId: PEZKUWI_ASSET_HUB_GENESIS,
      stakingType: STAKING_TYPE_RELAYCHAIN,
      address: stashAddress,
    });
    await staker.save();
    count++;
  }

  logger.info(`Initialized ${count} pool stash accounts as active stakers`);

  // Also compute and save APY on first block
  await computeAndSaveAPY();
}

/**
 * Handle nominationPools.Bonded event
 * When a member bonds to a pool, ensure the pool's stash account is
 * saved as an ActiveStaker with relaychain type.
 *
 * Event data: [member: AccountId, pool_id: u32, bonded: Balance, joined: bool]
 */
export async function handlePoolBonded(event: SubstrateEvent): Promise<void> {
  const {
    event: {
      data: [, poolIdEncoded],
    },
  } = event;

  const poolId = (poolIdEncoded as any).toNumber();
  const stashAddress = derivePoolStash(poolId);

  const stakerId = `${PEZKUWI_ASSET_HUB_GENESIS}-${STAKING_TYPE_RELAYCHAIN}-${stashAddress}`;
  const staker = ActiveStaker.create({
    id: stakerId,
    networkId: PEZKUWI_ASSET_HUB_GENESIS,
    stakingType: STAKING_TYPE_RELAYCHAIN,
    address: stashAddress,
  });
  await staker.save();

  logger.info(`Pool ${poolId} stash saved: ${stashAddress}`);
}

/**
 * Handle nominationPools.Unbonded event
 * If the pool has no remaining points after unbond, remove the stash
 * from ActiveStakers.
 *
 * Event data: [member: AccountId, pool_id: u32, balance: Balance, points: Balance, era: u32]
 */
export async function handlePoolUnbonded(event: SubstrateEvent): Promise<void> {
  const {
    event: {
      data: [, poolIdEncoded],
    },
  } = event;

  const poolId = (poolIdEncoded as any).toNumber();

  // Check if pool still has points
  const poolData = (await api.query.nominationPools.bondedPools(
    poolId,
  )) as Option<any>;

  if (poolData.isNone || poolData.unwrap().points.toBigInt() === BigInt(0)) {
    const stashAddress = derivePoolStash(poolId);
    const stakerId = `${PEZKUWI_ASSET_HUB_GENESIS}-${STAKING_TYPE_RELAYCHAIN}-${stashAddress}`;
    await ActiveStaker.remove(stakerId);
    logger.info(`Pool ${poolId} stash removed: ${stashAddress}`);
  }
}

// ===== APY Computation for Asset Hub =====

function calculateYearlyInflation(stakedPortion: number): number {
  const idealStake = INFLATION_STAKE_TARGET;
  const idealInterest = INFLATION_MAX / idealStake;
  if (stakedPortion >= 0 && stakedPortion <= idealStake) {
    return (
      INFLATION_MIN +
      stakedPortion * (idealInterest - INFLATION_MIN / idealStake)
    );
  } else {
    return (
      INFLATION_MIN +
      (idealInterest * idealStake - INFLATION_MIN) *
        Math.pow(2, (idealStake - stakedPortion) / INFLATION_FALLOFF)
    );
  }
}

async function computeAndSaveAPY(): Promise<void> {
  // Use AH's own totalIssuance. AH staking pallet mints inflation from AH supply.
  const TOTAL_SUPPLY = (
    (await api.query.balances.totalIssuance()) as any
  ).toBigInt();
  if (TOTAL_SUPPLY === BigInt(0)) return;

  const activeEraOpt = (await api.query.staking.activeEra()) as Option<any>;
  if (activeEraOpt.isNone) return;
  const currentEra = activeEraOpt.unwrap().index.toNumber();

  // Get all validator exposures for current era
  const overviews =
    await api.query.staking.erasStakersOverview.entries(currentEra);
  let totalStaked = BigInt(0);
  const validators: { totalStake: bigint; commission: number }[] = [];
  const validatorAddresses: string[] = [];

  for (const [key, exp] of overviews) {
    const [, validatorId] = key.args;
    const exposure = (exp as Option<any>).unwrap();
    const total = exposure.total.toBigInt();
    totalStaked += total;
    validatorAddresses.push(validatorId.toString());
    validators.push({ totalStake: total, commission: 0 });
  }

  if (validators.length === 0 || totalStaked === BigInt(0)) return;

  // Get commissions
  const prefs = await api.query.staking.validators.multi(validatorAddresses);
  for (let i = 0; i < prefs.length; i++) {
    const p = prefs[i] as any;
    validators[i].commission = p.commission
      ? Number(p.commission.toString()) / PERBILL_DIVISOR
      : 0;
  }

  // Calculate APY using relay total supply
  const SCALE = BigInt(1_000_000_000);
  const stakedPortion =
    Number((totalStaked * SCALE) / TOTAL_SUPPLY) / Number(SCALE);
  const yearlyInflation = calculateYearlyInflation(stakedPortion);
  const avgRewardPct = yearlyInflation / stakedPortion;
  const avgStake = totalStaked / BigInt(validators.length);

  // Compute per-validator APY, then take the max of validators with
  // at least 10% of average stake (filters out tiny-stake outliers)
  const minStake = avgStake / BigInt(10);
  let maxAPY = 0;
  for (const v of validators) {
    if (v.totalStake < minStake) continue;
    const stakeRatio =
      Number((avgStake * SCALE) / v.totalStake) / Number(SCALE);
    const apy = avgRewardPct * stakeRatio * (1 - v.commission);
    if (apy > maxAPY) maxAPY = apy;
  }

  // Save APY for AH relaychain staking
  const ahRelayApyId = `${PEZKUWI_ASSET_HUB_GENESIS}-${STAKING_TYPE_RELAYCHAIN}`;
  await StakingApy.create({
    id: ahRelayApyId,
    networkId: PEZKUWI_ASSET_HUB_GENESIS,
    stakingType: STAKING_TYPE_RELAYCHAIN,
    maxAPY,
  }).save();

  // Save APY for AH nomination-pool staking
  const ahPoolApyId = `${PEZKUWI_ASSET_HUB_GENESIS}-${STAKING_TYPE_NOMINATION_POOL}`;
  await StakingApy.create({
    id: ahPoolApyId,
    networkId: PEZKUWI_ASSET_HUB_GENESIS,
    stakingType: STAKING_TYPE_NOMINATION_POOL,
    maxAPY,
  }).save();

  logger.info(
    `AH APY: ${(maxAPY * 100).toFixed(2)}% from ${
      validators.length
    } validators, era ${currentEra}, stakedPortion=${(
      stakedPortion * 100
    ).toFixed(2)}%`,
  );
}

/**
 * Handle staking.StakersElected on Asset Hub - recompute APY each era
 */
export async function handleAHStakersElected(
  event: SubstrateEvent,
): Promise<void> {
  await computeAndSaveAPY();
}

/**
 * Handle staking.StakingElection on Asset Hub (old format)
 */
export async function handleAHNewEra(event: SubstrateEvent): Promise<void> {
  await computeAndSaveAPY();
}
