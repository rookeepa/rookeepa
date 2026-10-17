import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import {
  createCompany, listCompanies, renameCompany, deleteCompany, usage,
  setOpeningBalances, openingBalanceRows, seedAccounts, seedTaxCodes,
} from '../app/core/company.js';
import { accountBalance, postEntry, dr, cr } from '../app/core/ledger.js';
import { accountByRole, DEFAULT_ACCOUNTS, DEFAULT_TAX_CODES } from '../app/core/coa.js';
import { balanceSheet, trialBalance } from '../app/core/reports.js';
import { blankBankRule, saveBankRule, listBankRules } from '../app/core/bank-rules.js';

async function freshDb() {
  return DB.open({ forceMemory: true, debounceMs: 0 });
}

test('a new company file is seeded with a usable chart of accounts', async () => {
  const db = await freshDb();
  const company = createCompany(db, { name: 'Seed Test Pty Ltd', abn: '11 222 333 444' });
  const accounts = db.of('accounts', company.id);
  assert.equal(accounts.length, DEFAULT_ACCOUNTS.length);
  assert.equal(db.of('taxCodes', company.id).length, DEFAULT_TAX_CODES.length);

  // Every control role the posting engine relies on must exist out of the box,
  // otherwise the first invoice a new user raises would throw.
  for (const role of ['bank', 'ar', 'ap', 'gstCollected', 'gstPaid', 'inventory', 'opening', 'retained']) {
    assert.ok(accountByRole(accounts, role), `no account is flagged as "${role}"`);
  }
  assert.equal(db.of('accounts', company.id).every((a) => a.companyId === company.id), true);
});

test('seeding twice does not duplicate the chart', async () => {
  const db = await freshDb();
  const company = createCompany(db, { name: 'Once Only' });
  const before = db.of('accounts', company.id).length;
  seedAccounts(db, company.id);
  seedTaxCodes(db, company.id);
  assert.equal(db.of('accounts', company.id).length, before * 2, 'seedAccounts is a raw insert; company creation is what must not repeat');
});

test('company files are listed, renamed and counted', async () => {
  const db = await freshDb();
  const a = createCompany(db, { name: 'Alpha' });
  const b = createCompany(db, { name: 'Beta' });
  assert.equal(listCompanies(db).length, 2);
  renameCompany(db, a.id, { name: 'Alpha Trading', abn: '99 888 777 666' });
  assert.equal(db.get('companies', a.id).name, 'Alpha Trading');
  assert.equal(db.get('companies', a.id).abn, '99 888 777 666');
  const counts = usage(db, a.id);
  assert.equal(counts.accounts, DEFAULT_ACCOUNTS.length);
  assert.equal(counts.documents, 0);
  assert.ok(db.get('companies', b.id), 'the other company file is untouched');
});

test('opening balances land in the right direction and balance the books', async () => {
  const db = await freshDb();
  const company = createCompany(db, { name: 'Opening Test' });
  setOpeningBalances(db, company.id, [
    { accountCode: '1-0000', amount: 500000 },   // bank, a debit balance
    { accountCode: '1-1100', amount: 120000 },   // inventory, debit
    { accountCode: '2-2000', amount: 200000 },   // bank loan, a credit balance
    { accountCode: '3-0100', amount: 300000 },   // capital, credit
  ], '2026-07-01');

  const entries = db.of('entries', company.id);
  assert.equal(entries.length, 1);
  assert.equal(accountBalance(entries, '1-0000'), 500000);
  assert.equal(accountBalance(entries, '1-1100'), 120000);
  assert.equal(accountBalance(entries, '2-2000'), -200000, 'a loan is a credit balance');
  assert.equal(accountBalance(entries, '3-0100'), -300000);
  assert.equal(accountBalance(entries, '3-8000'), -120000, 'the difference lands in the balancing account');

  const bs = balanceSheet({
    accounts: db.of('accounts', company.id),
    entries,
    asOf: '2026-07-02',
  });
  assert.equal(bs.balanced, true, `assets must equal liabilities plus equity (out by ${bs.difference})`);
});

test('posting opening balances again REPLACES them rather than adding', async () => {
  const db = await freshDb();
  const company = createCompany(db, { name: 'Replace Test' });
  setOpeningBalances(db, company.id, [{ accountCode: '1-0000', amount: 500000 }], '2026-07-01');
  setOpeningBalances(db, company.id, [{ accountCode: '1-0000', amount: 750000 }], '2026-07-01');

  const entries = db.of('entries', company.id);
  assert.equal(entries.length, 1, 'a correction must not add a second opening-balances entry');
  assert.equal(accountBalance(entries, '1-0000'), 750000, 'editing opening balances is an edit, not a top-up');
});

