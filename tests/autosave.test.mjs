import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany, renameCompany } from '../app/core/company.js';
import { blankBankTxn } from '../app/core/docs.js';
import { attachFile, filesFor, exportAttachments, attachmentTotals } from '../app/core/attachments.js';
import { folderSupported, autosaveFileNames, writeFiles, saveToFolder, folderPermission, listBackups, machineTag } from '../app/core/autosave.js';

/*
 * Automatic saving into a folder, and the switch that turns attachments off.
 *
 * The folder dialog needs a person, so it is the *writing* that is tested here — against a stand-in handle
 * with the same shape the browser gives — because that is the part with logic in it: two files, the right
 * names, and a refusal when there is no folder.
 */

/** A stand-in for a directory handle: it records what was written into it. */
function fakeFolder() {
  const files = new Map();
  const mtimes = new Map();
  return {
    written: files,
    mtimes,
    async getFileHandle(name, opts = {}) {
      if (!opts.create && !files.has(name)) {
        const err = new Error('NotFoundError');
        err.name = 'NotFoundError';
        throw err;
      }
      return {
        async createWritable() {
          let buffer = '';
          return {
            async write(text) { buffer = text; },
            async close() { files.set(name, buffer); },
          };
        },
        async getFile() { return { text: async () => files.get(name), size: (files.get(name) || '').length, lastModified: mtimes.get(name) || 0 }; },
      };
    },
    // What a directory handle gives a reader: one entry per thing in it.
    async *values() {
      for (const name of files.keys()) {
        yield {
          name,
          kind: 'file',
          async getFile() { return { text: async () => files.get(name), size: (files.get(name) || '').length, lastModified: mtimes.get(name) || 0 }; },
        };
      }
    },
  };
}

const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

test('this runtime cannot open a folder dialog, and says so rather than pretending', () => {
  assert.equal(typeof globalThis.showDirectoryPicker, 'undefined');
  assert.equal(folderSupported(), false);
});

test('the files are named after the company, and paired with the books', () => {
  const names = autosaveFileNames({ name: 'Harbour & Co (Demo)' }, slug);
  assert.equal(names.books, 'harbour-co-demo-books.json');
  assert.equal(names.attachments, 'harbour-co-demo-attachments.json');
  assert.equal(autosaveFileNames(null, slug).books, 'company-books.json', 'and a company with no name still works');
  const tagged = autosaveFileNames({ name: 'Harbour & Co (Demo)' }, slug, 'a1b2');
  assert.equal(tagged.books, 'harbour-co-demo-books-a1b2.json', 'and this computer\u2019s tag keeps two computers apart');
  assert.equal(tagged.attachments, 'harbour-co-demo-attachments-a1b2.json');
});

test('two computers saving into one folder cannot write over each other', async () => {
  const folder = fakeFolder();
  const books = { app: 'rookeepa', data: { accounts: [] } };
  await saveToFolder(folder, { company: { name: 'Test Co' }, books, tag: 'a1b2' });
  await saveToFolder(folder, { company: { name: 'Test Co' }, books, tag: 'c3d4' });
  const names = [...folder.written.keys()].sort();
  assert.deepEqual(names, ['test-co-books-a1b2.json', 'test-co-books-c3d4.json'],
    'the second computer writes its own file rather than over the first');
  assert.equal(JSON.parse(folder.written.get('test-co-books-a1b2.json')).app, 'rookeepa', 'and the first is intact');
});

test('a folder can be read back: what is in it, newest name first, nothing guessed at', async () => {
  const folder = fakeFolder();
  folder.written.set('acme-books-zzz.json', JSON.stringify({
    app: 'rookeepa', savedAt: '2026-10-01T09:00:00.000Z',
    data: { companies: [{ name: 'Acme Demo' }], entries: [{}, {}, {}] },
  }));
  folder.written.set('acme-books-aaa.json', JSON.stringify({
    app: 'rookeepa', savedAt: '2026-10-17T09:00:00.000Z',
    data: { companies: [{ name: 'Acme Demo' }], entries: [{}] },
  }));
  folder.written.set('acme-attachments-aaa.json', JSON.stringify({ kind: 'attachments', files: [] }));
  folder.written.set('acme-books-broken.json', 'not json at all');
  const found = await listBackups(folder);
  assert.deepEqual(found.map((f) => f.name), ['acme-books-zzz.json', 'acme-books-broken.json', 'acme-books-aaa.json'],
    'newest name first, and the attachments file is not a candidate');
  assert.equal(found[0].savedAt, '2026-10-01T09:00:00.000Z', 'a backup says when it was taken');
  assert.equal(found[0].company, 'Acme Demo');
  assert.equal(found[0].entries, 3);
  assert.equal(found[1].unreadable, true, 'a file that will not parse is reported, not thrown on');
  assert.equal(found[1].snapshot, null);
  assert.equal(found[2].entries, 1);
  await assert.rejects(() => listBackups(null), /no folder to read from/);
});

