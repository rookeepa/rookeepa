import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { blankBankTxn, categoriseBankTxn } from '../app/core/docs.js';
import { entryTotals } from '../app/core/ledger.js';
import {
  blankBankRule, matchRule, suggestFor, applyRules,
  listBankRules, saveBankRule, deleteBankRule,
} from '../app/core/bank-rules.js';

/*
 * Bank rules file an imported statement line against an account when its
 * description looks familiar. Each test is written to fail against a naive
 * implementation — one that compares case-sensitively, ignores direction, takes
 * the first match regardless of how specific it is, or re-files lines it should
 * leave alone — so the behaviour is pinned rather than described.
 */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Rules Co' });
  const supplier = db.put('contacts', { companyId: company.id, name: 'Woolworths', isSupplier: true, terms: 'net30' });
  return { db, company, supplier };
}

/** A rule, defaulted to something sensible so each test only states its point. */
const rule = (o = {}) => blankBankRule({ companyId: 'c1', accountCode: '6-0700', direction: 'any', ...o });
/** A bank line, defaulted to a small payment out. */
const txn = (o = {}) => blankBankTxn({ companyId: 'c1', accountCode: '1-0000', description: '', amount: -1000, ...o });

/* ------------------------------------------------------------------ matching */

test('a rule matches the description regardless of case and stray spaces', () => {
  const r = rule({ match: 'contains', text: '  woolworths mkt  ' });

  assert.ok(matchRule([r], txn({ description: 'WOOLWORTHS MKT #1234', amount: -2500 })),
    'an upper-case description matches a lower-case rule');
  assert.equal(matchRule([r], txn({ description: 'woolworths mkt #1234' })).id, r.id);
  assert.ok(matchRule([r], txn({ description: '   Woolworths MKT #1234   ' })),
    'surrounding spaces on the line are trimmed before comparing');
  assert.equal(matchRule([r], txn({ description: 'Coles 1234' })), null,
    'a different merchant is not a match');
});

test('direction keeps a rule to money in or money out', () => {
  const inn = rule({ match: 'contains', text: 'acme', direction: 'in' });
  const out = rule({ match: 'contains', text: 'acme', direction: 'out' });
  const any = rule({ match: 'contains', text: 'acme', direction: 'any' });
  const incoming = txn({ description: 'ACME PAYMENT', amount: 5000 });
  const outgoing = txn({ description: 'ACME PAYMENT', amount: -5000 });

  assert.equal(matchRule([inn], incoming).id, inn.id);
  assert.equal(matchRule([inn], outgoing), null, 'money out is not money in');
  assert.equal(matchRule([out], outgoing).id, out.id);
  assert.equal(matchRule([out], incoming), null, 'money in is not money out');
  assert.equal(matchRule([any], incoming).id, any.id);
  assert.equal(matchRule([any], outgoing).id, any.id);

  // Zero is neither in nor out, so a directional rule cannot claim it.
  assert.equal(matchRule([inn, out], txn({ description: 'ACME', amount: 0 })), null);
});

test('the most specific rule wins: equals beats starts-with beats contains', () => {
  const contains = rule({ match: 'contains', text: 'rent' });
  const starts = rule({ match: 'starts-with', text: 'rent' });
  const equals = rule({ match: 'equals', text: 'rent' });
  const exactLine = txn({ description: 'rent' });

  assert.equal(matchRule([contains, starts, equals], exactLine).id, equals.id);
  assert.equal(matchRule([contains, starts], exactLine).id, starts.id);
  assert.equal(matchRule([contains], exactLine).id, contains.id);

  // The list order must not change the ranking.
  assert.equal(matchRule([equals, starts, contains], txn({ description: 'RENT' })).id, equals.id);
  assert.equal(matchRule([starts, contains], txn({ description: 'rent paid' })).id, starts.id);
});

test('two equally specific rules go to the earlier one in the list', () => {
  const first = rule({ name: 'first', match: 'contains', text: 'fuel' });
  const second = rule({ name: 'second', match: 'contains', text: 'fuel' });
  const line = txn({ description: 'FUEL STOP' });

  assert.equal(matchRule([first, second], line).id, first.id);
  assert.equal(matchRule([second, first], line).id, second.id, 'the list order is the tie-breaker');
});

