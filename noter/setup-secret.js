#!/usr/bin/env node
/**
 * Extract noter mnemonic from validator wallet file and write to Docker secrets location.
 * Usage: node setup-secret.js /path/to/MAINNET_WALLETS.json [ValidatorNumber]
 *
 * Default: Validator_01_Stash (first validator with Noter tiki)
 */

import fs from 'fs';
import path from 'path';

const walletFile = process.argv[2] || '/home/mamostehp/res/MAINNET_WALLETS_20260128_235407.json';
const validatorNum = process.argv[3] || '01';
const targetName = `Validator_${validatorNum.padStart(2, '0')}_Stash`;

const secretDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'secrets');
const secretFile = path.join(secretDir, 'noter_mnemonic.txt');

try {
  const data = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
  const wallet = data.wallets.find(w => w.name === targetName);

  if (!wallet || !wallet.seed_phrase) {
    console.error(`ERROR: ${targetName} not found in ${walletFile}`);
    process.exit(1);
  }

  // Create secrets directory if it doesn't exist
  if (!fs.existsSync(secretDir)) {
    fs.mkdirSync(secretDir, { mode: 0o700 });
  }

  // Write mnemonic
  fs.writeFileSync(secretFile, wallet.seed_phrase + '\n', { mode: 0o600 });

  console.log(`Noter secret written successfully.`);
  console.log(`  Account: ${targetName}`);
  console.log(`  Address: ${wallet.ss58_address}`);
  console.log(`  File: ${secretFile}`);
  console.log(`  Permissions: 0600`);
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
