import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { blankBankTxn, categoriseBankTxn } from '../app/core/docs.js';
import { postedEntries } from '../app/core/ledger.js';

/*
 * Splitting one bank line across several accounts — the loan repayment.
 *
 * $1,000 leaves the account: $800 pays down the principal, $200 is interest. One line on the bank side,
 * two on the other, in a single entry. These tests are about the two things that make that safe: the
 * entry balances, and the splits have to add up to what left the bank before anything is posted.
 */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Splits Co' });
  const accounts = db.of('accounts', company.id);
  const bank = accounts.find((a) => a.code === (company.bankAccount || '1-0000'));
  const loan = accounts.find((a) => a.type === 'liability' && /loan/i.test(a.name))
    || accounts.find((a) => a.type === 'liability');
  const interest = accounts.find((a) => a.type === 'expense' && /interest|bank fee|finance/i.test(a.name))
    || accounts.find((a) => a.type === 'expense');
  const anything = accounts.find((a) => a.type === 'expense' && a.code !== interest.code);
  const taxCodes = db.of('taxCodes', company.id);
  return { db, company, bank, loan, interest, anything, taxCodes, gst: taxCodes.find((t) => t.code === 'GST') };
}

const totals = (entry) => entry.lines.reduce((a, l) => ({
  debit: a.debit + (l.debit || 0), credit: a.credit + (l.credit || 0),
}), { debit: 0, credit: 0 });

const lineFor = (entry, code) => entry.lines.find((l) => l.accountCode === code);

test('a loan repayment splits into principal and interest in one balanced entry', async () => {
  const f = await setup();
  const txn = blankBankTxn({
    companyId: f.company.id,
    accountCode: f.bank.code,
    date: '2026-10-05',
    description: 'LOAN REPAYMENT',
    amount: -100000,
    status: 'unreconciled',
    splits: [
      { accountCode: f.loan.code, taxCode: 'N-T', amount: 80000, note: 'Principal' },
      { accountCode: f.interest.code, taxCode: 'GST', amount: 20000, note: 'Interest' },
    ],
  });
  f.db.put('bankTxns', txn);
  const saved = categoriseBankTxn(f.db, f.db.get('bankTxns', txn.id));

  const entries = postedEntries(f.db.of('entries', f.company.id));
  assert.equal(entries.length, 1, 'one entry, not two');
  const entry = entries[0];
  const t = totals(entry);
  assert.equal(t.debit, 100000, 'debits equal what left the bank');
  assert.equal(t.credit, 100000, 'and so do credits — the entry balances');

  // The bank side is one line for the whole amount.
  assert.equal(lineFor(entry, f.bank.code).credit, 100000);
  assert.equal(entry.lines.filter((l) => l.accountCode === f.bank.code).length, 1, 'one bank line');

  // The principal is the whole $800 — nothing to claim GST on.
  assert.equal(lineFor(entry, f.loan.code).debit, 80000);
  // The interest is $200 including GST, so the expense line is the net and GST gets its own line.
  const interestNet = entry.lines.filter((l) => l.accountCode === f.interest.code);
  assert.equal(interestNet[0].debit, 18182, 'net of 10% GST');
  // The GST line is found by its tax code: the account code of the GST account is "1-1300", which
  // says nothing about GST, so matching on the code would find nothing and pass a broken test.
  const gstLine = entry.lines.find((l) => l.taxCode === 'GST' && l.accountCode !== f.interest.code);
  assert.ok(gstLine, 'a GST line exists for the taxable split');
  assert.equal(gstLine.debit, 1818);
  assert.equal(interestNet[0].debit + gstLine.debit, 20000, 'the interest split accounts for the whole $200');
});

test('the split notes reach the ledger, so the reason is visible there', async () => {
  const f = await setup();
  const txn = blankBankTxn({
    companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-05', description: 'LOAN REPAYMENT', amount: -100000,
    splits: [
      { accountCode: f.loan.code, taxCode: 'N-T', amount: 80000, note: 'Principal' },
      { accountCode: f.interest.code, taxCode: 'N-T', amount: 20000, note: 'Interest' },
    ],
  });
  f.db.put('bankTxns', txn);
  categoriseBankTxn(f.db, f.db.get('bankTxns', txn.id));
  const entry = postedEntries(f.db.of('entries', f.company.id))[0];
  assert.match(lineFor(entry, f.loan.code).description, /Principal/);
  assert.match(lineFor(entry, f.interest.code).description, /Interest/);
});

test('splits that do not add up are refused, with the difference named and nothing posted', async () => {
  const f = await setup();
  const txn = blankBankTxn({
    companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-05', description: 'SHORT SPLIT', amount: -100000,
    splits: [
      { accountCode: f.loan.code, taxCode: 'N-T', amount: 80000 },
      { accountCode: f.interest.code, taxCode: 'N-T', amount: 15000 },
    ],
  });
  f.db.put('bankTxns', txn);
  assert.throws(() => categoriseBankTxn(f.db, f.db.get('bankTxns', txn.id)), /5000|\$50\.00|50\.00/);
  assert.equal(postedEntries(f.db.of('entries', f.company.id)).length, 0, 'nothing was posted');
  assert.equal(f.db.get('bankTxns', txn.id).journalId, null, 'and the line is left alone');
});

