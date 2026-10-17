import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { createCompany as _c } from '../app/core/company.js';
import {
  blankDocument, blankLine, blankPayment, blankBankTxn, authoriseDocument, savePayment,
  computeDocument, computeLine, documentSummary, allocatedTo, voidDocument, categoriseBankTxn,
  autoAllocate, buildDocumentEntry, dueDateFor, bankTxnToPayment,
} from '../app/core/docs.js';
import { accountBalance } from '../app/core/ledger.js';
import { accountByRole } from '../app/core/coa.js';
import { setOpeningBalances } from '../app/core/company.js';
import { reconciliation, setStatementOpening } from '../app/core/docs.js';

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Test Co' });
  const taxCodes = db.of('taxCodes', company.id);
  const customer = db.put('contacts', { companyId: company.id, name: 'Acme Pty Ltd', isCustomer: true, terms: 'net14' });
  const supplier = db.put('contacts', { companyId: company.id, name: 'Supplies R Us', isSupplier: true, terms: 'net30' });
  return { db, company, taxCodes, customer, supplier };
}

function invoiceFor(db, company, customer, lines, extra = {}) {
  const doc = blankDocument({
    companyId: company.id,
    type: 'invoice',
    contactId: customer.id,
    date: '2026-07-10',
    dueDate: '2026-07-24',
    lines: lines.map((l) => blankLine(l)),
    ...extra,
  });
  db.put('documents', doc);
  return authoriseDocument(db, doc.id);
}

test('per-line maths: quantity, discount and GST', async () => {
  const { taxCodes } = await setup();
  const r = computeLine({ qty: 2000, unitPrice: 45000, discountPct: 10, taxCode: 'GST' }, taxCodes);
  assert.equal(r.ex, 81000); // 2 x $450 less 10%
  assert.equal(r.discount, 9000);
  assert.equal(r.gst, 8100);
  assert.equal(r.total, 89100);
});

test('a tax-inclusive price splits back to the same total', async () => {
  const { taxCodes } = await setup();
  const r = computeLine({ qty: 1000, unitPrice: 11000, taxCode: 'GST', priceIncludesTax: true }, taxCodes);
  assert.equal(r.total, 11000);
  assert.equal(r.ex, 10000);
  assert.equal(r.gst, 1000);
});

test('a GST-free line carries no GST', async () => {
  const { taxCodes } = await setup();
  const r = computeLine({ qty: 12000, unitPrice: 3995, taxCode: 'FRE' }, taxCodes);
  assert.equal(r.ex, 47940);
  assert.equal(r.gst, 0);
});

test('authorising an invoice posts a balanced entry and sets up debtors', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [{ description: 'Consulting', accountCode: '4-0000', qty: 2000, unitPrice: 45000, taxCode: 'GST' }]);

  assert.equal(doc.status, 'open');
  assert.equal(doc.number, 'INV-0001');

  const entries = db.of('entries', company.id);
  assert.equal(entries.length, 1);
  const e = entries[0];
  const debits = e.lines.reduce((a, l) => a + l.debit, 0);
  const credits = e.lines.reduce((a, l) => a + l.credit, 0);
  assert.equal(debits, credits);
  assert.equal(debits, 99000);

  assert.equal(accountBalance(entries, '1-1000'), 99000, 'accounts receivable');
  assert.equal(accountBalance(entries, '4-0000'), -90000, 'income is a credit');
  assert.equal(accountBalance(entries, '2-1200'), -9000, 'GST collected');
  assert.equal(accountBalance(entries, '1-0000'), 0, 'no bank movement yet');
});

test('editing and re-authorising an invoice does not double the ledger', async () => {
  const { db, company, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [{ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }]);
  const edited = { ...db.get('documents', doc.id), lines: [blankLine({ description: 'Work', accountCode: '4-0000', qty: 3000, unitPrice: 10000, taxCode: 'GST' })] };
  db.put('documents', edited);
  authoriseDocument(db, doc.id, { force: true });
  const entries = db.of('entries', company.id);
  assert.equal(entries.length, 1, 'one entry per document');
  assert.equal(accountBalance(entries, '1-1000'), 33000);
  assert.equal(accountBalance(entries, '2-1200'), -3000);
});

test('paying an invoice moves the debt to the bank and marks it paid', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [{ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }]);
  const total = computeDocument(doc, taxCodes).total;
  savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-07-20',
    amount: total, accountCode: '1-0000', allocations: [{ docId: doc.id, amount: total }],
  }));
  const entries = db.of('entries', company.id);
  assert.equal(accountBalance(entries, '1-0000'), 11000);
  assert.equal(accountBalance(entries, '1-1000'), 0, 'debtors cleared');
  const summary = documentSummary(doc, taxCodes, db.of('payments', company.id), '2026-07-21');
  assert.equal(summary.status, 'paid');
  assert.equal(summary.balance, 0);
});

