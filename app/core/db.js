/**
 * Rookeepa — storage.
 *
 * Design: the whole company data set lives in memory (small-business volumes
 * are tiny) and is persisted per collection to IndexedDB as a JSON blob,
 * debounced, write-through. That keeps every query synchronous and every view
 * fast, while still surviving a browser restart, a crash and a power cut.
 *
 * Backends, tried in order: IndexedDB -> localStorage -> memory (tests, SSR).
 * Nothing is ever sent to a server; this is a local-first app.
 */

export const COLLECTIONS = [
  'companies',
  'accounts',
  'taxCodes',
  'contacts',
  'items',
  'documents',
  'payments',
  'entries',
  'bankTxns',
  'recurring',
  'jobs',
  'auditLog',
  // The files attached to transactions. Their bytes are deliberately kept out of the books backup — see
  // app/core/attachments.js — so this collection is listed here and filtered there.
  'files',
];

const SCHEMA_VERSION = 1;

export function uid(prefix = 'id') {
  const t = Date.now().toString(36);
  let r = '';
  const g = globalThis.crypto;
  if (g && g.getRandomValues) {
    const a = new Uint8Array(6);
    g.getRandomValues(a);
    r = Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('');
  } else {
    r = Math.random().toString(36).slice(2, 12);
  }
  return `${prefix}_${t}${r}`;
}

/* ------------------------------------------------------------------ backends */

export class MemoryBackend {
  constructor() { this.map = new Map(); this.kind = 'memory'; }
  async read(key) { return this.map.has(key) ? JSON.parse(this.map.get(key)) : null; }
  async write(key, value) { this.map.set(key, JSON.stringify(value)); }
  async writeMany(entries) { for (const [k, v] of entries) this.map.set(k, JSON.stringify(v)); }
  async remove(key) { this.map.delete(key); }
  async list() { return [...this.map.keys()]; }
}

export class LocalStorageBackend {
  constructor(prefix = 'rookeepa:') { this.prefix = prefix; this.kind = 'localStorage'; }
  async read(key) {
    const raw = globalThis.localStorage?.getItem(this.prefix + key);
    return raw ? JSON.parse(raw) : null;
  }
  async write(key, value) {
    globalThis.localStorage.setItem(this.prefix + key, JSON.stringify(value));
  }
  /**
   * localStorage has no transactions, and a full quota can fail part-way through a
   * set of writes. Roll the already-written keys back rather than leave half the
   * books stored: a whole set of collections, or none of it.
   */
  async writeMany(entries) {
    const previous = new Map(entries.map(([k]) => [k, globalThis.localStorage.getItem(this.prefix + k)]));
    const done = [];
    try {
      for (const [k, v] of entries) {
        globalThis.localStorage.setItem(this.prefix + k, JSON.stringify(v));
        done.push(k);
      }
    } catch (err) {
      for (const k of done) {
        const old = previous.get(k);
        if (old === null || old === undefined) globalThis.localStorage.removeItem(this.prefix + k);
        else globalThis.localStorage.setItem(this.prefix + k, old);
      }
      throw err;
    }
  }
  async remove(key) { globalThis.localStorage.removeItem(this.prefix + key); }
  async list() {
    const out = [];
    for (let i = 0; i < globalThis.localStorage.length; i++) {
      const k = globalThis.localStorage.key(i);
      if (k && k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
    }
    return out;
  }
}

export class IdbBackend {
  constructor(dbName = 'rookeepa') { this.dbName = dbName; this.kind = 'indexedDB'; this.db = null; }
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.open(this.dbName, 1);
      let settled = false;
      // A pending delete (another tab holding the database open, or the user
      // clearing site data) leaves `open()` blocked indefinitely. Rather than
      // hanging the whole app on a blank screen, give up and let the caller
      // fall back to a lesser backend — the sidebar will say it is not saving.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Timed out opening browser storage — another tab or a pending clear-data operation is holding it.'));
      }, 5000);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections');
      };
      req.onsuccess = () => {
        if (settled) { try { req.result.close(); } catch { /* ignore */ } return; }
        settled = true;
        clearTimeout(timer);
        const db = req.result;
        // Step aside when another tab wants to upgrade or delete, instead of
        // blocking it (and, later, blocking ourselves).
        db.onversionchange = () => {
          try { db.close(); } catch { /* ignore */ }
          this.db = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(req.error || new Error('Could not open browser storage.'));
      };
      req.onblocked = () => {
        // Another connection is holding a version change open; the timer above
        // makes sure we do not wait forever.
        console.warn('[rookeepa] browser storage is blocked by another connection');
      };
    });
    return this.db;
  }
  _tx(mode) {
    return this.db.transaction('collections', mode).objectStore('collections');
  }
  _wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async read(key) {
    await this.open();
    const v = await this._wrap(this._tx('readonly').get(key));
    return v === undefined ? null : v;
  }
  async write(key, value) {
    await this.open();
    await this._wrap(this._tx('readwrite').put(value, key));
  }
  /**
   * Write several collections in ONE transaction, resolving only once the browser has
   * committed it. The previous flush() wrote each collection through its own
   * transaction, so a failure part-way through could persist an invoice with a
   * journalId but no journal behind it — a document the ledger could not justify.
   */
  async writeMany(entries) {
    await this.open();
    if (!entries.length) return true;
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this.db.transaction('collections', 'readwrite');
      } catch (err) {
        reject(err);
        return;
      }
      const store = tx.objectStore('collections');
      for (const [key, value] of entries) store.put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Could not save to browser storage.'));
      tx.onabort = () => reject(tx.error || new Error('Saving was cancelled by the browser.'));
    });
  }
  async remove(key) {
    await this.open();
    await this._wrap(this._tx('readwrite').delete(key));
  }
  async list() {
    await this.open();
    return (await this._wrap(this._tx('readonly').getAllKeys())) || [];
  }
}

