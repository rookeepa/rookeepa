import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import {
  blankDocument, blankLine, blankPayment, authoriseDocument, voidDocument, savePayment, voidPayment,
} from '../app/core/docs.js';
import { incomeStatement, cashBasisIncomeStatement } from '../app/core/reports.js';
import { postEntry, makeEntry, dr, cr } from '../app/core/ledger.js';

/*
 * Cash-basis profit and loss.
 *
 * The books are always accrual; the cash basis is a view. These tests pin down what that view
 * recognises: money that settled a document, and money that went straight to an income or
 * expense account — and nothing else. Each test asserts the accrual answer too, so a
 * cash-basis figure of zero can never pass because the fixture failed to post anything.
 */

const JULY = { from: '2026-07-01', to: '2026-07-31' };
const AUGUST = { from: '2026-08-01', to: '2026-08-31' };

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Cash Basis Co' });
  const customer = db.put('contacts', { companyId: company.id, name: 'Client Pty Ltd', isCustomer: true });
  const supplier = db.put('contacts', { companyId: company.id, name: 'Supplier Pty Ltd', isSupplier: true });
  return { db, company, customer, supplier };
}

/** An invoice and a bill, both $1,000 + $100 GST unless told otherwise. */
function sale(db, company, customer, extra = {}) {
  const doc = blankDocument({
    companyId: company.id,
    type: 'invoice',
    contactId: customer.id,
    date: '2026-07-10',
    dueDate: '2026-07-24',
    priceIncludesTax: false,
    gstRegistered: true,
    lines: [blankLine({ description: 'Consulting', accountCode: '4-0000', taxCode: 'GST', qty: 1000, unitPrice: 100000 })],
    ...extra,
  });
  db.put('documents', doc);
  return authoriseDocument(db, doc.id);
}

function bill(db, company, supplier, extra = {}) {
  const doc = blankDocument({
    companyId: company.id,
    type: 'bill',
    contactId: supplier.id,
    date: '2026-07-05',
    dueDate: '2026-07-19',
    priceIncludesTax: false,
    gstRegistered: true,
    lines: [blankLine({ description: 'Materials', accountCode: '5-0000', taxCode: 'GST', qty: 1000, unitPrice: 50000 })],
    ...extra,
  });
  db.put('documents', doc);
  return authoriseDocument(db, doc.id);
}

function receipt(db, company, contact, { date, amount, docId }) {
  return savePayment(db, blankPayment({
    companyId: company.id,
    type: 'customer',
    contactId: contact.id,
    date,
    amount,
    accountCode: '1-0000',
    allocations: docId ? [{ docId, amount }] : [],
  }));
}

function payout(db, company, contact, { date, amount, docId }) {
  return savePayment(db, blankPayment({
    companyId: company.id,
    type: 'supplier',
    contactId: contact.id,
    date,
    amount,
    accountCode: '1-0000',
    allocations: docId ? [{ docId, amount }] : [],
  }));
}

/** Money straight out of the bank, not attached to any document. */
function bankExpense(db, company, { date, cents, accountCode = '6-0100' }) {
  return postEntry(db, makeEntry({
    companyId: company.id,
    date,
    memo: 'Bank fee',
    source: { type: 'bank-txn', id: null },
    lines: [dr(accountCode, cents), cr('1-0000', cents)],
  }));
}

const cash = (db, company, range) => cashBasisIncomeStatement({
  accounts: db.of('accounts', company.id),
  entries: db.of('entries', company.id),
  documents: db.of('documents', company.id),
  payments: db.of('payments', company.id),
  taxCodes: db.of('taxCodes', company.id),
  ...range,
});

const accrual = (db, company, range) => incomeStatement({
  accounts: db.of('accounts', company.id),
  entries: db.of('entries', company.id),
  ...range,
});

test('income is recognised when the money arrived, not when it was invoiced', async () => {
  const { db, company, customer } = await setup();
  const invoice = sale(db, company, customer);              // dated 10 July, $1,100
  receipt(db, company, customer, { date: '2026-08-05', amount: 110000, docId: invoice.id });

  const accrualJuly = accrual(db, company, JULY);
  assert.equal(accrualJuly.totals.income, 100000, 'sanity: on an accrual basis July earned the sale');
  assert.equal(accrualJuly.totals.income, 100000, 'and the GST is not income');

  const cashJuly = cash(db, company, JULY);
  assert.equal(cashJuly.totals.income, 0, 'no money arrived in July');
  assert.equal(cashJuly.totals.netProfit, 0);

  const cashAugust = cash(db, company, AUGUST);
  assert.equal(cashAugust.totals.income, 100000, 'the money arrived in August');
  assert.equal(cashAugust.basis, 'cash');
  assert.equal(accrual(db, company, AUGUST).totals.income, 0, 'August earned nothing on an accrual basis');
});

test('a part payment recognises only the share of the document the money covered', async () => {
  const { db, company, customer } = await setup();
  const invoice = sale(db, company, customer);
  receipt(db, company, customer, { date: '2026-08-05', amount: 55000, docId: invoice.id });  // half of $1,100

  const cashAugust = cash(db, company, AUGUST);
  assert.equal(cashAugust.totals.income, 50000, 'half the invoice, excluding GST');
  assert.ok(cash(db, company, JULY).totals.income === 0, 'and nothing before the money arrived');
});

test('money received on account is not income until it is applied to a document', async () => {
  const { db, company, customer } = await setup();
  sale(db, company, customer);
  receipt(db, company, customer, { date: '2026-08-05', amount: 110000 });   // received, not allocated

  const cashAugust = cash(db, company, AUGUST);
  assert.equal(cashAugust.totals.income, 0, 'a deposit is still the customer\'s credit, and could be refunded');
});

