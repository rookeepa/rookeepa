import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { incomeStatement } from '../app/core/reports.js';
import { postEntry, makeEntry, dr, cr } from '../app/core/ledger.js';

/*
 * Other income and other expenses (interest, and the like).
 *
 * These accounts sit outside trading, and the reason is margin reporting: interest the bank paid you is not
 * turnover, and a gross margin that includes a one-off receipt is not the business's margin. So the tests
 * here are mostly about what the split must *not* change — the trading figures — and about the P&L a
 * company that never separates anything still gets.
 */

const PERIOD = { from: '2026-07-01', to: '2026-09-30' };

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  // createCompany already lays down the default chart. Seeding it a second time here gave the company two
  // accounts sharing one code — the report iterates accounts but keys balances by code, so it counted the
  // same 10,000 twice. Harmless in the app (an account code cannot be duplicated through the UI) and a
  // trap in a fixture.
  const company = createCompany(db, { name: 'Split Co' });
  return { db, company };
}

/** Post a balanced two-line entry, dated inside the period. */
function post(db, company, codeDr, codeCr, cents, extra = {}) {
  return postEntry(db, makeEntry({
    companyId: company.id,
    date: '2026-08-15',
    memo: extra.memo || 'split test',
    lines: [dr(codeDr, cents, { taxCode: extra.taxCode }), cr(codeCr, cents, { taxCode: extra.taxCode })],
  }));
}

const pnl = (db, company) => incomeStatement({
  accounts: db.of('accounts', company.id),
  entries: db.of('entries', company.id),
  from: PERIOD.from,
  to: PERIOD.to,
});

test('interest is kept out of trading, so it cannot flatter the gross margin', async () => {
  const { db, company } = await setup();
  // Trading: 100,000 income, 40,000 cost of sales, 30,000 expenses. Outside trading: 5,000 interest
  // received, 1,200 interest paid.
  post(db, company, '1-0000', '4-0000', 10000000); // bank / sales
  post(db, company, '5-0000', '2-1000', 4000000); // cost of sales / payable
  post(db, company, '6-0800', '2-1000', 3000000); // an operating expense
  const interestIn = post(db, company, '1-0000', '4-0300', 500000, { taxCode: 'FRE' });
  const interestOut = post(db, company, '6-0500', '1-0000', 120000, { taxCode: 'FRE' });

  // The interest income is on an account of the new type, not lumped in with sales.
  const acct = db.of('accounts', company.id);
  assert.equal(acct.find((a) => a.code === '4-0300').type, 'otherIncome');
  assert.equal(acct.find((a) => a.code === '6-0500').type, 'otherExpenses');
  assert.ok(interestIn.number && interestOut.number);

  const is = pnl(db, company);
  assert.equal(is.totals.income, 10000000, 'turnover is trading income only');
  assert.equal(is.totals.grossProfit, 6000000, 'gross profit ignores interest received entirely');
  assert.equal(is.totals.grossMargin, 0.6, 'so the gross margin is the trading margin');
  assert.equal(is.totals.expenses, 3000000, 'interest paid is not an operating expense');
  assert.equal(is.totals.operatingProfit, 3000000);
  assert.equal(is.totals.otherIncome, 500000);
  assert.equal(is.totals.otherExpenses, 120000);
  assert.equal(is.totals.netProfit, 3380000, 'operating profit, then the interest');
  assert.equal(is.totals.netMargin, 0.338, 'net margin is on the trading turnover');

  // And they are grouped where the profit and loss screen can find them, not inside the trading groups.
  assert.deepEqual(is.groups.otherIncome.map((r) => r.code), ['4-0300']);
  assert.deepEqual(is.groups.otherExpenses.map((r) => r.code), ['6-0500']);
  assert.ok(!is.groups.income.some((r) => r.code === '4-0300'), 'never in both, or the totals would double-count');
  assert.ok(!is.groups.expense.some((r) => r.code === '6-0500'));
});

test('a business that separates nothing sees exactly the profit and loss it always saw', async () => {
  const { db, company } = await setup();
  post(db, company, '1-0000', '4-0000', 10000000);
  post(db, company, '5-0000', '2-1000', 4000000);
  post(db, company, '6-0800', '2-1000', 3000000);
  const is = pnl(db, company);
  assert.equal(is.totals.otherIncome, 0);
  assert.equal(is.totals.otherExpenses, 0);
  assert.equal(is.totals.operatingProfit, is.totals.netProfit, 'operating profit is the bottom line when there is nothing else');
  assert.equal(is.totals.netProfit, is.totals.grossProfit - is.totals.expenses, 'which is the figure it always was');
  assert.equal(is.totals.netMargin, is.totals.operatingProfit / is.totals.income);
});

test('an account re-typed to the new kinds keeps its history and moves in the report', async () => {
  const { db, company } = await setup();
  post(db, company, '1-0000', '4-0200', 2000000); // freight income, ordinary trading
  const acct = db.of('accounts', company.id).find((a) => a.code === '4-0200');
  db.put('accounts', { ...acct, type: 'otherIncome' });

  const is = pnl(db, company);
  assert.equal(is.totals.income, 0, 'it leaves turnover');
  assert.equal(is.totals.otherIncome, 2000000, 'and arrives under other income');
  assert.equal(is.totals.netProfit, 2000000, 'with the entries themselves untouched');
  assert.equal(db.of('entries', company.id).length, 1, 'nothing was re-posted to re-type an account');
});

test('the two new types have a natural side, so a balance is not shown inside out', async () => {
  const { db, company } = await setup();
  const { isDebitType, accountTypeLabel } = await import('../app/core/coa.js');
  assert.equal(isDebitType('otherExpenses'), true);
  assert.equal(isDebitType('otherIncome'), false);
  assert.equal(accountTypeLabel('otherIncome'), 'Other income');
  assert.equal(accountTypeLabel('otherExpenses'), 'Other expenses');
  // A credit balance on other income reads as a positive amount, like any other income account.
  post(db, company, '1-0000', '4-0300', 500000);
  const is = pnl(db, company);
  assert.equal(is.groups.otherIncome[0].amount, 500000);
});
