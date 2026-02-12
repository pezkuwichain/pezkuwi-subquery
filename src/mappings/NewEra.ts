import { SubstrateEvent } from "@subql/types";
import { eventId } from "./common";
import { EraValidatorInfo } from "../types/models/EraValidatorInfo";
import { IndividualExposure } from "../types";
import { Option } from "@pezkuwi/types";
import { Exposure } from "@pezkuwi/types/interfaces/staking";

export async function handleStakersElected(
  event: SubstrateEvent,
): Promise<void> {
  await handleNewEra(event);
}

export async function handleNewEra(event: SubstrateEvent): Promise<void> {
  const currentEra = ((await api.query.staking.currentEra()) as Option<any>)
    .unwrap()
    .toNumber();

  if (api.query.staking.erasStakersOverview) {
    await processEraStakersPaged(event, currentEra);
  } else {
    await processEraStakersClipped(event, currentEra);
  }
}

async function processEraStakersClipped(
  event: SubstrateEvent,
  currentEra: number,
): Promise<void> {
  const exposures =
    await api.query.staking.erasStakersClipped.entries(currentEra);

  for (const [key, exposure] of exposures) {
    const [, validatorId] = key.args;
    let validatorIdString = validatorId.toString();
    const exp = exposure as unknown as Exposure;
    const eraValidatorInfo = new EraValidatorInfo(
      eventId(event) + validatorIdString,
      validatorIdString,
      currentEra,
      exp.total.toBigInt(),
      exp.own.toBigInt(),
      exp.others.map((other) => {
        return {
          who: other.who.toString(),
          value: other.value.toString(),
        } as IndividualExposure;
      }),
    );
    await eraValidatorInfo.save();
  }
}

async function processEraStakersPaged(
  event: SubstrateEvent,
  currentEra: number,
): Promise<void> {
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

      const others: IndividualExposure[] = exposure.others.map(({ who, value }: any) => {
        return {
          who: who.toString(),
          value: value.toString(),
        } as IndividualExposure;
      });

      (accumulator[validatorIdString] = accumulator[validatorIdString] || {})[
        pageNumber
      ] = others;
      return accumulator;
    },
    {},
  );

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
  }
}