export async function pickBackend(opts = {}) {
  if (opts.backend) return opts.backend;
  if (opts.forceMemory) return new MemoryBackend();
  try {
    if (globalThis.indexedDB) {
      const b = new IdbBackend(opts.dbName || 'rookeepa');
      await b.open();
      // write probe: private windows expose IndexedDB but refuse writes
      await b.write('__probe', { t: Date.now() });
      await b.remove('__probe');
      return b;
    }
  } catch { /* fall through */ }
  try {
    if (globalThis.localStorage) {
      const b = new LocalStorageBackend();
      globalThis.localStorage.setItem('rookeepa:__probe', '1');
      globalThis.localStorage.removeItem('rookeepa:__probe');
      return b;
    }
  } catch { /* fall through */ }
  return new MemoryBackend();
}

/* ------------------------------------------------------------------------ db */

export class DB {
  constructor(backend, opts = {}) {
    this.backend = backend;
    this.data = {};
    for (const c of COLLECTIONS) this.data[c] = [];
    this.meta = { schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString() };
    this.dirty = new Set();
    this._timer = null;
    this._writing = Promise.resolve();
    this.debounceMs = opts.debounceMs === undefined ? 500 : opts.debounceMs;
    this.listeners = new Set();
    this.lastError = null;
    this.writes = 0;
    // The shell sets these so the footer, the toast and the "Force save now" button
    // all agree about whether the books are actually stored.
    this.onSaved = null;
    this.onSaveError = null;
    // Set by the shell when another tab holds the write lease: this tab must not
    // write, or it would silently overwrite whatever that tab has just saved.
    this.readOnly = false;
    this.onReadOnlyBlocked = null;
  }

  static async open(opts = {}) {
    const backend = await pickBackend(opts);
    const db = new DB(backend, opts);
    await db.load();
    return db;
  }

  async load() {
    for (const c of COLLECTIONS) {
      const rows = await this.backend.read(c);
      this.data[c] = Array.isArray(rows) ? rows : [];
    }
    const meta = await this.backend.read('meta');
    if (meta) this.meta = { ...this.meta, ...meta };
  }

  /* ---- change notification (views subscribe to re-render) ---- */
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify(change = {}) {
    for (const fn of [...this.listeners]) {
      try { fn(change); } catch (err) { console.error('[rookeepa] listener failed', err); }
    }
  }

  /* ---- sync reads ---- */
  all(coll) { return this.data[coll] || []; }
  of(coll, companyId) { return this.all(coll).filter((r) => r.companyId === companyId); }
  get(coll, id) { return this.all(coll).find((r) => r.id === id) || null; }
  find(coll, pred) { return this.all(coll).find(pred) || null; }
  filter(coll, pred) { return this.all(coll).filter(pred); }

  /* ---- writes ---- */
  put(coll, record, opts = {}) {
    if (!COLLECTIONS.includes(coll)) throw new Error(`Unknown collection: ${coll}`);
    const list = this.data[coll];
    const now = new Date().toISOString();
    const rec = { ...record };
    if (!rec.id) rec.id = uid(coll.slice(0, 4));
    if (!rec.createdAt) rec.createdAt = now;
    rec.updatedAt = now;
    const idx = list.findIndex((r) => r.id === rec.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...rec };
    else list.push(rec);
    this.markDirty(coll);
    if (!opts.silent) this.notify({ collection: coll, action: idx >= 0 ? 'update' : 'insert', id: rec.id });
    return idx >= 0 ? list[idx] : rec;
  }

  putMany(coll, records, opts = {}) {
    const out = records.map((r) => this.put(coll, r, { silent: true }));
    if (!opts.silent) this.notify({ collection: coll, action: 'bulk', count: out.length });
    return out;
  }

