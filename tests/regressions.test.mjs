import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import {
  blankDocument, blankLine, blankPayment, authoriseDocument, saveDocument, savePayment, voidPayment,
  documentSummary, autoAllocate, computeDocument, allocatedTo,
} from '../app/core/docs.js';
import { incomeStatement, balanceSheet, trialBalance, basSummary, agedReport, monthlyPnl } from '../app/core/reports.js';
import { toCsv, parseLooseDate, detectDateOrder, parseBankStatement } from '../app/core/csv.js';
import { toCents } from '../app/core/money.js';
import { postEntry } from '../app/core/ledger.js';

/*
 * Regression tests for defects found by external review (Claude and Codex) plus a
 * systematic missing-import audit. Each one is written to fail against the code as
 * it was before the fix, so it locks the behaviour in rather than describing it.
 */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Regression Co' });
  const taxCodes = db.of('taxCodes', company.id);
  const customer = db.put('contacts', { companyId: company.id, name: 'Acme Pty Ltd', isCustomer: true, terms: 'net14' });
  return { db, company, taxCodes, customer };
}

function invoiceFor(db, company, customer, lines, extra = {}) {
  const doc = blankDocument({
    companyId: company.id,
    type: 'invoice',
    contactId: customer.id,
    date: '2026-07-10',
    dueDate: '2026-07-24',
    lines: lines.map((l) => blankLine(l)),
    ...extra,
  });
  db.put('documents', doc);
  return authoriseDocument(db, doc.id);
}

const line = (unitPrice) => ({ description: 'Work', accountCode: '4-0000', qty: 1000, unitPrice, taxCode: 'GST' });

const dr = (accountCode, amount, extra = {}) => ({ accountCode, debit: amount, credit: 0, ...extra });
const cr = (accountCode, amount, extra = {}) => ({ accountCode, debit: 0, credit: amount, ...extra });

/** The Activity Statement for July 2026 for a company's own ledger. */
function basFor(db, company) {
  return basSummary({
    accounts: db.of('accounts', company.id),
    entries: db.of('entries', company.id),
    taxCodes: db.of('taxCodes', company.id),
    from: '2026-07-01',
    to: '2026-07-31',
  });
}

test('a reversed receipt stops paying the invoice', async () => {
  const { db, company, customer, taxCodes } = await setup();
  const doc = invoiceFor(db, company, customer, [line(100000)]); // $1,000 + $100 GST

  const payment = savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-07-20',
    amount: 110000, accountCode: '1-0000', allocations: [{ docId: doc.id, amount: 110000 }],
  }));

  const paidUp = documentSummary(doc, taxCodes, db.of('payments', company.id), '2026-07-21');
  assert.equal(paidUp.status, 'paid', 'sanity: the receipt pays the invoice first');

  voidPayment(db, payment.id, 'customer changed their mind');

  const payments = db.of('payments', company.id);
  const after = documentSummary(doc, taxCodes, payments, '2026-07-25');
  assert.equal(after.paid, 0, 'a reversed receipt must not keep counting as paid');
  assert.equal(after.balance, 110000, 'the full amount is owed again');
  assert.notEqual(after.status, 'paid', 'the invoice must not still read as paid');
});

test('a part-paid invoice past its due date is still overdue', async () => {
  const { db, company, customer, taxCodes } = await setup();
  const doc = invoiceFor(db, company, customer, [line(100000)]);

  savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-07-20',
    amount: 50000, accountCode: '1-0000', allocations: [{ docId: doc.id, amount: 50000 }],
  }));

  const payments = db.of('payments', company.id);
  const beforeDue = documentSummary(doc, taxCodes, payments, '2026-07-21');
  assert.equal(beforeDue.status, 'partly-paid', 'before the due date it is simply part paid');

  const afterDue = documentSummary(doc, taxCodes, payments, '2026-08-05');
  assert.equal(afterDue.status, 'overdue', 'half paid and past due is overdue first');
  assert.equal(afterDue.balance, 60000);
  assert.ok(afterDue.overdueDays > 0, 'overdue days are reported for part-paid overdue invoices');
});

