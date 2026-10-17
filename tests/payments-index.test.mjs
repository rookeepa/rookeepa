import test from 'node:test';
import assert from 'node:assert/strict';
import { allocatedTo, paymentsByDocument, documentSummary, documentStatus, blankDocument, blankLine } from '../app/core/docs.js';

/*
 * The receipts index is an optimisation for the dashboard and the aged report: instead of each
 * document searching every receipt, the receipts are grouped by document once. An optimisation
 * that changes an answer is a bug, so this pins the two paths together — including the two
 * subtle rules the index has to keep: a voided receipt pays nothing, and money received after
 * the "as at" date had not arrived yet.
 */

const TAX = [
  { code: 'GST', name: 'GST 10%', rate: 1000, reportable: true },
  { code: 'N-T', name: 'Not reportable', rate: 0, reportable: false },
];

const invoice = (id, total, extra = {}) => blankDocument({
  id,
  type: 'invoice',
  contactId: 'c1',
  date: '2026-07-01',
  dueDate: '2026-07-15',
  status: 'open',
  priceIncludesTax: false,
  gstRegistered: true,
  lines: [blankLine({ description: 'Work', accountCode: '4-0000', taxCode: 'GST', qty: 1000, unitPrice: total })],
  ...extra,
});

const docs = [invoice('d1', 100000), invoice('d2', 50000), invoice('d3', 25000)];

const payments = [
  // Settles d1 in full, before the as-at date below.
  { id: 'p1', type: 'customer', contactId: 'c1', date: '2026-07-10', status: 'posted', amount: 110000, allocations: [{ docId: 'd1', amount: 110000 }] },
  // Part-pays d2, after it.
  { id: 'p2', type: 'customer', contactId: 'c1', date: '2026-08-20', status: 'posted', amount: 30000, allocations: [{ docId: 'd2', amount: 30000 }] },
  // A reversed receipt against d2: it must not count.
  { id: 'p3', type: 'customer', contactId: 'c1', date: '2026-07-12', status: 'void', amount: 20000, allocations: [{ docId: 'd2', amount: 20000 }] },
  // Two receipts on the one document, both live.
  { id: 'p4', type: 'customer', contactId: 'c1', date: '2026-07-05', status: 'posted', amount: 10000, allocations: [{ docId: 'd3', amount: 10000 }] },
  { id: 'p5', type: 'customer', contactId: 'c1', date: '2026-07-06', status: 'posted', amount: 5000, allocations: [{ docId: 'd3', amount: 5000 }] },
  // Allocated to a document that is not in this list at all.
  { id: 'p6', type: 'customer', contactId: 'c1', date: '2026-07-07', status: 'posted', amount: 1000, allocations: [{ docId: 'd9', amount: 1000 }] },
  // An allocation with no document (a bad record) must not blow up the index.
  { id: 'p7', type: 'customer', contactId: 'c1', date: '2026-07-08', status: 'posted', amount: 100, allocations: [{ docId: null, amount: 100 }] },
];

const index = paymentsByDocument(payments);

test('the index and the full scan agree, for every document and as-at date', () => {
  for (const asOf of [null, '2026-07-04', '2026-07-31', '2026-08-31']) {
    for (const doc of docs) {
      assert.equal(
        allocatedTo(payments, doc.id, asOf, index),
        allocatedTo(payments, doc.id, asOf),
        `d${doc.id} as at ${asOf}`,
      );
    }
  }
});

test('and so do the summary and the status built from it', () => {
  for (const asOf of ['2026-07-31', '2026-08-31']) {
    for (const doc of docs) {
      assert.deepEqual(
        documentSummary(doc, TAX, payments, asOf, index),
        documentSummary(doc, TAX, payments, asOf),
      );
      assert.equal(
        documentStatus(doc, payments, asOf, TAX, index),
        documentStatus(doc, payments, asOf, TAX),
      );
    }
  }
});

test('the rules the index has to keep: voided receipts, later money, and a missing document', () => {
  assert.equal(allocatedTo(payments, 'd1', null, index), 110000, 'd1 is settled in full');
  assert.equal(documentStatus({ ...docs[0] }, payments, '2026-07-31', TAX, index), 'paid');

  assert.equal(allocatedTo(payments, 'd2', null, index), 30000, 'the voided receipt is left out');
  assert.equal(allocatedTo(payments, 'd2', '2026-07-31', index), 0, 'and the August receipt had not arrived');

  assert.equal(allocatedTo(payments, 'd3', null, index), 15000, 'two receipts on one document');
  assert.equal(allocatedTo(payments, 'd9', null, index), 1000, 'a document outside the list still resolves');
  assert.equal(allocatedTo(payments, 'nothing', null, index), 0);
});
