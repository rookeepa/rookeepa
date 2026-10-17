import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import {
  blankDocument, blankLine, blankPayment, authoriseDocument, savePayment, voidDocument, voidPayment,
} from '../app/core/docs.js';
import { statementFor } from '../app/core/statements.js';

/* ------------------------------------------------------------------ fixture */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Statement Co' });
  const taxCodes = db.of('taxCodes', company.id);
  const customer = db.put('contacts', { companyId: company.id, name: 'Acme Pty Ltd', isCustomer: true, terms: 'net14' });
  const other = db.put('contacts', { companyId: company.id, name: 'Someone Else', isCustomer: true, terms: 'net14' });
  return { db, company, taxCodes, customer, other };
}

const line = (unitPrice) => ({ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice, taxCode: 'GST' });

function invoiceFor(db, company, contact, lines, extra = {}) {
  const doc = blankDocument({
    companyId: company.id,
    type: 'invoice',
    contactId: contact.id,
    date: '2026-07-10',
    dueDate: '2026-07-24',
    lines: lines.map((l) => blankLine(l)),
    ...extra,
  });
  db.put('documents', doc);
  return authoriseDocument(db, doc.id);
}

function creditNoteFor(db, company, contact, lines, extra = {}) {
  const doc = blankDocument({
    companyId: company.id,
    type: 'credit-note-sale',
    contactId: contact.id,
    date: '2026-07-15',
    dueDate: '2026-07-15',
    lines: lines.map((l) => blankLine(l)),
    ...extra,
  });
  db.put('documents', doc);
  return authoriseDocument(db, doc.id);
}

function receiptFor(db, company, contact, { amount, allocations = [], date = '2026-07-20' } = {}) {
  return savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: contact.id, date, amount,
    accountCode: '1-0000', allocations,
  }));
}

/** statementFor() reading the current company's own documents and payments. */
function statementOf(db, company, taxCodes, contactId, range = {}) {
  return statementFor({
    documents: db.of('documents', company.id),
    payments: db.of('payments', company.id),
    taxCodes,
    contactId,
    ...range,
  });
}

const JULY = { from: '2026-07-01', to: '2026-07-31' };

/* --------------------------------------------------------------------- tests */

test('a statement carries the balance from before the range as its opening', async () => {
  const { db, company, taxCodes, customer } = await setup();
  invoiceFor(db, company, customer, [line(100000)], { date: '2026-06-01', dueDate: '2026-06-15' }); // $1,100

  const st = statementOf(db, company, taxCodes, customer.id, JULY);
  assert.equal(st.opening, 110000, 'the June invoice is carried in');
  assert.equal(st.lines.length, 0, 'but it is not repeated inside the range');
  assert.equal(st.closing, 110000);
  assert.deepEqual(st.totals, { debit: 0, credit: 0 });
  assert.equal(st.totalDue, 110000);
});

