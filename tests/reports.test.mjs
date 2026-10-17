import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { seedDemoCompany } from '../app/core/sample.js';
import {
  incomeStatement, balanceSheet, trialBalance, generalLedgerReport, journalReport,
  agedReport, basSummary, cashFlow, monthlyPnl, dashboardKpis,
} from '../app/core/reports.js';
import { accountBalance, balancesByAccount } from '../app/core/ledger.js';
import { fyStartFor, fyEndFor, todayISO, addDays, startOfMonth } from '../app/core/dates.js';
import { sum } from '../app/core/money.js';
import { computeDocument, documentSummary } from '../app/core/docs.js';
import { reconciliation } from '../app/core/docs.js';

const AS_OF = '2026-09-30';

async function demo() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = seedDemoCompany(db, { asOf: AS_OF });
  return {
    db,
    company,
    accounts: db.of('accounts', company.id),
    entries: db.of('entries', company.id),
    taxCodes: db.of('taxCodes', company.id),
    documents: db.of('documents', company.id),
    payments: db.of('payments', company.id),
  };
}

test('the demo books post cleanly: every entry balances', async () => {
  const { entries } = await demo();
  assert.ok(entries.length > 15);
  for (const e of entries.filter((x) => x.status === 'posted')) {
    const d = sum(e.lines.map((l) => l.debit));
    const c = sum(e.lines.map((l) => l.credit));
    assert.equal(d, c, `entry ${e.number || e.id} is out of balance`);
    assert.ok(d > 0, 'an entry with no money in it should never be posted');
  }
});

test('the trial balance balances and closes to zero', async () => {
  const { accounts, entries } = await demo();
  const tb = trialBalance({ accounts, entries, to: AS_OF });
  assert.equal(tb.totals.debit, tb.totals.credit, 'debits equal credits');
  assert.equal(tb.totals.closing, 0, 'every account nets to zero across the whole ledger');
  assert.equal(tb.totals.closingDebit, tb.totals.closingCredit);
  assert.ok(tb.balanced);

  const withOpening = trialBalance({ accounts, entries, from: '2026-07-01', to: AS_OF });
  assert.equal(withOpening.totals.opening, 0, 'a full-period trial balance opens at zero');
  assert.equal(withOpening.totals.debit, withOpening.totals.credit);
});

test('the balance sheet balances, whatever the date', async () => {
  const { accounts, entries } = await demo();
  for (const asOf of ['2026-07-01', '2026-08-15', AS_OF, '2027-01-31']) {
    const bs = balanceSheet({ accounts, entries, asOf });
    assert.equal(bs.difference, 0, `assets must equal liabilities plus equity at ${asOf}`);
    assert.ok(bs.balanced);
  }
});

test('profit and loss equals the movement in the profit and loss accounts', async () => {
  const { accounts, entries } = await demo();
  const from = '2026-07-01';
  const is = incomeStatement({ accounts, entries, from, to: AS_OF });
  const bal = balancesByAccount(entries, { from, to: AS_OF });
  let income = 0;
  let cogs = 0;
  let expenses = 0;
  let otherIncome = 0;
  let otherExpenses = 0;
  for (const a of accounts) {
    const signed = bal.get(a.code) || 0;
    if (a.type === 'income') income += -signed;
    else if (a.type === 'costOfSales') cogs += signed;
    else if (a.type === 'expense') expenses += signed;
    else if (a.type === 'otherIncome') otherIncome += -signed;
    else if (a.type === 'otherExpenses') otherExpenses += signed;
  }
  assert.equal(is.totals.income, income);
  assert.equal(is.totals.costOfSales, cogs);
  assert.equal(is.totals.expenses, expenses);
  assert.equal(is.totals.otherIncome, otherIncome);
  assert.equal(is.totals.otherExpenses, otherExpenses);
  assert.equal(is.totals.operatingProfit, income - cogs - expenses);
  assert.equal(is.totals.netProfit, income - cogs - expenses + otherIncome - otherExpenses);
  assert.equal(is.totals.grossProfit, is.totals.income - is.totals.costOfSales);
});

