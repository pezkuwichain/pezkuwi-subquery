/**
 * Build a stake proof for `prove_stake` on the People chain.
 *
 * The stake is on the Asset Hub, and the People chain does not take anyone's word for it --
 * not this bot's, not the hub's governance's. It takes a proof: a relay proof of the hub's head
 * under a relay root the People chain kept, and a hub proof of the account's staking records
 * under that head's state root. This bot only carries what the chains themselves wrote; it
 * cannot make a proof say anything they did not.
 */
import { u8aConcat, u8aToHex, stringToU8a } from '@pezkuwi/util';

/** The account a nomination pool's bond sits in: `modl`, the pools pallet id, `Bonded`, the id. */
export function poolBondedAccount(palletId, poolId) {
  const id = new Uint8Array(4);
  new DataView(id.buffer).setUint32(0, poolId, true);
  const out = new Uint8Array(32);
  out.set(u8aConcat(stringToU8a('modl'), palletId, new Uint8Array([0]), id));
  return out;
}

/**
 * The relay block to anchor on: the relay parent of the People chain's best block, which that
 * block kept in `RelayRoots`. `null` if the People chain does not have it (not upgraded yet).
 */
export async function anchorRelayBlock(peopleApi) {
  if (!peopleApi.query.stakingScore?.relayRoots) return null;
  const vd = await peopleApi.query.teyrchainSystem.validationData();
  if (vd.isNone) return null;
  const relayBlock = vd.unwrap().relayParentNumber.toNumber();
  const root = await peopleApi.query.stakingScore.relayRoots(relayBlock);
  return root.isSome ? relayBlock : null;
}

/** The hub keys a stake is read from, in the order the People chain reads them. */
export async function stakeKeys(assetHubApi, ahHash, address) {
  const at = await assetHubApi.at(ahHash);
  const keys = [
    assetHubApi.query.staking.bonded.key(address),
    assetHubApi.query.staking.nominators.key(address),
    assetHubApi.query.nominationPools.poolMembers.key(address),
  ];
  const bonded = await at.query.staking.bonded(address);
  keys.push(assetHubApi.query.staking.ledger.key(bonded.isSome ? bonded.unwrap() : address));

  const member = await at.query.nominationPools.poolMembers(address);
  if (member.isSome) {
    const poolId = member.unwrap().poolId.toNumber();
    const pool = poolBondedAccount(assetHubApi.consts.nominationPools.palletId.toU8a(), poolId);
    keys.push(assetHubApi.query.nominationPools.bondedPools.key(poolId));
    keys.push(assetHubApi.query.staking.bonded.key(pool));
    const poolBonded = await at.query.staking.bonded(pool);
    keys.push(assetHubApi.query.staking.ledger.key(poolBonded.isSome ? poolBonded.unwrap() : pool));
  }
  return keys;
}

/**
 * Everything `prove_stake(who, relay_block, relay_proof, hub_proof)` needs for `address`, or
 * `null` when the People chain cannot take a proof yet.
 */
export async function buildStakeProof({ relayApi, assetHubApi, peopleApi, address, hubParaId = 1000 }) {
  const relayBlock = await anchorRelayBlock(peopleApi);
  if (relayBlock === null) return null;
  const relayHash = await relayApi.rpc.chain.getBlockHash(relayBlock);
  const headKey = relayApi.query.paras.heads.key(hubParaId);
  const relayProof = await relayApi.rpc.state.getReadProof([headKey], relayHash);
  const head = (await relayApi.query.paras.heads.at(relayHash, hubParaId)).unwrap();
  const ahHash = assetHubApi.registry.createType('Header', head.toU8a(true)).hash;
  const hubProof = await assetHubApi.rpc.state.getReadProof(
    await stakeKeys(assetHubApi, ahHash, address),
    ahHash,
  );
  return {
    relayBlock,
    relayProof: relayProof.proof.map((n) => u8aToHex(n)),
    hubProof: hubProof.proof.map((n) => u8aToHex(n)),
  };
}
