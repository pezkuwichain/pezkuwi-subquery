import { SubstrateEvent, SubstrateBlock } from "@subql/types";
import { eventId } from "./common";
import { EraValidatorInfo, StakingApy, ActiveStaker } from "../types";
import { IndividualExposure } from "../types";
import { Option } from "@pezkuwi/types";
import { Exposure } from "@pezkuwi/types/interfaces/staking";
import {
  PEZKUWI_RELAY_GENESIS,
  PEZKUWI_ASSET_HUB_GENESIS,
  STAKING_TYPE_RELAYCHAIN,
  STAKING_TYPE_NOMINATION_POOL,
  INFLATION_FALLOFF,
  INFLATION_MAX,
  INFLATION_MIN,
  INFLATION_STAKE_TARGET,
  PERBILL_DIVISOR,
} from "./constants";

let relayStakersInitialized = false;

/**
 * Block handler: on the FIRST block processed, query the live chain state
 * for all current era's elected nominators and validators, then save them
 * as ActiveStakers. This ensures existing stakers are captured even if
 * StakersElected events were missed or had parsing issues.
 */
export async function handleRelayBlock(block: SubstrateBlock): Promise<void> {
  if (relayStakersInitialized) return;
  relayStakersInitialized = true;

  logger.info("Initializing active relay stakers from live chain state...");

  // Safety: staking pallet was removed from relay chain in spec 1_020_006
  if (!api.query.staking || !api.query.staking.activeEra) {
    logger.info("Staking pallet not available on relay chain - skipping relay staker init");
    return;
  }

  let activeEraOpt: Option<any>;
  try {
    activeEraOpt = (await api.query.staking.activeEra()) as Option<any>;
  } catch (e) {
    logger.warn(`Failed to query staking.activeEra on relay: ${e}`);
    return;
  }
  if (activeEraOpt.isNone) {
    logger.info("No active era found on relay chain");
    return;
  }
  const currentEra = activeEraOpt.unwrap().index.toNumber();
  logger.info(`Current active era: ${currentEra}`);

  const activeNominators = new Set<string>();
  const activeValidators = new Set<string>();

  // Read all validators from overview (includes validators with only self-stake)
  const overviews =
    await api.query.staking.erasStakersOverview.entries(currentEra);
  for (const [key, ov] of overviews) {
    const [, validatorId] = key.args;
    activeValidators.add(validatorId.toString());
  }

  // Read all paged exposure entries for current era (contains nominators)
  const pages = await api.query.staking.erasStakersPaged.entries(currentEra);
  for (const [key, exp] of pages) {
    const [, validatorId] = key.args;
    activeValidators.add(validatorId.toString());

    let exposure: any;
    try {
      const asOpt = exp as Option<any>;
      if (asOpt.isNone) continue;
      exposure = asOpt.unwrap();
    } catch {
      exposure = exp as any;
    }

    if (exposure.others) {
      for (const other of exposure.others) {
        activeNominators.add(other.who.toString());
      }
    }
  }

  // Fallback: if overview had no results, try legacy erasStakersClipped
  if (activeValidators.size === 0) {
    const clipped =
      await api.query.staking.erasStakersClipped.entries(currentEra);
    for (const [key, exposure] of clipped) {
      const [, validatorId] = key.args;
      activeValidators.add(validatorId.toString());
      const exp = exposure as unknown as Exposure;
      for (const other of exp.others) {
        activeNominators.add(other.who.toString());
      }
    }
  }

  // Save validators as active stakers
  for (const address of activeValidators) {
    const stakerId = `${PEZKUWI_RELAY_GENESIS}-${STAKING_TYPE_RELAYCHAIN}-${address}`;
    const staker = ActiveStaker.create({
      id: stakerId,
      networkId: PEZKUWI_RELAY_GENESIS,
      stakingType: STAKING_TYPE_RELAYCHAIN,
      address,
    });
    await staker.save();
  }

  // Save nominators as active stakers
  for (const address of activeNominators) {
    const stakerId = `${PEZKUWI_RELAY_GENESIS}-${STAKING_TYPE_RELAYCHAIN}-${address}`;
    const staker = ActiveStaker.create({
      id: stakerId,
      networkId: PEZKUWI_RELAY_GENESIS,
      stakingType: STAKING_TYPE_RELAYCHAIN,
      address,
    });
    await staker.save();
  }

  logger.info(
    `Initialized ${activeValidators.size} validators + ${activeNominators.size} nominators as active relay stakers`,
  );
}

export async function handleStakersElected(
  event: SubstrateEvent,
): Promise<void> {
  await handleNewEra(event);
}

