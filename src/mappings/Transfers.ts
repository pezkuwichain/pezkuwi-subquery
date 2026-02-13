import { HistoryElement, Transfer, AssetTransfer } from "../types";
import { SubstrateEvent } from "@subql/types";
import {
  blockNumber,
  eventId,
  calculateFeeAsString,
  timestamp,
  getEventData,
} from "./common";

export async function handleTransfer(event: SubstrateEvent): Promise<void> {
  const [from, to, amount] = getEventData(event);

  await createTransfer(
    event,
    from.toString(),
    "-from",
    from.toString(),
    to.toString(),
    amount.toString(),
  );
  await createTransfer(
    event,
    to.toString(),
    "-to",
    from.toString(),
    to.toString(),
    amount.toString(),
  );
}

async function createTransfer(
  event: SubstrateEvent,
  address: string,
  suffix: string,
  from: string,
  to: string,
  amount: string,
): Promise<void> {
  const transfer: Transfer = {
    amount: amount,
    from: from,
    to: to,
    fee: calculateFeeAsString(event.extrinsic, from),
    eventIdx: event.idx,
    success: true,
  };

  const element = new HistoryElement(
    `${eventId(event)}${suffix}`,
    blockNumber(event),
    timestamp(event.block),
    address,
  );

  if (event.extrinsic !== undefined) {
    element.extrinsicHash = event.extrinsic.extrinsic.hash.toString();
    element.extrinsicIdx = event.extrinsic.idx;
  }

  element.transfer = transfer;
  await element.save();
}

export async function handleAssetTransfer(event: SubstrateEvent): Promise<void> {
  const [assetId, from, to, amount] = getEventData(event);

  const assetTransferData: AssetTransfer = {
    assetId: assetId.toString(),
    amount: amount.toString(),
    from: from.toString(),
    to: to.toString(),
    fee: calculateFeeAsString(event.extrinsic, from.toString()),
    eventIdx: event.idx,
    success: true,
  };

  await createAssetTransferHistory(event, from.toString(), "-from", assetTransferData);
  await createAssetTransferHistory(event, to.toString(), "-to", assetTransferData);
}

async function createAssetTransferHistory(
  event: SubstrateEvent,
  address: string,
  suffix: string,
  data: AssetTransfer,
): Promise<void> {
  const element = new HistoryElement(
    `${eventId(event)}${suffix}`,
    blockNumber(event),
    timestamp(event.block),
    address,
  );

  if (event.extrinsic !== undefined) {
    element.extrinsicHash = event.extrinsic.extrinsic.hash.toString();
    element.extrinsicIdx = event.extrinsic.idx;
  }

  element.assetTransfer = data;
  await element.save();
}
