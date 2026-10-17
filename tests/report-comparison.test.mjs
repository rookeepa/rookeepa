/**
 * Comparing a report against another period.
 *
 * The comparison is only useful if the periods line up, so these tests pin the ranges
 * (including the leap-day case, where "a year earlier" has to clamp rather than slide into
 * March) and the meaning of a variance: how much, which way, and whether that is good news.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonPeriod, varianceOf } from '../app/core/reports.js';
import { addYears, daysBetween } from '../app/core/dates.js';

test('a comparison period is the stretch before, or the same dates a year earlier', () => {
  const prev = comparisonPeriod({ from: '2026-08-01', to: '2026-08-31', mode: 'prev' });
  assert.equal(prev.from, '2026-07-01');
  assert.equal(prev.to, '2026-07-31');
  assert.equal(
    daysBetween(prev.from, prev.to) + 1,
    daysBetween('2026-08-01', '2026-08-31') + 1,
    'the previous period is the same length as the one it compares against',
  );

  const lastYear = comparisonPeriod({ from: '2026-08-01', to: '2026-08-31', mode: 'last-year' });
  assert.equal(lastYear.from, '2025-08-01');
  assert.equal(lastYear.to, '2025-08-31');

  assert.equal(comparisonPeriod({ from: '2026-08-01', to: '2026-08-31', mode: 'none' }), null);
  assert.equal(comparisonPeriod({ from: '2026-08-01', to: '2026-08-31', mode: null }), null);
});

test('a single day compares against the day before, not a whole month', () => {
  const prev = comparisonPeriod({ from: '2026-08-15', to: '2026-08-15', mode: 'prev' });
  assert.equal(prev.from, '2026-08-14');
  assert.equal(prev.to, '2026-08-14');
});

test('a leap day compares against 28 February, not 1 March', () => {
  assert.equal(addYears('2028-02-29', -1), '2027-02-28');
  assert.equal(addYears('2028-02-29', 1), '2029-02-28');
  assert.equal(addYears('2026-02-28', 1), '2027-02-28');
  assert.equal(addYears('2026-12-31', 1), '2027-12-31', 'an ordinary date is untouched');

  const period = comparisonPeriod({ from: '2028-02-01', to: '2028-02-29', mode: 'last-year' });
  assert.equal(period.from, '2027-02-01');
  assert.equal(period.to, '2027-02-28', 'February 2027 has no 29th');
});

test('the variance says how much, which way, and whether that is good news', () => {
  const moreIncome = varianceOf(120000, 100000, 'income');
  assert.equal(moreIncome.change, 20000);
  assert.equal(moreIncome.pct, 20);
  assert.equal(moreIncome.up, true);
  assert.equal(moreIncome.favourable, true, 'earning more is good news');

  const moreExpense = varianceOf(120000, 100000, 'expense');
  assert.equal(moreExpense.change, 20000);
  assert.equal(moreExpense.up, true);
  assert.equal(moreExpense.favourable, false, 'spending more is not');

  const lessIncome = varianceOf(50000, 100000, 'income');
  assert.equal(lessIncome.pct, -50);
  assert.equal(lessIncome.favourable, false);

  const lessExpense = varianceOf(50000, 100000, 'expense');
  assert.equal(lessExpense.favourable, true, 'spending less is good news');

  const noMovement = varianceOf(100000, 100000, 'income');
  assert.equal(noMovement.change, 0);
  assert.equal(noMovement.pct, 0);
  assert.equal(noMovement.favourable, null, 'no movement is neither good nor bad');

  assert.equal(varianceOf(100, null, 'income'), null, 'there is nothing to compare against');
  assert.equal(varianceOf(100, undefined, 'income'), null);
});

test('a change from nothing has no percentage rather than an invented one', () => {
  const fromZero = varianceOf(50000, 0, 'income');
  assert.equal(fromZero.change, 50000);
  assert.equal(fromZero.pct, null, 'dividing by a zero base would be meaningless');
  assert.equal(fromZero.favourable, true, 'but the direction is still known');
  assert.equal(varianceOf(0, 0, 'expense').favourable, null);
});

test('the percentage is measured against the size of the base, not its sign', () => {
  // A negative base — a loss, or a credit balance — must not flip the meaning.
  const recovering = varianceOf(-50000, -100000, 'income');
  assert.equal(recovering.change, 50000);
  assert.equal(recovering.pct, 50, 'half the loss recovered reads as +50%');
  assert.equal(recovering.favourable, true, 'and that is progress');

  const worsening = varianceOf(-150000, -100000, 'income');
  assert.equal(worsening.pct, -50);
  assert.equal(worsening.favourable, false);
});