test('statement lines are ordered by date, then number, with a running balance', async () => {
  const { db, company, taxCodes, customer } = await setup();

  // Inserted newest-first so a statement that came out in insertion order would
  // read wrong: the older invoice must still come first.
  invoiceFor(db, company, customer, [line(200000)], { date: '2026-07-20', dueDate: '2026-08-03' }); // $2,200
  invoiceFor(db, company, customer, [line(100000)], { date: '2026-07-05', dueDate: '2026-07-19' }); // $1,100

  const july = statementOf(db, company, taxCodes, customer.id, JULY);
  assert.deepEqual(july.lines.map((l) => l.date), ['2026-07-05', '2026-07-20'], 'date order, not insertion order');
  assert.equal(july.lines[0].balance, 110000, 'the balance runs forward');
  assert.equal(july.lines[1].balance, 330000);
  assert.deepEqual(july.totals, { debit: 330000, credit: 0 });
  assert.equal(july.closing, 330000);

  // Two invoices on the same date: the lower number must come first regardless of
  // the order they were raised in.
  invoiceFor(db, company, customer, [line(10000)], { date: '2026-08-01', dueDate: '2026-08-15', number: 'INV-0009' }); // $110
  invoiceFor(db, company, customer, [line(20000)], { date: '2026-08-01', dueDate: '2026-08-15', number: 'INV-0003' }); // $220

  const august = statementOf(db, company, taxCodes, customer.id, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(august.lines.map((l) => l.number), ['INV-0003', 'INV-0009'], 'same date sorts by number');
  assert.equal(august.lines[0].balance, august.opening + 22000);
  assert.equal(august.lines[1].balance, august.lines[0].balance + 11000);
});

test('a credit note reduces the balance', async () => {
  const { db, company, taxCodes, customer } = await setup();
  invoiceFor(db, company, customer, [line(100000)], { date: '2026-07-05' }); // $1,100
  creditNoteFor(db, company, customer, [line(40000)], { date: '2026-07-10' }); // $440 credited

  const st = statementOf(db, company, taxCodes, customer.id, JULY);
  assert.equal(st.lines.length, 2);
  assert.equal(st.lines[1].kind, 'credit-note');
  assert.equal(st.lines[1].debit, 0, 'a credit note never debits');
  assert.equal(st.lines[1].credit, 44000);
  assert.equal(st.lines[1].balance, 66000, 'the customer owes less after the credit');
  assert.deepEqual(st.totals, { debit: 110000, credit: 44000 });
  assert.equal(st.closing, 66000);
  assert.equal(st.totalDue, 66000);
});

test('a receipt allocated to an invoice reduces what is owed', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const inv = invoiceFor(db, company, customer, [line(100000)], { date: '2026-07-05' }); // $1,100
  receiptFor(db, company, customer, { amount: 60000, allocations: [{ docId: inv.id, amount: 60000 }] });

  const st = statementOf(db, company, taxCodes, customer.id, JULY);
  assert.equal(st.lines.length, 2);
  assert.equal(st.lines[1].kind, 'receipt');
  assert.equal(st.lines[1].debit, 0);
  assert.equal(st.lines[1].credit, 60000);
  assert.equal(st.lines[1].balance, 50000);
  assert.equal(st.closing, 50000);
  assert.equal(st.totalDue, 50000);
});

test('a voided invoice and a voided receipt are left out of the statement', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const keep = invoiceFor(db, company, customer, [line(100000)], { date: '2026-07-05' }); // $1,100
  const gone = invoiceFor(db, company, customer, [line(50000)], { date: '2026-07-06' }); // $550
  voidDocument(db, gone.id, 'raised in error');

  const receipt = receiptFor(db, company, customer, { amount: 110000, allocations: [{ docId: keep.id, amount: 110000 }] });
  voidPayment(db, receipt.id, 'bank reversed it');

  const st = statementOf(db, company, taxCodes, customer.id, JULY);
  assert.equal(st.lines.length, 1, 'only the live invoice remains');
  assert.equal(st.lines[0].number, keep.number);
  assert.equal(st.lines[0].debit, 110000);
  assert.ok(!st.lines.some((l) => l.number === gone.number), 'the voided invoice is gone');
  assert.ok(!st.lines.some((l) => l.kind === 'receipt'), 'the reversed receipt is gone');
  assert.equal(st.closing, 110000, 'the whole invoice is owed again');
  assert.equal(st.totalDue, 110000);
});

test('a receipt for a different contact is ignored', async () => {
  const { db, company, taxCodes, customer, other } = await setup();
  invoiceFor(db, company, customer, [line(100000)], { date: '2026-07-05' }); // Acme owes $1,100
  const theirs = invoiceFor(db, company, other, [line(100000)], { date: '2026-07-05' });
  receiptFor(db, company, other, { amount: 110000, allocations: [{ docId: theirs.id, amount: 110000 }] });

  const st = statementOf(db, company, taxCodes, customer.id, JULY);
  assert.equal(st.lines.length, 1, 'only Acme’s own invoice appears');
  assert.equal(st.lines[0].kind, 'invoice');
  assert.deepEqual(st.totals, { debit: 110000, credit: 0 }, 'the other contact’s receipt is not Acme’s credit');
  assert.equal(st.closing, 110000);
  assert.equal(st.totalDue, 110000);
});

