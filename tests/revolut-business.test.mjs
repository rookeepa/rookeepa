import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBankStatement } from '../app/core/csv.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (name) => readFileSync(join(here, '..', 'docs', 'samples', name), 'utf8');

/*
 * A Revolut Business export, kept as a sample file rather than inline text so it can be read the
 * way a user's own export arrives: 19 columns, timestamps rather than dates, a separate fee, and
 * two amount columns.
 *
 * The trap is the pair "Orig amount" and "Amount". The first is the amount in the original
 * currency and is *unsigned*; the second is signed and says which way the money went. Matching
 * the wrong one read a card payment as money in — turning spending into income, silently, on
 * every import. Both columns are present here on purpose.
 */

test('a Revolut Business export imports the signed amount, not the original currency', () => {
  const out = parseBankStatement(sample('revolut-business.csv'));

  assert.notEqual(out.unrecognised, true, 'the file is recognised');
  assert.equal(out.headerRow, 0);
  assert.equal(out.rows.length, 3, 'every completed row is read');
  assert.equal(out.skipped.length, 0, 'and none is skipped');

  assert.equal(out.columns.amount, 11, 'the amount comes from "Amount", not "Orig amount"');
  assert.equal(out.columns.balance, 13);

  // Money out is negative: this is the assertion that fails if the wrong column wins.
  assert.equal(out.rows[0].amount, -4210, 'a card payment is money out');
  assert.equal(out.rows[1].amount, 121000, 'an incoming transfer is money in');
  assert.equal(out.rows[2].amount, -1500, 'and so is a fee');

  assert.equal(out.rows[0].date, '2026-09-28', 'the timestamp becomes a date');
  assert.equal(out.rows[0].description, 'Tesco Stores 3421');
  assert.equal(out.rows[0].balance, 395790, 'the running balance is kept');
});