test('a paused rule is skipped, even when it is the more specific one', () => {
  const live = rule({ name: 'live', match: 'contains', text: 'adobe', active: true });
  const paused = rule({ name: 'paused', match: 'equals', text: 'adobe', active: false });
  const line = txn({ description: 'adobe', amount: -2900 });

  assert.equal(matchRule([paused, live], line).id, live.id);
  assert.equal(matchRule([paused], line), null, 'a paused rule matches nothing');
});

test('no match gives null, and a rule with no text never matches anything', () => {
  assert.equal(matchRule([rule({ match: 'contains', text: 'xero' })], txn({ description: 'Adobe' })), null);
  assert.equal(matchRule([], txn({ description: 'anything' })), null);
  assert.equal(matchRule([rule({ match: 'contains', text: '' })], txn({ description: '' })), null,
    'an empty rule must not become a catch-all');
  assert.equal(suggestFor([rule({ match: 'contains', text: 'xero' })], txn({ description: 'Adobe' })), null);
});

test('suggestFor reports the account, tax code, contact and rule that matched', () => {
  const r = rule({
    match: 'contains', text: 'woolworths', direction: 'out',
    accountCode: '6-0700', taxCode: 'FRE', contactId: 'con_1',
  });
  const s = suggestFor([r], txn({ description: 'WOOLWORTHS MKT', amount: -1234 }));

  assert.ok(s);
  assert.equal(s.accountCode, '6-0700');
  assert.equal(s.taxCode, 'FRE');
  assert.equal(s.contactId, 'con_1');
  assert.equal(s.ruleId, r.id);
});

/* ------------------------------------------------------------------- storage */

test('rules are stored per company file and can be removed', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const a = createCompany(db, { name: 'Alpha' });
  const b = createCompany(db, { name: 'Beta' });

  const saved = saveBankRule(db, blankBankRule({ companyId: a.id, name: 'Woolies', text: 'woolworths', accountCode: '6-0700' }));
  assert.equal(listBankRules(db, a.id).length, 1);
  assert.equal(listBankRules(db, b.id).length, 0, "one company file's rules are not another's");

  assert.equal(deleteBankRule(db, a.id, saved.id), true);
  assert.equal(listBankRules(db, a.id).length, 0);
  assert.equal(deleteBankRule(db, a.id, saved.id), false, 'deleting a rule that is gone changes nothing');
});

/* ------------------------------------------------------------------ applying */

test('applyRules files the uncategorised lines that match, posting balanced journals', async () => {
  const { db, company, supplier } = await setup();
  const cid = company.id;

  saveBankRule(db, blankBankRule({
    companyId: cid, name: 'Woolies', match: 'contains', text: 'woolworths',
    direction: 'out', accountCode: '6-0700', taxCode: 'GST', contactId: supplier.id,
  }));
  saveBankRule(db, blankBankRule({
    companyId: cid, name: 'Rent', match: 'contains', text: 'rent',
    direction: 'out', accountCode: '6-0800', taxCode: 'GST',
  }));

  const groceries = db.put('bankTxns', blankBankTxn({
    companyId: cid, accountCode: '1-0000', date: '2026-07-05', description: 'WOOLWORTHS MKT 1234',
    amount: -5500, importedFrom: 'stmt.csv', status: 'unreconciled',
  }));
  const rent = db.put('bankTxns', blankBankTxn({
    companyId: cid, accountCode: '1-0000', date: '2026-07-06', description: 'Rent July',
    amount: -220000, importedFrom: 'stmt.csv', status: 'unreconciled',
  }));
  const unmatched = db.put('bankTxns', blankBankTxn({
    companyId: cid, accountCode: '1-0000', date: '2026-07-07', description: 'Some other shop',
    amount: -1000, importedFrom: 'stmt.csv', status: 'unreconciled',
  }));

  const result = applyRules(db, cid);
  assert.equal(result.applied, 2);
  assert.deepEqual(result.matched.slice().sort(), [groceries.id, rent.id].sort());
  assert.ok(result.skipped.includes(unmatched.id), 'a line no rule matches is reported as skipped');

  // The groceries line posted an ordinary, balanced Spend money entry.
  const gEntry = db.get('entries', db.get('bankTxns', groceries.id).journalId);
  assert.ok(gEntry, 'the groceries line was posted');
  const totals = entryTotals(gEntry);
  assert.equal(totals.debit, totals.credit, 'the posted journal balances');
  assert.equal(totals.debit, 5500);
  assert.ok(gEntry.lines.some((l) => l.accountCode === '6-0700' && l.debit === 5000), 'the net went to the expense account');
  assert.ok(gEntry.lines.some((l) => l.accountCode === '1-1300' && l.debit === 500), 'the GST went to GST paid');
  assert.ok(gEntry.lines.some((l) => l.accountCode === '1-0000' && l.credit === 5500), 'the bank was credited in full');

  // The line now carries the rule's account, tax code and contact, and is settled.
  const savedGroceries = db.get('bankTxns', groceries.id);
  assert.equal(savedGroceries.categoryAccount, '6-0700');
  assert.equal(savedGroceries.taxCode, 'GST');
  assert.equal(savedGroceries.contactId, supplier.id);
  assert.equal(savedGroceries.status, 'reconciled', 'an imported line becomes reconciled once filed');

  // Each rule filed to its own account.
  const rEntry = db.get('entries', db.get('bankTxns', rent.id).journalId);
  assert.ok(rEntry.lines.some((l) => l.accountCode === '6-0800'), 'the rent went to the rent account, not the groceries one');
});

