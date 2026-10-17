import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import {
  blankBankTxn, categoriseBankTxn, excludeBankTxn, reinstateBankTxn, unreconcileBankTxn,
  undoBankTxnCategorisation,
} from '../app/core/docs.js';
import { postedEntries } from '../app/core/ledger.js';

/*
 * Excluding a line, and putting it back.
 *
 * The cases that matter are the two ways this can quietly do damage. Reinstating a categorised line as
 * "unreconciled" would invite it to be categorised again, and categorising it again posts a second
 * entry — money in the ledger twice. And excluding a reconciled line would leave the reconciliation
 * saying one thing and the line another.
 */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Exclude Co' });
  const accounts = db.of('accounts', company.id);
  const bank = accounts.find((a) => a.code === (company.bankAccount || '1-0000'));
  const expense = accounts.find((a) => a.type === 'expense');
  const taxCodes = db.of('taxCodes', company.id);
  return { db, company, bank, expense, gst: taxCodes.find((t) => t.code === 'GST') };
}

const line = (f, over = {}) => f.db.put('bankTxns', {
  id: 'btx1', companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-09',
  description: 'EXCLUDE ME', amount: -4400, status: 'unreconciled', ...over,
});

test('excluding keeps the reason and is in the audit log', async () => {
  const f = await setup();
  line(f);
  const saved = excludeBankTxn(f.db, 'btx1', 'personal — not the business');
  assert.equal(saved.status, 'excluded');
  assert.equal(saved.note, 'personal — not the business');
  assert.ok(f.db.of('auditLog', f.company.id).some((a) => a.action === 'exclude' && a.entityId === 'btx1'));
});

test('excluding writes nothing to the ledger and leaves a categorised line categorised', async () => {
  const f = await setup();
  line(f, { categoryAccount: f.expense.code, taxCode: f.gst.code });
  const posted = categoriseBankTxn(f.db, f.db.get('bankTxns', 'btx1'));
  const before = postedEntries(f.db.of('entries', f.company.id)).length;
  const excluded = excludeBankTxn(f.db, posted, 'not this year');
  assert.equal(excluded.journalId, posted.journalId, 'the entry is untouched');
  assert.equal(postedEntries(f.db.of('entries', f.company.id)).length, before);
});

test('reinstating a categorised line returns it to posted, so it cannot be posted twice', async () => {
  const f = await setup();
  line(f, { categoryAccount: f.expense.code, taxCode: f.gst.code });
  const posted = categoriseBankTxn(f.db, f.db.get('bankTxns', 'btx1'));
  const reinstated = reinstateBankTxn(f.db, excludeBankTxn(f.db, posted, 'oops'));
  assert.equal(reinstated.status, 'posted', 'still categorised, so nothing offers to categorise it again');
  assert.equal(reinstated.journalId, posted.journalId);
  assert.equal(reinstated.note, '', 'and the exclusion note goes with the exclusion');
  // The entry it posted is still the only one.
  assert.equal(postedEntries(f.db.of('entries', f.company.id)).length, 1);
});

test('reinstating an uncategorised line returns it to review', async () => {
  const f = await setup();
  line(f);
  const reinstated = reinstateBankTxn(f.db, excludeBankTxn(f.db, 'btx1', 'no'));
  assert.equal(reinstated.status, 'unreconciled');
});

test('a reconciled line cannot be excluded, and only an excluded line can be reinstated', async () => {
  const f = await setup();
  line(f, { status: 'reconciled', matchedEntryId: 'e1' });
  assert.throws(() => excludeBankTxn(f.db, 'btx1'), /un-reconcile this line before/i);
  line(f, { status: 'posted' });
  assert.throws(() => reinstateBankTxn(f.db, 'btx1'), /only an excluded line/i);
});

test('excluding twice is not an error — a batch can skip what is already done', async () => {
  const f = await setup();
  line(f);
  excludeBankTxn(f.db, 'btx1', 'first');
  const again = excludeBankTxn(f.db, 'btx1', 'second');
  assert.equal(again.status, 'excluded');
  assert.equal(again.note, 'first', 'and the first reason is not overwritten by a no-op');
});

test('un-reconciling a matched line unmatches it, leaving the other side alone', async () => {
  // The second-batch item asked for an "unmatch" button; un-reconciling is what it does, so this pins
  // that down rather than leaving it as a claim.
  const f = await setup();
  f.db.put('payments', { id: 'p1', companyId: f.company.id, journalId: 'e7', amount: 4400, date: '2026-10-09' });
  line(f, { status: 'reconciled', journalId: 'e7', docId: 'doc1', matchedEntryId: 'e9' });
  const back = unreconcileBankTxn(f.db, 'btx1');
  assert.equal(back.matchedEntryId, null, 'the match is gone');
  assert.equal(back.docId, null, 'and the document link with it');
  assert.ok(f.db.get('payments', 'p1'), 'the payment stays — it was real money');
});

test('a whole batch can be walked with each line attempted on its own terms', async () => {
  // What the bulk bar does: try each line, count what worked, name what did not. A batch must not stop
  // at the first line it cannot act on, and must not report success for a line it skipped.
  const f = await setup();
  f.db.put('bankTxns', { id: 'b1', companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-09', description: 'A', amount: -100, status: 'reconciled', journalId: 'e1' });
  f.db.put('bankTxns', { id: 'b2', companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-09', description: 'B', amount: -100, status: 'posted', journalId: 'e2' });
  f.db.put('bankTxns', { id: 'b3', companyId: f.company.id, accountCode: f.bank.code, date: '2026-10-09', description: 'C', amount: -100, status: 'unreconciled' });

  const done = [];
  const refused = [];
  for (const id of ['b1', 'b2', 'b3']) {
    try { done.push(unreconcileBankTxn(f.db, id).id); } catch (err) { refused.push(`${id}: ${err.message}`); }
  }
  assert.deepEqual(done, ['b1'], 'only the reconciled line could be un-reconciled');
  assert.equal(refused.length, 2, 'and the other two said why');
  assert.match(refused[0], /only a reconciled line/i);

  // Reversing works through the same loop. b3 has no entry yet, so it refuses; then it is categorised
  // for real and reversed, and its entry stops counting.
  assert.throws(() => undoBankTxnCategorisation(f.db, 'b3'), /nothing to undo/i);
  const posted = categoriseBankTxn(f.db, {
    ...f.db.get('bankTxns', 'b3'), categoryAccount: f.expense.code, taxCode: f.gst.code,
  });
  assert.equal(postedEntries(f.db.of('entries', f.company.id)).length, 1);
  const reversed = undoBankTxnCategorisation(f.db, posted);
  assert.equal(reversed.status, 'unreconciled', 'back in review, ready to re-code');
  assert.equal(postedEntries(f.db.of('entries', f.company.id)).length, 0, 'its entry is voided, not counted');
});
