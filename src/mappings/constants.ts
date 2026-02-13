// Pezkuwi chain genesis hashes (with 0x prefix, as the app expects)
export const PEZKUWI_RELAY_GENESIS =
  "0xbb4a61ab0c4b8c12f5eab71d0c86c482e03a275ecdafee678dea712474d33d75";
export const PEZKUWI_ASSET_HUB_GENESIS =
  "0x00d0e1d0581c3cd5c5768652d52f4520184018b44f56a2ae1e0dc9d65c00c948";

// Staking type identifiers (must match the app's mapStakingTypeToSubQueryId)
export const STAKING_TYPE_RELAYCHAIN = "relaychain";
export const STAKING_TYPE_NOMINATION_POOL = "nomination-pool";

// Substrate default inflation parameters (Kusama-like, no parachains)
export const INFLATION_FALLOFF = 0.05;
export const INFLATION_MAX = 0.1;
export const INFLATION_MIN = 0.025;
export const INFLATION_STAKE_TARGET = 0.75;

// Commission is stored in perbill (1_000_000_000 = 100%)
export const PERBILL_DIVISOR = 1_000_000_000;
