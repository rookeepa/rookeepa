import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { blankBankTxn, categoriseBankTxn } from '../app/core/docs.js';

/*
 * The contract the Spend money / Receive money dialog now depends on.
 *
 * That dialog used to build its own ledger lines. It hands the line to categoriseBankTxn instead, so these
 * tests pin what it now relies on: the source the journal shows, the way a split's note reaches the ledger,
 * the link back to the bank line, and the status a hand-typed line lands in. If any of that changes, the
 * dialog changes with it — which is the point of having one path rather than two.
 */

async function setup(extra = {}) {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Engine Co' });
  const txn = db.put('bankTxns', blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-08-12',
    description: 'SUPPLIES PLUS', reference: 'CHQ-1', amount: -30000, status: 'unreconciled', type: 'spend',
    categoryAccount: '6-0700', taxCode: 'GST',
    splits: [
      { accountCode: '6-0700', taxCode: 'GST', amount: 20000, note: 'paper' },
      { accountCode: '6-0800', taxCode: 'GST', amount: 10000, note: '' },
    ],
    ...extra,
  }));
  return { db, company, txn };
}

test('a hand-typed line is posted and waiting, not reconciled', async () => {
  const { db, txn } = await setup();
  const saved = categoriseBankTxn(db, txn);
  assert.equal(saved.status, 'posted', 'nothing has confirmed it against a statement yet');
  assert.ok(saved.journalId);
  const entry = db.get('entries', saved.journalId);
  assert.equal(entry.status, 'posted');
});

test('the entry carries the source the dialog used to set itself', async () => {
  const { db, txn } = await setup();
  const entry = db.get('entries', categoriseBankTxn(db, txn).journalId);
  assert.deepEqual(entry.source, { type: 'spend-money', id: txn.id });
});

test('every line links back to the bank line it came from', async () => {
  const { db, txn } = await setup();
  const entry = db.get('entries', categoriseBankTxn(db, txn).journalId);
  for (const line of entry.lines) {
    assert.equal(line.sourceDocId, txn.id, 'so the ledger can always say which bank line this was');
    assert.equal(line.sourceDocType, 'bank');
  }
});

test("a split's note reaches the ledger with the description, not instead of it", async () => {
  const { db, txn } = await setup();
  const entry = db.get('entries', categoriseBankTxn(db, txn).journalId);
  const paper = entry.lines.find((l) => l.description.includes('paper'));
  assert.equal(paper.description, 'SUPPLIES PLUS — paper', 'the description survives and the note is added');
  assert.equal(paper.accountCode, '6-0700');
  assert.equal(paper.debit, 18182 - 0 + 0, 'the note does not change what is posted');
  const plain = entry.lines.find((l) => l.accountCode === '6-0800');
  assert.equal(plain.description, 'SUPPLIES PLUS', 'no note leaves the description alone');
});

test('a file with GST but no GST account is refused rather than posted wrongly', async () => {
  const { db, company, txn } = await setup();
  // Remove the GST account the way a hand-edited chart might.
  const gst = db.of('accounts', company.id).find((a) => a.control === 'gstPaid');
  db.remove('accounts', gst.id);
  assert.throws(() => categoriseBankTxn(db, txn), /no "gstPaid" account exists/);
  assert.equal(db.of('entries', company.id).length, 0, 'and nothing half-formed is left behind');
});

test('a split that does not add up is refused, naming the difference', async () => {
  const { db, txn } = await setup();
  const bad = { ...txn, splits: [{ accountCode: '6-0700', taxCode: 'GST', amount: 10000 }] };
  assert.throws(() => categoriseBankTxn(db, bad), /short of|over/);
});