test('the profit and loss balance equals the unclosed profit on the balance sheet', async () => {
  const { accounts, entries } = await demo();
  const is = incomeStatement({ accounts, entries, from: null, to: AS_OF });
  const bs = balanceSheet({ accounts, entries, asOf: AS_OF });
  // Unclosed profit is shown split: this year's, and anything earlier never closed off.
  // The invariant is the sum of those lines, which is what keeps the sheet balanced.
  const synthetic = bs.equity.rows.filter((r) => r.synthetic);
  assert.ok(synthetic.length, 'unclosed profit must appear as its own equity line');
  const unclosedTotal = synthetic.reduce((a, r) => a + r.amount, 0);
  assert.equal(unclosedTotal, is.totals.netProfit);

  const thisYear = synthetic.find((r) => /current year/i.test(r.name));
  if (thisYear) {
    const fyPnl = incomeStatement({ accounts, entries, from: bs.fyStart, to: AS_OF });
    assert.equal(thisYear.amount, fyPnl.totals.netProfit,
      'the current-year line is this year\'s profit, not every year\'s');
  }
});

test('aged receivables ties exactly to the debtors control account', async () => {
  const { accounts, entries, documents, payments, taxCodes } = await demo();
  const ar = agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'receivable', asOf: AS_OF });
  assert.equal(ar.reconciles, true, `aged total ${ar.totals.total} vs control ${ar.controlBalance}`);
  assert.equal(ar.totals.total, ar.controlBalance);
  assert.equal(
    ar.totals.total + ar.openingBalance,
    accountBalance(entries, '1-1000'),
    'aged documents plus opening balances must equal the whole control account',
  );
  assert.equal(
    ar.totals.current + ar.totals.d1_30 + ar.totals.d31_60 + ar.totals.d61_90 + ar.totals.d90plus,
    ar.totals.total,
    'the buckets must add up to the total',
  );
  assert.ok(ar.rows.length >= 4, 'the demo leaves several customers owing money');
  assert.ok(ar.totals.d1_30 > 0 || ar.totals.d31_60 > 0, 'some invoices are past due');
});

test('aged payables ties to the creditors control account', async () => {
  const { accounts, entries, documents, payments, taxCodes } = await demo();
  const ap = agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'payable', asOf: AS_OF });
  assert.equal(ap.reconciles, true, `aged total ${ap.totals.total} vs control ${ap.controlBalance}`);
  assert.equal(ap.totals.total + ap.openingBalance, -accountBalance(entries, '2-1000'));
  assert.ok(ap.totals.total > 0, 'the demo owes suppliers money');
});

test('a supplier prepayment shows on the aged payables report as money on account', async () => {
  const { accounts, entries, documents, payments, taxCodes } = await demo();
  const ap = agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'payable', asOf: AS_OF });
  assert.ok(ap.totals.onAccount < 0, 'prepayments reduce what is owed');
});

test('the activity statement ties to the GST control accounts', async () => {
  const { accounts, entries, taxCodes } = await demo();
  const from = '2026-07-01';
  const bas = basSummary({ accounts, entries, taxCodes, from, to: AS_OF });
  const bal = balancesByAccount(entries, { from, to: AS_OF });
  const gstCollected = -(bal.get('2-1200') || 0);
  const gstPaid = bal.get('1-1300') || 0;
  assert.equal(bas.boxes['1A'], gstCollected, '1A must equal GST collected');
  assert.equal(bas.boxes['1B'], gstPaid, '1B must equal GST paid');
  assert.equal(bas.netGst, gstCollected - gstPaid);
  assert.equal(bas.lodgement, false, 'Rookeepa never lodges');
});

test('the activity statement squares G1 with total sales, other income included', async () => {
  const { accounts, entries, taxCodes } = await demo();
  const bas = basSummary({ accounts, entries, taxCodes, from: '2026-07-01', to: AS_OF });
  const is = incomeStatement({ accounts, entries, from: '2026-07-01', to: AS_OF });
  // G1 is TOTAL sales on an activity statement — GST-free and input-taxed sales belong in it as well as
  // taxable ones (the app's own tax-code table sends FRE to G1 and G3). Other income is sales too: interest
  // received is turnover on the statement, not a purchase, and it used to be counted as a negative one.
  const totalSales = is.totals.income + (is.totals.otherIncome || 0);
  assert.equal(bas.boxes.G1, totalSales, 'G1 is total sales excluding GST');
  assert.ok(bas.boxes.G1 > is.totals.income, 'and the GST-free other income is in it, not hidden from the BAS');
  assert.equal(bas.boxes.G2, 0, 'no exports in the demo data');
  assert.equal(bas.boxes.G10, 0, 'no capital purchases in the demo data');
  assert.ok(bas.boxes.G11 > 0, 'and nothing makes G11 negative');
  assert.ok(bas.boxes.G3 > 0, 'the GST-free sales are reported in G3 as well as G1');
});

