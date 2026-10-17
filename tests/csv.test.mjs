import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseCsv, toCsv, sniffDelimiter, parseLooseDate, detectBankColumns, parseBankStatement,
} from '../app/core/csv.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (name) => readFileSync(join(here, '..', 'docs', 'samples', name), 'utf8');

test('parseCsv handles quotes, commas inside quotes and a BOM', () => {
  const rows = parseCsv('\uFEFFa,b,c\r\n"x,1","he said ""hi""",3\r\n');
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['x,1', 'he said "hi"', '3']);
});

test('parseCsv sniffs the delimiter', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(sniffDelimiter('a,b,c\n1,2,3'), ',');
  const rows = parseCsv('a;b\n1;2');
  assert.deepEqual(rows[1], ['1', '2']);
});

test('parseCsv keeps blank trailing fields out of the way', () => {
  const rows = parseCsv('a,b\n1,\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '']]);
});

test('toCsv escapes what needs escaping', () => {
  const out = toCsv([['a', 'b,c'], ['quote "here"', 'line\nbreak']]);
  assert.equal(out, 'a,"b,c"\r\n"quote ""here""","line\nbreak"');
});

test('parseLooseDate reads the date formats banks actually use', () => {
  assert.equal(parseLooseDate('01/09/2026'), '2026-09-01'); // day first, Australian
  assert.equal(parseLooseDate('2026-09-01'), '2026-09-01');
  assert.equal(parseLooseDate('1 Sep 2026'), '2026-09-01');
  assert.equal(parseLooseDate('15/09/26'), '2026-09-15');
  assert.equal(parseLooseDate('09/15/2026'), '2026-09-15'); // unambiguous, month first
  assert.equal(parseLooseDate('2026/09/01'), '2026-09-01');
  assert.equal(parseLooseDate(''), null);
  assert.equal(parseLooseDate('not a date'), null);
});

test('detectBankColumns finds a signed-amount statement', () => {
  const rows = parseCsv(sample('bank-statement-signed-amount.csv'));
  const detected = detectBankColumns(rows);
  assert.equal(detected.cols.date, 0);
  assert.equal(detected.cols.description, 1);
  assert.equal(detected.cols.amount, 2);
  assert.equal(detected.cols.balance, 3);
});

test('detectBankColumns finds a separate debit/credit statement', () => {
  const rows = parseCsv(sample('bank-statement-debit-credit.csv'));
  const detected = detectBankColumns(rows);
  assert.equal(detected.cols.date, 0);
  assert.equal(detected.cols.debit, 2);
  assert.equal(detected.cols.credit, 3);
  assert.equal(detected.cols.balance, 4);
});

test('a signed-amount statement imports with the right signs', () => {
  const { rows, skipped } = parseBankStatement(sample('bank-statement-signed-amount.csv'));
  assert.equal(rows.length, 10);
  assert.equal(skipped.length, 0);
  assert.equal(rows[0].date, '2026-08-01');
  assert.equal(rows[0].amount, 99000);
  assert.equal(rows[1].amount, -220000);
  assert.equal(rows[0].description, 'DEPOSIT COASTAL YOGA STUDIO');
  assert.equal(rows[0].balance, 1533000);
});

test('a debit/credit statement imports with the right signs', () => {
  const { rows, skipped } = parseBankStatement(sample('bank-statement-debit-credit.csv'));
  assert.equal(rows.length, 15);
  assert.equal(skipped.length, 0);
  assert.equal(rows[0].amount, 192500, 'a credit column entry is money in');
  assert.equal(rows[1].amount, -200000, 'a debit column entry is money out');
  assert.equal(rows[0].date, '2026-09-01');
});

test('unreadable rows are skipped with a reason, not guessed at', () => {
  const text = [
    'Date,Description,Amount',
    '01/09/2026,Good row,-10.00',
    'rubbish,no date here,-5.00',
    '02/09/2026,No amount,',
    '03/09/2026,Zero,0.00',
  ].join('\n');
  const { rows, skipped } = parseBankStatement(text);
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 3);
  assert.ok(skipped.every((s) => s.reason));
  assert.ok(skipped.some((s) => /date/i.test(s.reason)));
  assert.ok(skipped.some((s) => /amount/i.test(s.reason)));
});

test('a statement with no recognisable header is refused rather than mangled', () => {
  const { rows, skipped, columns } = parseBankStatement('one,two,three\n1,2,3\n');
  assert.equal(columns, null);
  assert.equal(rows.length, 0);
});

test('European-style amounts in a statement are read correctly', () => {
  const text = 'Datum;Omschrijving;Bedrag\n01.09.2026;Huur;-1.234,56\n';
  const { rows } = parseBankStatement(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -123456);
});
