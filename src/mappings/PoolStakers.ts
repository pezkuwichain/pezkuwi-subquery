import { SubstrateEvent } from "@subql/types";
import { ActiveStaker } from "../types";
import { Option } from "@pezkuwi/types";
import {
  PEZKUWI_ASSET_HUB_GENESIS,
  STAKING_TYPE_NOMINATION_POOL,
} from "./constants";

/**
 * Handle nominationPools.Bonded event
 * Fired when a member bonds (joins or adds more) to a nomination pool.
 * Creates an ActiveStaker entry for this address.
 *
 * Event data: [member: AccountId, pool_id: u32, bonded: Balance, joined: bool]
 */
export async function handlePoolBonded(
  event: SubstrateEvent,
): Promise<void> {
  const {
    event: {
      data: [memberEncoded],
    },
  } = event;

  const address = memberEncoded.toString();

  const stakerId = `${PEZKUWI_ASSET_HUB_GENESIS}-${STAKING_TYPE_NOMINATION_POOL}-${address}`;
  const staker = ActiveStaker.create({
    id: stakerId,
    networkId: PEZKUWI_ASSET_HUB_GENESIS,
    stakingType: STAKING_TYPE_NOMINATION_POOL,
    address,
  });
  await staker.save();

  logger.info(`Pool staker added: ${address}`);
}

/**
 * Handle nominationPools.Unbonded event
 * Fired when a member unbonds from a nomination pool.
 * If the member has no remaining points, remove the ActiveStaker entry.
 *
 * Event data: [member: AccountId, pool_id: u32, balance: Balance, points: Balance, era: u32]
 */
export async function handlePoolUnbonded(
  event: SubstrateEvent,
): Promise<void> {
  const {
    event: {
      data: [memberEncoded],
    },
  } = event;

  const address = memberEncoded.toString();

  // Check if member still has points in the pool
  const memberData = (await api.query.nominationPools.poolMembers(
    address,
  )) as Option<any>;

  if (memberData.isNone || memberData.unwrap().points.toBigInt() === BigInt(0)) {
    // Member fully left the pool - remove active staker
    const stakerId = `${PEZKUWI_ASSET_HUB_GENESIS}-${STAKING_TYPE_NOMINATION_POOL}-${address}`;
    await ActiveStaker.remove(stakerId);
    logger.info(`Pool staker removed: ${address}`);
  }
}
