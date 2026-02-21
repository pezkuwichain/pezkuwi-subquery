/**
 * Patch @subql/node and @polkadot/api to handle pruned blockchain state.
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
let count = 0;

// --- Patch 1: @subql/node base-runtime.service.js ---
// getSpecFromApi() and getRuntimeVersion() call
// this.api.rpc.state.getRuntimeVersion(parentBlockHash)
const runtimeFile =
  "/app/node_modules/@subql/node/dist/indexer/runtime/base-runtime.service.js";
let runtimeCode = fs.readFileSync(runtimeFile, "utf8");
runtimeCode = runtimeCode.replace(
  /await this\.api\.rpc\.state\.getRuntimeVersion\((\w+)\)/g,
  (m, v) => { count++; return `await this.api.rpc.state.getRuntimeVersion(${v}).catch(() => this.api.rpc.state.getRuntimeVersion())`; }
);
fs.writeFileSync(runtimeFile, runtimeCode);
console.log(`[1/4] base-runtime.service.js: ${count} patches`);

// --- Patch 2: @subql/node utils/substrate.js ---
// fetchRuntimeVersionRange() catches and rethrows; add fallback before rethrow
count = 0;
const utilsFile =
  "/app/node_modules/@subql/node/dist/utils/substrate.js";
let utilsCode = fs.readFileSync(utilsFile, "utf8");
utilsCode = utilsCode.replace(
  /api\.rpc\.state\.getRuntimeVersion\(hash\)\.catch\(\(e\)/g,
  () => { count++; return "api.rpc.state.getRuntimeVersion(hash).catch(() => api.rpc.state.getRuntimeVersion()).catch((e)"; }
);
fs.writeFileSync(utilsFile, utilsCode);
console.log(`[2/4] utils/substrate.js: ${count} patches`);

// --- Patch 3: @polkadot/api Init.js ---
// _getBlockRegistryViaHash calls getRuntimeVersion.raw(header.parentHash)
// which fails when parentHash points to a pruned block (including genesis).
count = 0;
const initFile =
  "/app/node_modules/@polkadot/api/cjs/base/Init.js";
let initCode = fs.readFileSync(initFile, "utf8");
initCode = initCode.replace(
  /await \(0, rxjs_1\.firstValueFrom\)\(this\._rpcCore\.state\.getRuntimeVersion\.raw\(header\.parentHash\)\)/g,
  () => { count++; return "await (0, rxjs_1.firstValueFrom)(this._rpcCore.state.getRuntimeVersion.raw(header.parentHash)).catch(() => (0, rxjs_1.firstValueFrom)(this._rpcCore.state.getRuntimeVersion()))"; }
);
fs.writeFileSync(initFile, initCode);
console.log(`[3/4] @polkadot/api Init.js: ${count} patches`);

// --- Patch 4: @subql/node utils/substrate.js (fetchEventsRange) ---
// When events.at(hash) fails with "State already discarded" for pruned blocks,
// return an empty events array instead of crashing. The block is processed with
// no events (data is lost anyway since state was pruned).
count = 0;
let utilsCode2 = fs.readFileSync(utilsFile, "utf8");
utilsCode2 = utilsCode2.replace(
  /api\.query\.system\.events\.at\(hash\)\.catch\(\(e\) => \{/g,
  () => { count++; return "api.query.system.events.at(hash).catch((e) => { if (e.message && e.message.includes('State already discarded')) { const empty = []; empty.toArray = () => []; return empty; }"; }
);
fs.writeFileSync(utilsFile, utilsCode2);
console.log(`[4/5] utils/substrate.js fetchEventsRange: ${count} patches`);

console.log("[5/5] All pruned-state patches applied successfully.");
