import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { renameAccountCode } from '../app/core/coa.js';
import { incomeStatement } from '../app/core/reports.js';
import { postEntry, makeEntry, dr, cr } from '../app/core/ledger.js';
import {
  blankDocument, blankLine, blankPayment, authoriseDocument, savePayment, blankBankTxn,
  undoBankTxnCategorisation, allocatedTo,
} from '../app/core/docs.js';

/*
 * Two findings from an independent review, each reproduced the way it was reported.
 *
 * Renaming a used account code used to relabel the account and leave every posting pointing at a code that no
 * longer existed: income vanished from the reports while the journal still balanced. Un-categorising a bank
 * line that had paid an invoice used to void the journal and leave the payment live, so the invoice stayed
 * marked paid against a control account that had gone back to zero.
 */

test('renaming a used account code moves its postings with it', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Rename Co' });
  // A plain sale: $100 to the bank against sales income. No GST, because this is about the code, not the tax.
  postEntry(db, makeEntry({
    companyId: company.id, date: '2026-07-10', memo: 'Sale',
    lines: [dr('1-1100', 10000), cr('4-0000', 10000)],
  }));
  const range = { from: '2026-07-01', to: '2026-07-31' };
  const before = incomeStatement({ accounts: db.of('accounts', company.id), entries: db.of('entries', company.id), ...range });
  assert.equal(before.totals.income, 10000, 'the sale is income to begin with');

  const moved = renameAccountCode(db, company.id, '4-0000', '4-0999');
  assert.ok(moved > 0, 'something was rewritten');

  const accounts = db.of('accounts', company.id);
  assert.ok(accounts.some((a) => a.code === '4-0999'), 'the account has the new code');
  assert.ok(!accounts.some((a) => a.code === '4-0000'), 'and no longer the old one');

  // The root of the reported symptom: a journal line naming a code the chart does not have.
  const codes = new Set(accounts.map((a) => a.code));
  for (const entry of db.of('entries', company.id)) {
    for (const line of entry.lines) {
      assert.ok(codes.has(line.accountCode), `a journal line still refers to ${line.accountCode}, which is not in the chart`);
    }
  }

  const after = incomeStatement({ accounts, entries: db.of('entries', company.id), ...range });
  assert.equal(after.totals.income, 10000, 'so the income did not vanish');
  const debits = db.of('entries', company.id).flatMap((e) => e.lines).reduce((n, l) => n + (l.debit || 0), 0);
  const credits = db.of('entries', company.id).flatMap((e) => e.lines).reduce((n, l) => n + (l.credit || 0), 0);
  assert.equal(debits, credits, 'and the journal still balances');
});

test('a rename that collides, or names an account that is not there, is refused', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Collide Co' });
  assert.throws(() => renameAccountCode(db, company.id, '4-0000', '6-0100'), /already used/);
  assert.throws(() => renameAccountCode(db, company.id, '9-9999', '9-9998'), /no account with code/);
});

test('un-categorising a bank line that paid an invoice releases the payment', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Undo Co' });
  const customer = db.put('contacts', { companyId: company.id, name: 'Client Pty Ltd', isCustomer: true });

  const invoice = blankDocument({
    companyId: company.id, type: 'invoice', contactId: customer.id, date: '2026-07-10',
    dueDate: '2026-07-24', priceIncludesTax: false, gstRegistered: true,
    lines: [blankLine({ description: 'Consulting', accountCode: '4-0000', taxCode: 'GST', qty: 1000, unitPrice: 100000 })],
  });
  db.put('documents', invoice);
  authoriseDocument(db, invoice.id);

  const payment = savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-07-20',
    amount: 110000, accountCode: '1-0000', allocations: [{ docId: invoice.id, amount: 110000 }],
  }));
  const paymentEntry = db.of('entries', company.id).find((e) => e.source?.type === 'customer-payment' && e.source.id === payment.id);
  assert.ok(paymentEntry, 'the payment posted an entry');
  assert.equal(allocatedTo(db.of('payments', company.id), invoice.id), 110000, 'and the invoice is paid');

  // The bank line that brought the money in, coded to that payment.
  const txn = db.put('bankTxns', blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-07-20', description: 'CLIENT PAYMENT',
    amount: 110000, status: 'posted', journalId: paymentEntry.id,
  }));

  undoBankTxnCategorisation(db, txn.id);

  assert.equal(db.get('entries', paymentEntry.id).status, 'void', 'the journal is voided');
  const after = db.get('payments', payment.id);
  assert.equal(after.status, 'void', 'and the payment is voided with it, rather than left live');
  assert.deepEqual(after.allocations, [], 'its allocations are released');
  assert.equal(allocatedTo(db.of('payments', company.id), invoice.id), 0, 'so the invoice is unpaid again, as it should be');
  assert.equal(db.get('bankTxns', txn.id).status, 'unreconciled', 'and the bank line is back in review');
});


test('a rename moves the statement opening balance and the bank rules filed in meta', async () => {
  // These live in db.meta, keyed by company, and name an account by code — the collections alone do not
  // cover them, so a rename used to strand a bank account's opening balance and every rule that used it.
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Meta Co' });
  db.meta = {
    ...db.meta,
    statementOpening: { [company.id]: { '1-1100': 50000 } },
    bankRules: { [company.id]: [{ id: 'rule1', name: 'Rent', accountCode: '1-1100', taxCode: 'GST', conditions: [] }] },
  };

  renameAccountCode(db, company.id, '1-1100', '1-1199');

  assert.equal(db.meta.statementOpening[company.id]['1-1199'], 50000, 'the opening balance moved with the code');
  assert.equal(db.meta.statementOpening[company.id]['1-1100'], undefined, 'and is no longer filed under the old one');
  assert.equal(db.meta.bankRules[company.id][0].accountCode, '1-1199', 'and the bank rule points at it still');
});

test('two jobs on one account keep their own tax codes in the journal', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Jobs Co' });
  const customer = db.put('contacts', { companyId: company.id, name: 'Client', isCustomer: true });
  const doc = blankDocument({
    companyId: company.id, type: 'invoice', contactId: customer.id, date: '2026-07-10',
    dueDate: '2026-07-24', priceIncludesTax: false, gstRegistered: true,
    lines: [
      blankLine({ description: 'Fitting', accountCode: '4-0000', taxCode: 'GST', qty: 1000, unitPrice: 10000, jobCode: 'JOB-001' }),
      blankLine({ description: 'Export', accountCode: '4-0000', taxCode: 'FRE', qty: 1000, unitPrice: 20000, jobCode: 'JOB-002' }),
    ],
  });
  db.put('documents', doc);
  authoriseDocument(db, doc.id);

  const entry = db.of('entries', company.id).find((e) => e.status === 'posted');
  const onJob1 = entry.lines.find((l) => l.jobCode === 'JOB-001' && l.accountCode === '4-0000');
  const onJob2 = entry.lines.find((l) => l.jobCode === 'JOB-002' && l.accountCode === '4-0000');
  assert.ok(onJob1 && onJob2, 'both jobs got their own journal line');
  assert.equal(onJob1.taxCode, 'GST', 'each line carries its own tax code');
  assert.equal(onJob2.taxCode, 'FRE', 'including the second job, which used to inherit the first');
});
