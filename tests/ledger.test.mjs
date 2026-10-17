import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import {
  dr, cr, postEntry, validateEntry, voidEntry, nextNumber, accountBalance, balancesByAccount,
  accountLedger, turnoverByAccount,
} from '../app/core/ledger.js';

async function freshDb() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Test Co' });
  return { db, company };
}

test('a manual journal posts, balances and shows in the account', async () => {
  const { db, company } = await freshDb();
  const entry = postEntry(db, {
    companyId: company.id,
    date: '2026-07-05',
    memo: 'Owner investment',
    lines: [dr('1-0000', 500000, { description: 'Bank' }), cr('3-0100', 500000, { description: 'Capital' })],
    source: { type: 'journal', id: 'j1' },
  });
  assert.equal(entry.status, 'posted');
  assert.equal(entry.lines.length, 2);
  assert.equal(accountBalance(db.of('entries', company.id), '1-0000'), 500000);
  assert.equal(accountBalance(db.of('entries', company.id), '3-0100'), -500000);
});

test('an unbalanced entry is refused with a readable reason', async () => {
  const { db, company } = await freshDb();
  assert.throws(() => postEntry(db, {
    companyId: company.id,
    date: '2026-07-05',
    lines: [dr('1-0000', 500000), cr('3-0100', 400000)],
    source: { type: 'journal', id: 'bad1' },
  }), /Out of balance by 100000 cents/);
});

test('nonsense lines are each caught', async () => {
  const { db, company } = await freshDb();
  const accounts = db.of('accounts', company.id);
  const cases = [
    { lines: [dr('1-0000', 100)], why: /at least two lines/ },
    { lines: [dr('1-0000', 100), cr('3-0100', 100), cr('1-0000', -100)], why: /negative amount/ },
    { lines: [{ accountCode: '1-0000', debit: 100, credit: 100 }, cr('3-0100', 100)], why: /both a debit and a credit/ },
    { lines: [dr('', 100), cr('3-0100', 100)], why: /has no account/ },
    { lines: [dr('9-9999', 100), cr('3-0100', 100)], why: /does not exist in this company file/ },
    { lines: [dr('1-0000', 0), cr('3-0100', 0)], why: /has no amount/ },
    { lines: [dr('1-0000', 100), cr('3-0100', 100)], date: 'not-a-date', why: /not a valid date/ },
  ];
  for (const c of cases) {
    const res = validateEntry({ companyId: company.id, date: c.date || '2026-07-01', lines: c.lines }, { accounts });
    assert.equal(res.ok, false, `expected failure for ${c.why}`);
    assert.ok(res.errors.some((e) => c.why.test(e)), `expected ${c.why} in: ${res.errors.join(' | ')}`);
  }
});

test('a fractional cent can never enter the ledger', async () => {
  const { db, company } = await freshDb();
  assert.throws(() => postEntry(db, {
    companyId: company.id,
    date: '2026-07-01',
    lines: [{ accountCode: '1-0000', debit: 10.5, credit: 0 }, cr('3-0100', 10.5)],
    source: { type: 'journal', id: 'frac' },
  }), /whole cents/);
});

test('reposting the same source replaces the entry instead of doubling it', async () => {
  const { db, company } = await freshDb();
  const base = {
    companyId: company.id, date: '2026-07-05', memo: 'Rent',
    source: { type: 'spend-money', id: 'bank-1' },
  };
  postEntry(db, { ...base, lines: [dr('6-0800', 100000), cr('1-0000', 100000)] });
  postEntry(db, { ...base, lines: [dr('6-0800', 120000), cr('1-0000', 120000)] });
  const entries = db.of('entries', company.id);
  assert.equal(entries.length, 1, 'only one entry should exist for that source');
  assert.equal(accountBalance(entries, '6-0800'), 120000);
});

test('voiding keeps the audit trail but removes the money from reports', async () => {
  const { db, company } = await freshDb();
  const entry = postEntry(db, {
    companyId: company.id, date: '2026-07-05',
    lines: [dr('6-0700', 5500), cr('1-0000', 5500)],
    source: { type: 'journal', id: 'j2' },
  });
  voidEntry(db, entry.id, 'Entered twice');
  const stored = db.get('entries', entry.id);
  assert.equal(stored.status, 'void');
  assert.equal(stored.voidReason, 'Entered twice');
  assert.equal(accountBalance(db.of('entries', company.id), '6-0700'), 0);
  assert.equal(db.of('auditLog', company.id).some((a) => a.action === 'void'), true);
});

test('document numbers increment and never collide', async () => {
  const { db, company } = await freshDb();
  const first = nextNumber(db, company.id, 'invoice');
  assert.equal(first, 'INV-0001');
  db.put('documents', { companyId: company.id, type: 'invoice', number: first });
  assert.equal(nextNumber(db, company.id, 'invoice'), 'INV-0002');
  db.put('documents', { companyId: company.id, type: 'invoice', number: 'INV-0042' });
  assert.equal(nextNumber(db, company.id, 'invoice'), 'INV-0043');
  assert.equal(nextNumber(db, company.id, 'bill'), 'BILL-0001');
});

test('the general ledger rows add up to the account balance', async () => {
  const { db, company } = await freshDb();
  postEntry(db, { companyId: company.id, date: '2026-07-01', lines: [dr('1-0000', 300000), cr('3-0100', 300000)], source: { type: 'journal', id: 'a' } });
  postEntry(db, { companyId: company.id, date: '2026-07-02', lines: [dr('6-0700', 25000), cr('1-0000', 25000)], source: { type: 'journal', id: 'b' } });
  const rows = accountLedger(db.of('entries', company.id), '1-0000');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].balance, 275000);
  assert.equal(rows[1].balance, accountBalance(db.of('entries', company.id), '1-0000'));
});

test('turnover and balance agree over a window', async () => {
  const { db, company } = await freshDb();
  postEntry(db, { companyId: company.id, date: '2026-07-01', lines: [dr('1-0000', 100000), cr('3-0100', 100000)], source: { type: 'journal', id: 'a' } });
  postEntry(db, { companyId: company.id, date: '2026-08-01', lines: [dr('6-0700', 20000), cr('1-0000', 20000)], source: { type: 'journal', id: 'b' } });
  const entries = db.of('entries', company.id);
  const tv = turnoverByAccount(entries, { from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(tv.get('1-0000'), { debit: 100000, credit: 0 });
  const bal = balancesByAccount(entries, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(bal.get('1-0000'), -20000);
});