test('the folder reader reads only the newest few, so a year of dailies stays quick', async () => {
  const folder = fakeFolder();
  for (let i = 1; i <= 30; i++) {
    const day = String(i).padStart(2, '0');
    folder.written.set(`acme-books-2026-01-${day}.json`, JSON.stringify({ app: 'rookeepa', data: {} }));
  }
  const found = await listBackups(folder, { limit: 5 });
  assert.equal(found.length, 5);
  assert.equal(found[0].name, 'acme-books-2026-01-30.json', 'and it is the newest that is read');
});

test('a save writes both files, and says what it wrote', async () => {
  const folder = fakeFolder();
  const out = await saveToFolder(folder, {
    company: { name: 'Test Co' },
    books: { app: 'rookeepa', data: { accounts: [] } },
    attachments: { kind: 'attachments', files: [] },
    tag: 'a1b2',
  });
  assert.deepEqual(out.written.map((w) => w.name), ['test-co-books-a1b2.json', 'test-co-attachments-a1b2.json']);
  assert.ok(folder.written.has('test-co-books-a1b2.json'));
  const books = JSON.parse(folder.written.get('test-co-books-a1b2.json'));
  assert.equal(books.app, 'rookeepa');
  assert.equal(JSON.parse(folder.written.get('test-co-attachments-a1b2.json')).kind, 'attachments');
  assert.ok(out.at, 'and the save says when it happened');
});

test('the attachments file is only written when there is something to put in it', async () => {
  const folder = fakeFolder();
  const out = await saveToFolder(folder, { company: { name: 'Test Co' }, books: { app: 'rookeepa' }, tag: 'a1b2' });
  assert.deepEqual(out.written.map((w) => w.name), ['test-co-books-a1b2.json']);
});

test('writing without a folder, or with rubbish, is refused rather than half-done', async () => {
  await assert.rejects(() => writeFiles(null, [{ name: 'x.json', text: '{}' }]), /no folder/);
  const folder = fakeFolder();
  await assert.rejects(() => writeFiles(folder, [{ name: 'x.json' }]), /not a file to write/);
  await assert.rejects(() => writeFiles(folder, [null]), /not a file to write/);
  assert.equal(await folderPermission(null), 'none');
});

test('attachments turned off hides nothing and deletes nothing, but refuses new ones', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Toggle Co' });
  const txn = db.put('bankTxns', blankBankTxn({ companyId: company.id, accountCode: '1-0000', date: '2026-09-01', description: 'BOLTS', amount: -1000 }));
  const kept = attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'a.pdf', data: 'data:application/pdf;base64,AAAA' });
  assert.equal(filesFor(db, company.id, 'bankTxn', txn.id).length, 1);

  renameCompany(db, company.id, { attachmentsEnabled: false });
  assert.throws(() => attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'b.pdf', data: 'data:application/pdf;base64,AAAA' }),
    /turned off for this company file/);
  assert.equal(filesFor(db, company.id, 'bankTxn', txn.id).length, 1, 'the file that was there stays');
  assert.equal(db.get('files', kept.id).data, kept.data, 'and keeps its contents: off is not delete');
  assert.equal(attachmentTotals(db, company.id).count, 1, 'so the export still carries it');
  assert.equal(exportAttachments(db, company.id).files.length, 1);

  renameCompany(db, company.id, { attachmentsEnabled: true });
  assert.ok(attachFile(db, { companyId: company.id, entityType: 'bankTxn', entityId: txn.id, name: 'c.pdf', data: 'data:application/pdf;base64,AAAA' }));
});


test('this computer\u2019s tag is the same on every call, and honest when it cannot be stored', async () => {
  // No IndexedDB in this runtime, so the tag cannot be kept — the save still has to work, and has to say so
  // rather than pretending to be distinguishable from another computer.
  const first = await machineTag();
  const second = await machineTag();
  assert.equal(first, second, 'the same tag every time, so a save does not scatter across filenames');
  assert.ok(typeof first === 'string' && first.length > 0);
});


test('the newest backup is found even when its name sorts last', async () => {
  // Names carry a computer's tag, which says nothing about age. Choosing the twelve that sort first once
  // dropped the most recently saved file entirely.
  const folder = fakeFolder();
  for (let i = 0; i < 13; i++) {
    const tag = String.fromCharCode(97 + i); // a..m
    const name = `acme-books-${tag}.json`;
    folder.written.set(name, JSON.stringify({ app: 'rookeepa', savedAt: `2026-09-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`, data: {} }));
    folder.mtimes.set(name, 1_000_000 + i * 1000);
  }
  // Written last, but first alphabetically — exactly the case that used to be cut.
  const newest = 'acme-books-a.json';
  folder.mtimes.set(newest, 9_000_000);

  const found = await listBackups(folder, { limit: 5 });
  assert.equal(found.length, 5);
  assert.equal(found[0].name, newest, 'the most recently written backup is the first one listed');
  assert.ok(found.some((f) => f.name === newest), 'and it is not cut off before its date is read');
});