  remove(coll, id, opts = {}) {
    const list = this.data[coll];
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.markDirty(coll);
    if (!opts.silent) this.notify({ collection: coll, action: 'delete', id });
    return true;
  }

  removeWhere(coll, pred, opts = {}) {
    const list = this.data[coll];
    const keep = [];
    let removed = 0;
    for (const r of list) {
      if (pred(r)) removed++; else keep.push(r);
    }
    this.data[coll] = keep;
    if (removed) {
      this.markDirty(coll);
      if (!opts.silent) this.notify({ collection: coll, action: 'deleteMany', count: removed });
    }
    return removed;
  }

  markDirty(coll) {
    this.dirty.add(coll);
    this.dirty.add('meta');
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.debounceMs <= 0) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this.flush().catch(() => {}); }, this.debounceMs);
  }

  async flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this.dirty.size) return;
    if (this.readOnly) {
      // Another tab holds the write lease. Write nothing, and keep the changes pending
      // so they still save if this tab takes the lease over — the point is to make the
      // choice explicit rather than let the last writer win.
      this.onReadOnlyBlocked?.();
      return;
    }
    const pending = [...this.dirty];
    this.dirty.clear();
    const run = async () => {
      // One transaction for every dirty collection: the books save together or not at
      // all. Writing each collection separately could persist a document without the
      // journal entry that makes it true.
      const entries = pending.map((coll) => [coll, coll === 'meta' ? this.meta : this.data[coll]]);
      await this.backend.writeMany(entries);
      this.writes += entries.length;
    };
    this._writing = this._writing.then(run, run);
    try {
      await this._writing;
      this.lastError = null;
      this.onSaved?.();
    } catch (err) {
      this.lastError = err;
      // Put the collections back so a later flush retries; a quota error on a
      // private-window IndexedDB is the common cause here.
      for (const c of pending) this.dirty.add(c);
      console.error('[rookeepa] could not save to browser storage', err);
      this.onSaveError?.(err);
      throw err;
    }
  }

  /* ---- whole-file import/export ---- */

  /**
   * Metadata keyed by company id. These are maps of { companyId: { ... } }, so a
   * company's backup must carry only its own entry, and restoring one company must
   * never overwrite another's — otherwise restoring company A's file would wipe
   * company B's bank reconciliation.
   */
  // Meta that belongs to one company file. Everything not listed here is global, so a
  // company-scoped backup carries it whole — which is how one company's bank rules ended up
  // inside another company's exported file. Add a key here the moment its value is keyed by
  // company id.
  static COMPANY_KEYED_META = ['statementOpening', 'reconciled', 'bankRules'];

  /**
   * Check a snapshot BEFORE anything is touched.
   *
   * A restore replaces the whole file, and the previous code turned any collection the
   * file omitted into an empty list — so a truncated or hand-edited backup silently
   * emptied accounts, contacts and journals, then wrote that emptiness to storage. A
   * backup that cannot be trusted must change nothing at all.
   */
  validateSnapshot(snapshot) {
    const APP_IDS = ['rookeepa', 'ledgerly'];
    if (!snapshot || typeof snapshot !== 'object' || !APP_IDS.includes(snapshot.app) || !snapshot.data) {
      throw new Error('That file is not a Rookeepa backup (expected a JSON file exported from Settings → Backup).');
    }
    const problems = [];
    for (const c of COLLECTIONS) {
      if (!Array.isArray(snapshot.data[c])) problems.push(`no ${c} list`);
    }
    if (!problems.length) {
      if (!Array.isArray(snapshot.data.companies) || !snapshot.data.companies.length) {
        problems.push('no company file in it');
      }
      for (const [coll, rows] of Object.entries(snapshot.data)) {
        if (!Array.isArray(rows)) continue;
        if (rows.some((r) => !r || typeof r !== 'object' || !r.id)) {
          problems.push(`a ${coll} record with no id`);
          break;
        }
      }
      const entryIds = new Set((snapshot.data.entries || []).map((e) => e.id));
      for (const e of snapshot.data.entries || []) {
        const lines = Array.isArray(e.lines) ? e.lines : [];
        const debit = lines.reduce((a, l) => a + (l.debit || 0), 0);
        const credit = lines.reduce((a, l) => a + (l.credit || 0), 0);
        if (!Number.isInteger(debit) || !Number.isInteger(credit)) {
          problems.push(`journal ${e.number || e.id} has fractional cents`);
          break;
        }
        if (debit !== credit) {
          problems.push(`journal ${e.number || e.id} is out of balance`);
          break;
        }
      }
      for (const d of snapshot.data.documents || []) {
        if (d.journalId && !entryIds.has(d.journalId)) {
          problems.push(`document ${d.number || d.id} points at a journal entry the file does not contain`);
          break;
        }
      }
    }
    if (problems.length) {
      throw new Error(`That backup cannot be used, so nothing was changed — it has ${problems.slice(0, 4).join('; ')}. Try an uncorrupted export.`);
    }
    return true;
  }

  /** A snapshot's metadata, restricted to the company it belongs to. */
  scopedMeta(companyId) {
    const out = { ...this.meta };
    for (const key of DB.COMPANY_KEYED_META) {
      const map = this.meta[key];
      if (map && typeof map === 'object') out[key] = companyId ? { [companyId]: map[companyId] || {} } : map;
    }
    return out;
  }

  /** Merge incoming metadata, merging company-keyed maps per company rather than wholesale. */
  mergeMeta(current, incoming, companyId = null) {
    const out = { ...current, ...incoming };
    for (const key of DB.COMPANY_KEYED_META) {
      const map = incoming[key];
      if (!map || typeof map !== 'object') continue;
      out[key] = { ...(current[key] || {}), ...map };
      if (companyId) out[key][companyId] = map[companyId] || {};
    }
    return out;
  }

  snapshot(companyId = null) {
    const out = {
      app: 'rookeepa',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      meta: this.scopedMeta(companyId),
      data: {},
    };
    for (const c of COLLECTIONS) {
      if (!companyId) {
        out.data[c] = this.all(c);
        continue;
      }
      // The company record identifies itself with `id`, not `companyId` like
      // every other collection, so filtering the usual way would silently drop
      // it and leave a backup nobody could restore.
      out.data[c] = c === 'companies'
        ? this.all(c).filter((r) => r.id === companyId)
        : this.of(c, companyId);
    }
    return out;
  }

  /**
   * Replace or merge the whole data set from a snapshot.
   * Async on purpose: a bad file rejects rather than throwing mid-call, so every
   * caller can handle it the same way with a try/catch around an await.
   */
  async replaceAll(snapshot, opts = {}) {
    // Nothing at all is changed until the file has been proved usable. (This also
    // keeps the "not a Rookeepa backup" message for a file of the wrong kind.)
    this.validateSnapshot(snapshot);
    const replacing = opts.replace !== false;
    if (replacing) {
      for (const c of COLLECTIONS) {
        this.data[c] = snapshot.data[c].slice();
        this.dirty.add(c);
      }
    } else {
      let added = 0;
      for (const c of COLLECTIONS) {
        const rows = snapshot.data[c];
        const byId = new Map(this.data[c].map((r) => [r.id, r]));
        for (const r of rows) {
          if (!r.id || byId.has(r.id)) continue;
          this.data[c].push(r); added++;
        }
        this.dirty.add(c);
      }
      console.info(`[rookeepa] imported ${added} new records`);
    }
    if (snapshot.meta) {
      // Replacing with a company-scoped file must not carry that company's stale
      // metadata alongside the incoming records; merging keeps every company's.
      const base = replacing && snapshot.companyId ? {} : this.meta;
      this.meta = this.mergeMeta(base, snapshot.meta, snapshot.companyId);
    }
    this.dirty.add('meta');
    this.notify({ action: 'import' });
    return this.flush();
  }

  async wipe() {
    for (const c of COLLECTIONS) { this.data[c] = []; this.dirty.add(c); }
    this.dirty.add('meta');
    await this.flush();
    this.notify({ action: 'wipe' });
  }

  stats() {
    const s = {};
    for (const c of COLLECTIONS) if (this.data[c].length) s[c] = this.data[c].length;
    return s;
  }
}

export async function openDatabase(opts = {}) {
  return DB.open(opts);
}

/**
 * Ask the browser to keep this origin's storage permanently.
 *
 * Without this, a browser is entitled to evict the data whenever it needs the space, and Safari
 * clears a site's storage after seven days without a visit. For a bookkeeping app that is
 * somebody's books, so it is worth asking. It is a request, not a setting: the browser may
 * decline, and it is likelier to agree once the site has been bookmarked or added to the home
 * screen. Calling it on every boot is safe and idempotent — once granted, it stays granted.
 *
 * Returns what happened, so the app can tell the truth about it rather than assume.
 */
export async function requestPersistentStorage() {
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.persist !== 'function') {
    return { supported: false, persisted: false, reason: 'this browser does not offer it' };
  }
  try {
    const already = typeof storage.persisted === 'function' ? await storage.persisted() : false;
    if (already) return { supported: true, persisted: true, already: true };
    const granted = await storage.persist();
    return { supported: true, persisted: granted === true, already: false };
  } catch (err) {
    // A browser that refuses the call outright must not stop the app from starting.
    return { supported: true, persisted: false, error: err?.message || 'the request failed' };
  }
}