test('a range with no activity still reports the opening balance', async () => {
  const { db, company, taxCodes, customer } = await setup();
  invoiceFor(db, company, customer, [line(100000)], { date: '2026-06-15', dueDate: '2026-06-29' }); // $1,100 in June

  const st = statementOf(db, company, taxCodes, customer.id, JULY);
  assert.equal(st.opening, 110000);
  assert.equal(st.lines.length, 0, 'nothing happened in July');
  assert.deepEqual(st.totals, { debit: 0, credit: 0 });
  assert.equal(st.closing, 110000, 'the balance is simply carried through');
  assert.equal(st.totalDue, 110000);
});

test('closing equals the opening plus the movement', async () => {
  const { db, company, taxCodes, customer } = await setup();
  invoiceFor(db, company, customer, [line(100000)], { date: '2026-06-10', dueDate: '2026-06-24' }); // opening $1,100
  const july = invoiceFor(db, company, customer, [line(50000)], { date: '2026-07-10' }); // + $550
  receiptFor(db, company, customer, { amount: 30000, allocations: [{ docId: july.id, amount: 30000 }] }); // - $300

  const st = statementOf(db, company, taxCodes, customer.id, JULY);
  assert.equal(st.opening, 110000);
  assert.deepEqual(st.totals, { debit: 55000, credit: 30000 });
  assert.equal(st.closing, 135000);
  assert.equal(st.closing, st.opening + st.totals.debit - st.totals.credit, 'closing is exactly opening plus the movement');
  assert.equal(st.lines[st.lines.length - 1].balance, st.closing, 'the last running balance is the closing figure');
});

test('the amount due does not depend on the range', async () => {
  const { db, company, taxCodes, customer } = await setup();
  invoiceFor(db, company, customer, [line(100000)], { date: '2026-06-10', dueDate: '2026-06-24' });
  const july = invoiceFor(db, company, customer, [line(50000)], { date: '2026-07-10' });
  receiptFor(db, company, customer, { amount: 30000, allocations: [{ docId: july.id, amount: 30000 }] });

  const wide = statementOf(db, company, taxCodes, customer.id); // the whole account
  const julyOnly = statementOf(db, company, taxCodes, customer.id, JULY);
  const august = statementOf(db, company, taxCodes, customer.id, { from: '2026-08-01', to: '2026-08-31' });

  assert.equal(wide.totalDue, 135000);
  assert.equal(julyOnly.totalDue, 135000, 'a July statement still shows the true balance');
  assert.equal(august.totalDue, 135000, 'and so does a quiet month');
  assert.equal(august.lines.length, 0);
  assert.equal(august.opening, 135000, 'everything is carried in as the opening balance');
});

test('an unapplied receipt (money on account) settles nothing', async () => {
  const { db, company, taxCodes, customer } = await setup();
  const inv = invoiceFor(db, company, customer, [line(100000)], { date: '2026-07-05' }); // $1,100
  // Money received but not applied to any invoice: it is on account, and this app
  // refuses to guess which debt it should settle.
  receiptFor(db, company, customer, { amount: 50000, allocations: [] });

  const st = statementOf(db, company, taxCodes, customer.id, JULY);
  assert.equal(db.of('payments', company.id).length, 1, 'sanity: the receipt exists');
  assert.equal(st.lines.length, 1, 'only the invoice is shown');
  assert.ok(!st.lines.some((l) => l.kind === 'receipt'), 'an unapplied receipt moves nothing');
  assert.equal(st.closing, 110000, 'the invoice is still owed in full');
  assert.equal(st.totalDue, 110000);
  assert.ok(inv.id, 'the invoice is the only thing on the account');
});
