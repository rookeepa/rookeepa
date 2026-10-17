import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { saveNow, setHandle, startAutosave, autosaveState } from '../app/ui/autosave-runner.js';

/*
 * The timer saves whatever company is open when it fires, not the one that was open the first time a screen
 * was drawn.
 *
 * The old version closed over the settings render's ctx, so switching companies and waiting wrote a backup of
 * the previous one — and if that one had been deleted, it wrote a file with a company's name and no companies
 * in it. These tests drive the runner the way the shell does: a getter, asked at save time.
 */

function fakeFolder() {
  const files = new Map();
  return {
    name: 'Test folder',
    files,
    async getFileHandle(name) {
      return {
        async createWritable() {
          let buf = '';
          return { async write(t) { buf = t; }, async close() { files.set(name, buf); } };
        },
        async getFile() { return { text: async () => files.get(name), size: 0, lastModified: 0 }; },
      };
    },
    async *values() { for (const n of files.keys()) yield { name: n, kind: 'file' }; },
    async queryPermission() { return 'granted'; },
  };
}

test('the save follows the company that is open now, not the one that was open first', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const a = createCompany(db, { name: 'First Co' });
  const b = createCompany(db, { name: 'Second Co' });
  const folder = fakeFolder();

  let open = a;
  await startAutosave(() => ({ db, companyId: open.id, company: db.get('companies', open.id) }));
  setHandle(folder);

  await saveNow({ quiet: true });
  assert.ok([...folder.files.keys()].some((n) => n.startsWith('first-co-books')), 'the open company was saved');

  // The person switches company. Nothing re-renders the settings screen; the timer simply fires later.
  open = b;
  await saveNow({ quiet: true });
  assert.ok([...folder.files.keys()].some((n) => n.startsWith('second-co-books')), 'and now the second one, because it is what is open');
});

test('a company that has been deleted is not written as an empty backup', async () => {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Gone Co' });
  const folder = fakeFolder();
  let open = company;
  await startAutosave(() => {
    const current = db.get('companies', open.id);
    return current ? { db, companyId: current.id, company: current } : { db, companyId: open.id, company: null };
  });
  setHandle(folder);

  await saveNow({ quiet: true });
  const before = folder.files.size;
  assert.ok(before > 0);

  // Deleted while the folder was still pointed at it: nothing honest to write, so nothing is written.
  db.remove('companies', company.id, { silent: true });
  const out = await saveNow({ quiet: true });
  assert.equal(out, null, 'no save happens for a company that no longer exists');
  assert.equal(folder.files.size, before, 'and no file is overwritten with an empty one');
  assert.equal(autosaveState().scheduled, true, 'the timer stays scheduled for whatever is opened next');
});

test('the runner reports its own state, so the screen has nothing to remember', async () => {
  await startAutosave(() => ({ db: null, companyId: null, company: null }));
  setHandle(null);
  const state = autosaveState();
  assert.equal(state.handle, null);
  assert.equal(state.minutes, 15, 'a sane rhythm by default');
  assert.equal(state.scheduled, false, 'and nothing scheduled without a folder');
});