export async function handleNewEra(event: SubstrateEvent): Promise<void> {
  // Safety: staking pallet was removed from relay chain in spec 1_020_006
  if (!api.query.staking || !api.query.staking.currentEra) {
    logger.warn("Staking pallet not available - skipping handleNewEra");
    return;
  }

  let currentEra: number;
  try {
    currentEra = ((await api.query.staking.currentEra()) as Option<any>)
      .unwrap()
      .toNumber();
  } catch (e) {
    logger.warn(`Failed to query staking.currentEra: ${e}`);
    return;
  }

  let validatorExposures: Array<{
    address: string;
    total: bigint;
    own: bigint;
    others: IndividualExposure[];
  }>;

  if (api.query.staking.erasStakersOverview) {
    validatorExposures = await processEraStakersPaged(event, currentEra);
  } else {
    validatorExposures = await processEraStakersClipped(event, currentEra);
  }

  // Compute and save APY + active stakers
  await updateStakingApyAndActiveStakers(currentEra, validatorExposures);
}

interface ValidatorExposureData {
  address: string;
  total: bigint;
  own: bigint;
  others: IndividualExposure[];
}

async function processEraStakersClipped(
  event: SubstrateEvent,
  currentEra: number,
): Promise<ValidatorExposureData[]> {
  const exposures =
    await api.query.staking.erasStakersClipped.entries(currentEra);

  const result: ValidatorExposureData[] = [];

  for (const [key, exposure] of exposures) {
    const [, validatorId] = key.args;
    let validatorIdString = validatorId.toString();
    const exp = exposure as unknown as Exposure;
    const others = exp.others.map((other) => {
      return {
        who: other.who.toString(),
        value: other.value.toString(),
      } as IndividualExposure;
    });

    const eraValidatorInfo = new EraValidatorInfo(
      eventId(event) + validatorIdString,
      validatorIdString,
      currentEra,
      exp.total.toBigInt(),
      exp.own.toBigInt(),
      others,
    );
    await eraValidatorInfo.save();

    result.push({
      address: validatorIdString,
      total: exp.total.toBigInt(),
      own: exp.own.toBigInt(),
      others,
    });
  }

  return result;
}

async function processEraStakersPaged(
  event: SubstrateEvent,
  currentEra: number,
): Promise<ValidatorExposureData[]> {
  const overview =
    await api.query.staking.erasStakersOverview.entries(currentEra);
  const pages = await api.query.staking.erasStakersPaged.entries(currentEra);

  interface AccumulatorType {
    [key: string]: { [page: number]: IndividualExposure[] };
  }

  const othersCounted = pages.reduce(
    (accumulator: AccumulatorType, [key, exp]) => {
      const exposure = (exp as Option<any>).unwrap();
      const [, validatorId, pageId] = key.args;
      const pageNumber = (pageId as any).toNumber();
      const validatorIdString = validatorId.toString();

      const others: IndividualExposure[] = exposure.others.map(
        ({ who, value }: any) => {
          return {
            who: who.toString(),
            value: value.toString(),
          } as IndividualExposure;
        },
      );

      (accumulator[validatorIdString] = accumulator[validatorIdString] || {})[
        pageNumber
      ] = others;
      return accumulator;
    },
    {},
  );

  const result: ValidatorExposureData[] = [];

  for (const [key, exp] of overview) {
    const exposure = (exp as Option<any>).unwrap();
    const [, validatorId] = key.args;
    let validatorIdString = validatorId.toString();

    let others: IndividualExposure[] = [];
    for (let i = 0; i < exposure.pageCount.toNumber(); ++i) {
      others.push(...othersCounted[validatorIdString][i]);
    }

    const eraValidatorInfo = new EraValidatorInfo(
      eventId(event) + validatorIdString,
      validatorIdString,
      currentEra,
      exposure.total.toBigInt(),
      exposure.own.toBigInt(),
      others,
    );
    await eraValidatorInfo.save();

    result.push({
      address: validatorIdString,
      total: exposure.total.toBigInt(),
      own: exposure.own.toBigInt(),
      others,
    });
  }

  return result;
}

// ===== APY Calculation (Substrate inflation curve) =====