test('deactivating an account never hides its history from the reports', async () => {
  const { db, company, customer } = await setup();
  invoiceFor(db, company, customer, [line(100000)]); // $1,000 revenue + $100 GST

  const accounts = db.of('accounts', company.id);
  const entries = db.of('entries', company.id);
  const income = accounts.find((a) => a.type === 'income');
  assert.ok(income, 'the chart has an income account');

  const before = incomeStatement({ accounts, entries, from: '2026-07-01', to: '2026-07-31' });
  assert.ok(before.groups.income.some((r) => r.amount === 100000), 'revenue is reported before deactivation');
  assert.equal(before.totals.income, 100000);

  db.put('accounts', { ...income, active: false });

  const after = incomeStatement({ accounts: db.of('accounts', company.id), entries, from: '2026-07-01', to: '2026-07-31' });
  assert.equal(after.totals.income, 100000,
    'a deactivated account keeps its revenue — deactivation only affects pickers and new postings');
  assert.ok(after.groups.income.some((r) => r.amount === 100000), 'and the account still appears in the report');

  const bs = balanceSheet({ accounts: db.of('accounts', company.id), entries, asOf: '2026-07-31' });
  assert.equal(bs.balanced, true, 'the balance sheet still balances after deactivation');

  const tb = trialBalance({ accounts: db.of('accounts', company.id), entries, to: '2026-07-31' });
  assert.equal(tb.balanced, true, 'the trial balance still closes after deactivation');
});

test('a receipt is never auto-allocated to a credit note as if it were a debt', async () => {
  const { db, company, customer } = await setup();
  const invoice = invoiceFor(db, company, customer, [line(100000)]); // $1,100 owing

  const credit = blankDocument({
    companyId: company.id, type: 'credit-note-sale', contactId: customer.id,
    // Deliberately dated before the invoice: auto-allocation works oldest-first, so
    // this is the ordering that exposed the receipt being applied to the credit note.
    date: '2026-07-01', dueDate: '2026-07-05', lines: [blankLine(line(20000))],
  });
  db.put('documents', credit);
  authoriseDocument(db, credit.id);

  const allocations = autoAllocate(db, {
    companyId: company.id, contactId: customer.id, type: 'customer', amount: 88000,
  });

  assert.ok(!allocations.some((a) => a.docId === credit.id),
    'money received is not applied to a credit note — a credit note reduces what is owed');
  assert.deepEqual(allocations.map((a) => a.docId), [invoice.id]);
  assert.equal(allocations.reduce((a, x) => a + x.amount, 0), 88000, 'the whole receipt is applied');
});

test('an exported CSV cannot smuggle a spreadsheet formula', () => {
  const one = (v) => toCsv([[v]]);

  // Text that begins like a formula is defused: Excel and LibreOffice would otherwise
  // execute a bank memo or a supplier description that arrived from outside.
  assert.equal(one('=1+1'), "'=1+1");
  assert.equal(one('@SUM(1+1)*cmd'), "'@SUM(1+1)*cmd");
  assert.equal(one('+cmd|"/c calc"!A1'), '"\'+cmd|""/c calc""!A1"', 'still properly quoted');
  assert.equal(one('-2+3+cmd'), "'-2+3+cmd");
  assert.equal(one('=1+1, with comma'), '"\'=1+1, with comma"');

  // Real amounts must stay numeric, or the column stops adding up in a spreadsheet.
  assert.equal(one('-1234.56'), '-1234.56');
  assert.equal(one('-1100.00'), '-1100.00');
  // A thousands separator means it gets quoted for the delimiter — but never
  // apostrophe-prefixed, which is what would turn the amount into text.
  assert.equal(one('-1,234.56'), '"-1,234.56"');
  assert.ok(!one('-1,234.56').includes("'"), 'no apostrophe is added to a negative amount');
  assert.equal(one('Normal customer'), 'Normal customer');
  assert.equal(one(123456), '123456');
});

test('a flush writes every collection in one transaction', async () => {
  // Writing each collection through its own transaction is what allowed a half-saved
  // set of books: a document persisted without the journal entry behind it.
  const batches = [];
  const backend = {
    kind: 'memory',
    async read() { return null; },
    async remove() {},
    async list() { return []; },
    async write() { throw new Error('write() must not be used by a flush — that is the non-atomic path'); },
    async writeMany(entries) { batches.push(entries.map(([k]) => k)); },
  };
  const db = await DB.open({ backend, debounceMs: 0 });
  db.put('contacts', { companyId: 'c1', name: 'Acme' });
  db.put('entries', { companyId: 'c1', memo: 'sale' });
  await db.flush();

  assert.equal(batches.length, 1, 'one transaction, not one per collection');
  assert.deepEqual(batches[0].sort(), ['contacts', 'entries', 'meta']);
  assert.equal(db.lastError, null);
});

