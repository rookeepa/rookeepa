import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany, deleteCompany } from '../app/core/company.js';
import { blankBankTxn } from '../app/core/docs.js';
import { attachFile } from '../app/core/attachments.js';
import { saveJob, blankJob } from '../app/core/jobs.js';

/*
 * Deleting a company file has to take everything with it.
 *
 * The collections are cleared by walking the whole list rather than a hand-written one, because the written
 * one went stale the moment a collection was added: attachments, jobs and audit records survived the delete
 * while the audit entry announced that all the company's data had gone.
 */

test('deleting a company file takes its attachments, jobs and audit trail with it', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Doomed Co' });
  const kept = createCompany(db, { name: 'Kept Co' });

  const txn = db.put('bankTxns', blankBankTxn({ companyId: company.id, accountCode: '1-0000', date: '2026-09-01', description: 'BOLTS', amount: -1000 }));
  attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'a.pdf', data: 'data:application/pdf;base64,AAAA' });
  saveJob(db, blankJob({ companyId: company.id, name: 'Job one' }));
  const keptTxn = db.put('bankTxns', blankBankTxn({ companyId: kept.id, accountCode: '1-0000', date: '2026-09-01', description: 'KEPT', amount: -500 }));
  attachFile(db, { companyId: kept.id, entityType: 'bankTxn', entityId: keptTxn.id, name: 'b.pdf', data: 'data:application/pdf;base64,BBBB' });

  assert.ok(db.of('files', company.id).length > 0, 'there is something to lose');
  assert.ok(deleteCompany(db, company.id));

  for (const coll of ['accounts', 'taxCodes', 'contacts', 'documents', 'payments', 'entries', 'bankTxns', 'jobs', 'files']) {
    assert.equal(db.of(coll, company.id).length, 0, `${coll} still holds records for the deleted company`);
  }
  assert.equal(db.of('companies', company.id).length, 0, 'and the company file itself is gone');
  assert.ok(db.of('files', kept.id).length > 0, 'while another company file is untouched');
  assert.ok(db.of('entries', kept.id).length === 0, 'and has no entries it never had');
});