test('capital purchases land in G10, not G11', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = seedDemoCompany(db, { asOf: AS_OF });
  const { blankDocument, blankLine, authoriseDocument } = await import('../app/core/docs.js');
  const supplier = db.of('contacts', company.id).find((c) => c.isSupplier);
  const doc = blankDocument({
    companyId: company.id, type: 'bill', contactId: supplier.id, date: '2026-08-01', dueDate: '2026-08-15',
    lines: [blankLine({ description: 'New laptop', accountCode: '1-2100', qty: 1000, unitPrice: 200000, taxCode: 'CAP' })],
  });
  db.put('documents', doc);
  authoriseDocument(db, doc.id);
  const bas = basSummary({
    accounts: db.of('accounts', company.id),
    entries: db.of('entries', company.id),
    taxCodes: db.of('taxCodes', company.id),
    from: '2026-07-01',
    to: AS_OF,
  });
  assert.equal(bas.boxes.G10, 220000, 'capital purchases are GST-inclusive in G10');
  assert.equal(bas.byTaxCode.find((r) => r.code === 'CAP').purchasesGst, 20000);
});

test('cash flow closes at the sum of the bank accounts', async () => {
  const { accounts, entries } = await demo();
  const cf = cashFlow({ accounts, entries, from: '2026-07-01', to: AS_OF });
  const bal = balancesByAccount(entries, { to: AS_OF });
  const bankCodes = accounts.filter((a) => a.control && a.control.startsWith('bank')).map((a) => a.code);
  const expected = sum(bankCodes.map((c) => bal.get(c) || 0));
  assert.equal(cf.closing, expected);
  assert.equal(cf.opening + cf.inflows + cf.outflows, cf.closing);
  assert.equal(cf.months.length >= 2, true);
});

test('the general ledger ties to the account balance for every account', async () => {
  const { accounts, entries } = await demo();
  for (const acc of accounts) {
    const gl = generalLedgerReport({ accounts, entries, code: acc.code, from: null, to: AS_OF });
    assert.equal(gl.closing, accountBalance(entries, acc.code), `account ${acc.code} ledger disagrees with its balance`);
    assert.equal(gl.opening + gl.debit - gl.credit, gl.closing);
  }
});

test('the journal report totals match the trial balance movement', async () => {
  const { accounts, entries } = await demo();
  const jr = journalReport({ accounts, entries, from: '2026-07-01', to: AS_OF });
  const tb = trialBalance({ accounts, entries, from: '2026-07-01', to: AS_OF });
  assert.equal(jr.totals.debit, tb.totals.debit);
  assert.equal(jr.totals.credit, tb.totals.credit);
  assert.equal(jr.totals.debit, jr.totals.credit);
});

test('monthly profit adds up to the profit for the whole period', async () => {
  const { accounts, entries } = await demo();
  const rows = monthlyPnl({ accounts, entries, from: '2026-07-01', to: AS_OF });
  const is = incomeStatement({ accounts, entries, from: '2026-07-01', to: AS_OF });
  assert.equal(sum(rows.map((r) => r.net)), is.totals.netProfit);
  assert.ok(rows.length >= 3);
});

test('the dashboard numbers agree with the reports behind them', async () => {
  const { accounts, entries, documents, payments, taxCodes, company } = await demo();
  const k = dashboardKpis({ accounts, entries, documents, payments, taxCodes, company, asOf: AS_OF });
  const bs = balanceSheet({ accounts, entries, asOf: AS_OF });
  const is = incomeStatement({ accounts, entries, from: fyStartFor(AS_OF), to: AS_OF });
  const ar = agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'receivable', asOf: AS_OF });
  const ap = agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'payable', asOf: AS_OF });
  assert.equal(k.netAssets, bs.netAssets);
  assert.equal(k.netProfitFy, is.totals.netProfit);
  assert.equal(k.balanced, true);
  assert.equal(k.receivables, ar.totals.total, 'dashboard debtors is the aged total');
  assert.equal(k.payables, ap.totals.total, 'dashboard creditors is the aged total');
  assert.equal(ar.reconciles, true);
  assert.equal(ap.reconciles, true);
  assert.ok(k.overdueCount >= 1, 'the demo data deliberately leaves an overdue invoice');
  assert.ok(k.cash > 0);
});