test('a failed save writes nothing, keeps the changes pending and says so', async () => {
  const written = [];
  const backend = {
    kind: 'memory',
    async read() { return null; },
    async remove() {},
    async list() { return []; },
    async write() { written.push('write'); throw new Error('quota exceeded'); },
    async writeMany() { throw new Error('quota exceeded'); },
  };
  const db = await DB.open({ backend, debounceMs: 0 });
  let reported = null;
  let saved = 0;
  db.onSaveError = (err) => { reported = err; };
  db.onSaved = () => { saved += 1; };

  db.put('contacts', { companyId: 'c1', name: 'Acme' });
  db.put('documents', { companyId: 'c1', number: 'INV-0001' });

  await assert.rejects(() => db.flush(), /quota exceeded/);
  assert.equal(written.length, 0, 'nothing at all reached storage');
  assert.ok(reported, 'the shell was told, so the footer cannot keep claiming success');
  assert.ok(db.lastError, 'the database records the failure');
  assert.ok(db.dirty.has('contacts') && db.dirty.has('documents'), 'the changes stay pending for a retry');
  assert.equal(saved, 0, 'no success was signalled');

  // A successful flush afterwards clears the error and reports the save.
  const healthy = await DB.open({ forceMemory: true, debounceMs: 0 });
  let healthySaved = 0;
  healthy.onSaved = () => { healthySaved += 1; };
  healthy.put('contacts', { companyId: 'c1', name: 'Acme' });
  await healthy.flush();
  assert.equal(healthySaved, 1, 'a durable save reports success');
  assert.equal(healthy.lastError, null);
});

test('input-taxed sales are reported at G1, as the ATO requires', async () => {
  const { db, company } = await setup();
  postEntry(db, {
    companyId: company.id,
    date: '2026-07-15',
    memo: 'Residential rent (input taxed)',
    lines: [dr('1-1000', 110000), cr('4-0000', 110000, { taxCode: 'ITS' })],
    source: { type: 'journal', id: 'its-1' },
  });

  const bas = basFor(db, company);
  assert.equal(bas.boxes.G1, 110000, 'input-taxed sales are part of G1 total sales');
  assert.equal(bas.inputTaxedSales, 110000, 'and are disclosed on their own line');
  assert.equal(bas.boxes['1A'], 0, 'input-taxed sales carry no GST');
  assert.equal(bas.gstBasis, 'exclusive', 'the basis is stated, because G1 is where it matters');
});

test('a journal labelled GST that posts no GST does not invent a liability', async () => {
  const { db, company } = await setup();
  postEntry(db, {
    companyId: company.id,
    date: '2026-07-16',
    memo: 'Sale where the GST was never posted',
    // Deliberately wrong, and easy to do by hand: the income line says GST but nothing
    // was credited to the GST account, so the ledger holds no GST.
    lines: [dr('1-0000', 100000), cr('4-0000', 100000, { taxCode: 'GST' })],
    source: { type: 'journal', id: 'gst-missing-1' },
  });

  const bas = basFor(db, company);
  assert.equal(bas.boxes['1A'], 0, 'the boxes report what was posted, not what a rate implies');
  assert.equal(bas.boxes.G1, 100000);
  assert.equal(bas.journalsWithUnpostedGst, 1, 'and the report says which journals to fix');
});

test('a journal that does post GST reports that GST', async () => {
  const { db, company } = await setup();
  postEntry(db, {
    companyId: company.id,
    date: '2026-07-17',
    memo: 'Sale with the GST posted properly',
    lines: [
      dr('1-0000', 110000),
      cr('4-0000', 100000, { taxCode: 'GST' }),
      cr('2-1200', 10000),
    ],
    source: { type: 'journal', id: 'gst-posted-1' },
  });

  const bas = basFor(db, company);
  assert.equal(bas.boxes['1A'], 10000, 'the GST actually posted at 1A');
  assert.equal(bas.boxes.G1, 100000, 'G1 is the GST-exclusive value');
  assert.equal(bas.journalsWithUnpostedGst, 0);
  const salesGstInBreakdown = bas.byTaxCode.reduce((a, r) => a + r.salesGst, 0);
  assert.equal(salesGstInBreakdown, bas.boxes['1A'], 'the per-tax-code breakdown still reconciles');
});

