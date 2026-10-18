// node --test noter/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsReconfirmation, DEFAULT_CONFIRM_EVERY_BLOCKS } from '../confirm.js';

const EVERY = DEFAULT_CONFIRM_EVERY_BLOCKS;
const steady = {
  supported: true, changed: false, pending: false, queryFailed: false,
  recordedStake: 500n, lastConfirmedAt: 1_000, currentBlock: 1_000 + EVERY, everyBlocks: EVERY,
};

test('unchanged stake is confirmed again once the last confirmation is old enough', () => {
  assert.equal(needsReconfirmation(steady), true);
});

test('not before then: every submission restarts the dispute window', () => {
  assert.equal(needsReconfirmation({ ...steady, currentBlock: 1_000 + EVERY - 1 }), false);
});

test('never while a submission is still pending', () => {
  assert.equal(needsReconfirmation({ ...steady, pending: true }), false);
});

test('a change is submitted as a change, not as a confirmation', () => {
  assert.equal(needsReconfirmation({ ...steady, changed: true }), false);
});

test('half-read data is not confirmed', () => {
  assert.equal(needsReconfirmation({ ...steady, queryFailed: true }), false);
});

test('there is nothing to confirm without a recorded stake', () => {
  assert.equal(needsReconfirmation({ ...steady, recordedStake: null }), false);
  assert.equal(needsReconfirmation({ ...steady, recordedStake: 0n }), false);
});

test('stake recorded before the chain kept confirmations is confirmed', () => {
  assert.equal(needsReconfirmation({ ...steady, lastConfirmedAt: null, currentBlock: 5 }), true);
});

test('a chain that keeps no confirmations is left alone', () => {
  assert.equal(needsReconfirmation({ ...steady, supported: false }), false);
});

test('the default leaves several tries inside the fourteen-day allowance', () => {
  const allowance = 14 * 24 * 600;
  assert.ok(allowance / EVERY >= 4);
});