test('applyRules never touches a line that is already reconciled', async () => {
  const { db, company } = await setup();
  const cid = company.id;
  saveBankRule(db, blankBankRule({
    companyId: cid, name: 'Woolies', match: 'contains', text: 'woolworths', direction: 'out', accountCode: '6-0700',
  }));

  const settled = db.put('bankTxns', blankBankTxn({
    companyId: cid, accountCode: '1-0000', date: '2026-07-05', description: 'WOOLWORTHS MKT 1234',
    amount: -5500, status: 'reconciled', categoryAccount: '6-0700', journalId: 'entry-settled',
  }));
  const before = JSON.stringify(db.get('bankTxns', settled.id));

  const result = applyRules(db, cid);
  assert.equal(result.applied, 0);
  assert.ok(result.skipped.includes(settled.id));
  assert.equal(JSON.stringify(db.get('bankTxns', settled.id)), before, 'the reconciled line is byte-for-byte unchanged');
  assert.equal(db.of('entries', cid).filter((e) => e.source?.id === settled.id).length, 0, 'nothing new was posted for it');
});

test('onlyUncategorised (the default) leaves a line that is already posted alone', async () => {
  const { db, company } = await setup();
  const cid = company.id;
  saveBankRule(db, blankBankRule({
    companyId: cid, name: 'Woolies', match: 'contains', text: 'woolworths', direction: 'out', accountCode: '6-0000',
  }));

  // A hand-typed line, categorised by the user against a different account.
  const posted = db.put('bankTxns', blankBankTxn({
    companyId: cid, accountCode: '1-0000', date: '2026-07-05', description: 'WOOLWORTHS MKT 1234',
    amount: -5500, status: 'posted',
  }));
  categoriseBankTxn(db, { ...db.get('bankTxns', posted.id), categoryAccount: '6-0300', taxCode: 'GST' });
  assert.equal(db.get('bankTxns', posted.id).categoryAccount, '6-0300');

  const result = applyRules(db, cid);
  assert.equal(result.applied, 0, 'an already-posted line is not re-filed');
  assert.ok(result.skipped.includes(posted.id));
  assert.equal(db.get('bankTxns', posted.id).categoryAccount, '6-0300', 'it keeps the account the user chose');
});

test('applying the rules twice does nothing the second time', async () => {
  const { db, company } = await setup();
  const cid = company.id;
  saveBankRule(db, blankBankRule({
    companyId: cid, name: 'Woolies', match: 'contains', text: 'woolworths', direction: 'out', accountCode: '6-0700',
  }));
  db.put('bankTxns', blankBankTxn({
    companyId: cid, accountCode: '1-0000', date: '2026-07-05', description: 'WOOLWORTHS MKT',
    amount: -5500, importedFrom: 'stmt.csv', status: 'unreconciled',
  }));

  const first = applyRules(db, cid);
  assert.equal(first.applied, 1);
  const journalCount = () => db.of('entries', cid).filter((e) => e.status === 'posted').length;
  const afterFirst = journalCount();

  const second = applyRules(db, cid);
  assert.equal(second.applied, 0);
  assert.equal(journalCount(), afterFirst, 'no second journal is posted');
});