test('GST-free and export sales are in G1 and in their own boxes', async () => {
  const { db, company } = await setup();
  postEntry(db, {
    companyId: company.id,
    date: '2026-07-18',
    memo: 'Export sale (GST-free)',
    lines: [dr('1-1000', 20000), cr('4-0000', 20000, { taxCode: 'EXP' })],
    source: { type: 'journal', id: 'exp-1' },
  });
  postEntry(db, {
    companyId: company.id,
    date: '2026-07-19',
    memo: 'Other GST-free sale',
    lines: [dr('1-1000', 50000), cr('4-0000', 50000, { taxCode: 'FRE' })],
    source: { type: 'journal', id: 'fre-1' },
  });

  const bas = basFor(db, company);
  assert.equal(bas.boxes.G1, 70000, 'both are sales, so both count at G1');
  assert.equal(bas.boxes.G2, 20000, 'export sales at G2');
  assert.equal(bas.boxes.G3, 50000, 'other GST-free sales at G3');
  assert.equal(bas.boxes['1A'], 0, 'neither carries GST');
});

test('a damaged backup is refused and leaves the books untouched', async () => {
  const { db, company } = await setup();
  const accountsBefore = db.of('accounts', company.id).length;
  const contactsBefore = db.of('contacts', company.id).length;

  // A truncated or hand-edited file: the old code turned the missing collection into
  // an empty list and wrote that emptiness over the real books.
  const truncated = db.snapshot(company.id);
  delete truncated.data.entries;
  await assert.rejects(() => db.replaceAll(truncated), /nothing was changed/);

  assert.equal(db.of('accounts', company.id).length, accountsBefore, 'accounts survive');
  assert.equal(db.of('contacts', company.id).length, contactsBefore, 'contacts survive');
});

test('a backup is refused for an out-of-balance journal, fractional cents, or a dangling link', async () => {
  const { db, company } = await setup();

  const unbalanced = db.snapshot(company.id);
  unbalanced.data.entries = [{ id: 'e-1', companyId: company.id, lines: [{ accountCode: '1-0000', debit: 100 }, { accountCode: '4-0000', credit: 90 }] }];
  await assert.rejects(() => db.replaceAll(unbalanced), /out of balance/);

  const fractional = db.snapshot(company.id);
  fractional.data.entries = [{ id: 'e-2', companyId: company.id, lines: [{ accountCode: '1-0000', debit: 100.5 }, { accountCode: '4-0000', credit: 100.5 }] }];
  await assert.rejects(() => db.replaceAll(fractional), /fractional cents/);

  const dangling = db.snapshot(company.id);
  dangling.data.documents = [{ id: 'd-1', companyId: company.id, number: 'INV-0001', journalId: 'e-missing' }];
  await assert.rejects(() => db.replaceAll(dangling), /does not contain/);

  assert.ok(db.of('accounts', company.id).length, 'and none of the refusals emptied the file');
});

test('a company backup carries only that company\'s settings, and merging leaves the other alone', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const a = createCompany(db, { name: 'Alpha' });
  const b = createCompany(db, { name: 'Beta' });
  db.meta.statementOpening = { [a.id]: { '1-0000': 111 }, [b.id]: { '1-0000': 222 } };

  const snapshot = db.snapshot(a.id);
  assert.deepEqual(Object.keys(snapshot.meta.statementOpening), [a.id],
    'the other company\'s statement opening must not travel in this file');
  assert.equal(snapshot.meta.statementOpening[a.id]['1-0000'], 111);

  // Merge it into another browser that holds both companies: Beta's own setting stays.
  const other = await DB.open({ forceMemory: true, debounceMs: 0 });
  createCompany(other, { name: 'Alpha' });
  createCompany(other, { name: 'Beta' });
  other.meta.statementOpening = { [b.id]: { '1-0000': 999 } };
  await other.replaceAll(snapshot, { replace: false });
  assert.equal(other.meta.statementOpening[b.id]['1-0000'], 999, 'Beta keeps its own reconciliation');
});