test('a part payment shows as partly paid with the right balance', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [{ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 100000, taxCode: 'GST' }]);
  savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-07-20',
    amount: 50000, accountCode: '1-0000', allocations: [{ docId: doc.id, amount: 50000 }],
  }));
  const summary = documentSummary(doc, taxCodes, db.of('payments', company.id), '2026-07-21');
  assert.equal(summary.status, 'partly-paid');
  assert.equal(summary.paid, 50000);
  assert.equal(summary.balance, 60000);
});

test('an unpaid invoice past its due date reads as overdue', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [{ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }]);
  const payments = db.of('payments', company.id);
  assert.equal(documentSummary(doc, taxCodes, payments, '2026-07-23').status, 'open');
  assert.equal(documentSummary(doc, taxCodes, payments, '2026-07-25').status, 'overdue');
  assert.equal(documentSummary(doc, taxCodes, payments, '2026-08-24').overdueDays, 31);
});

test('a supplier bill posts to creditors, expenses and GST paid', async () => {
  const { db, company, supplier } = await setup();
  const doc = blankDocument({
    companyId: company.id, type: 'bill', contactId: supplier.id, date: '2026-07-05', dueDate: '2026-08-04',
    lines: [blankLine({ description: 'Office chairs', accountCode: '6-0700', qty: 1000, unitPrice: 50000, taxCode: 'GST' })],
  });
  db.put('documents', doc);
  authoriseDocument(db, doc.id);
  const entries = db.of('entries', company.id);
  assert.equal(accountBalance(entries, '2-1000'), -55000, 'creditors');
  assert.equal(accountBalance(entries, '6-0700'), 50000, 'expense');
  assert.equal(accountBalance(entries, '1-1300'), 5000, 'GST paid');
});

test('a credit note reverses the sale', async () => {
  const { db, company, customer } = await setup();
  invoiceFor(db, company, customer, [{ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 100000, taxCode: 'GST' }]);
  const cn = blankDocument({
    companyId: company.id, type: 'credit-note-sale', contactId: customer.id, date: '2026-07-15', dueDate: '2026-07-15',
    lines: [blankLine({ description: 'Returned goods', accountCode: '4-0000', qty: 1000, unitPrice: 40000, taxCode: 'GST' })],
  });
  db.put('documents', cn);
  authoriseDocument(db, cn.id);
  const entries = db.of('entries', company.id);
  assert.equal(accountBalance(entries, '1-1000'), 66000, 'net receivable');
  assert.equal(accountBalance(entries, '4-0000'), -60000, 'income reduced by the credit note');
  assert.equal(accountBalance(entries, '2-1200'), -6000, 'GST collected reduced');
});

test('voiding an invoice reverses its ledger effect but keeps the audit trail', async () => {
  const { db, company, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [{ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }]);
  voidDocument(db, doc.id, 'Raised in error');
  const entries = db.of('entries', company.id);
  assert.equal(accountBalance(entries, '1-1000'), 0);
  assert.equal(db.get('documents', doc.id).status, 'void');
  assert.equal(entries[0].status, 'void');
  assert.ok(db.of('auditLog', company.id).some((a) => a.action === 'void'));
});

test('categorising an imported statement line reconciles it', async () => {
  const { db, company } = await setup();
  setOpeningBalances(db, company.id, [{ accountCode: '1-0000', amount: 100000 }], '2026-07-01');
  setStatementOpening(db, company.id, '1-0000', 100000);
  const txn = db.put('bankTxns', blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-07-05',
    description: 'ELECTRICITY', amount: -55000, categoryAccount: '6-0300', taxCode: 'GST',
    importedFrom: 'statement.csv',
  }));
  categoriseBankTxn(db, txn);

  assert.equal(db.get('bankTxns', txn.id).status, 'reconciled', 'a line from a statement is reconciled when categorised');
  const rec = reconciliation(db, company.id, '1-0000', '2026-07-31');
  assert.equal(rec.ledgerBalance, 45000);
  assert.equal(rec.clearedBalance, 45000);
  assert.equal(rec.difference, 0);
  assert.equal(rec.reconciles, true);
  assert.equal(rec.unreconciledCount, 0);
});

test('a hand-typed bank line stays outstanding until a statement confirms it', async () => {
  const { db, company } = await setup();
  setOpeningBalances(db, company.id, [{ accountCode: '1-0000', amount: 100000 }], '2026-07-01');
  setStatementOpening(db, company.id, '1-0000', 100000);
  const txn = db.put('bankTxns', blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-07-05',
    description: 'Cash purchase', amount: -11000, categoryAccount: '6-0700', taxCode: 'GST',
  }));
  categoriseBankTxn(db, txn);
  assert.equal(db.get('bankTxns', txn.id).status, 'posted');
  const rec = reconciliation(db, company.id, '1-0000', '2026-07-31');
  assert.equal(rec.unreconciledCount, 1, 'it still needs checking against the statement');
  assert.equal(rec.reconciles, false);
  assert.equal(rec.difference, -11000, 'the ledger is behind the statement until the line clears');
});

