/**
 * Patch @subql/node to handle pruned blockchain state.
 *
 * Problem: Substrate nodes prune historical state by default (~256 blocks).
 * When SubQuery restarts and tries to fetch runtime version for old blocks,
 * state_getRuntimeVersion fails with "State already discarded" and the node
 * enters a crash loop.
 *
 * Fix: When getRuntimeVersion(blockHash) fails due to pruned state,
 * fall back to getRuntimeVersion() (current runtime version).
 * This is safe for chains with infrequent spec upgrades.
 */
const fs = require("fs");

// --- Patch 1: base-runtime.service.js ---
// Handles getSpecFromApi() and getRuntimeVersion() which call
// this.api.rpc.state.getRuntimeVersion(parentBlockHash)
const runtimeFile =
  "/app/node_modules/@subql/node/dist/indexer/runtime/base-runtime.service.js";
let runtimeCode = fs.readFileSync(runtimeFile, "utf8");

const runtimeMatches = (
  runtimeCode.match(
    /await this\.api\.rpc\.state\.getRuntimeVersion\(\w+\)/g
  ) || []
).length;

runtimeCode = runtimeCode.replace(
  /await this\.api\.rpc\.state\.getRuntimeVersion\((\w+)\)/g,
  "await this.api.rpc.state.getRuntimeVersion($1).catch(() => this.api.rpc.state.getRuntimeVersion())"
);
fs.writeFileSync(runtimeFile, runtimeCode);
console.log(`Patched base-runtime.service.js (${runtimeMatches} call sites)`);

// --- Patch 2: utils/substrate.js ---
// Handles fetchRuntimeVersionRange() which calls
// api.rpc.state.getRuntimeVersion(hash).catch((e) => { throw ... })
const utilsFile =
  "/app/node_modules/@subql/node/dist/utils/substrate.js";
let utilsCode = fs.readFileSync(utilsFile, "utf8");

const utilsBefore = utilsCode.includes("getRuntimeVersion(hash).catch((e)");

// Insert a fallback .catch before the existing error handler:
// Original: getRuntimeVersion(hash).catch((e) => { throw... })
// Patched:  getRuntimeVersion(hash).catch(() => getRuntimeVersion()).catch((e) => { throw... })
utilsCode = utilsCode.replace(
  /api\.rpc\.state\.getRuntimeVersion\(hash\)\.catch\(\(e\)/g,
  "api.rpc.state.getRuntimeVersion(hash).catch(() => api.rpc.state.getRuntimeVersion()).catch((e)"
);
fs.writeFileSync(utilsFile, utilsCode);
console.log(`Patched utils/substrate.js (had target: ${utilsBefore})`);

console.log("All pruned-state patches applied.");