/* ------------------------------------------------------------------ importing */

test('an amount keeps its sign wherever the currency symbol sits', () => {
  // Stripping non-numeric characters before looking for a minus turned a refund into a
  // payment: "$-123.45" came back as +12345.
  assert.equal(toCents('$-123.45'), -12345, 'a refund written with the symbol first is money out');
  assert.equal(toCents('-$123.45'), -12345);
  assert.equal(toCents('$-1,234.56'), -123456);
  assert.equal(toCents('($123.45)'), -12345, 'accounting parentheses still mean negative');
  assert.equal(toCents('$123.45'), 12345, 'and a plain positive still works');
  // The Australian reading of a three-digit group is documented behaviour, not a bug:
  assert.equal(toCents('1,234'), 123400);
  assert.equal(toCents('1.239'), 123900);
});

test('a grouped amount is read as one number, and malformed grouping is refused', () => {
  // Only the last group used to be examined, so 1,234,567 was treated as "1,234.567"
  // and rounded to the wrong amount.
  assert.equal(toCents('1,234,567'), 123456700);
  assert.equal(toCents('12,345,678.90'), 1234567890);
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('1.234,56'), 123456, 'European grouping still works');
  assert.throws(() => toCents('1,23,4'), /not a readable amount/, 'malformed grouping is refused, not guessed');
  assert.throws(() => toCents('1.23,456'), /not a readable amount/);
});

test('impossible dates are refused, leap days are not', () => {
  assert.equal(parseLooseDate('31/02/2026'), null, '31 February is not a date');
  assert.equal(parseLooseDate('31/04/2026'), null, 'April has 30 days');
  assert.equal(parseLooseDate('29/02/2027'), null, '2027 is not a leap year');
  assert.equal(parseLooseDate('29/02/2024'), '2024-02-29', 'but 2024 is');
  assert.equal(parseLooseDate('00/05/2026'), null);
  assert.equal(parseLooseDate('13/13/2026'), null);
});

test('one date order is decided for the whole file, not re-guessed per row', () => {
  const file = ['Date,Description,Amount', '03/14/2026,Second,10.00', '03/04/2026,First,20.00'].join('\n');
  const parsed = parseBankStatement(file);
  assert.equal(parsed.dateOrder, 'mdy', 'the month-first row settles the file');
  assert.deepEqual(parsed.rows.map((r) => r.date), ['2026-03-14', '2026-03-04'],
    'so the other row is read month-first too, instead of being read as 3 April');
});

test('a file whose dates contradict each other is refused rather than half-guessed', () => {
  const file = ['Date,Description,Amount', '13/04/2026,Only valid day-first,10.00', '04/13/2026,Only valid month-first,20.00'].join('\n');
  const parsed = parseBankStatement(file);
  assert.equal(parsed.dateOrderConflict, true);
  assert.equal(parsed.rows.length, 0, 'nothing is imported');
  assert.match(parsed.problem, /contradict/i, 'and the reason can be shown to the user');
});

test('a file where every date is ambiguous says that it assumed an order', () => {
  const file = ['Date,Description,Amount', '03/04/2026,Rent,10.00', '05/06/2026,Power,20.00'].join('\n');
  const parsed = parseBankStatement(file);
  assert.equal(parsed.dateOrderAssumed, true, 'the assumption is disclosed, not silent');
  assert.equal(parsed.dateOrder, 'dmy', 'and the Australian convention is what it assumed');
  assert.deepEqual(parsed.rows.map((r) => r.date), ['2026-04-03', '2026-06-05']);

  // An explicit choice overrides the guess, so the import screen can offer one.
  const explicit = parseBankStatement(file, { dateOrder: 'mdy' });
  assert.deepEqual(explicit.rows.map((r) => r.date), ['2026-03-04', '2026-05-06']);
});

