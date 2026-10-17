import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany, setOpeningBalances } from '../app/core/company.js';
import { balanceSheet, trialBalance } from '../app/core/reports.js';
import { accountBalance } from '../app/core/ledger.js';

/*
 * The journal is the only source of truth, so a balance field on an account must change nothing.
 *
 * Opening balances are a real feature, and they are a posted journal entry: Accounts → Opening balances writes
 * one, and it can only be changed by voiding it first. The `openingBalance` field carried on the account record
 * is left over from before that, and nothing reads it. These two tests pin both halves down — the field is
 * inert, and the feature works through the ledger — so that a future change cannot quietly start believing the
 * field and leave the two disagreeing.
 */

const snapshot = (db, companyId) => JSON.stringify({
  balanceSheet: balanceSheet({ accounts: db.of('accounts', companyId), entries: db.of('entries', companyId), asOf: '2026-07-31' }),
  trialBalance: trialBalance({ accounts: db.of('accounts', companyId), entries: db.of('entries', companyId), to: '2026-07-31' }),
});

test('an openingBalance field on an account changes nothing in any report', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Inert Co' });
  const bank = db.of('accounts', company.id).find((a) => a.control === 'bank');

  const before = snapshot(db, company.id);
  // Write a balance onto the account record, the way a seeded or imported account might carry one.
  db.put('accounts', { ...bank, openingBalance: 500000 }, { silent: true });

  assert.equal(snapshot(db, company.id), before, 'neither the balance sheet nor the trial balance noticed');
  assert.equal(accountBalance(db.of('entries', company.id), bank.code), 0, 'and the ledger holds nothing for it');
});

test('opening balances that are real work through the ledger, and re-saving replaces them', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Opening Co' });
  const bank = db.of('accounts', company.id).find((a) => a.control === 'bank');

  setOpeningBalances(db, company.id, [{ accountCode: bank.code, amount: 500000 }], '2026-07-01');
  const entries = db.of('entries', company.id).filter((e) => e.status === 'posted');
  assert.equal(entries.length, 1, 'one posted entry carries the opening balances');
  const debits = entries[0].lines.reduce((n, l) => n + (l.debit || 0), 0);
  const credits = entries[0].lines.reduce((n, l) => n + (l.credit || 0), 0);
  assert.equal(debits, credits, 'and it balances, with the remainder in the Historical Balancing Account');
  assert.equal(accountBalance(db.of('entries', company.id), bank.code), 500000, 'so the bank holds the figure entered');

  // Editing opening balances must replace the old entry, never add a second one.
  setOpeningBalances(db, company.id, [{ accountCode: bank.code, amount: 400000 }], '2026-07-01');
  const after = db.of('entries', company.id).filter((e) => e.status === 'posted');
  assert.equal(after.length, 1, 'saving again leaves one live opening entry, not two');
  assert.equal(accountBalance(db.of('entries', company.id), bank.code), 400000, 'with the new figure');
});
