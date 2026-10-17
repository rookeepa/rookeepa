import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { blankBankTxn, categoriseBankTxn, reconcileBankTxn, unreconcileBankTxn, excludeBankTxn, reconciliation } from '../app/core/docs.js';
import { balancesByAccount } from '../app/core/ledger.js';

/*
 * Ticking a coded line off against the statement.
 *
 * A line that has been categorised has posted its own entry, and that entry is the record the bank agrees
 * with — so ticking it off must change the line's status and nothing else. These tests pin the guards and,
 * more importantly, that the ledger is untouched and the reconciliation actually closes.
 */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Reconcile Co' });
  // The account travels on the transaction, which is how the coding dialog builds it — categoriseBankTxn
  // reads txn.categoryAccount, not an option.
  const txn = db.put('bankTxns', { ...blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-08-10',
    description: 'Office chairs', amount: -55000, status: 'unreconciled', type: 'spend',
    categoryAccount: '6-0700', taxCode: 'GST',
  }) });
  const coded = categoriseBankTxn(db, txn);
  return { db, company, txn, coded };
}

test('a coded line is waiting to be ticked off, and ticking it off changes only that', async () => {
  const { db, company, coded } = await setup();
  const row = db.get('bankTxns', coded.id);
  assert.equal(row.status, 'posted', 'categorising leaves it waiting, not reconciled');
  assert.ok(row.journalId, 'and posts an entry of its own');
  const entriesBefore = db.of('entries', company.id).length;
  const balanceBefore = balancesByAccount(db.of('entries', company.id), {}).get('1-0000');

  const after = reconcileBankTxn(db, row);
  assert.equal(after.status, 'reconciled');
  assert.equal(db.get('bankTxns', coded.id).status, 'reconciled', 'and it is saved, not just returned');
  assert.equal(db.of('entries', company.id).length, entriesBefore, 'nothing is posted by ticking a line off');
  assert.equal(db.get('entries', row.journalId).status, 'posted', 'the entry it already had is untouched');
  assert.equal(balancesByAccount(db.of('entries', company.id), {}).get('1-0000'), balanceBefore);
});

test('ticking it off closes the reconciliation, which is the whole point', async () => {
  const { db, company, coded } = await setup();
  const bank = db.of('accounts', company.id).find((a) => a.code === '1-0000');
  const before = reconciliation(db, company.id, bank.code, '2026-08-31');
  assert.equal(before.clearedMovement, 0, 'a coded line is not in the cleared total yet');
  assert.equal(before.difference, before.ledgerBalance, 'so the whole ledger balance is the gap');
  reconcileBankTxn(db, db.get('bankTxns', coded.id));
  const after = reconciliation(db, company.id, bank.code, '2026-08-31');
  assert.equal(after.clearedMovement, -55000, 'and ticking it off puts it in');
  assert.equal(after.difference, before.difference - (-55000), 'closing the gap by exactly its amount');
  assert.equal(after.unreconciledCount, 0, 'with nothing left to review');
});

test('reconciling twice is a no-op, and un-reconciling puts it back to waiting', async () => {
  const { db, coded } = await setup();
  const once = reconcileBankTxn(db, db.get('bankTxns', coded.id));
  const twice = reconcileBankTxn(db, once);
  assert.equal(twice.status, 'reconciled');
  const back = unreconcileBankTxn(db, twice);
  assert.equal(back.status, 'posted', 'a line with its own entry goes back to waiting, so it can be re-ticked');
  const again = reconcileBankTxn(db, back);
  assert.equal(again.status, 'reconciled', 'and round the loop again without anything being posted');
});

test('a line with no entry of its own is refused, and told what to do instead', async () => {
  const { db, company } = await setup();
  const plain = db.put('bankTxns', { ...blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-08-10',
    description: 'Uncoded', amount: -1000, status: 'unreconciled', type: 'spend',
  }) });
  assert.throws(() => reconcileBankTxn(db, plain), /match it to something already in your books, or categorise it first/);
});

test('an excluded line cannot be ticked off until it is reinstated', async () => {
  const { db, company } = await setup();
  const plain = db.put('bankTxns', { ...blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-08-11',
    description: 'Duplicate of a line', amount: -1000, status: 'unreconciled', type: 'spend',
  }) });
  const excluded = excludeBankTxn(db, plain, 'duplicate');
  assert.equal(excluded.status, 'excluded');
  assert.throws(() => reconcileBankTxn(db, excluded), /excluded from reconciliation/);
});