test('detectDateOrder reads a whole column', () => {
  assert.deepEqual(detectDateOrder(['03/04/2026']), { order: 'dmy', conflict: false, assumed: true });
  assert.deepEqual(detectDateOrder(['14/03/2026']), { order: 'dmy', conflict: false, assumed: false });
  assert.deepEqual(detectDateOrder(['03/14/2026']), { order: 'mdy', conflict: false, assumed: false });
  assert.deepEqual(detectDateOrder(['14/03/2026', '03/14/2026']), { order: null, conflict: true, assumed: false });
});

/* ---------------------------------------------------------------- as at dates */

test('the ageing means "as at" the date it is given, money and invoices later than it included', async () => {
  const { db, company, customer, taxCodes } = await setup();
  const july = invoiceFor(db, company, customer, [line(100000)]); // $1,100, dated 10 July

  // Paid in August, and a further invoice raised in September: both exist in the books,
  // neither belongs in a report as at the end of July.
  savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-08-05',
    amount: 110000, accountCode: '1-0000', allocations: [{ docId: july.id, amount: 110000 }],
  }));
  const september = invoiceFor(db, company, customer, [line(50000)],
    { date: '2026-09-20', dueDate: '2026-10-04' });

  const aged = (asOf) => agedReport({
    accounts: db.of('accounts', company.id),
    entries: db.of('entries', company.id),
    documents: db.of('documents', company.id),
    payments: db.of('payments', company.id),
    taxCodes, kind: 'receivable', asOf,
  });

  const owedNumbers = (rep) => rep.rows.flatMap((r) => r.docs.filter((x) => x.balance !== 0).map((x) => x.number));

  const julyEnd = aged('2026-07-31');
  assert.equal(julyEnd.totals.total, 110000, 'the July invoice is still owed at 31 July');
  assert.equal(julyEnd.reconciles, true, 'and the ageing ties to the control account at that date');
  assert.deepEqual(owedNumbers(julyEnd), [july.number],
    'the September invoice does not appear yet, and the August receipt has not arrived');

  const augustEnd = aged('2026-08-31');
  assert.equal(augustEnd.totals.total, 0, 'by then it has been paid');
  assert.equal(augustEnd.reconciles, true);
  assert.deepEqual(owedNumbers(augustEnd), [], 'nothing is owed at the end of August');

  const septemberEnd = aged('2026-09-30');
  assert.equal(septemberEnd.totals.total, 55000, 'and the September invoice is owed by then');
  assert.equal(septemberEnd.reconciles, true);
  assert.deepEqual(owedNumbers(septemberEnd), [september.number], 'only that one is outstanding');
});

test('unclosed profit is split between this year and earlier years', async () => {
  const { db, company } = await setup();
  postEntry(db, {
    companyId: company.id, date: '2026-06-30', memo: 'Sale in the year before',
    lines: [dr('1-1000', 100000), cr('4-0000', 100000, { taxCode: 'FRE' })],
    source: { type: 'journal', id: 'prev-year-1' },
  });
  postEntry(db, {
    companyId: company.id, date: '2026-08-10', memo: 'Sale this year',
    lines: [dr('1-1000', 50000), cr('4-0000', 50000, { taxCode: 'FRE' })],
    source: { type: 'journal', id: 'this-year-1' },
  });

  const bs = balanceSheet({
    accounts: db.of('accounts', company.id),
    entries: db.of('entries', company.id),
    asOf: '2026-08-31',
    fyStartMonth: 7, // the year runs from 1 July, so 30 June is the year before
  });
  const rows = Object.fromEntries(bs.equity.rows.filter((r) => r.synthetic).map((r) => [r.name, r.amount]));
  assert.equal(rows['Current year earnings (not yet closed)'], 50000, 'this year only');
  assert.equal(rows['Earlier years (not yet closed)'], 100000, 'the year never closed off');
  assert.equal(bs.balanced, true, 'and the sheet still balances with the profit split');
});

