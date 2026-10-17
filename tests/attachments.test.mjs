import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { blankBankTxn } from '../app/core/docs.js';
import { exportCompany, importSnapshot } from '../app/core/backup.js';
import {
  attachFile, filesFor, removeFile, exportAttachments, importAttachments,
  MAX_FILE_BYTES, dataUrlBytes, formatBytes, attachmentTotals,
} from '../app/core/attachments.js';

/*
 * Attachments, and the promise that its bytes stay out of the books backup.
 *
 * The dangerous half is the restore: it replaces every collection, so a books backup that does not carry the
 * files must not be allowed to delete them. That is the first thing tested here, because it is the one defect
 * that would silently destroy a person's records.
 */

const bytes = (n) => `data:application/pdf;base64,${Buffer.alloc(n).toString('base64')}`;

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Attach Co' });
  const txn = db.put('bankTxns', blankBankTxn({
    companyId: company.id, accountCode: '1-0000', date: '2026-08-20',
    description: 'HARDWARE', amount: -50000, status: 'unreconciled', type: 'spend',
  }));
  return { db, company, txn };
}

test('a file attaches to a transaction, and is measured rather than trusted', async () => {
  const { db, company, txn } = await setup();
  const saved = attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id,
    name: 'receipt.pdf', data: bytes(2048) });
  assert.equal(saved.size, 2048, 'the size comes from the data, not from what the caller said');
  assert.equal(saved.mime, 'application/pdf');
  assert.equal(filesFor(db, company.id, 'bankTxn', txn.id).length, 1);
  assert.equal(attachmentTotals(db, company.id).bytes, 2048);
});

test('a file over the limit is refused, and says by how much', async () => {
  const { db, company, txn } = await setup();
  const tooBig = bytes(MAX_FILE_BYTES + 1);
  assert.throws(() => attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'big.pdf', data: tooBig }),
    new RegExp(`The limit is ${formatBytes(MAX_FILE_BYTES).replace('.', '\\.')}`));
  assert.equal(filesFor(db, company.id, 'bankTxn', txn.id).length, 0, 'and nothing is stored');
});

test('a file attached to nothing, or to something that cannot hold one, is refused', async () => {
  const { db, company, txn } = await setup();
  assert.throws(() => attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: null, name: 'x', data: bytes(10) }), /something to attach to/);
  assert.throws(() => attachFile(db, { companyId: company.id, entityType: 'companies', entityId: txn.id, name: 'x', data: bytes(10) }), /Cannot attach files to a companies/);
  assert.throws(() => attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'x', data: '' }), /no contents/);
});

test('the books backup describes the file but does not carry it', async () => {
  const { db, company, txn } = await setup();
  attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'receipt.pdf', data: bytes(4096) });
  const snapshot = exportCompany(db, company.id);
  const row = snapshot.data.files.find((f) => f.entityId === txn.id);
  assert.ok(row, 'the file is described, so the restore knows the transaction had one');
  assert.equal(row.name, 'receipt.pdf');
  assert.equal(row.size, 4096);
  assert.equal(row.data, null, 'and its contents are not in the books backup');
  assert.equal(row.metadataOnly, true);
  assert.equal(snapshot.attachmentsKeptSeparately, true);
  assert.ok(!JSON.stringify(snapshot).includes('JVBERi'), 'no base64 in the backup at all');
});

test('restoring a books backup keeps the files that are already on the device', async () => {
  const { db, company, txn } = await setup();
  const kept = attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'receipt.pdf', data: bytes(4096) });
  const backup = exportCompany(db, company.id);
  // Something happens to the books afterwards: the file is still here, the transaction is edited.
  db.put('bankTxns', { ...db.get('bankTxns', txn.id), description: 'HARDWARE (edited)' });
  await importSnapshot(db, backup);
  const after = db.get('files', kept.id);
  assert.ok(after, 'the attachment is still recorded');
  assert.equal(after.data, kept.data, 'and its contents survived a restore that never carried them');
  assert.equal(after.metadataOnly, undefined, 'so it is not flagged as missing');
  assert.equal(db.get('bankTxns', txn.id).description, 'HARDWARE', 'while the books went back to the backup');
});

test('a file the backup describes but this device does not have is recorded as missing, not invented', async () => {
  const { db, company, txn } = await setup();
  const elsewhere = { id: 'file_from_elsewhere', companyId: company.id, entityType: 'bankTxn', entityId: txn.id,
    name: 'scan.pdf', mime: 'application/pdf', size: 999, addedAt: '2026-08-01T00:00:00.000Z', data: bytes(999) };
  const backup = exportCompany(db, company.id);
  backup.data.files.push({ ...elsewhere, data: null, metadataOnly: true });
  await importSnapshot(db, backup);
  const row = db.get('files', 'file_from_elsewhere');
  assert.ok(row, 'it is described');
  assert.equal(row.data, null, 'but without contents, because none were in the backup');
  assert.equal(row.metadataOnly, true);
  assert.equal(attachmentTotals(db, company.id).withoutData, 1, 'and the screen can count what is missing');
});