test('a split with no account, the bank account itself, or no amount is refused', async () => {
  const f = await setup();
  const base = {
    companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-05', description: 'BAD SPLIT', amount: -100000,
  };
  const check = (splits, pattern) => {
    const txn = blankBankTxn({ ...base, splits });
    f.db.put('bankTxns', txn);
    assert.throws(() => categoriseBankTxn(f.db, f.db.get('bankTxns', txn.id)), pattern);
    f.db.del?.('bankTxns', txn.id);
  };
  check([{ accountCode: '9-9999', taxCode: 'N-T', amount: 100000 }], /does not exist/i);
  check([{ accountCode: f.bank.code, taxCode: 'N-T', amount: 100000 }], /other than the bank account/i);
  check([{ accountCode: f.loan.code, taxCode: 'N-T', amount: 60000 }, { accountCode: f.interest.code, taxCode: 'N-T', amount: 0 }], /no amount/i);
});

test('coding to a single account is unchanged, splits or no splits field', async () => {
  const plain = await setup();
  const one = blankBankTxn({
    companyId: plain.company.id, accountCode: plain.bank.code, date: '2026-10-06',
    description: 'OFFICE CHAIRS', amount: -11000, categoryAccount: plain.interest.code, taxCode: plain.gst.code,
  });
  plain.db.put('bankTxns', one);
  const viaSingle = categoriseBankTxn(plain.db, plain.db.get('bankTxns', one.id));
  const singleEntry = postedEntries(plain.db.of('entries', plain.company.id))[0];

  const split = await setup();
  const many = blankBankTxn({
    companyId: split.company.id, accountCode: split.bank.code, date: '2026-10-06',
    description: 'OFFICE CHAIRS', amount: -11000, taxCode: split.gst.code,
    splits: [{ accountCode: split.interest.code, taxCode: split.gst.code, amount: 11000 }],
  });
  split.db.put('bankTxns', many);
  const viaSplits = categoriseBankTxn(split.db, split.db.get('bankTxns', many.id));
  const splitEntry = postedEntries(split.db.of('entries', split.company.id))[0];

  const shape = (e) => e.lines.map((l) => `${l.accountCode}:${l.debit || 0}:${l.credit || 0}:${l.taxCode || ''}`).sort();
  assert.deepEqual(shape(splitEntry), shape(singleEntry), 'a one-element split is the same entry');
  assert.equal(viaSingle.categoryAccount, viaSplits.categoryAccount);
  assert.deepEqual(viaSingle.splits, [], 'a line coded to one account keeps no split list');
  assert.equal(viaSplits.splits.length, 1, 'and a one-element split records it');
});

test('the first split is recorded as the line\'s account, so a single-category reader still works', async () => {
  const f = await setup();
  const txn = blankBankTxn({
    companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-05', description: 'LOAN REPAYMENT', amount: -100000,
    splits: [
      { accountCode: f.loan.code, taxCode: 'N-T', amount: 80000, note: 'Principal' },
      { accountCode: f.interest.code, taxCode: 'GST', amount: 20000, note: 'Interest' },
    ],
  });
  f.db.put('bankTxns', txn);
  const saved = categoriseBankTxn(f.db, f.db.get('bankTxns', txn.id));
  assert.equal(saved.categoryAccount, f.loan.code);
  assert.equal(saved.taxCode, 'N-T');
  assert.equal(saved.splits.length, 2);
  assert.equal(saved.splits[1].accountCode, f.interest.code);
  assert.equal(saved.splits[1].note, 'Interest');
  assert.equal(saved.status, 'posted', 'typed in by hand, so it waits for a statement');
});

test('a GST-free split invents no GST, and a business not registered for GST gets none anywhere', async () => {
  const f = await setup();
  const txn = blankBankTxn({
    companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-05', description: 'TWO GST-FREE', amount: -30000,
    splits: [
      { accountCode: f.loan.code, taxCode: 'N-T', amount: 20000 },
      { accountCode: f.interest.code, taxCode: 'N-T', amount: 10000 },
    ],
  });
  f.db.put('bankTxns', txn);
  categoriseBankTxn(f.db, f.db.get('bankTxns', txn.id));
  const entry = postedEntries(f.db.of('entries', f.company.id))[0];
  assert.equal(entry.lines.length, 3, 'two account lines and the bank, no GST line');
  assert.equal(entry.lines.filter((l) => l.taxCode === 'GST').length, 0);
  // The summary now lists every coded split rather than only the ones carrying GST — a business not
  // registered for GST, or a split on a no-tax code, must not invent GST anywhere. What matters is that no
  // GST is claimed and no BAS box is touched, which is what the tax code's own flags decide.
  const summary = entry.taxSummary || [];
  assert.ok(summary.every((t) => t.gst === 0), 'no GST is invented on any row');
  assert.ok(summary.every((t) => t.taxCode === 'N-T'), 'and the no-tax code is what is recorded');
});

test('the tax summary carries a row per taxable split', async () => {
  const f = await setup();
  const second = f.anything.code === f.interest.code ? f.loan.code : f.anything.code;
  const txn = blankBankTxn({
    companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-05', description: 'MIXED', amount: -22000,
    splits: [
      { accountCode: f.interest.code, taxCode: 'GST', amount: 11000 },
      { accountCode: second, taxCode: 'GST', amount: 11000 },
    ],
  });
  f.db.put('bankTxns', txn);
  categoriseBankTxn(f.db, f.db.get('bankTxns', txn.id));
  const entry = postedEntries(f.db.of('entries', f.company.id))[0];
  assert.equal((entry.taxSummary || []).length, 2, 'two taxable splits, two BAS rows');
  for (const row of entry.taxSummary) {
    assert.equal(row.gst, 1000);
    assert.equal(row.net, 10000);
  }
});
