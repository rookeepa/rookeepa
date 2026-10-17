import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import {
  blankDocument, blankLine, authoriseDocument, blankPayment, savePayment, documentSummary,
} from '../app/core/docs.js';
import { postedEntries } from '../app/core/ledger.js';

/*
 * A note on an allocation.
 *
 * The accounting question is not whether the note is stored — it is whether storing one can change
 * anything. A note describes why part of a payment went to a document; it is not money. So these tests
 * assert the note survives a round trip through the database, and that the ledger is *identical* with
 * and without it. If a note ever moves a cent, this fails.
 */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Notes Co' });
  const customer = db.put('contacts', { companyId: company.id, name: 'Client Pty Ltd', isCustomer: true });
  const accounts = db.of('accounts', company.id);
  const income = accounts.find((a) => a.type === 'income');
  const bank = accounts.find((a) => a.code === (company.bankAccount || '1-0000'));
  const tax = db.of('taxCodes', company.id).find((t) => t.code === 'GST') || db.of('taxCodes', company.id)[0];

  const doc = authoriseDocument(db, blankDocument({
    companyId: company.id,
    type: 'invoice',
    contactId: customer.id,
    date: '2026-10-01',
    lines: [blankLine({ description: 'Consulting', quantity: 1000, unitPrice: 110000, accountCode: income.code, taxCode: tax.code })],
  }));

  const pay = (allocations) => savePayment(db, blankPayment({
    companyId: company.id,
    type: 'customer',
    contactId: customer.id,
    date: '2026-10-10',
    amount: 110000,
    accountCode: bank.code,
    allocations,
  }));

  return { db, company, customer, doc, pay, bank };
}

const ledgerShape = (db, companyId) => postedEntries(db.of('entries', companyId))
  .flatMap((e) => e.lines.map((l) => `${l.accountCode}:${l.debit || 0}:${l.credit || 0}`))
  .sort();

test('an allocation note is saved on the allocation and comes back with the payment', async () => {
  const f = await setup();
  const payment = f.pay([{ docId: f.doc.id, amount: 110000, docNumber: f.doc.number, docType: f.doc.type, note: 'Second half of the March invoice' }]);
  const stored = f.db.get('payments', payment.id);
  assert.equal(stored.allocations[0].note, 'Second half of the March invoice');
  assert.equal(stored.allocations[0].amount, 110000, 'and the note is not an amount');
  assert.equal(f.db.of('payments', f.company.id).length, 1);
});

test('the ledger is identical with and without a note', async () => {
  const without = await setup();
  const plain = without.pay([{ docId: without.doc.id, amount: 110000, docNumber: without.doc.number, docType: without.doc.type }]);

  const with_ = await setup();
  const noted = with_.pay([{ docId: with_.doc.id, amount: 110000, docNumber: with_.doc.number, docType: with_.doc.type, note: 'A note that must not move money' }]);

  assert.deepEqual(ledgerShape(with_.db, with_.company.id), ledgerShape(without.db, without.company.id));
  assert.notEqual(plain.id, noted.id, 'different payments — the assertion is about the entries, not the ids');
});

test('a note does not change what a document owes', async () => {
  const f = await setup();
  const allPayments = () => f.db.of('payments', f.company.id);
  const before = documentSummary(f.doc, f.db.of('taxCodes', f.company.id), allPayments(), '2026-10-31');
  f.pay([{ docId: f.doc.id, amount: 50000, docNumber: f.doc.number, docType: f.doc.type, note: 'Part payment, rest next week' }]);
  const after = documentSummary(f.doc, f.db.of('taxCodes', f.company.id), allPayments(), '2026-10-31');
  assert.equal(before.balance - after.balance, 50000, 'the money applied is the allocation amount, not the note');
  assert.equal(after.balance, before.balance - 50000, 'and the note did not alter the balance by a cent');
  assert.ok(after.balance > 0, 'part paid, so something is still owed');
});

test('an empty note is simply an empty string, and a payment without notes is unchanged', async () => {
  const f = await setup();
  const payment = f.pay([{ docId: f.doc.id, amount: 110000, docNumber: f.doc.number, docType: f.doc.type, note: '' }]);
  assert.equal(f.db.get('payments', payment.id).allocations[0].note, '');
  assert.equal(payment.allocations[0].note, '');
});
