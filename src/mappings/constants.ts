// Pezkuwi chain genesis hashes (with 0x prefix, as the app expects)
export const PEZKUWI_RELAY_GENESIS =
  "0x1aa94987791a5544e9667ec249d2cef1b8fdd6083c85b93fc37892d54a1156ca";
export const PEZKUWI_ASSET_HUB_GENESIS =
  "0xe7c15092dcbe3f320260ddbbc685bfceed9125a3b3d8436db2766201dec3b949";

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
