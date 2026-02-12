import { SubstrateExtrinsic } from "@subql/types";
import { HistoryElement, Transfer } from "../types";
import {
  callFromProxy,
  callsFromBatch,
  calculateFeeAsString,
  extrinsicIdFromBlockAndIdx,
  isBatch,
  isProxy,
  isNativeTransfer,
  isNativeTransferAll,
  timestamp,
} from "./common";

type TransferData = {
  isTransferAll: boolean;
  transfer: Transfer;
};

export async function handleHistoryElement(
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  const { isSigned } = extrinsic.extrinsic;

  if (isSigned) {
    let failedTransfers = findFailedTransferCalls(extrinsic);
    if (failedTransfers != null) {
      await saveFailedTransfers(failedTransfers, extrinsic);
    } else {
      await saveExtrinsic(extrinsic);
    }
  }
}

function createHistoryElement(
  extrinsic: SubstrateExtrinsic,
  address: string,
  suffix: string = "",
  hash?: string
) {
  let extrinsicHash = hash || extrinsic.extrinsic.hash.toString();
  let blockNum = extrinsic.block.block.header.number.toNumber();
  let extrinsicIdx = extrinsic.idx;
  let extrinsicId = extrinsicIdFromBlockAndIdx(blockNum, extrinsicIdx);
  let blockTimestamp = timestamp(extrinsic.block);

  const historyElement = HistoryElement.create({
    id: `${extrinsicId}${suffix}`,
    blockNumber: blockNum,
    timestamp: blockTimestamp,
    address,
  });
  historyElement.extrinsicHash = extrinsicHash;
  historyElement.extrinsicIdx = extrinsicIdx;
  historyElement.timestamp = blockTimestamp;

  return historyElement;
}

async function saveFailedTransfers(
  transfers: Array<TransferData>,
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  for (const { isTransferAll, transfer } of transfers) {
    const elementFrom = createHistoryElement(extrinsic, transfer.from, `-from`);
    elementFrom.transfer = transfer;

    if (!isTransferAll || transfer.from !== transfer.to) {
      const elementTo = createHistoryElement(extrinsic, transfer.to, `-to`);
      elementTo.transfer = transfer;
      await elementTo.save();
    }

    await elementFrom.save();
  }
}

async function saveExtrinsic(extrinsic: SubstrateExtrinsic): Promise<void> {
  const element = createHistoryElement(
    extrinsic,
    extrinsic.extrinsic.signer.toString(),
    "-extrinsic"
  );

  element.extrinsic = {
    hash: extrinsic.extrinsic.hash.toString(),
    module: extrinsic.extrinsic.method.section,
    call: extrinsic.extrinsic.method.method,
    success: extrinsic.success,
    fee: calculateFeeAsString(extrinsic),
  };
  await element.save();
}

function findFailedTransferCalls(
  extrinsic: SubstrateExtrinsic
): Array<TransferData> | null {
  if (extrinsic.success) {
    return null;
  }

  let sender = extrinsic.extrinsic.signer;

  const createTransfer = (
    isTransferAll: boolean,
    address: string,
    amount: bigint
  ): TransferData => {
    return {
      isTransferAll,
      transfer: {
        amount: amount.toString(),
        from: sender.toString(),
        to: address,
        fee: calculateFeeAsString(extrinsic),
        eventIdx: -1,
        success: false,
      },
    };
  };

  let transferCalls = determineTransferCallsArgs(
    extrinsic.extrinsic.method,
    createTransfer
  );

  if (transferCalls.length == 0) {
    return null;
  }

  return transferCalls;
}

function determineTransferCallsArgs(
  causeCall: any,
  createTransfer: (isTransferAll: boolean, address: string, amount: bigint) => TransferData
): Array<TransferData> {
  if (isNativeTransfer(causeCall)) {
    const [destinationAddress, amount] = causeCall.args;
    return [createTransfer(false, destinationAddress.toString(), (amount as any).toBigInt())];
  } else if (isNativeTransferAll(causeCall)) {
    const [destinationAddress] = causeCall.args;
    return [createTransfer(true, destinationAddress.toString(), BigInt(0))];
  } else if (isBatch(causeCall)) {
    return callsFromBatch(causeCall)
      .map((call: any) => determineTransferCallsArgs(call, createTransfer))
      .flat();
  } else if (isProxy(causeCall)) {
    let proxyCall = callFromProxy(causeCall);
    return determineTransferCallsArgs(proxyCall, createTransfer);
  } else {
    return [];
  }
}
