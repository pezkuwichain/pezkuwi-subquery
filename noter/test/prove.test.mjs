// node --test noter/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringToU8a } from '@pezkuwi/util';
import { poolBondedAccount } from '../prove.js';

// The People chain derives the same account (`hub_proof::pool_bonded_account`); pool 10 on
// Zagros, read off the live chain on 2026-10-28.
test('a pool bonded account is derived as the hub derives it', () => {
  const zagrosPool10 = [
    109, 111, 100, 108, 112, 121, 47, 110, 111, 112, 108, 115, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  assert.deepEqual(Array.from(poolBondedAccount(stringToU8a('py/nopls'), 10)), zagrosPool10);
});
