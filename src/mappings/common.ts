import { SubstrateBlock, SubstrateEvent } from "@subql/types";
import { SubstrateExtrinsic } from "@subql/types";

const batchCalls = ["batch", "batchAll", "forceBatch"];
const transferCalls = ["transfer", "transferKeepAlive"];

export function distinct<T>(array: Array<T>): Array<T> {
  return [...new Set(array)];
}

export function isBatch(call: any): boolean {
  return call.section == "utility" && batchCalls.includes(call.method);
}

export function isProxy(call: any): boolean {
  return call.section == "proxy" && call.method == "proxy";
}

export function isNativeTransfer(call: any): boolean {
  return call.section == "balances" && transferCalls.includes(call.method);
}

export function isNativeTransferAll(call: any): boolean {
  return call.section == "balances" && call.method === "transferAll";
}

export function callsFromBatch(batchCall: any): any[] {
  return batchCall.args[0] as any[];
}

export function callFromProxy(proxyCall: any): any {
  return proxyCall.args[2];
}

export function eventIdWithAddress(
  event: SubstrateEvent,
  address: String,
): string {
  return `${eventId(event)}-${address}`;
}

export function eventId(event: SubstrateEvent): string {
  return `${blockNumber(event)}-${event.idx}`;
}

export function eventIdFromBlockAndIdx(blockNumber: string, eventIdx: string) {
  return `${blockNumber}-${eventIdx}`;
}

export function eventIdFromBlockAndIdxAndAddress(
  blockNumber: string,
  eventIdx: string,
  address: string,
) {
  return `${blockNumber}-${eventIdx}-${address}`;
}

export function extrinsicIdx(event: SubstrateEvent): string {
  let idx: string = event.extrinsic
    ? event.extrinsic.idx.toString()
    : event.idx.toString();
  return idx;
}

export function blockNumber(event: SubstrateEvent): number {
  return event.block.block.header.number.toNumber();
}

export function extrinsicIdFromBlockAndIdx(
  blockNumber: number,
  extrinsicIdx: number,
): string {
  return `${blockNumber.toString()}-${extrinsicIdx.toString()}`;
}

export function timestamp(block: SubstrateBlock): bigint {
  return BigInt(
    Math.round(block.timestamp ? block.timestamp.getTime() / 1000 : -1),
  );
}

export function calculateFeeAsString(
  extrinsic?: SubstrateExtrinsic,
  from: string = "",
): string {
  if (extrinsic) {
    const transactionPaymentFee =
      exportFeeFromTransactionFeePaidEvent(extrinsic);

    if (transactionPaymentFee != undefined) {
      return transactionPaymentFee.toString();
    }

    const withdrawFee = exportFeeFromBalancesWithdrawEvent(extrinsic, from);

    if (withdrawFee !== BigInt(0)) {
      return withdrawFee.toString();
    }

    let balancesFee = exportFeeFromBalancesDepositEvent(extrinsic);
    let treasureFee = exportFeeFromTreasureDepositEvent(extrinsic);

    let totalFee = balancesFee + treasureFee;
    return totalFee.toString();
  } else {
    return BigInt(0).toString();
  }
}

export function getEventData(event: SubstrateEvent): any {
  return event.event.data;
}

export function eventRecordToSubstrateEvent(eventRecord: any): SubstrateEvent {
  return eventRecord as unknown as SubstrateEvent;
}

export function BigIntFromCodec(codec: any): bigint {
  return codec.toBigInt();
}

export function getRewardData(event: SubstrateEvent): [any, any] {
  const {
    event: { data: innerData },
  } = event;
  let account: any, amount: any;
  if (innerData.length == 2) {
    [account, amount] = innerData;
  } else {
    [account, , amount] = innerData;
  }
  return [account, amount];
}

function exportFeeFromBalancesWithdrawEvent(
  extrinsic: SubstrateExtrinsic,
  from: string = "",
): bigint {
  const eventRecord = extrinsic.events.find(
    (event) =>
      event.event.method == "Withdraw" && event.event.section == "balances",
  );

  if (eventRecord !== undefined) {
    const {
      event: {
        data: [accountid, fee],
      },
    } = eventRecord;

    const extrinsicSigner = from || extrinsic.extrinsic.signer.toString();
    const withdrawAccountId = accountid.toString();
    return extrinsicSigner === withdrawAccountId
      ? (fee as any).toBigInt()
      : BigInt(0);
  }

  return BigInt(0);
}

function exportFeeFromTransactionFeePaidEvent(
  extrinsic: SubstrateExtrinsic,
  from: string = "",
): bigint | undefined {
  const eventRecord = extrinsic.events.find(
    (event) =>
      event.event.method == "TransactionFeePaid" &&
      event.event.section == "transactionPayment",
  );

  if (eventRecord !== undefined) {
    const {
      event: {
        data: [accountid, fee, tip],
      },
    } = eventRecord;

    const fullFee = (fee as any).toBigInt() + (tip as any).toBigInt();

    const extrinsicSigner = from || extrinsic.extrinsic.signer.toString();
    const withdrawAccountId = accountid.toString();
    return extrinsicSigner === withdrawAccountId ? fullFee : undefined;
  }

  return undefined;
}

function exportFeeFromBalancesDepositEvent(
  extrinsic: SubstrateExtrinsic,
): bigint {
  const eventRecord = extrinsic.events.find((event) => {
    return event.event.method == "Deposit" && event.event.section == "balances";
  });

  if (eventRecord != undefined) {
    const {
      event: {
        data: [, fee],
      },
    } = eventRecord;

    return (fee as any).toBigInt();
  }

  return BigInt(0);
}

function exportFeeFromTreasureDepositEvent(
  extrinsic: SubstrateExtrinsic,
): bigint {
  const eventRecord = extrinsic.events.find((event) => {
    return event.event.method == "Deposit" && event.event.section == "treasury";
  });

  if (eventRecord != undefined) {
    const {
      event: {
        data: [fee],
      },
    } = eventRecord;

    return (fee as any).toBigInt();
  } else {
    return BigInt(0);
  }
}

export function extractTransactionPaidFee(events: any[]): string | undefined {
  const eventRecord = events.find(
    (event: any) =>
      event.event.method == "TransactionFeePaid" &&
      event.event.section == "transactionPayment",
  );

  if (eventRecord == undefined) return undefined;

  const {
    event: {
      data: [_, fee, tip],
    },
  } = eventRecord;

  const fullFee = (fee as any).toBigInt() + (tip as any).toBigInt();

  return fullFee.toString();
}
