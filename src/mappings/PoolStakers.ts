import { SubstrateEvent, SubstrateBlock } from "@subql/types";
import { ActiveStaker } from "../types";
import { Option } from "@pezkuwi/types";
import {
  PEZKUWI_ASSET_HUB_GENESIS,
  STAKING_TYPE_RELAYCHAIN,
} from "./constants";

let poolStakersInitialized = false;

/**
 * Derive the bonded (stash) account for a nomination pool.
 * Formula: PalletId("py/nopls") + encode((AccountType::Bonded=0, poolId)) padded to 32 bytes
 * This matches Substrate's PalletId::into_sub_account_truncating
 */
function derivePoolStash(poolId: number): string {
  const buf = new Uint8Array(32);
  // PalletId: "py/nopls" (8 bytes)
  const palletId = [0x70, 0x79, 0x2f, 0x6e, 0x6f, 0x70, 0x6c, 0x73];
  for (let i = 0; i < 8; i++) buf[i] = palletId[i];
  // AccountType::Bonded = 0
  buf[8] = 0;
  // Pool ID as u32 LE
  buf[9] = poolId & 0xff;
  buf[10] = (poolId >> 8) & 0xff;
  buf[11] = (poolId >> 16) & 0xff;
  buf[12] = (poolId >> 24) & 0xff;
  // Remaining bytes are already 0 (padding)
  return api.registry.createType("AccountId", buf).toString();
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
}

/**
 * Handle nominationPools.Bonded event
 * When a member bonds to a pool, ensure the pool's stash account is
 * saved as an ActiveStaker with relaychain type.
 *
 * Event data: [member: AccountId, pool_id: u32, bonded: Balance, joined: bool]
 */
export async function handlePoolBonded(
  event: SubstrateEvent,
): Promise<void> {
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
export async function handlePoolUnbonded(
  event: SubstrateEvent,
): Promise<void> {
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
