/**
 * A throughput check for one company file, so "can it handle a busy year?" has a number
 * rather than an opinion.
 *
 * Two parts, because they are different problems:
 *
 *   reports  — synthesise documents, receipts and journal entries as plain records and time
 *              the dashboard and the aged report. This is where a bookkeeping app is asked to
 *              do the most work per keystroke: every document is compared with every payment.
 *   posting  — time authorising one more invoice as the file grows, which is about the cost of
 *              finding the next document number and saving a collection.
 *
 * Reporting is measured on synthetic records so the build is linear; posting uses real
 * documents through the real code path. Run it with `npm run bench`.
 */
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { blankDocument, blankLine, blankPayment, authoriseDocument, computeDocument } from '../app/core/docs.js';
import { dashboardKpis, agedReport } from '../app/core/reports.js';
import { todayISO, addDays } from '../app/core/dates.js';

const AS_OF = '2026-06-30';
const ms = (fn) => {
  const t0 = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t0 };
};
const fmtMs = (v) => (v < 1000 ? `${v.toFixed(1)} ms` : `${(v / 1000).toFixed(2)} s`);

/* ------------------------------------------------ reporting, on synthetic records */

function fakeCompany(size) {
  // A customer base, and invoices spread over two years, about 30% of them settled.
  const accounts = [
    { code: '1-0000', name: 'Business Bank Account', type: 'asset', control: 'bank', active: true },
    { code: '1-1000', name: 'Accounts Receivable (Debtors)', type: 'asset', control: 'ar', active: true },
    { code: '2-1000', name: 'Accounts Payable (Creditors)', type: 'liability', control: 'ap', active: true },
    { code: '4-0000', name: 'Sales — Services', type: 'income', active: true },
    { code: '6-0000', name: 'Advertising & Marketing', type: 'expense', active: true },
  ];
  const taxCodes = [
    { code: 'GST', name: 'GST 10%', rate: 1000, reportable: true },
    { code: 'N-T', name: 'Not reportable', rate: 0, reportable: false },
  ];
  const contacts = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, name: `Customer ${i}`, isCustomer: true }));

  const documents = [];
  const payments = [];
  const entries = [];
  for (let i = 0; i < size; i++) {
    const date = addDays('2024-07-01', Math.floor((i / size) * 700));
    const total = 50000 + (i % 37) * 1000;
    documents.push({
      id: `doc${i}`, companyId: 'co1', type: i % 11 === 0 ? 'credit-note-sale' : 'invoice',
      contactId: `c${i % 60}`, number: `INV-${String(i + 1).padStart(5, '0')}`,
      date, dueDate: addDays(date, 14), status: 'open', priceIncludesTax: false, gstRegistered: true,
      lines: [blankLine({ description: 'Services', accountCode: '4-0000', taxCode: 'GST', qty: 1000, unitPrice: total })],
    });
    entries.push({
      id: `ent${i}`, companyId: 'co1', date, status: 'posted', source: { type: 'invoice', id: `doc${i}` },
      lines: [
        { accountCode: '1-1000', debit: total + Math.round(total * 0.1), credit: 0 },
        { accountCode: '4-0000', debit: 0, credit: total },
        { accountCode: '2-1200', debit: 0, credit: Math.round(total * 0.1) },
      ],
    });
    // Every third invoice is settled, in full or in part: the receipts are what the reports
    // have to search when they ask "is this invoice paid?".
    if (i % 3 === 0) {
      const amount = i % 6 === 0 ? total + Math.round(total * 0.1) : Math.round(total / 2);
      payments.push({
        id: `pay${i}`, companyId: 'co1', type: 'customer', contactId: `c${i % 60}`,
        date: addDays(date, 10), amount, accountCode: '1-0000', status: 'posted',
        allocations: [{ docId: `doc${i}`, amount }],
      });
    }
  }
  return { accounts, taxCodes, contacts, documents, payments, entries };
}

console.log('Reporting, one company file (dashboard and aged receivables)\n');
console.log('documents   receipts   dashboard   aged report');
for (const size of [1000, 3000, 6000, 10000]) {
  const d = fakeCompany(size);
  // One warm-up, so the numbers are not measuring the first-call cost of a Map.
  dashboardKpis({ ...d, company: { fyStartMonth: 7 }, asOf: AS_OF });
  const kpis = ms(() => dashboardKpis({ ...d, company: { fyStartMonth: 7 }, asOf: AS_OF }));
  const aged = ms(() => agedReport({ ...d, kind: 'receivable', asOf: AS_OF }));
  console.log(
    `${String(size).padStart(9)}   ${String(d.payments.length).padStart(8)}   ${fmtMs(kpis.ms).padStart(9)}   ${fmtMs(aged.ms).padStart(11)}`,
  );
}

/* ------------------------------------------------------------ posting, on a real file */

console.log('\nPosting one more invoice through the real code path\n');
console.log('documents   authorise one');
for (const size of [250, 1000, 2500]) {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: `Bench ${size}` });
  const customer = db.put('contacts', { companyId: company.id, name: 'Bench Customer', isCustomer: true });
  for (let i = 0; i < size; i++) {
    const doc = blankDocument({
      companyId: company.id, type: 'invoice', contactId: customer.id,
      date: addDays('2025-01-01', i % 300), dueDate: addDays('2025-01-15', i % 300),
      lines: [blankLine({ description: 'Work', accountCode: '4-0000', taxCode: 'GST', qty: 1000, unitPrice: 20000 })],
    });
    db.put('documents', doc);
    authoriseDocument(db, doc.id);
  }
  const next = blankDocument({
    companyId: company.id, type: 'invoice', contactId: customer.id, date: todayISO(), dueDate: todayISO(),
    lines: [blankLine({ description: 'One more', accountCode: '4-0000', taxCode: 'GST', qty: 1000, unitPrice: 20000 })],
  });
  db.put('documents', next);
  const timed = ms(() => authoriseDocument(db, next.id));
  console.log(`${String(size).padStart(9)}   ${fmtMs(timed.ms).padStart(13)}`);
}