test('a document with payments applied cannot be voided behind your back', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [{ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }]);
  const total = computeDocument(doc, taxCodes).total;
  savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-07-20',
    amount: total, accountCode: '1-0000', allocations: [{ docId: doc.id, amount: total }],
  }));
  assert.throws(() => voidDocument(db, doc.id), /Payments are applied/);
});

test('categorising a bank line splits GST correctly in both directions', async () => {
  const { db, company } = await setup();
  const spend = db.put('bankTxns', blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-07-11',
    description: 'Electricity', amount: -55000, categoryAccount: '6-0300', taxCode: 'GST',
  }));
  categoriseBankTxn(db, spend);
  const receive = db.put('bankTxns', blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-07-12',
    description: 'Workshop fees', amount: 33000, categoryAccount: '4-0500', taxCode: 'GST',
  }));
  categoriseBankTxn(db, receive);

  const entries = db.of('entries', company.id);
  assert.equal(accountBalance(entries, '6-0300'), 50000);
  assert.equal(accountBalance(entries, '1-1300'), 5000, 'GST paid on the spend');
  assert.equal(accountBalance(entries, '4-0500'), -30000);
  assert.equal(accountBalance(entries, '2-1200'), -3000, 'GST collected on the receipt');
  assert.equal(accountBalance(entries, '1-0000'), -55000 + 33000);
});

test('the activity statement summary is stamped on the entry', async () => {
  const { db, company, customer } = await setup();
  invoiceFor(db, company, customer, [
    { description: 'Taxable', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' },
    { description: 'GST free', accountCode: '4-0000', qty: 1000, unitPrice: 5000, taxCode: 'FRE' },
  ]);
  const e = db.of('entries', company.id)[0];
  const gst = e.taxSummary.find((t) => t.taxCode === 'GST');
  const fre = e.taxSummary.find((t) => t.taxCode === 'FRE');
  assert.equal(gst.net, 10000);
  assert.equal(gst.gst, 1000);
  assert.equal(fre.net, 5000);
  assert.equal(fre.gst, 0);
  assert.equal(gst.side, 'sales');
});

test('a payment can be auto-allocated across the oldest invoices first', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const older = invoiceFor(db, company, customer, [{ description: 'Old', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }]);
  db.put('documents', { ...db.get('documents', older.id), date: '2026-07-01', dueDate: '2026-07-01' });
  const newer = invoiceFor(db, company, customer, [{ description: 'New', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }]);
  const allocations = autoAllocate(db, { companyId: company.id, contactId: customer.id, type: 'customer', amount: 15000, asOf: '2026-07-30' });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].docId, older.id);
  assert.equal(allocations[0].amount, 11000);
  assert.equal(allocations[1].amount, 4000);
});

test('bank receipts can be turned into payments that pay off invoices', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [{ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }]);
  const txn = db.put('bankTxns', blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-07-25', description: 'DEPOSIT ACME', amount: 11000,
  }));
  bankTxnToPayment(db, { ...txn, contactId: customer.id });
  const summary = documentSummary(doc, taxCodes, db.of('payments', company.id), '2026-07-26');
  assert.equal(summary.status, 'paid');
});

test('opening balances land in the balancing account and close to zero', async () => {
  const { db, company, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [{ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }]);
  const backDated = { ...db.get('documents', doc.id), date: '2026-06-01' };
  db.put('documents', backDated);
  authoriseDocument(db, doc.id, { force: true });
  const e = db.of('entries', company.id).find((x) => x.source.type === 'invoice');
  assert.equal(e.date, '2026-06-01');
});

test('due dates follow the payment terms, including end of month', async () => {
  assert.equal(dueDateFor('2026-07-10', 'net14'), '2026-07-24');
  assert.equal(dueDateFor('2026-07-10', 'due_on_receipt'), '2026-07-10');
  assert.equal(dueDateFor('2026-07-10', 'eom'), '2026-07-31');
  assert.equal(dueDateFor('2026-02-01', 'eom'), '2026-02-28');
});

test('the GST account is found by role, not by a hard-coded code', async () => {
  const { db, company } = await setup();
  const accounts = db.of('accounts', company.id);
  const hmm = accountByRole(accounts, 'nonsense');
  assert.equal(hmm, null);
  assert.equal(accountByRole(accounts, 'ar').code, '1-1000');
  assert.equal(accountByRole(accounts, 'ap').code, '2-1000');
  assert.equal(accountByRole(accounts, 'gstCollected').code, '2-1200');
});

test('a preview of the posting can be built without touching the database', async () => {
  const { db, company, customer, taxCodes } = await setup();
  const doc = blankDocument({
    companyId: company.id, type: 'invoice', contactId: customer.id, number: 'INV-9001', date: '2026-07-10',
    lines: [blankLine({ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' })],
  });
  const entry = buildDocumentEntry({ ...doc, id: 'preview' }, {
    accounts: db.of('accounts', company.id), taxCodes, company, items: [], contactName: customer.name,
  });
  assert.equal(entry.lines.reduce((a, l) => a + l.debit, 0), 11000);
  assert.equal(db.of('entries', company.id).length, 0, 'preview must not write');
});
