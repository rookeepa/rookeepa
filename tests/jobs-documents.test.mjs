import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { blankJob, saveJob, jobsSummary } from '../app/core/jobs.js';
import { blankDocument, blankLine, buildDocumentEntry } from '../app/core/docs.js';
import { postEntry } from '../app/core/ledger.js';

/*
 * A job chosen on a document line, and what it does to the posting.
 *
 * The interesting case is one invoice carrying two jobs on the same account — grouping by account alone would
 * merge those two lines into one and drop the allocation silently, which is the defect this change exists to
 * prevent. Both halves are asserted: the ledger keeps them apart, and the report sees them.
 */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Doc Jobs Co' });
  const one = saveJob(db, blankJob({ companyId: company.id, name: 'Job one' }));
  const two = saveJob(db, blankJob({ companyId: company.id, name: 'Job two' }));
  const ctx = {
    accounts: db.of('accounts', company.id),
    taxCodes: db.of('taxCodes', company.id),
    company,
    items: [],
  };
  return { db, company, one, two, ctx };
}

const invoice = (company, lines) => blankDocument({
  companyId: company.id, type: 'invoice', number: 'INV-500', date: '2026-08-20',
  priceIncludesTax: false, gstRegistered: true, lines,
});

test('a job on a document line reaches the ledger line it posts to', async () => {
  const { db, company, one, ctx } = await setup();
  const doc = invoice(company, [blankLine({ accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST', jobCode: one.code })]);
  const entry = buildDocumentEntry(doc, ctx);
  const income = entry.lines.find((l) => l.accountCode === '4-0000');
  assert.equal(income.jobCode, one.code, 'the job travelled from the line to the posting');
  assert.equal(income.credit, 10000, 'and nothing else about the posting changed');
});

test('an invoice carrying two jobs on one account keeps them apart', async () => {
  const { db, company, one, two, ctx } = await setup();
  const doc = invoice(company, [
    blankLine({ accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST', description: 'materials', jobCode: one.code }),
    blankLine({ accountCode: '4-0000', qty: 1000, unitPrice: 5000, taxCode: 'GST', description: 'labour', jobCode: two.code }),
  ]);
  const entry = buildDocumentEntry(doc, ctx);
  const income = entry.lines.filter((l) => l.accountCode === '4-0000');
  assert.equal(income.length, 2, 'two postings, not one merged line');
  assert.deepEqual(income.map((l) => l.jobCode).sort(), [one.code, two.code].sort());
  assert.equal(income.reduce((n, l) => n + l.credit, 0), 15000, 'and together they still equal the invoice');
  const debit = entry.lines.reduce((n, l) => n + l.debit, 0);
  const credit = entry.lines.reduce((n, l) => n + l.credit, 0);
  assert.equal(debit, credit, 'the entry balances');
});

test('lines with no job still post as one line per account, as they always did', async () => {
  const { db, company, ctx } = await setup();
  const doc = invoice(company, [
    blankLine({ accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST' }),
    blankLine({ accountCode: '4-0000', qty: 1000, unitPrice: 5000, taxCode: 'GST' }),
  ]);
  const entry = buildDocumentEntry(doc, ctx);
  const income = entry.lines.filter((l) => l.accountCode === '4-0000');
  assert.equal(income.length, 1, 'one account, one line');
  assert.equal(income[0].credit, 15000);
  assert.equal(income[0].jobCode, null);
});

test('and the report sees a document job once it is posted', async () => {
  const { db, company, one, two, ctx } = await setup();
  const doc = invoice(company, [
    blankLine({ accountCode: '4-0000', qty: 1000, unitPrice: 10000, taxCode: 'GST', jobCode: one.code }),
    blankLine({ accountCode: '4-0000', qty: 1000, unitPrice: 5000, taxCode: 'GST', jobCode: two.code }),
  ]);
  const entry = buildDocumentEntry(doc, ctx);
  postEntry(db, { ...entry, companyId: company.id });
  const report = jobsSummary(db, company.id, {});
  const byCode = Object.fromEntries(report.rows.map((r) => [r.code, r]));
  assert.equal(byCode[one.code].income, 10000);
  assert.equal(byCode[two.code].income, 5000);
  assert.equal(report.totals.income, 15000);
  assert.equal(report.rows.some((r) => r.code === null), false, 'nothing was left unassigned');
});
