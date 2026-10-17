import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toCents, formatCents, formatPlain, formatRaw, formatQty, mulRate, mulQty, splitInclusive, gstOf, sum,
} from '../app/core/money.js';

test('toCents reads the formats people and banks actually produce', () => {
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('$1,234.56'), 123456);
  assert.equal(toCents('1234.56'), 123456);
  assert.equal(toCents('1.234,56'), 123456); // European grouping
  assert.equal(toCents('(1,234.56)'), -123456); // accounting negative
  assert.equal(toCents('1234.56-'), -123456); // trailing minus
  assert.equal(toCents('-0.01'), -1);
  assert.equal(toCents('1,234'), 123400); // thousands, not a decimal
  assert.equal(toCents('1.239'), 123900); // ambiguous: a 3-digit group is read as thousands
  assert.equal(toCents('1.2399'), 124); // no valid group: read as a decimal and round
  assert.equal(toCents('12.3456'), 1235);
  assert.equal(toCents(12.5), 1250);
  assert.equal(toCents(''), 0);
  assert.equal(toCents(null), 0);
  assert.equal(toCents('0.005'), 1);
  assert.equal(toCents('abc'), 0);
});

test('mulRate rounds half-up away from zero', () => {
  assert.equal(mulRate(10000, 1000), 1000); // $100 + 10%
  assert.equal(mulRate(5, 1000), 1); // half a cent rounds up
  assert.equal(mulRate(4, 1000), 0); // less than half rounds down
  assert.equal(mulRate(1, 1000), 0);
  assert.equal(mulRate(-5, 1000), -1);
  assert.equal(mulRate(123456, 1250), 15432); // 12.5% discount
});

test('mulQty multiplies a thousandths quantity by a cent price', () => {
  assert.equal(mulQty(1500, 10000), 15000); // 1.5 x $100.00
  assert.equal(mulQty(1000, 3995), 3995);
  assert.equal(mulQty(12000, 3995), 47940); // 12 x $39.95
  assert.equal(mulQty(-1000, 100), -100);
});

test('splitInclusive never loses or invents a cent', () => {
  for (const inc of [11000, 100, 999, 1, 123456789, 7]) {
    const { ex, gst } = splitInclusive(inc, { gstBps: 1000 });
    assert.equal(ex + gst, inc, `split of ${inc} must add back up`);
  }
  assert.deepEqual(splitInclusive(11000, { gstBps: 1000 }), { ex: 10000, gst: 1000 });
  assert.deepEqual(splitInclusive(100, { gstBps: 0 }), { ex: 100, gst: 0 });
});

test('gstOf applies the tax code rate', () => {
  assert.equal(gstOf(100000, { gstBps: 1000 }), 10000);
  assert.equal(gstOf(100000, { gstBps: 0 }), 0);
  assert.equal(gstOf(100000, null), 0);
});

test('formatting is stable and accountant-friendly', () => {
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(-123456), '-$1,234.56');
  assert.equal(formatCents(-123456, { parens: true }), '($1,234.56)');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(123456, { symbol: false }), '1,234.56');
  assert.equal(formatPlain(123456), '1,234.56');
  assert.equal(formatRaw(123456), '1234.56');
  assert.equal(formatRaw(-5), '-0.05');
  assert.equal(formatQty(1500), '1.5');
  assert.equal(formatQty(1000), '1');
  assert.equal(formatQty(1234), '1.234');
});

test('round-tripping through toCents is lossless', () => {
  for (const cents of [0, 1, -1, 99, 100, 123456, -987654321]) {
    assert.equal(toCents(formatRaw(cents)), cents);
    assert.equal(toCents(formatPlain(cents)), cents);
  }
});

test('sum handles empty lists and cents', () => {
  assert.equal(sum([]), 0);
  assert.equal(sum([1, 2, 3]), 6);
});