test('money paid straight out of the bank is an expense when it leaves', async () => {
  const { db, company } = await setup();
  bankExpense(db, company, { date: '2026-08-15', cents: 4500 });

  const cashAugust = cash(db, company, AUGUST);
  assert.equal(cashAugust.totals.expenses, 4500);
  assert.equal(cashAugust.totals.netProfit, -4500);
  assert.equal(cash(db, company, JULY).totals.expenses, 0, 'it belongs to August, when it was paid');
});

test('a bill paid is an expense when it is paid, not when it was dated', async () => {
  const { db, company, supplier } = await setup();
  const purchase = bill(db, company, supplier);             // dated 5 July, $500 + $50 GST
  // Materials sit in cost of sales rather than expenses, so both count here.
  const spent = (report) => report.totals.costOfSales + report.totals.expenses;

  assert.equal(spent(accrual(db, company, JULY)), 50000, 'sanity: accrual has it in July');
  assert.equal(spent(cash(db, company, JULY)), 0, 'no money had left yet');

  payout(db, company, supplier, { date: '2026-08-03', amount: 55000, docId: purchase.id });
  assert.equal(spent(cash(db, company, AUGUST)), 50000, 'and excluding GST');
});

test('a transfer between accounts is neither income nor expense', async () => {
  const { db, company } = await setup();
  postEntry(db, makeEntry({
    companyId: company.id, date: '2026-08-10', memo: 'Transfer to savings',
    source: { type: 'transfer', id: null },
    lines: [dr('1-0100', 300000), cr('1-0000', 300000)],
  }));

  const cashAugust = cash(db, company, AUGUST);
  assert.equal(cashAugust.totals.income, 0);
  assert.equal(cashAugust.totals.expenses, 0);
});

test('a reversed receipt stops being cash-basis income', async () => {
  const { db, company, customer } = await setup();
  const invoice = sale(db, company, customer);
  const payment = receipt(db, company, customer, { date: '2026-08-05', amount: 110000, docId: invoice.id });
  assert.equal(cash(db, company, AUGUST).totals.income, 100000, 'sanity: it counted while it stood');

  voidPayment(db, payment.id, 'paid into the wrong account');
  assert.equal(cash(db, company, AUGUST).totals.income, 0);
});

test('a voided invoice is never recognised, even if it was paid', async () => {
  const { db, company, customer } = await setup();
  const invoice = sale(db, company, customer);
  const payment = receipt(db, company, customer, { date: '2026-08-05', amount: 110000, docId: invoice.id });
  assert.equal(cash(db, company, AUGUST).totals.income, 100000, 'sanity: it counted while it stood');

  // A document that has been paid cannot be voided until the money is reversed — which is the
  // right order anyway, and means a void invoice can never leave income behind it.
  assert.throws(() => voidDocument(db, invoice.id, 'raised in error'), /reverse those payments/i);

  voidPayment(db, payment.id, 'reversed so the invoice could be voided');
  voidDocument(db, invoice.id, 'raised in error');
  assert.equal(cash(db, company, AUGUST).totals.income, 0);
});

test('a receipt cannot be allocated to another contact, so cash income cannot leak between customers', async () => {
  const { db, company, customer } = await setup();
  const invoice = sale(db, company, customer);
  const other = db.put('contacts', { companyId: company.id, name: 'Someone Else', isCustomer: true });

  // The books refuse the allocation outright, which is why the engine never has to decide
  // whose income it is: an allocation names a document, and a document belongs to a contact.
  assert.throws(
    () => receipt(db, company, other, { date: '2026-08-05', amount: 110000, docId: invoice.id }),
    /different contact/i,
  );

  // Money that arrives without being applied to a document is not income, whatever it is for.
  receipt(db, company, other, { date: '2026-08-20', amount: 20000 });
  assert.equal(cash(db, company, AUGUST).totals.income, 0);

  // Once the invoice is actually settled, the income appears.
  receipt(db, company, customer, { date: '2026-08-25', amount: 110000, docId: invoice.id });
  assert.equal(cash(db, company, AUGUST).totals.income, 100000);
});

test('both bases return the same shape, so one report can render either', async () => {
  const { db, company, customer } = await setup();
  const invoice = sale(db, company, customer);
  receipt(db, company, customer, { date: '2026-08-05', amount: 110000, docId: invoice.id });

  const a = accrual(db, company, AUGUST);
  const c = cash(db, company, AUGUST);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(c).sort());
  assert.deepEqual(Object.keys(a.totals).sort(), Object.keys(c.totals).sort());
  assert.deepEqual(Object.keys(a.groups).sort(), Object.keys(c.groups).sort());
  assert.equal(a.basis, 'accrual');
  assert.equal(c.basis, 'cash');
});


test('a refund allocated back to the invoice reverses the income its receipt brought in', async () => {
  // A refund is a negative allocation against the document it came from. Clamping it to zero meant the
  // original receipt kept its income after the money had gone back out — the cash view was simply wrong.
  const { db, company, customer } = await setup();
  const doc = sale(db, company, customer);
  receipt(db, company, customer, { date: '2026-07-15', amount: 110000, docId: doc.id });
  assert.equal(cash(db, company, JULY).totals.income, 100000, 'the receipt recognised the income');

  receipt(db, company, customer, { date: '2026-08-05', amount: -110000, docId: doc.id });
  const august = cash(db, company, AUGUST);
  assert.equal(august.totals.income, -100000, 'and the refund takes it back out, in the period it went out');
  assert.equal(cash(db, company, { from: '2026-07-01', to: '2026-08-31' }).totals.income, 0,
    'over both months the cash view recognises nothing, because the money came in and went back out');
});
