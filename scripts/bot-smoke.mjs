// Runs from a bot's directory (in its image: mounted at /app/bot-smoke.mjs) and fails unless the
// installed crypto stack is the one package-lock.json records and can sign and
// verify with every key type. A stack that only loads is not enough: the broken
// @pezkuwi/wasm-crypto 7.5.17 loaded fine and failed at ed25519 and ecdsa.
//
//   node bot-smoke.mjs <esm|cjs|indexer>
//
// indexer: the subql-node image, which loads @pezkuwi through @polkadot aliases
// (CommonJS); the aliases are checked against the lock too.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;

function check (name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

  if (!ok) {
    failed++;
  }
}

const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));

const scope = mode === 'indexer' ? '@polkadot' : '@pezkuwi';
const locked = ['@pezkuwi/wasm-crypto', '@pezkuwi/util-crypto', '@pezkuwi/api', '@pezkuwi/keyring'];

if (mode === 'indexer') {
  locked.push('@polkadot/wasm-crypto', '@polkadot/util-crypto', '@polkadot/api', '@polkadot/keyring');
}

for (const name of locked) {
  const want = lock.packages[`node_modules/${name}`]?.version;
  const have = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version;

  check(`${name} is the locked version`, !!want && want === have, `lock ${want}, installed ${have}`);
}

// Load the stack the way the image does: the noter is an ES module, the payout
// bot and subql-node are CommonJS.
const load = (name) => mode === 'esm' ? import(`${scope}/${name}`) : require(`${scope}/${name}`);
const { Keyring } = await load('api');
const { cryptoWaitReady, mnemonicGenerate } = await load('util-crypto');

check('crypto initialises', await cryptoWaitReady());

try {
  check('a mnemonic can be generated', mnemonicGenerate().split(' ').length === 12);
} catch (error) {
  check('a mnemonic can be generated', false, error.message);
}

// Derived from the public development phrase, so the check needs no secret
// and does not depend on mnemonic generation working.
const message = new TextEncoder().encode('pezkuwi bot smoke');

for (const type of ['sr25519', 'ed25519', 'ecdsa']) {
  try {
    const pair = new Keyring({ type }).addFromUri('//Smoke');
    const signature = pair.sign(message);

    check(`${type} signs and verifies`, pair.verify(message, signature, pair.publicKey));
    check(`${type} rejects a tampered message`, !pair.verify(new TextEncoder().encode('tampered'), signature, pair.publicKey));
  } catch (error) {
    check(`${type} signs and verifies`, false, error.message);
  }
}

console.log(failed ? `FAILED: ${failed}` : `all ${mode} smoke checks passed`);
process.exit(failed ? 1 : 0);