test('the files travel in their own file, which round-trips', async () => {
  const { db, company, txn } = await setup();
  attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'receipt.pdf', data: bytes(3000) });
  const bag = exportAttachments(db, company.id);
  assert.equal(bag.kind, 'attachments');
  assert.equal(bag.files[0].data.startsWith('data:application/pdf;base64,'), true);

  // A fresh device: the books are restored from the books backup, then the files from their own file. A
  // company-scoped backup brings the company record with it, so the ids are the ones the backup used —
  // which is exactly why the files can be matched back to their transactions by id.
  const fresh = await DB.open({ forceMemory: true, debounceMs: 0 });
  await importSnapshot(fresh, exportCompany(db, company.id));
  const itsTxn = fresh.of('bankTxns', company.id)[0];
  assert.ok(itsTxn, 'the transaction came back with the books');
  assert.equal(itsTxn.id, txn.id);
  assert.equal(fresh.of('files', company.id)[0].data, null, 'the books backup brought the description only');
  const result = importAttachments(fresh, bag);
  // The books restore left the file's description behind, so importing the file's own export fills in the
  // contents of a row that already exists: one file accounted for, none skipped.
  assert.equal(result.added + result.updated, 1, JSON.stringify(result));
  assert.equal(result.skipped, 0, JSON.stringify(result));
  assert.equal(fresh.get('files', bag.files[0].id).data, bag.files[0].data, 'and the file is whole again');
  assert.equal(fresh.get('files', bag.files[0].id).size, 3000, 'the size it was recorded with');
  assert.equal(importAttachments(fresh, bag).added, 0, 'importing twice adds nothing');
});

test('importing something that is not an attachments file is refused with somewhere to go', async () => {
  const { db, company } = await setup();
  assert.throws(() => importAttachments(db, { files: [] }), /Settings → Attachments/);
  assert.throws(() => importAttachments(db, exportCompany(db, company.id)), /Settings → Attachments/);
});

test('removing a file takes it out and says what is left', async () => {
  const { db, company, txn } = await setup();
  const a = attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'a.pdf', data: bytes(100) });
  attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'b.pdf', data: bytes(100) });
  const out = removeFile(db, a);
  assert.equal(out.removed.name, 'a.pdf');
  assert.equal(out.remaining, 1);
  assert.equal(filesFor(db, company.id, 'bankTxn', txn.id)[0].name, 'b.pdf');
});

test('the byte counter reads a data URL the same way the browser does', () => {
  assert.equal(dataUrlBytes(bytes(0)), 0);
  assert.equal(dataUrlBytes(bytes(1)), 1);
  assert.equal(dataUrlBytes(bytes(1023)), 1023);
  assert.equal(dataUrlBytes(bytes(4096)), 4096);
  assert.equal(dataUrlBytes('not a data url'), 0);
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});


test('restoring an older backup keeps the receipts it never knew about', async () => {
  // The invariant this exists for: a backup deliberately does not carry the file contents, and a restore
  // replaces the whole collection — so a receipt attached *after* the backup was taken would be deleted by
  // restoring it. That is the worst outcome of keeping the files separate, and it is invisible until the
  // receipt is needed.
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Receipt Co' });
  const other = createCompany(db, { name: 'Another Co' });
  const txn = db.put('bankTxns', blankBankTxn({ companyId: company.id, accountCode: '1-0000', date: '2026-09-01', description: 'BOLTS', amount: -1000 }));
  const early = attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'early.pdf', data: 'data:application/pdf;base64,AAAA' });
  const exported = exportCompany(db, company.id);

  // Taken after the backup: this one is not in it.
  const late = attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'late.pdf', data: 'data:application/pdf;base64,BBBB' });
  // And a receipt belonging to a company the backup does not mention at all.
  const otherTxn = db.put('bankTxns', blankBankTxn({ companyId: other.id, accountCode: '1-0000', date: '2026-09-02', description: 'OTHER', amount: -2000 }));
  const elsewhere = attachFile(db, { companyId: other.id, entityType: 'bankTxn', entityId: otherTxn.id, name: 'elsewhere.pdf', data: 'data:application/pdf;base64,CCCC' });

  await importSnapshot(db, exported, { mode: 'replace' });

  assert.equal(db.get('files', early.id)?.data, early.data, 'the one the backup described is still here');
  assert.equal(db.get('files', late.id)?.data, late.data, 'and the one attached after it was taken is not deleted');
  assert.equal(db.get('files', elsewhere.id)?.data, elsewhere.data, 'nor is one belonging to another company file');
  assert.equal(filesFor(db, company.id, 'bankTxn', txn.id).length, 2, 'both receipts still belong to the transaction');
});


test('an imported file is measured, not trusted, and the caps still apply', async () => {
  // The import path used to store whatever `size` the file claimed and skip both caps, so an export could
  // carry anything past the limits that the picker enforces.
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Import Co' });
  const txn = db.put('bankTxns', blankBankTxn({ companyId: company.id, accountCode: '1-0000', date: '2026-09-01', description: 'BOLTS', amount: -1000 }));
  const attach = (name, bytes) => ({ entityType: 'bankTxn', entityId: txn.id, name, data: 'data:application/pdf;base64,' + 'A'.repeat(Math.ceil(bytes / 3) * 4) });

  const honest = { ...attach('small.pdf', 1000), id: 'fil_small', companyId: company.id, size: 0, mime: 'application/pdf' };
  const oversized = { ...attach('huge.pdf', 2 * 1024 * 1024 + 200), id: 'fil_huge', companyId: company.id, size: 0, mime: 'application/pdf' };
  const out = importAttachments(db, { app: 'rookeepa', kind: 'attachments', version: 1, companyId: company.id, files: [honest, oversized] });

  assert.equal(out.added, 1, 'the file within the limit is taken');
  assert.equal(out.refused.length, 1, 'and the one over it is not');
  assert.match(out.refused[0].reason, /over the .* limit for one file/);
  assert.ok(!db.get('files', 'fil_huge'), 'the oversized file is not stored');

  const stored = db.get('files', 'fil_small');
  assert.ok(stored.size > 0, 'the size stored is the one measured from the contents, not the zero it claimed');
  assert.equal(stored.size, dataUrlBytes(honest.data));

  // Importing the same file again changes nothing, and says so.
  const again = importAttachments(db, { app: 'rookeepa', kind: 'attachments', version: 1, companyId: company.id, files: [honest] });
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.skipped, 1);
});