test('a monthly report respects the range it was given', async () => {
  const { db, company } = await setup();
  postEntry(db, {
    companyId: company.id, date: '2026-07-03', memo: 'Early July sale',
    lines: [dr('1-1000', 100000), cr('4-0000', 100000, { taxCode: 'FRE' })],
    source: { type: 'journal', id: 'early-july-1' },
  });
  postEntry(db, {
    companyId: company.id, date: '2026-07-31', memo: 'Late July sale',
    lines: [dr('1-1000', 250000), cr('4-0000', 250000, { taxCode: 'FRE' })],
    source: { type: 'journal', id: 'late-july-1' },
  });

  const accounts = db.of('accounts', company.id);
  const entries = db.of('entries', company.id);

  // Each month used to be widened to its full calendar range, so a 31 July sale showed
  // up in a report for 1–14 July while the plain profit and loss correctly reported none.
  const firstHalf = monthlyPnl({ accounts, entries, from: '2026-07-01', to: '2026-07-14' });
  assert.equal(firstHalf.length, 1);
  assert.equal(firstHalf[0].income, 100000, 'the 31 July sale is outside the range');
  assert.equal(incomeStatement({ accounts, entries, from: '2026-07-01', to: '2026-07-14' }).totals.income, 100000,
    'and the monthly total agrees with the plain report');

  const wholeMonth = monthlyPnl({ accounts, entries, from: '2026-07-01', to: '2026-07-31' });
  assert.equal(wholeMonth[0].income, 350000, 'the whole month includes both sales');
});

/* ---------------------------------------------------------------------------
 * Second round: inventory on credit notes, the GST-registration switch, a refused
 * edit changing a posted document, and the signed allocation model.
 * ------------------------------------------------------------------------- */

/** The code of the account filling a ledger role, so tests do not hard-code the chart. */
const codeFor = (db, company, role) => db.of('accounts', company.id).find((a) => a.control === role).code;

test('a sales credit note puts the stock back and reverses the cost', async () => {
  const { db, company, customer } = await setup();
  db.put('companies', { ...company, perpetualInventory: true });
  const item = db.put('items', {
    companyId: company.id, name: 'Widget', costCents: 30000, priceCents: 50000, taxCode: 'GST', accountCode: '4-0000',
  });
  const widget = { ...line(50000), itemId: item.id, qty: 2000 }; // two units

  const invoice = invoiceFor(db, company, customer, [widget]);
  const credit = invoiceFor(db, company, customer, [widget], { type: 'credit-note-sale', date: '2026-07-20' });

  const cost = 60000; // two units at $300 each
  const sale = db.get('entries', invoice.journalId);
  assert.ok(sale.lines.some((l) => l.accountCode === '5-0000' && l.debit === cost), 'the sale moved the cost into cost of sales');
  assert.ok(sale.lines.some((l) => l.accountCode === '1-1100' && l.credit === cost), 'and relieved inventory');

  // Before the fix the credit note posted no inventory lines at all (the code was guarded
  // on `!reverse`), so the stock stayed gone and the cost stayed in the accounts.
  const reversal = db.get('entries', credit.journalId);
  assert.ok(reversal.lines.some((l) => l.accountCode === '1-1100' && l.debit === cost), 'the credit note restores the stock');
  assert.ok(reversal.lines.some((l) => l.accountCode === '5-0000' && l.credit === cost), 'and reverses the cost of sales');

  const net = (code) => db.of('entries', company.id)
    .filter((e) => e.status === 'posted')
    .flatMap((e) => e.lines)
    .filter((l) => l.accountCode === code)
    .reduce((a, l) => a + l.debit - l.credit, 0);
  assert.equal(net('1-1100'), 0, 'inventory ends where it started');
  assert.equal(net('5-0000'), 0, 'and so does cost of sales');
});

test('a company that is not registered for GST charges none', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Unregistered Co', gstRegistered: false });
  const customer = db.put('contacts', { companyId: company.id, name: 'Acme Pty Ltd', isCustomer: true, terms: 'net14' });

  const doc = invoiceFor(db, company, customer, [line(100000)]); // $1,000 plus would-be $100 GST
  const totals = computeDocument(db.get('documents', doc.id), db.of('taxCodes', company.id));
  assert.equal(totals.tax, 0, 'no GST is charged');
  assert.equal(totals.total, 100000, 'so the customer is invoiced the net amount');

  const gstCodes = db.of('accounts', company.id)
    .filter((a) => a.control === 'gstCollected' || a.control === 'gstPaid').map((a) => a.code);
  const entry = db.get('entries', doc.journalId);
  assert.ok(!entry.lines.some((l) => gstCodes.includes(l.accountCode)), 'nothing was posted to a GST account');
  assert.equal(entry.taxSummary.reduce((a, t) => a + t.gst, 0), 0, 'and there is no GST to report');

  // A registered company is unaffected.
  const second = await setup();
  const other = invoiceFor(second.db, second.company, second.customer, [line(100000)]);
  assert.equal(computeDocument(second.db.get('documents', other.id), second.taxCodes).tax, 10000,
    'a registered company still charges GST');
});

