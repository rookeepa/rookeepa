import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATE_PRESETS, NON_RANGE_PRESETS, presetRange, canonicalPreset, presetLabel, matchPreset,
} from '../app/core/periods.js';
import { parseISO } from '../app/core/dates.js';

/*
 * The named date ranges.
 *
 * The cases worth pinning are the boundaries: the day a financial year turns over, the last day of a
 * quarter, a week at the end of a month, and a business whose year does not start in July. Everything
 * else is the same arithmetic on a quieter day.
 *
 * The last test is the one that guards the point of this module: every preset offered to a person has
 * to compute. A key with no case behind it silently returns null, which on screen is an empty report
 * and no explanation.
 */

const opts = (asOf, fyStartMonth) => ({ asOf, fyStartMonth });
const r = (key, asOf, fyStartMonth = 7) => presetRange(key, opts(asOf, fyStartMonth));

test('the financial year turns over on 1 July, not on 30 June', () => {
  assert.deepEqual(r('this-fy', '2026-06-30'), { from: '2025-07-01', to: '2026-06-30' });
  assert.deepEqual(r('this-fy', '2026-07-01'), { from: '2026-07-01', to: '2027-06-30' });
  assert.deepEqual(r('this-fy', '2026-10-15'), { from: '2026-07-01', to: '2027-06-30' });
});

test('last financial year is the whole year before the current one', () => {
  assert.deepEqual(r('last-fy', '2026-10-15'), { from: '2025-07-01', to: '2026-06-30' });
  // From inside a financial year, one day into it, and on its last day — all the same answer.
  assert.deepEqual(r('last-fy', '2026-07-01'), { from: '2025-07-01', to: '2026-06-30' });
  // On 30 June the current year has not ended yet, so "last" is still the one before it.
  assert.deepEqual(r('last-fy', '2027-06-30'), { from: '2025-07-01', to: '2026-06-30' });
  // The next day it has, and last year is the year that just finished.
  assert.deepEqual(r('last-fy', '2027-07-01'), { from: '2026-07-01', to: '2027-06-30' });
});

test("a business whose year starts in January gets January, not July", () => {
  assert.deepEqual(r('this-fy', '2026-05-20', 1), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(r('last-fy', '2026-05-20', 1), { from: '2025-01-01', to: '2025-12-31' });
  // And a financial year starting in April, which is neither.
  assert.deepEqual(r('this-fy', '2026-05-20', 4), { from: '2026-04-01', to: '2027-03-31' });
});

test('quarters are calendar quarters, and last quarter steps back over the year', () => {
  assert.deepEqual(r('this-quarter', '2026-02-10'), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(r('this-quarter', '2026-11-20'), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(r('this-quarter', '2026-03-31'), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(r('this-quarter', '2026-04-01'), { from: '2026-04-01', to: '2026-06-30' });
  assert.deepEqual(r('last-quarter', '2026-02-10'), { from: '2025-10-01', to: '2025-12-31' });
});

test('a week runs Monday to Sunday, seven days inclusive', () => {
  const week = r('this-week', '2026-10-15');
  assert.equal(parseISO(week.from).getDay(), 1, 'starts on a Monday');
  assert.equal(parseISO(week.to).getDay(), 0, 'ends on a Sunday');
  const last = r('last-week', '2026-10-15');
  assert.equal(last.to < week.from, true, 'last week ends before this week starts');
  // Whatever day the week is asked about, it is the same week.
  for (const day of ['2026-10-12', '2026-10-15', '2026-10-18']) {
    assert.deepEqual(r('this-week', day), week, `same week from ${day}`);
  }
  assert.notDeepEqual(r('this-week', '2026-10-19'), week, 'and the next Monday is a new week');
});

test('months step back over a year boundary and end on the real last day', () => {
  assert.deepEqual(r('this-month', '2026-10-15'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r('last-month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(r('this-month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(r('last-month', '2027-03-15'), { from: '2027-02-01', to: '2027-02-28' });
  // March in a leap year has the 29th, and February before it has one too.
  assert.deepEqual(r('last-month', '2028-03-31'), { from: '2028-02-01', to: '2028-02-29' });
});

test('today, year to date, and the two that are not a range', () => {
  assert.deepEqual(r('today', '2026-10-15'), { from: '2026-10-15', to: '2026-10-15' });
  assert.deepEqual(r('ytd', '2026-10-15'), { from: '2026-07-01', to: '2026-10-15' });
  assert.deepEqual(r('all', '2026-10-15'), { from: null, to: null });
  assert.equal(r('custom', '2026-10-15'), null, 'custom is the screen\'s own two dates');
  assert.equal(r('nonsense', '2026-10-15'), null);
});

test('the old key names still resolve, so a remembered choice is not reset', () => {
  for (const [old, now] of [['month', 'this-month'], ['quarter', 'this-quarter'], ['fy', 'this-fy']]) {
    assert.equal(canonicalPreset(old), now);
    assert.deepEqual(r(old, '2026-10-15'), r(now, '2026-10-15'), `${old} means ${now}`);
  }
  assert.equal(canonicalPreset('this-week'), 'this-week', 'and a current key is left alone');
  assert.equal(presetLabel('fy'), 'This financial year');
});

test('every preset offered to a person computes a range', () => {
  for (const p of DATE_PRESETS) {
    const range = presetRange(p.value, opts('2026-10-15'));
    assert.ok(range, `${p.value} has no case behind it — it would show an empty report`);
    assert.match(range.from, /^\d{4}-\d{2}-\d{2}$/, `${p.value} from`);
    assert.match(range.to, /^\d{4}-\d{2}-\d{2}$/, `${p.value} to`);
    assert.ok(range.from <= range.to, `${p.value} must not end before it starts`);
  }
  for (const p of NON_RANGE_PRESETS) {
    assert.doesNotThrow(() => presetRange(p.value, opts('2026-10-15')), `${p.value} must not throw`);
  }
  // And the list has no duplicate keys, which would make one of them unreachable.
  const keys = DATE_PRESETS.concat(NON_RANGE_PRESETS).map((p) => p.value);
  assert.equal(new Set(keys).size, keys.length);
});

test('a pair of dates can be recognised back as a preset', () => {
  assert.equal(matchPreset('2026-07-01', '2027-06-30'), 'this-fy');
  assert.equal(matchPreset('2025-07-01', '2026-06-30'), 'last-fy');
  assert.equal(matchPreset('2026-01-01', '2026-01-31'), null, 'an arbitrary range is none of them');
  assert.equal(matchPreset(null, null), 'all');
});
