/**
 * Rookeepa — one writer per browser profile.
 *
 * The books live in one origin's storage, and every tab keeps its own copy in memory
 * and writes whole collections back. Two tabs therefore do not merge: the last flush
 * wins and the other tab's work disappears with no warning. There is no server to
 * arbitrate, so the only safe rule is one writer at a time — the first tab to boot
 * takes the lease, any other tab is read-only until the user deliberately takes over.
 *
 * The lease lives in localStorage so every tab of the same origin can see it, and it
 * carries a timestamp so a tab that was closed (or crashed) does not lock the app
 * forever: a lease older than `ttlMs` is treated as abandoned.
 */

const DEFAULT_KEY = 'rookeepa:writer-lease';
const DEFAULT_TTL_MS = 15000;
const DEFAULT_HEARTBEAT_MS = 5000;

export function createTabLease(opts = {}) {
  const storage = opts.storage || globalThis.localStorage;
  // `storage` events are dispatched on the window, never on the Storage object itself — listening there meant
  // no listener at all in a browser, so two tabs each believed they held the file.
  const events = opts.events || (typeof globalThis.addEventListener === 'function' ? globalThis : storage);
  const key = opts.key || DEFAULT_KEY;
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  const heartbeatMs = opts.heartbeatMs === undefined ? DEFAULT_HEARTBEAT_MS : opts.heartbeatMs;
  const now = opts.now || (() => Date.now());

  /**
   * A tab keeps its identity across a reload.
   *
   * sessionStorage belongs to one tab and survives a reload, so a page that comes back after
   * being refreshed recognises the lease it wrote itself. Without this, every reload looked
   * like a second tab holding the file: the reloaded page found its own still-fresh lease,
   * declared itself read-only, and stayed that way until the lease expired — "Read-only in this
   * tab" with no other tab open, on a file nobody else was touching. That is a wrong answer, not
   * a slow one, and it tells the owner their keystrokes are not being saved when they are.
   *
   * A duplicated tab inherits sessionStorage and would share an id; both copies then believe they
   * hold the lease. That is the older behaviour for that one case, and no worse than it was.
   */
  const idKey = opts.idKey || `${key}:tab`;
  const session = opts.session || (() => { try { return globalThis.sessionStorage; } catch { return null; } })();
  let tabId = opts.tabId || null;
  if (!tabId && session) {
    try { tabId = session.getItem(idKey) || null; } catch { tabId = null; }
  }
  if (!tabId) {
    tabId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try { session?.setItem(idKey, tabId); } catch { /* private window: a fresh id each load is fine */ }
  }

  let role = 'holder'; // holder | reader
  let timer = null;
  const listeners = new Set();

  const emit = () => { for (const fn of listeners) { try { fn({ role, tabId }); } catch { /* a listener must not break the lease */ } } };

  const read = () => {
    try {
      const raw = storage?.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.tabId !== 'string') return null;
      if (now() - (parsed.at || 0) >= ttlMs) return null; // abandoned: the tab is gone
      return parsed;
    } catch {
      return null; // unreadable storage: behave as if no one holds it
    }
  };

  const write = () => {
    try {
      storage?.setItem(key, JSON.stringify({ tabId, at: now() }));
      return true;
    } catch {
      // Storage refused (private window, quota). The lease cannot be enforced, so
      // this tab carries on as the writer rather than becoming permanently read-only.
      return false;
    }
  };

  /** True when another live tab holds the lease. */
  const heldByOther = () => {
    const cur = read();
    return !!cur && cur.tabId !== tabId;
  };

  const claim = () => {
    write();
    if (role !== 'holder') { role = 'holder'; emit(); }
    return true;
  };

  const release = (opts2 = {}) => {
    // Only clear the key if it is still ours: a tab that lost the lease must not
    // delete the lease of the tab that took over.
    const cur = read();
    if (cur && cur.tabId !== tabId && !opts2.force) return false;
    try { storage?.removeItem(key); } catch { /* nothing to do */ }
    return true;
  };

  const refresh = () => {
    if (role === 'holder') write();
    else if (!heldByOther()) {
      // The other tab closed without releasing (crash, force quit). Take the lease
      // back rather than leave the app read-only with no explanation.
      role = 'holder';
      write();
      emit();
    }
  };

  /** Someone else may have claimed or released the lease — check and react. */
  const inspect = () => {
    if (role === 'holder' && heldByOther()) { role = 'reader'; emit(); }
  };

  const start = () => {
    role = heldByOther() ? 'reader' : 'holder';
    if (role === 'holder') write();
    if (events?.addEventListener) events.addEventListener('storage', (e) => { if (!e.key || e.key === key) inspect(); });
    if (heartbeatMs > 0) timer = setInterval(() => { refresh(); }, heartbeatMs);
    emit();
    return role;
  };

  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

  return {
    get tabId() { return tabId; },
    get role() { return role; },
    isHolder: () => role === 'holder',
    isReader: () => role === 'reader',
    heldByOther,
    claim,
    release,
    refresh,
    inspect,
    start,
    stop,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