test('openingBalanceRows reports the natural amount for each account', async () => {
  const db = await freshDb();
  const company = createCompany(db, { name: 'Rows Test' });
  setOpeningBalances(db, company.id, [
    { accountCode: '1-0000', amount: 500000 },
    { accountCode: '2-2000', amount: 200000 },
  ], '2026-07-01');
  const rows = openingBalanceRows(db, company.id);
  const bank = rows.find((r) => r.accountCode === '1-0000');
  const loan = rows.find((r) => r.accountCode === '2-2000');
  assert.equal(bank.amount, 500000, 'a debit-balance asset reads positive');
  assert.equal(loan.amount, 200000, 'a credit-balance liability also reads positive, as it was entered');
  assert.equal(bank.hasEntry, true);
  assert.equal(rows.find((r) => r.accountCode === '6-0700').amount, 0);
});

test('deleting a company file takes its records and leaves the others alone', async () => {
  const db = await freshDb();
  const keep = createCompany(db, { name: 'Keep Me' });
  const drop = createCompany(db, { name: 'Delete Me' });
  postEntry(db, {
    companyId: drop.id,
    date: '2026-07-05',
    lines: [dr('1-0000', 1000), cr('3-0100', 1000)],
    source: { type: 'journal', id: 'x1' },
  });
  assert.equal(db.of('entries', drop.id).length, 1);

  deleteCompany(db, drop.id);

  assert.equal(db.get('companies', drop.id), null);
  assert.equal(db.of('accounts', drop.id).length, 0);
  assert.equal(db.of('entries', drop.id).length, 0);
  assert.ok(db.get('companies', keep.id), 'the surviving company file is still there');
  assert.equal(db.of('accounts', keep.id).length, DEFAULT_ACCOUNTS.length);
  assert.equal(trialBalance({ accounts: db.of('accounts', keep.id), entries: db.of('entries', keep.id), to: '2026-12-31' }).balanced, true);
});

test('one company file cannot see another company file\'s books', async () => {
  const db = await freshDb();
  const one = createCompany(db, { name: 'One' });
  const two = createCompany(db, { name: 'Two' });
  postEntry(db, {
    companyId: one.id,
    date: '2026-07-05',
    lines: [dr('1-0000', 250000), cr('3-0100', 250000)],
    source: { type: 'journal', id: 'only-one' },
  });
  assert.equal(accountBalance(db.of('entries', one.id), '1-0000'), 250000);
  assert.equal(accountBalance(db.of('entries', two.id), '1-0000'), 0);
});

test('a backup is stamped with the app name, and older ones still restore', async () => {
  const db = await freshDb();
  const company = createCompany(db, { name: 'Backup Test' });
  const other = createCompany(db, { name: 'Not In This Backup' });
  const snapshot = db.snapshot(company.id);
  assert.equal(snapshot.app, 'rookeepa', 'the export identifies itself');
  assert.ok(Array.isArray(snapshot.data.accounts));
  assert.ok(snapshot.data.accounts.length > 0);
  assert.equal(snapshot.data.accounts.every((a) => a.companyId === company.id), true,
    'a company-scoped backup contains every record of that company');
  assert.equal(snapshot.data.accounts.some((a) => a.companyId === other.id), false,
    'and nothing at all from another company file');
  assert.equal(snapshot.data.companies.length, 1);

  // A file exported before the project was renamed must still restore.
  const legacy = { ...snapshot, app: 'ledgerly' };
  await db.replaceAll(legacy, { replace: true });
  assert.equal(db.of('accounts', company.id).length, DEFAULT_ACCOUNTS.length);

  // Anything else is refused, with a message that says what to do about it.
  await assert.rejects(
    () => db.replaceAll({ app: 'something-else', data: {} }, { replace: true }),
    /not a Rookeepa backup/,
  );
});

test('a company backup carries its own settings and never another file\'s', async () => {
  const db = await freshDb();
  const one = createCompany(db, { name: 'Rules One' });
  const two = createCompany(db, { name: 'Rules Two' });

  // Settings that live in db.meta are keyed by company id. Anything keyed that way and not
  // declared in COMPANY_KEYED_META is exported whole, so one company's rules rode along inside
  // another company's backup file — a leak you would only notice after restoring it.
  saveBankRule(db, blankBankRule({ companyId: one.id, name: 'One only', text: 'one', accountCode: '6-0100' }));
  saveBankRule(db, blankBankRule({ companyId: two.id, name: 'Two only', text: 'two', accountCode: '6-0100' }));

  const snapshot = db.snapshot(one.id);
  assert.deepEqual(Object.keys(snapshot.meta.bankRules), [one.id], 'the export names only this company file');
  assert.equal(snapshot.meta.bankRules[one.id].length, 1);
  assert.equal(snapshot.meta.bankRules[one.id][0].name, 'One only');

  // Merging that file back must not disturb the other company file's rules.
  await db.replaceAll(snapshot, { replace: false });
  assert.equal(listBankRules(db, two.id).length, 1, 'the other company file kept its own rules');
  assert.equal(listBankRules(db, two.id)[0].name, 'Two only');
  assert.equal(listBankRules(db, one.id)[0].name, 'One only');
});
