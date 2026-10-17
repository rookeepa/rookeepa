import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { unreconcileBankTxn, undoBankTxnCategorisation, categoriseBankTxn } from '../app/core/docs.js';
import { postedEntries } from '../app/core/ledger.js';

/*
 * The way through a reconciled line: undo → edit → re-reconcile.
 *
 * The point of these tests is not that a status field flips. It is that the books are left alone in
 * exactly the places they should be, and that the round trip cannot double-count: reconciling never
 * posted anything, and undoing a categorisation voids the entry instead of deleting it — and a
 * voided entry is not counted — so categorising the line again produces one live entry.
 */

async function seed() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Unreconcile Co' });
  const companyId = company.id;
  const accounts = db.of('accounts', companyId);
  const bank = accounts.find((a) => a.code === (company.bankAccount || '1-0000')) || accounts[0];
  const expenses = accounts.filter((a) => a.type === 'expense');
  const taxCodes = db.of('taxCodes', companyId);
  return {
    db,
    companyId,
    bank,
    expense: expenses[0],
    other: expenses[1] || expenses[0],
    gst: taxCodes.find((t) => t.code === 'GST') || taxCodes[0],
  };
}

const line = (db, fields, over = {}) => db.put('bankTxns', {
  id: 'btx1', companyId: fields.companyId, accountCode: fields.bank.code, date: '2026-10-01',
  description: 'TEST LINE', amount: -11000, status: 'unreconciled', ...over,
});

test('un-reconciling a line that posted its own entry returns it to posted, entry intact', async () => {
  const fields = await seed();
  line(fields.db, fields, { status: 'reconciled', journalId: 'e1', categoryAccount: fields.expense.code });
  const saved = unreconcileBankTxn(fields.db, 'btx1');
  assert.equal(saved.status, 'posted', 'still categorised, just not ticked off');
  assert.equal(saved.journalId, 'e1', 'the entry is not disturbed');
  assert.equal(saved.categoryAccount, fields.expense.code);
  assert.ok(fields.db.of('auditLog', fields.companyId).some((a) => a.action === 'unreconcile' && a.entityId === 'btx1'),
    'the undo is in the audit log');
});

test('un-reconciling a matched line returns it to review and forgets the match', async () => {
  const fields = await seed();
  line(fields.db, fields, { status: 'reconciled', matchedEntryId: 'e9', journalId: null });
  const saved = unreconcileBankTxn(fields.db, 'btx1');
  assert.equal(saved.status, 'unreconciled');
  assert.equal(saved.matchedEntryId, null);
  assert.equal(saved.docId, null);
});

test('un-reconciling a line that was a payment match leaves the payment alone', async () => {
  const fields = await seed();
  fields.db.put('payments', { id: 'p1', companyId: fields.companyId, journalId: 'e7', amount: 11000, date: '2026-10-01' });
  line(fields.db, fields, { status: 'reconciled', journalId: 'e7', docId: 'doc1' });
  const saved = unreconcileBankTxn(fields.db, 'btx1');
  assert.equal(saved.status, 'posted');
  assert.equal(saved.docId, null, 'the match is forgotten');
  assert.ok(fields.db.get('payments', 'p1'), 'the payment was real money — it stays in the books');
});

test('un-reconciling a line that is not reconciled is refused', async () => {
  const fields = await seed();
  line(fields.db, fields, { status: 'unreconciled' });
  assert.throws(() => unreconcileBankTxn(fields.db, 'btx1'), /only a reconciled line/i);
  line(fields.db, fields, { status: 'reconciled' });
  unreconcileBankTxn(fields.db, 'btx1');
  assert.throws(() => unreconcileBankTxn(fields.db, 'btx1'), /only a reconciled line/i, 'and not twice');
});

test('undoing a categorisation voids the entry rather than deleting it, and the line can be redone', async () => {
  const fields = await seed();
  line(fields.db, fields, { categoryAccount: fields.expense.code, taxCode: fields.gst.code });
  const posted = categoriseBankTxn(fields.db, fields.db.get('bankTxns', 'btx1'));
  assert.equal(posted.status, 'posted');
  const firstEntry = posted.journalId;
  assert.equal(postedEntries(fields.db.of('entries', fields.companyId)).length, 1);

  const undone = undoBankTxnCategorisation(fields.db, posted);
  assert.equal(undone.status, 'unreconciled', 'back in review, where it can be re-coded');
  assert.equal(undone.journalId, null);
  assert.equal(undone.categoryAccount, null);
  assert.ok(fields.db.get('entries', firstEntry), 'the entry is kept, not deleted');
  assert.equal(postedEntries(fields.db.of('entries', fields.companyId)).length, 0, 'and it no longer counts');

  // Categorising it again is now safe: one live entry, the voided one ignored.
  const redone = categoriseBankTxn(fields.db, {
    ...fields.db.get('bankTxns', 'btx1'), categoryAccount: fields.other.code, taxCode: fields.gst.code,
  });
  assert.notEqual(redone.journalId, firstEntry);
  const live = postedEntries(fields.db.of('entries', fields.companyId));
  assert.equal(live.length, 1);
  assert.equal(live[0].id, redone.journalId);
  const debits = live.flatMap((e) => e.lines).reduce((a, l) => a + (l.debit || 0), 0);
  const credits = live.flatMap((e) => e.lines).reduce((a, l) => a + (l.credit || 0), 0);
  assert.equal(debits, credits, 'still balanced');
  assert.equal(debits + credits, 11000 + 11000, 'the $110 line is in the ledger exactly once');
});

test('undoing a categorisation is refused on a line that has none, and on a reconciled one', async () => {
  const fields = await seed();
  line(fields.db, fields, { status: 'unreconciled' });
  assert.throws(() => undoBankTxnCategorisation(fields.db, 'btx1'), /nothing to undo/i);
  line(fields.db, fields, { status: 'reconciled', journalId: 'e1' });
  assert.throws(() => undoBankTxnCategorisation(fields.db, 'btx1'), /un-reconcile this line before/i,
    'the order matters: un-reconcile, then undo');
});
