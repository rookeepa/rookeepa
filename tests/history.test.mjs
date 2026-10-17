import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDescription, similarity, suggestAccount } from '../app/core/history.js';

/*
 * Suggestions from history.
 *
 * The cases that matter are the two ways this can be useless. Suggest nothing, and it does nothing for a
 * fresh import — which is the whole reason for it. Suggest too readily, and every line in the file gets
 * an account because they all share "LTD" or the name of the city, which is worse than nothing because
 * it looks like work already done.
 */

const line = (date, description, categoryAccount, extra = {}) => ({
  id: `t_${date}_${description.slice(0, 6)}`, date, description, categoryAccount, companyId: 'c1',
  accountCode: '1-0000', amount: -1000, status: 'posted', ...extra,
});

test('the parts that change every time are dropped, so the same shop is the same shop', () => {
  assert.equal(normaliseDescription('WOOLWORTHS 1234 SYDNEY'), 'WOOLWORTHS SYDNEY');
  assert.equal(normaliseDescription('Woolworths  5678  Sydney'), 'WOOLWORTHS SYDNEY');
  assert.equal(normaliseDescription('EFTPOS 12/10 VISA WOOLWORTHS METRO 004'), 'EFTPOS VISA WOOLWORTHS METRO');
  assert.equal(normaliseDescription(''), '');
  assert.equal(normaliseDescription(null), '');
});

test('a card number changing between two payments does not stop them matching', () => {
  const history = [line('2026-09-01', 'WOOLWORTHS 1234 SYDNEY', '6-0100')];
  const got = suggestAccount(history, 'WOOLWORTHS 5678 SYDNEY');
  assert.equal(got.accountCode, '6-0100');
  assert.equal(got.count, 1);
  assert.equal(got.lastDate, '2026-09-01');
});

test('the most recent similar line decides, not the best-scoring older one', () => {
  const history = [
    line('2023-01-05', 'ACME CONTRACTORS PTY LTD INVOICE', '6-0700'),
    line('2026-10-01', 'ACME CONTRACTORS INVOICE', '6-1000'),
  ];
  const got = suggestAccount(history, 'ACME CONTRACTORS INVOICE 9921');
  assert.equal(got.accountCode, '6-1000', 'last time is the answer, not the tidiest match');
  assert.equal(got.lastDate, '2026-10-01');
});

test('a word every line shares is not enough to match on', () => {
  const history = [line('2026-09-01', 'SMITH PTY LTD', '6-0100')];
  // LTD and PTY are three characters, so neither counts at all — two different companies share nothing.
  assert.equal(similarity('JONES PTY LTD', 'SMITH PTY LTD'), 0);
  assert.equal(suggestAccount(history, 'JONES PTY LTD'), null, 'so there is no suggestion to make');
  // And something shared that is long enough but says nothing about the merchant does not carry a match.
  const mixed = [line('2026-09-01', 'SYDNEY STORAGE', '6-0100')];
  assert.equal(suggestAccount(mixed, 'SYDNEY WATER').score, 0.5, 'one word in common out of two');
  assert.equal(suggestAccount(mixed, 'SYDNEY WATER', { minScore: 0.75 }), null, 'a stricter caller gets nothing');
  // And a suburb on its own does not carry a match either.
  const sydney = [line('2026-09-01', 'SYDNEY', '6-0100')];
  assert.equal(suggestAccount(sydney, 'PARRAMATTA'), null);
});

test('a genuinely new supplier gets no suggestion, so the caller keeps its own default', () => {
  const history = [line('2026-09-01', 'WOOLWORTHS METRO', '6-0100')];
  assert.equal(suggestAccount(history, 'NORTHSIDE PHYSIOTHERAPY'), null);
  assert.equal(suggestAccount([], 'WOOLWORTHS METRO'), null);
  assert.equal(suggestAccount(history, ''), null, 'and a line with no description suggests nothing');
});

test('lines that were never coded carry no answer', () => {
  const history = [
    line('2026-10-01', 'WOOLWORTHS METRO', null),
    line('2026-10-02', 'WOOLWORTHS METRO', ''),
  ];
  assert.equal(suggestAccount(history, 'WOOLWORTHS METRO'), null);
});

test('the count and examples are the evidence, so a suggestion can be judged', () => {
  const history = [
    line('2026-08-01', 'WOOLWORTHS 1111 SYDNEY', '6-0100'),
    line('2026-09-01', 'WOOLWORTHS 2222 SYDNEY', '6-0100'),
    line('2026-10-01', 'WOOLWORTHS 3333 SYDNEY', '6-0100'),
    line('2026-10-02', 'WOOLWORTHS 4444 SYDNEY', '6-0700'),
  ];
  const got = suggestAccount(history, 'WOOLWORTHS 5555 SYDNEY');
  assert.equal(got.accountCode, '6-0700', 'the last one coded is the answer');
  assert.equal(got.count, 1, 'and the evidence counts the lines that agree with it, not all similar lines');
  assert.deepEqual(got.examples, ['WOOLWORTHS 4444 SYDNEY']);
});

test('it is pure: the same input gives the same answer and nothing is touched', () => {
  const history = [line('2026-10-01', 'WOOLWORTHS 3333 SYDNEY', '6-0100')];
  const before = JSON.stringify(history);
  const first = suggestAccount(history, 'WOOLWORTHS 9999 SYDNEY');
  const second = suggestAccount(history, 'WOOLWORTHS 9999 SYDNEY');
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(history), before, 'the history is read, never written');
});
