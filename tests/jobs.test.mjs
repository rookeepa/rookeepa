import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { blankBankTxn, categoriseBankTxn } from '../app/core/docs.js';
import { postEntry, makeEntry, dr, cr } from '../app/core/ledger.js';
import { blankJob, saveJob, listJobs, setJobActive, jobsSummary, nextJobCode, jobByCode } from '../app/core/jobs.js';

/*
 * Jobs, and the field the ledger has always had for them.
 *
 * The two things worth pinning: a job put on a split reaches the ledger line that split creates (the whole
 * path, through the engine), and the summary classifies by the account a line sits on rather than the document
 * it came from — which is what makes one invoice carrying two jobs come out right.
 */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Jobs Co' });
  return { db, company };
}

test('a new job gets a code that cannot clash', async () => {
  const { db, company } = await setup();
  assert.equal(nextJobCode(db, company.id), 'JOB-001');
  const first = saveJob(db, blankJob({ companyId: company.id, name: 'Kitchen renovation' }));
  assert.equal(first.code, 'JOB-001', 'the code is made when one is not given');
  const second = saveJob(db, blankJob({ companyId: company.id, name: 'Bathroom' }));
  assert.equal(second.code, 'JOB-002');
  assert.equal(listJobs(db, company.id).length, 2);
  assert.throws(() => saveJob(db, blankJob({ companyId: company.id, code: 'job-001', name: 'Clash' })), /already used/);
  assert.throws(() => saveJob(db, blankJob({ companyId: company.id, name: '   ' })), /name/);
});

test('a retired job keeps its history and leaves the pickers', async () => {
  const { db, company } = await setup();
  const job = saveJob(db, blankJob({ companyId: company.id, name: 'Old job' }));
  setJobActive(db, job, false);
  assert.equal(listJobs(db, company.id).length, 0, 'not offered any more');
  assert.equal(listJobs(db, company.id, { includeInactive: true }).length, 1, 'still there');
  assert.equal(jobByCode(db, company.id, job.code).name, 'Old job');
});

test('a job on a split reaches the ledger line that split creates', async () => {
  const { db, company } = await setup();
  const job = saveJob(db, blankJob({ companyId: company.id, name: 'Shop fitout' }));
  const txn = db.put('bankTxns', { ...blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-08-05',
    description: 'TIMBER AND PAINT', amount: -30000, status: 'unreconciled', type: 'spend',
    categoryAccount: '6-0700', taxCode: 'GST',
    splits: [
      { accountCode: '6-0700', taxCode: 'GST', amount: 20000, note: 'timber', jobCode: job.code },
      { accountCode: '6-0700', taxCode: 'GST', amount: 10000, note: 'paint' },
    ],
  }) });
  const entry = db.get('entries', categoriseBankTxn(db, txn).journalId);
  const timber = entry.lines.find((l) => (l.description || '').includes('timber'));
  const paint = entry.lines.find((l) => (l.description || '').includes('paint'));
  assert.equal(timber.jobCode, job.code, 'the job travelled from the split to the line');
  assert.equal(paint.jobCode, null, 'and the split without one stays without one');
});

test('the summary classifies by account, so one invoice can carry two jobs', async () => {
  const { db, company } = await setup();
  const one = saveJob(db, blankJob({ companyId: company.id, name: 'Job one' }));
  const two = saveJob(db, blankJob({ companyId: company.id, name: 'Job two' }));
  // An invoice for 1,000 + GST: half for job one, half for job two.
  postEntry(db, makeEntry({ companyId: company.id, date: '2026-08-10', memo: 'INV-9', lines: [
    dr('1-1000', 110000), cr('4-0000', 100000, { taxCode: 'GST' }), cr('2-1200', 10000, { taxCode: 'GST' }),
  ] }));
  // ...but the posting above has no jobs, so it lands under "no job" — the point being that the report has a
  // place for it rather than dropping it. The lines that do carry jobs are the ones paid for below.
  postEntry(db, makeEntry({ companyId: company.id, date: '2026-08-11', memo: 'materials', lines: [
    dr('6-0700', 30000, { jobCode: one.code }), dr('6-0700', 20000, { jobCode: two.code }), cr('1-0000', 50000),
  ] }));
  postEntry(db, makeEntry({ companyId: company.id, date: '2026-08-12', memo: 'job one sale', lines: [
    dr('1-0000', 55000), cr('4-0000', 50000, { jobCode: one.code, taxCode: 'GST' }), cr('2-1200', 5000),
  ] }));
  const report = jobsSummary(db, company.id, { from: '2026-08-01', to: '2026-08-31' });
  const byCodeRows = Object.fromEntries(report.rows.map((r) => [r.code, r]));
  assert.equal(byCodeRows[one.code].expenses, 30000, 'borrowed against job one');
  assert.equal(byCodeRows[one.code].income, 50000, 'and earned on it');
  assert.equal(byCodeRows[one.code].net, 20000);
  assert.equal(byCodeRows[two.code].expenses, 20000);
  assert.equal(byCodeRows[two.code].income, 0);
  assert.equal(byCodeRows[two.code].net, -20000);
  assert.equal(byCodeRows[null].income, 100000, 'the lines with no job are gathered, not dropped');
  assert.equal(report.totals.income, 150000, 'so the totals still agree with the profit and loss');
  assert.equal(report.totals.expenses, 50000);
  assert.equal(report.totals.net, 100000);
  assert.equal(report.rows[report.rows.length - 1].code, null, 'and "no job" sorts last, where it belongs');
});

test('a balance-sheet line with a job is not profit, so it is left out of the report', async () => {
  const { db, company } = await setup();
  const job = saveJob(db, blankJob({ companyId: company.id, name: 'Capital job' }));
  postEntry(db, makeEntry({ companyId: company.id, date: '2026-08-14', memo: 'equipment', lines: [
    dr('1-2000', 100000, { jobCode: job.code }), cr('2-1000', 100000),
  ] }));
  const report = jobsSummary(db, company.id, {});
  assert.equal(report.rows.length, 0, 'the equipment is an asset, not a cost — it appears when it depreciates');
  assert.equal(report.totals.net, 0);
});

test('the period bounds the report, and voided entries are ignored', async () => {
  const { db, company } = await setup();
  const job = saveJob(db, blankJob({ companyId: company.id, name: 'Timed job' }));
  postEntry(db, makeEntry({ companyId: company.id, date: '2026-07-05', memo: 'july', lines: [
    dr('6-0700', 10000, { jobCode: job.code }), cr('1-0000', 10000),
  ] }));
  postEntry(db, makeEntry({ companyId: company.id, date: '2026-08-05', memo: 'august', lines: [
    dr('6-0700', 20000, { jobCode: job.code }), cr('1-0000', 20000),
  ] }));
  assert.equal(jobsSummary(db, company.id, { from: '2026-08-01', to: '2026-08-31' }).totals.expenses, 20000);
  assert.equal(jobsSummary(db, company.id, { from: '2026-07-01', to: '2026-07-31' }).totals.expenses, 10000);
  assert.equal(jobsSummary(db, company.id, {}).totals.expenses, 30000);
});