test('the financial year helper understands an Australian year', async () => {
  assert.equal(fyStartFor('2026-09-30', 7), '2026-07-01');
  assert.equal(fyEndFor('2026-09-30', 7), '2027-06-30');
  assert.equal(fyStartFor('2026-03-15', 7), '2025-07-01');
  assert.equal(fyStartFor('2026-03-15', 1), '2026-01-01');
});

test('a period with no transactions reports zero, not nothing', async () => {
  const { accounts } = await demo();
  const is = incomeStatement({ accounts, entries: [], from: '2030-01-01', to: '2030-06-30' });
  assert.equal(is.totals.income, 0);
  assert.equal(is.totals.netProfit, 0);
  assert.deepEqual(is.groups.income, []);
});

test('bills due soon lists only bills that are genuinely still to pay', async () => {
  const { accounts, entries, documents, payments, taxCodes, company } = await demo();
  const k = dashboardKpis({ accounts, entries, documents, payments, taxCodes, company, asOf: AS_OF });
  const bills = documents.filter((d) => d.type === 'bill' && d.status === 'open');
  const settled = bills.filter((d) => documentSummary(d, taxCodes, payments, AS_OF).status === 'paid');
  assert.ok(settled.length > 0, 'the demo pays some bills, so this case is exercised');

  for (const doc of k.billsDueSoon) {
    const s = documentSummary(doc, taxCodes, payments, AS_OF);
    assert.ok(s.balance > 0, `${doc.number} is settled but was listed as due`);
    assert.ok(doc.dueDate <= addDays(AS_OF, 7), `${doc.number} is due too far out to be "due soon"`);
  }
  assert.equal(k.billsDueSoonTotal, sum(k.billsDueSoon.map((d) => documentSummary(d, taxCodes, payments, AS_OF).balance)));
  assert.ok(k.billsDueSoon.length < bills.length, 'settled bills must not crowd out the ones still owed');
});

test('overdue invoices are only the ones still owed', async () => {
  const { accounts, entries, documents, payments, taxCodes, company } = await demo();
  const k = dashboardKpis({ accounts, entries, documents, payments, taxCodes, company, asOf: AS_OF });
  assert.equal(k.overdueCount, k.overdueInvoices.length);
  for (const doc of k.overdueInvoices) {
    const s = documentSummary(doc, taxCodes, payments, AS_OF);
    assert.equal(s.status, 'overdue', `${doc.number} is not actually overdue`);
    assert.ok(s.balance > 0, `${doc.number} is settled`);
  }
  const invoiceCount = documents.filter((d) => d.type === 'invoice').length;
  assert.ok(k.overdueInvoices.length < invoiceCount, 'a settled or future invoice must not count as overdue');
  assert.equal(k.overdueTotal, sum(k.overdueInvoices.map((d) => documentSummary(d, taxCodes, payments, AS_OF).balance)));
});

test('the demo business bank account reconciles against its statement', async () => {
  const { db, company } = await demo();
  const rec = reconciliation(db, company.id, '1-0000', AS_OF);
  assert.equal(rec.reconciles, true, `out by ${rec.difference} cents`);
  assert.equal(rec.difference, 0);
  assert.ok(rec.ledgerBalance > 0, 'there is cash in the demo bank account');
  assert.equal(rec.ledgerBalance, rec.openingBalance + rec.clearedMovement);
  assert.equal(rec.unreconciledCount, 0, 'every demo bank line has been dealt with');
});

test('documents in the demo are internally consistent', async () => {
  const { documents, payments, taxCodes } = await demo();
  const invoices = documents.filter((d) => d.type === 'invoice' && d.status === 'open');
  assert.ok(invoices.length >= 4);
  for (const d of invoices) {
    const s = documentSummary(d, taxCodes, payments, AS_OF);
    assert.equal(s.subtotal + s.tax, s.total);
    assert.equal(s.total - s.paid, s.balance);
    assert.ok(s.balance >= 0);
  }
  assert.equal(computeDocument(invoices[0], taxCodes).total, documentSummary(invoices[0], taxCodes, payments, AS_OF).total);
});
