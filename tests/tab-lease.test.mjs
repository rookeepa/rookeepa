import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabLease } from '../app/core/tab-lease.js';
import { DB } from '../app/core/db.js';

/*
 * Two tabs of Rookeepa share one origin's storage but keep separate copies of the
 * books in memory, and each writes whole collections back. Before the lease, the last
 * tab to flush simply won and the other tab's work vanished with no warning. These
 * tests pin the rule that replaces it: one writer at a time, chosen explicitly.
 */

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    addEventListener: () => {},
  };
}

function clock(start = 1000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('the first tab to boot takes the lease; a second tab is read-only', () => {
  const storage = fakeStorage();
  const now = clock();
  const a = createTabLease({ storage, now, tabId: 'tab-a', heartbeatMs: 0 });
  assert.equal(a.start(), 'holder');

  const b = createTabLease({ storage, now, tabId: 'tab-b', heartbeatMs: 0 });
  assert.equal(b.start(), 'reader', 'a live lease must make the second tab read-only');
  assert.equal(b.isReader(), true);
});

test('an abandoned lease does not lock the app out', () => {
  const storage = fakeStorage();
  const now = clock();
  const a = createTabLease({ storage, now, tabId: 'tab-a', heartbeatMs: 0, ttlMs: 1000 });
  a.start();

  now.advance(5000); // that tab crashed or was force-quit without releasing
  const b = createTabLease({ storage, now, tabId: 'tab-b', heartbeatMs: 0, ttlMs: 1000 });
  assert.equal(b.start(), 'holder', 'a stale lease is treated as free, not as a lock');
});

test('a reader picks the lease back up when the holding tab disappears', () => {
  const storage = fakeStorage();
  const now = clock();
  const a = createTabLease({ storage, now, tabId: 'tab-a', heartbeatMs: 0, ttlMs: 1000 });
  a.start();
  const b = createTabLease({ storage, now, tabId: 'tab-b', heartbeatMs: 0, ttlMs: 1000 });
  b.start();
  assert.equal(b.isHolder(), false);

  now.advance(2000);
  b.refresh();
  assert.equal(b.isHolder(), true, 'the app must not stay read-only with no other tab open');
});

test('a tab can take over deliberately and the other tab notices', () => {
  const storage = fakeStorage();
  const now = clock();
  const a = createTabLease({ storage, now, tabId: 'tab-a', heartbeatMs: 0 });
  const b = createTabLease({ storage, now, tabId: 'tab-b', heartbeatMs: 0 });
  a.start();
  b.start();

  let aRole = null;
  a.onChange(({ role }) => { aRole = role; });

  b.claim();               // the user chooses to work in this tab
  assert.equal(b.isHolder(), true);
  a.inspect();             // tab A sees the new lease
  assert.equal(a.isHolder(), false, 'the original tab gives up the lease');
  assert.equal(aRole, 'reader', 'and is told, so it can show the read-only notice');
});

test('a tab never releases a lease another tab has taken', () => {
  const storage = fakeStorage();
  const now = clock();
  const a = createTabLease({ storage, now, tabId: 'tab-a', heartbeatMs: 0 });
  a.start();
  const b = createTabLease({ storage, now, tabId: 'tab-b', heartbeatMs: 0 });
  b.claim();

  assert.equal(a.release(), false, 'tab A must not clear tab B\'s lease');
  assert.ok(String(storage.getItem('rookeepa:writer-lease')).includes('tab-b'));
});

test('read-only blocks the write, keeps the change pending, and says why', async () => {
  const batches = [];
  const backend = {
    kind: 'memory',
    async read() { return null; },
    async remove() {},
    async list() { return []; },
    async write() { throw new Error('a read-only tab must not write'); },
    async writeMany(entries) { batches.push(entries.length); },
  };
  const db = await DB.open({ backend, debounceMs: 0 });
  let blocked = 0;
  db.onReadOnlyBlocked = () => { blocked += 1; };

  db.readOnly = true;
  db.put('contacts', { companyId: 'c1', name: 'Acme' });
  await db.flush();

  assert.equal(batches.length, 0, 'nothing was written while another tab holds the lease');
  assert.equal(blocked, 1, 'the user is told why the change did not save');
  assert.ok(db.dirty.has('contacts'), 'the change is still pending, not silently dropped');

  db.readOnly = false; // this tab takes over
  await db.flush();
  assert.equal(batches.length, 1, 'once this tab holds the lease, the pending change saves');
});

test('a reload in the same tab keeps the file — it recognises the lease it wrote itself', () => {
  const shared = fakeStorage();       // localStorage: shared by every tab of the origin
  const tabSession = fakeStorage();   // sessionStorage: this tab only, and it survives a reload
  const t = clock();

  const first = createTabLease({ storage: shared, session: tabSession, now: t, heartbeatMs: 0 });
  assert.equal(first.start(), 'holder', 'the first load takes the lease');

  // The page reloads. Same tab, so sessionStorage comes back — but the previous instance's lease
  // is still fresh in localStorage, where every tab can see it, and the TTL has not passed.
  const reloaded = createTabLease({ storage: shared, session: tabSession, now: t, heartbeatMs: 0 });
  assert.equal(reloaded.start(), 'holder',
    'the reloaded page must not read its own lease as another tab holding the file');
  assert.equal(reloaded.isReader(), false,
    'and it must not tell the owner their changes are not being saved');
});

test('a genuinely different tab is still read-only, through its own reloads', () => {
  const shared = fakeStorage();
  const t = clock();
  const tabA = createTabLease({ storage: shared, session: fakeStorage(), now: t, heartbeatMs: 0 });
  assert.equal(tabA.start(), 'holder');

  const sessionB = fakeStorage();
  const tabB = createTabLease({ storage: shared, session: sessionB, now: t, heartbeatMs: 0 });
  assert.equal(tabB.start(), 'reader', 'a different tab has its own id and stands back');

  const tabBReloaded = createTabLease({ storage: shared, session: sessionB, now: t, heartbeatMs: 0 });
  assert.equal(tabBReloaded.start(), 'reader', 'still read-only: the file really is open elsewhere');
});

test('a storage event in the window makes the losing tab notice, which is the whole point of the lease', () => {
  // The event is dispatched on the window, never on the Storage object — listening on the object meant no
  // listener in a browser at all, so two tabs each believed they held the file and both saved.
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  const listeners = new Set();
  const events = {
    addEventListener: (type, fn) => { if (type === 'storage') listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
    fire: () => { for (const fn of listeners) fn({ key: null }); },
  };

  const a = createTabLease({ storage, events, key: 'lease-test', heartbeatMs: 0, tabId: 'A' });
  const b = createTabLease({ storage, events, key: 'lease-test', heartbeatMs: 0, tabId: 'B' });
  assert.equal(a.start(), 'holder');
  assert.equal(b.start(), 'reader', 'the second tab is a reader while the first holds it');

  assert.ok(b.claim({ force: true }), 'B takes over');
  assert.equal(b.isHolder(), true);
  // A is told by the event, not by asking.
  events.fire();
  assert.equal(a.isReader(), true, 'the tab that lost the file went read-only without being asked to check');
  a.stop(); b.stop();
});
