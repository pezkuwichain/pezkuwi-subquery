import { SubstrateEvent, SubstrateExtrinsic } from "@subql/types";
import {
  Referendum,
  CastingVoting,
  DelegatorVoting,
  Delegation,
  Delegate,
  DelegateVote,
} from "../types";
import { isBatch, isProxy, callsFromBatch, callFromProxy } from "./common";

// ========== Helpers ==========

function findCall(
  extrinsic: SubstrateExtrinsic,
  module: string,
  method: string,
): any | null {
  const topCall = extrinsic.extrinsic.method;

  if (topCall.section === module && topCall.method === method) {
    return topCall;
  }

  if (isBatch(topCall)) {
    for (const inner of callsFromBatch(topCall)) {
      if (inner.section === module && inner.method === method) {
        return inner;
      }
      // Nested batch/proxy
      if (isBatch(inner)) {
        for (const nested of callsFromBatch(inner)) {
          if (nested.section === module && nested.method === method) {
            return nested;
          }
        }
      }
      if (isProxy(inner)) {
        const proxied = callFromProxy(inner);
        if (proxied.section === module && proxied.method === method) {
          return proxied;
        }
      }
    }
  }

  if (isProxy(topCall)) {
    const inner = callFromProxy(topCall);
    if (inner.section === module && inner.method === method) {
      return inner;
    }
    if (isBatch(inner)) {
      for (const nested of callsFromBatch(inner)) {
        if (nested.section === module && nested.method === method) {
          return nested;
        }
      }
    }
  }

  return null;
}

function getSigner(extrinsic: SubstrateExtrinsic): string {
  return extrinsic.extrinsic.signer.toString();
}

function getBlockNum(extrinsic: SubstrateExtrinsic): number {
  return extrinsic.block.block.header.number.toNumber();
}

function getTimestamp(extrinsic: SubstrateExtrinsic): bigint {
  const ts = extrinsic.block.timestamp;
  return BigInt(Math.round(ts ? ts.getTime() / 1000 : 0));
}

function parseAccountVote(voteData: any): {
  standardVote?: any;
  splitVote?: any;
  splitAbstainVote?: any;
} {
  if (voteData.isStandard) {
    const std = voteData.asStandard;
    return {
      standardVote: {
        aye: std.vote.isAye,
        vote: {
          amount: std.balance.toString(),
          conviction: std.vote.conviction.toString(),
        },
      },
    };
  }

  if (voteData.isSplit) {
    const s = voteData.asSplit;
    return {
      splitVote: {
        ayeAmount: s.aye.toString(),
        nayAmount: s.nay.toString(),
      },
    };
  }

  if (voteData.isSplitAbstain) {
    const sa = voteData.asSplitAbstain;
    return {
      splitAbstainVote: {
        ayeAmount: sa.aye.toString(),
        nayAmount: sa.nay.toString(),
        abstainAmount: sa.abstain.toString(),
      },
    };
  }

  return {};
}

// ========== Delegation Propagation ==========

async function propagateVoteToDelegators(
  delegateAddress: string,
  cv: CastingVoting,
  referendumId: string,
): Promise<void> {
  const delegations = await Delegation.getByDelegateId(delegateAddress, {
    limit: 500,
  });
  if (!delegations || delegations.length === 0) return;

  const referendum = await Referendum.get(referendumId);
  if (!referendum) return;

  for (const d of delegations) {
    if (d.trackId !== referendum.trackId) continue;

    const dvId = `${cv.id}-${d.delegator}`;
    const dv = DelegatorVoting.create({
      id: dvId,
      parentId: cv.id,
      delegator: d.delegator,
      vote: d.delegation,
    });
    await dv.save();
  }
}

async function createDelegatorVotingsForNewDelegation(
  delegation: Delegation,
): Promise<void> {
  const cvList = await CastingVoting.getByVoter(delegation.delegateId, {
    limit: 500,
  });
  if (!cvList || cvList.length === 0) return;

  for (const cv of cvList) {
    const ref = await Referendum.get(cv.referendumId);
    if (!ref || ref.trackId !== delegation.trackId) continue;

    const dvId = `${cv.id}-${delegation.delegator}`;
    const dv = DelegatorVoting.create({
      id: dvId,
      parentId: cv.id,
      delegator: delegation.delegator,
      vote: delegation.delegation,
    });
    await dv.save();
  }
}

async function removeDelegatorVotings(
  delegator: string,
  delegateId: string,
  trackId: number,
): Promise<void> {
  const cvList = await CastingVoting.getByVoter(delegateId, { limit: 500 });
  if (!cvList) return;

  for (const cv of cvList) {
    const ref = await Referendum.get(cv.referendumId);
    if (!ref || ref.trackId !== trackId) continue;

    const dvId = `${cv.id}-${delegator}`;
    await store.remove("DelegatorVoting", dvId);
  }
}

async function updateDelegateStats(
  accountId: string,
  delegationAmount: string,
  isAdd: boolean,
): Promise<void> {
  let delegate = await Delegate.get(accountId);

  if (!delegate) {
    if (!isAdd) return;
    delegate = Delegate.create({
      id: accountId,
      accountId: accountId,
      delegators: 0,
      delegatorVotes: BigInt(0),
    });
  }

  const amount = BigInt(delegationAmount || "0");

  if (isAdd) {
    delegate.delegators += 1;
    delegate.delegatorVotes = (delegate.delegatorVotes || BigInt(0)) + amount;
  } else {
    delegate.delegators = Math.max(0, delegate.delegators - 1);
    const newVotes = (delegate.delegatorVotes || BigInt(0)) - amount;
    delegate.delegatorVotes = newVotes < BigInt(0) ? BigInt(0) : newVotes;
  }

  await delegate.save();
}

