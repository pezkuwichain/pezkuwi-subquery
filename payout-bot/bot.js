#!/usr/bin/env node
/**
 * Pezkuwi Auto-Payout Bot
 *
 * Periodically calls staking.payoutStakersByPage for all validators
 * in completed eras that haven't been claimed yet.
 *
 * Environment:
 *   ASSET_HUB_RPC  - WebSocket RPC endpoint (default: wss://asset-hub-rpc.pezkuwichain.io)
 *   MNEMONIC_FILE  - Path to file containing the payer mnemonic
 *   INTERVAL_MS    - Check interval in ms (default: 600000 = 10 min)
 */

const { ApiPromise, WsProvider, Keyring } = require("@pezkuwi/api");
const fs = require("fs");

const RPC = process.env.ASSET_HUB_RPC || "wss://asset-hub-rpc.pezkuwichain.io";
const MNEMONIC_FILE = process.env.MNEMONIC_FILE || "/run/secrets/payout_mnemonic";
const INTERVAL = parseInt(process.env.INTERVAL_MS || "600000", 10);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const mnemonic = fs.readFileSync(MNEMONIC_FILE, "utf8").trim();
  const kr = new Keyring({ type: "sr25519", ss58Format: 42 });
  const pair = kr.addFromMnemonic(mnemonic);
  log(`Payer account: ${pair.address}`);

  let api;

  async function connect() {
    if (api && api.isConnected) return;
    log(`Connecting to ${RPC}...`);
    api = await ApiPromise.create({
      provider: new WsProvider(RPC, 5000),
      noInitWarn: true,
    });
    log("Connected");
  }

  async function runPayouts() {
    await connect();

    const activeEraOpt = await api.query.staking.activeEra();
    if (activeEraOpt.isNone) {
      log("No active era found");
      return;
    }
    const activeEra = activeEraOpt.unwrap().index.toNumber();

    const validators = await api.query.staking.validators.entries();
    const valAddrs = validators.map(([k]) => k.args[0].toString());

    let totalSent = 0;
    let nonce = (await api.rpc.system.accountNextIndex(pair.address)).toNumber();

    // Check all completed eras (activeEra is current, so 0..activeEra-1 are complete)
    for (let era = Math.max(0, activeEra - 84); era < activeEra; era++) {
      const eraReward = await api.query.staking.erasValidatorReward(era);
      if (eraReward.isNone) continue;

      for (const addr of valAddrs) {
        // Check if validator had exposure in this era
        const overview = await api.query.staking.erasStakersOverview(era, addr);
        if (overview.isNone || overview.toJSON() === null) continue;

        const pageCount = overview.unwrap().pageCount.toNumber();

        // Check each page
        for (let page = 0; page < pageCount; page++) {
          const claimed = await api.query.staking.claimedRewards(era, addr);
          const claimedPages = claimed.toJSON();
          if (claimedPages.includes(page)) continue;

          // Unclaimed page — send payout
          try {
            const tx = api.tx.staking.payoutStakersByPage(addr, era, page);
            await tx.signAndSend(pair, { nonce: nonce++ });
            totalSent++;
            log(
              `Payout: era=${era} validator=${addr.substring(0, 16)}... page=${page}`
            );
          } catch (e) {
            log(`Error: era=${era} ${addr.substring(0, 16)}... page=${page}: ${e.message}`);
            // Refresh nonce on error
            nonce = (
              await api.rpc.system.accountNextIndex(pair.address)
            ).toNumber();
          }
        }
      }
    }

    if (totalSent > 0) {
      log(`Sent ${totalSent} payouts for era(s) up to ${activeEra - 1}`);
    } else {
      log(`All eras claimed (active era: ${activeEra})`);
    }
  }

  // Initial run
  try {
    await runPayouts();
  } catch (e) {
    log(`Error in initial run: ${e.message}`);
  }

  // Periodic runs
  setInterval(async () => {
    try {
      await runPayouts();
    } catch (e) {
      log(`Error: ${e.message}`);
      // Force reconnect on next run
      try {
        await api.disconnect();
      } catch (_) {}
      api = null;
    }
  }, INTERVAL);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