function calculateYearlyInflation(stakedPortion: number): number {
  const idealStake = INFLATION_STAKE_TARGET; // No parachains on Pezkuwi
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

interface ValidatorAPYData {
  totalStake: bigint;
  commission: number; // 0.0 to 1.0
}

function calculateMaxAPY(
  totalIssuance: bigint,
  validators: ValidatorAPYData[],
): number {
  if (validators.length === 0 || totalIssuance === BigInt(0)) return 0;

  const totalStaked = validators.reduce(
    (sum, v) => sum + v.totalStake,
    BigInt(0),
  );
  if (totalStaked === BigInt(0)) return 0;

  // Use scaled division for precision with large BigInts
  const SCALE = BigInt(1_000_000_000);
  const stakedPortion =
    Number((totalStaked * SCALE) / totalIssuance) / Number(SCALE);

  const yearlyInflation = calculateYearlyInflation(stakedPortion);
  const averageValidatorRewardPercentage = yearlyInflation / stakedPortion;
  const averageValidatorStake = totalStaked / BigInt(validators.length);

  let maxAPY = 0;
  for (const v of validators) {
    if (v.totalStake === BigInt(0)) continue;
    const stakeRatio =
      Number((averageValidatorStake * SCALE) / v.totalStake) / Number(SCALE);
    const yearlyRewardPercentage =
      averageValidatorRewardPercentage * stakeRatio;
    const apy = yearlyRewardPercentage * (1 - v.commission);
    if (apy > maxAPY) maxAPY = apy;
  }

  return maxAPY;
}

async function updateStakingApyAndActiveStakers(
  currentEra: number,
  validatorExposures: ValidatorExposureData[],
): Promise<void> {
  if (validatorExposures.length === 0) return;

  // 1. Get total issuance from the relay chain
  const totalIssuance = (
    (await api.query.balances.totalIssuance()) as any
  ).toBigInt();

  // 2. Get validator commissions
  const validatorAddresses = validatorExposures.map((v) => v.address);
  const validatorPrefs =
    await api.query.staking.validators.multi(validatorAddresses);

  const validatorsWithCommission: ValidatorAPYData[] = validatorExposures.map(
    (v, i) => {
      const prefs = validatorPrefs[i] as any;
      const commissionPerbill = prefs.commission
        ? Number(prefs.commission.toString())
        : 0;
      return {
        totalStake: v.total,
        commission: commissionPerbill / PERBILL_DIVISOR,
      };
    },
  );

  // 3. Calculate maxAPY
  const maxAPY = calculateMaxAPY(totalIssuance, validatorsWithCommission);

  // 4. Save StakingApy for relay chain (relaychain staking)
  const relayApyId = `${PEZKUWI_RELAY_GENESIS}-${STAKING_TYPE_RELAYCHAIN}`;
  const relayApy = StakingApy.create({
    id: relayApyId,
    networkId: PEZKUWI_RELAY_GENESIS,
    stakingType: STAKING_TYPE_RELAYCHAIN,
    maxAPY,
  });
  await relayApy.save();

  // 5. Save StakingApy for Asset Hub (relaychain staking option)
  const ahRelayApyId = `${PEZKUWI_ASSET_HUB_GENESIS}-${STAKING_TYPE_RELAYCHAIN}`;
  const ahRelayApy = StakingApy.create({
    id: ahRelayApyId,
    networkId: PEZKUWI_ASSET_HUB_GENESIS,
    stakingType: STAKING_TYPE_RELAYCHAIN,
    maxAPY,
  });
  await ahRelayApy.save();

  // 6. Save StakingApy for Asset Hub (nomination-pool staking option)
  const ahPoolApyId = `${PEZKUWI_ASSET_HUB_GENESIS}-${STAKING_TYPE_NOMINATION_POOL}`;
  const ahPoolApy = StakingApy.create({
    id: ahPoolApyId,
    networkId: PEZKUWI_ASSET_HUB_GENESIS,
    stakingType: STAKING_TYPE_NOMINATION_POOL,
    maxAPY,
  });
  await ahPoolApy.save();

  logger.info(
    `Era ${currentEra}: maxAPY=${(maxAPY * 100).toFixed(2)}% validators=${
      validatorExposures.length
    } totalIssuance=${totalIssuance}`,
  );

  // 7. Collect all unique nominator addresses from exposures (active stakers)
  const activeNominators = new Set<string>();
  for (const v of validatorExposures) {
    for (const nominator of v.others) {
      activeNominators.add(nominator.who);
    }
  }

  // 8. Clear previous active stakers and save new ones
  // For relay chain direct staking
  for (const address of activeNominators) {
    const relayStakerId = `${PEZKUWI_RELAY_GENESIS}-${STAKING_TYPE_RELAYCHAIN}-${address}`;
    const staker = ActiveStaker.create({
      id: relayStakerId,
      networkId: PEZKUWI_RELAY_GENESIS,
      stakingType: STAKING_TYPE_RELAYCHAIN,
      address,
    });
    await staker.save();
  }

  // Also save validators themselves as active stakers
  for (const v of validatorExposures) {
    const validatorStakerId = `${PEZKUWI_RELAY_GENESIS}-${STAKING_TYPE_RELAYCHAIN}-${v.address}`;
    const staker = ActiveStaker.create({
      id: validatorStakerId,
      networkId: PEZKUWI_RELAY_GENESIS,
      stakingType: STAKING_TYPE_RELAYCHAIN,
      address: v.address,
    });
    await staker.save();
  }

  logger.info(
    `Era ${currentEra}: saved ${activeNominators.size} active stakers (relay)`,
  );
}