// ========== Event Handlers ==========

export async function handleReferendumSubmitted(
  event: SubstrateEvent,
): Promise<void> {
  const {
    event: {
      data: [indexRaw, trackRaw],
    },
  } = event;

  const refIndex = (indexRaw as any).toNumber();
  const trackId = (trackRaw as any).toNumber();
  const id = refIndex.toString();

  let referendum = await Referendum.get(id);
  if (!referendum) {
    referendum = Referendum.create({ id, trackId });
  } else {
    referendum.trackId = trackId;
  }
  await referendum.save();
}

// ========== Call Handlers ==========

export async function handleVoteCall(
  extrinsic: SubstrateExtrinsic,
): Promise<void> {
  const call = findCall(extrinsic, "convictionVoting", "vote");
  if (!call) return;

  const pollIndex = (call.args[0] as any).toNumber();
  const voteData = call.args[1];
  const voter = getSigner(extrinsic);
  const block = getBlockNum(extrinsic);
  const ts = getTimestamp(extrinsic);

  const referendumId = pollIndex.toString();

  // Ensure referendum entity exists
  let referendum = await Referendum.get(referendumId);
  if (!referendum) {
    referendum = Referendum.create({ id: referendumId, trackId: 0 });
    await referendum.save();
  }

  // Parse vote
  const parsed = parseAccountVote(voteData);

  // Create/update CastingVoting
  const cvId = `${referendumId}-${voter}`;
  let cv = await CastingVoting.get(cvId);

  if (!cv) {
    cv = CastingVoting.create({
      id: cvId,
      referendumId: referendumId,
      voter: voter,
      delegateId: voter,
      standardVote: parsed.standardVote ?? undefined,
      splitVote: parsed.splitVote ?? undefined,
      splitAbstainVote: parsed.splitAbstainVote ?? undefined,
      at: block,
      timestamp: ts,
    });
  } else {
    cv.standardVote = parsed.standardVote ?? undefined;
    cv.splitVote = parsed.splitVote ?? undefined;
    cv.splitAbstainVote = parsed.splitAbstainVote ?? undefined;
    cv.at = block;
    cv.timestamp = ts;
  }
  await cv.save();

  // If this voter is a delegate, track the vote and propagate
  const delegate = await Delegate.get(voter);
  if (delegate && delegate.delegators > 0) {
    const dvoteId = `${voter}-${referendumId}`;
    const dvote = DelegateVote.create({
      id: dvoteId,
      delegateId: voter,
      at: block,
      timestamp: ts,
    });
    await dvote.save();

    await propagateVoteToDelegators(voter, cv, referendumId);
  }
}

export async function handleRemoveVoteCall(
  extrinsic: SubstrateExtrinsic,
): Promise<void> {
  const call = findCall(extrinsic, "convictionVoting", "removeVote");
  if (!call) return;

  const voter = getSigner(extrinsic);
  // removeVote(class: Option<ClassOf>, index: PollIndexOf)
  const pollIndex = (call.args[1] as any).toNumber();
  const referendumId = pollIndex.toString();
  const cvId = `${referendumId}-${voter}`;

  // Remove child DelegatorVoting entries
  const dvList = await DelegatorVoting.getByParentId(cvId, { limit: 500 });
  if (dvList) {
    for (const dv of dvList) {
      await store.remove("DelegatorVoting", dv.id);
    }
  }

  // Remove DelegateVote
  await store.remove("DelegateVote", `${voter}-${referendumId}`);

  // Remove CastingVoting
  await store.remove("CastingVoting", cvId);
}

export async function handleDelegateCall(
  extrinsic: SubstrateExtrinsic,
): Promise<void> {
  const call = findCall(extrinsic, "convictionVoting", "delegate");
  if (!call) return;

  // delegate(class, to, conviction, balance)
  const trackId = (call.args[0] as any).toNumber();
  const target = (call.args[1] as any).toString();
  const conviction = (call.args[2] as any).toString();
  const balance = (call.args[3] as any).toString();
  const delegator = getSigner(extrinsic);

  const delegationId = `${delegator}-${trackId}`;

  // Clean up old delegation on this track if exists
  const oldDelegation = await Delegation.get(delegationId);
  if (oldDelegation) {
    await updateDelegateStats(
      oldDelegation.delegateId,
      oldDelegation.delegation?.amount || "0",
      false,
    );
    if (oldDelegation.delegateId !== target) {
      await removeDelegatorVotings(
        delegator,
        oldDelegation.delegateId,
        trackId,
      );
    }
  }

  // Create new delegation
  const voteBalance = { amount: balance, conviction };
  const delegation = Delegation.create({
    id: delegationId,
    delegateId: target,
    delegator: delegator,
    trackId: trackId,
    delegation: voteBalance,
  });
  await delegation.save();

  // Update delegate stats
  await updateDelegateStats(target, balance, true);

  // Create DelegatorVoting entries for existing votes by this delegate
  await createDelegatorVotingsForNewDelegation(delegation);
}

export async function handleUndelegateCall(
  extrinsic: SubstrateExtrinsic,
): Promise<void> {
  const call = findCall(extrinsic, "convictionVoting", "undelegate");
  if (!call) return;

  // undelegate(class)
  const trackId = (call.args[0] as any).toNumber();
  const delegator = getSigner(extrinsic);

  const delegationId = `${delegator}-${trackId}`;
  const delegation = await Delegation.get(delegationId);
  if (!delegation) return;

  const target = delegation.delegateId;

  // Remove DelegatorVoting entries
  await removeDelegatorVotings(delegator, target, trackId);

  // Update delegate stats
  await updateDelegateStats(
    target,
    delegation.delegation?.amount || "0",
    false,
  );

  // Remove delegation
  await store.remove("Delegation", delegationId);
}