test('a refused edit leaves the posted document and the ledger untouched', async () => {
  const { db, company, customer, taxCodes } = await setup();
  const doc = invoiceFor(db, company, customer, [line(100000)]);
  const before = db.get('documents', doc.id);
  const beforeTotal = computeDocument(before, taxCodes).total;
  const entriesBefore = db.of('entries', company.id).filter((e) => e.status === 'posted').length;

  // A 150% discount would turn the line negative. The old order saved the document and
  // only then discovered the posting was invalid, so a refused edit changed the books.
  const broken = { ...before, lines: before.lines.map((l) => ({ ...l, discountPct: 150 })) };
  assert.throws(() => saveDocument(db, broken), /discount cannot be more than 100%/);

  const after = db.get('documents', doc.id);
  assert.deepEqual(after.lines, before.lines, 'the stored document is unchanged');
  assert.equal(computeDocument(after, taxCodes).total, beforeTotal, 'and so is its total');
  assert.equal(db.of('entries', company.id).filter((e) => e.status === 'posted').length, entriesBefore,
    'and no journal was written');
});

test('a payment cannot be applied past what a document owes', async () => {
  const { db, company, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [line(100000)]); // $1,100
  const bank = db.of('accounts', company.id).find((a) => a.control === 'bank');

  assert.throws(() => savePayment(db, blankPayment({
    companyId: company.id,
    type: 'customer',
    contactId: customer.id,
    date: '2026-07-15',
    amount: 200000,
    accountCode: bank.code,
    allocations: [{ docId: doc.id, amount: 200000 }],
  })), /has \$1,100\.00 outstanding/);

  assert.equal(db.of('payments', company.id).length, 0, 'a refused payment is not recorded');
  assert.equal(db.of('entries', company.id).filter((e) => e.source?.type === 'customer-payment').length, 0,
    'and nothing was posted');
});

test('a refund is the mirror of the receipt it reverses', async () => {
  const { db, company, customer } = await setup();
  const doc = invoiceFor(db, company, customer, [line(100000)]); // $1,100
  const bank = db.of('accounts', company.id).find((a) => a.control === 'bank');
  const ar = codeFor(db, company, 'ar');

  savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-07-15',
    amount: 110000, accountCode: bank.code, allocations: [{ docId: doc.id, amount: 110000 }],
  }));
  assert.equal(allocatedTo(db.of('payments', company.id), doc.id), 110000, 'the invoice is paid');

  // Giving the money back: a negative receipt with a negative allocation.
  const refund = savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-07-20',
    amount: -110000, accountCode: bank.code, allocations: [{ docId: doc.id, amount: -110000 }],
  }));
  // Before the fix the amount was forced positive, so a refund booked money INTO the bank.
  const lines = db.get('entries', refund.journalId).lines;
  assert.ok(lines.some((l) => l.accountCode === bank.code && l.credit === 110000), 'the money leaves the bank');
  assert.ok(lines.some((l) => l.accountCode === ar && l.debit === 110000), 'and the customer owes it again');
  assert.equal(allocatedTo(db.of('payments', company.id), doc.id), 0, 'the invoice is unpaid again');
});

test('one payment is applied in one direction', async () => {
  const { db, company, customer } = await setup();
  const first = invoiceFor(db, company, customer, [line(100000)]);
  const second = invoiceFor(db, company, customer, [line(50000)], { date: '2026-07-11' });
  const bank = db.of('accounts', company.id).find((a) => a.control === 'bank');

  assert.throws(() => savePayment(db, blankPayment({
    companyId: company.id, type: 'customer', contactId: customer.id, date: '2026-07-15',
    amount: 60000, accountCode: bank.code,
    allocations: [{ docId: first.id, amount: 110000 }, { docId: second.id, amount: -50000 }],
  })), /in one direction/);
  assert.equal(db.of('payments', company.id).length, 0, 'nothing was recorded');
});
