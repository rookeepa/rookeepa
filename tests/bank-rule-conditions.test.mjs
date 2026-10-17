import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blankBankRule, ruleMatches, matchRule, ruleConditions, conditionMatches,
} from '../app/core/bank-rules.js';

/*
 * Rules with more than one condition, and with an amount bracket.
 *
 * The first test is the one that matters most: rules saved before any of this existed have a single
 * `match`/`text` pair and no condition list, and they are people's saved work. Reading them as one
 * description condition keeps every one of them matching exactly as it did, without rewriting
 * anything on disk.
 */

const txn = (description, amount, reference = '') => ({ description, amount, reference });

test('a rule saved in the old single-condition shape matches exactly as it did', () => {
  const legacy = { id: 'r1', name: 'Old', match: 'contains', text: 'amazon', direction: 'out', active: true };
  assert.equal(ruleMatches(legacy, txn('AMAZON MARKETPLACE', -4500)), true);
  assert.equal(ruleMatches(legacy, txn('AMAZON MARKETPLACE', 4500)), false, 'direction still applies');
  assert.equal(ruleMatches({ ...legacy, match: 'equals' }, txn('AMAZON MARKETPLACE', -4500)), false);
  assert.equal(ruleMatches({ ...legacy, match: 'equals' }, txn('Amazon', -4500)), true, 'case-insensitive');

  // And it is read as one description condition rather than being migrated.
  assert.deepEqual(ruleConditions(legacy), [{ field: 'description', match: 'contains', text: 'amazon' }]);
});

test('with combine "all", every condition has to match', () => {
  const rule = blankBankRule({
    name: 'Amazon over $50',
    direction: 'out',
    combine: 'all',
    conditions: [
      { field: 'description', match: 'contains', text: 'amazon' },
      { field: 'amount', match: 'more-than', cents: 5000 },
    ],
  });
  assert.equal(ruleMatches(rule, txn('AMAZON MARKETPLACE', -6000)), true);
  assert.equal(ruleMatches(rule, txn('AMAZON MARKETPLACE', -4000)), false, 'too small');
  assert.equal(ruleMatches(rule, txn('EBAY', -6000)), false, 'wrong merchant');
});

test('with combine "any", one matching condition is enough', () => {
  const rule = blankBankRule({
    name: 'Amazon or eBay',
    combine: 'any',
    conditions: [
      { field: 'description', match: 'contains', text: 'amazon' },
      { field: 'description', match: 'contains', text: 'ebay' },
    ],
  });
  assert.equal(ruleMatches(rule, txn('AMAZON MARKETPLACE', -1000)), true);
  assert.equal(ruleMatches(rule, txn('EBAY AUSTRALIA', -1000)), true);
  assert.equal(ruleMatches(rule, txn('ETSY', -1000)), false);
});

test('an amount bracket is about size, and the direction decides which way the money went', () => {
  const over = blankBankRule({ name: 'Over $50', conditions: [{ field: 'amount', match: 'more-than', cents: 5000 }] });
  assert.equal(ruleMatches(over, txn('X', -6000)), true, 'spent $60');
  assert.equal(ruleMatches(over, txn('X', 6000)), true, 'received $60 — size, not sign');
  assert.equal(ruleMatches(over, txn('X', -4000)), false);
  assert.equal(ruleMatches(over, txn('X', -5000)), false, 'exactly the bracket is not over it');

  const outOnly = { ...over, direction: 'out' };
  assert.equal(ruleMatches(outOnly, txn('X', -6000)), true);
  assert.equal(ruleMatches(outOnly, txn('X', 6000)), false, 'direction is what separates in from out');

  const between = blankBankRule({ conditions: [{ field: 'amount', match: 'between', cents: 2000, centsTo: 5000 }] });
  assert.equal(ruleMatches(between, txn('X', -3000)), true);
  assert.equal(ruleMatches(between, txn('X', -2000)), true, 'the bracket includes its ends');
  assert.equal(ruleMatches(between, txn('X', -5000)), true);
  assert.equal(ruleMatches(between, txn('X', -1999)), false);
  assert.equal(ruleMatches(between, txn('X', -5001)), false);
  // Ends given the wrong way round are still a bracket, not an empty range.
  const reversed = blankBankRule({ conditions: [{ field: 'amount', match: 'between', cents: 5000, centsTo: 2000 }] });
  assert.equal(ruleMatches(reversed, txn('X', -3000)), true);
});

test('a condition can read the reference instead of the description', () => {
  const rule = blankBankRule({ conditions: [{ field: 'reference', match: 'starts-with', text: 'inv-' }] });
  assert.equal(ruleMatches(rule, txn('Payment', -1000, 'INV-1042')), true);
  assert.equal(ruleMatches(rule, txn('INV-1042 in the description', -1000, '')), false);
});

test('a rule with no usable condition matches nothing, whatever its shape', () => {
  assert.equal(ruleMatches(blankBankRule({ name: 'Empty' }), txn('Anything', -1000)), false);
  assert.equal(ruleMatches(blankBankRule({ conditions: [] }), txn('Anything', -1000)), false);
  assert.equal(ruleMatches(blankBankRule({ conditions: [{ field: 'description', match: 'contains', text: '' }] }), txn('Anything', -1000)), false);
  assert.equal(ruleMatches({ ...blankBankRule({ text: '' }) }, txn('Anything', -1000)), false);
  assert.equal(ruleMatches(blankBankRule({ name: 'Paused', conditions: [{ field: 'description', match: 'contains', text: 'x' }], active: false }), txn('x', -1)), false);
});

test('an amount condition counts as specific, so it is not overridden by a broad rule', () => {
  const broad = blankBankRule({ name: 'Anything with fee', conditions: [{ field: 'description', match: 'contains', text: 'fee' }] });
  // A bracket with both ends at $9.95 is "is exactly $9.95" — there is no separate equals-amount mode,
  // because a bracket covers it and one fewer mode is one fewer thing to get wrong.
  const precise = blankBankRule({
    name: 'The $9.95 fee',
    conditions: [
      { field: 'amount', match: 'between', cents: 995, centsTo: 995 },
      { field: 'description', match: 'contains', text: 'fee' },
    ],
  });
  assert.equal(ruleMatches(broad, txn('MONTHLY FEE', -995)), true);
  assert.equal(matchRule([broad, precise], txn('MONTHLY FEE', -995)).name, 'The $9.95 fee');
  assert.equal(matchRule([broad, precise], txn('MONTHLY FEE', -1200)).name, 'Anything with fee');
});

test('a text match aimed at the amount field matches nothing, rather than reading the description', () => {
  // Mis-built conditions must fail closed. Reading the description instead would file lines the rule
  // never described.
  const muddled = blankBankRule({ conditions: [{ field: 'amount', match: 'contains', text: 'amazon' }] });
  assert.equal(ruleMatches(muddled, txn('AMAZON MARKETPLACE', -4500)), false);
  assert.equal(conditionMatches({ field: 'amount', match: 'contains', text: 'amazon' }, txn('AMAZON MARKETPLACE', -4500)), false);
});

test('one condition is enough for a rule built in the new shape', () => {
  const rule = blankBankRule({ conditions: [{ field: 'description', match: 'contains', text: 'spotify' }] });
  assert.equal(ruleMatches(rule, txn('SPOTIFY P1234', -1699)), true);
  assert.equal(conditionMatches(rule.conditions[0], txn('SPOTIFY P1234', -1699)), true);
});
