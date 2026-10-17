/**
 * Rookeepa — application shell.
 *
 * Boots the database, draws the sidebar, routes hash URLs to view modules and
 * hands each view a context object. Views are loaded on demand so the first
 * paint is fast even on a slow connection.
 */

import { openDatabase, requestPersistentStorage } from './core/db.js';
import { listCompanies, createCompany, deleteCompany } from './core/company.js';
import { seedDemoCompany } from './core/sample.js';
import { exportCompany, readFileAsJson, backupFilename, downloadJson, importSnapshot } from './core/backup.js';
import { documentSummary } from './core/docs.js';
import { UiState, parseRoute, buildHash } from './ui/ui-state.js';
import { createTabLease } from './core/tab-lease.js';
import { todayISO } from './core/dates.js';
import * as kit from './ui/kit.js';
import { h, clear, append, button, icon, ICONS, card, toast, confirmDialog, modal, field, input, emptyState, closeAllModals } from './ui/kit.js';
import { recallFolder } from './core/autosave.js';
import { startAutosave } from './ui/autosave-runner.js';

/** Resolve a file inside the app directory, so it works at any base path. */
const assetUrl = (path) => new URL(path, document.baseURI).href;

const VIEWS = {
  dashboard: () => import('./ui/dashboard.js'),
  sales: () => import('./ui/sales.js'),
  purchases: () => import('./ui/purchases.js'),
  contacts: () => import('./ui/contacts.js'),
  items: () => import('./ui/items.js'),
  banking: () => import('./ui/banking.js'),
  recurring: () => import('./ui/recurring.js'),
  journal: () => import('./ui/journal.js'),
  accounts: () => import('./ui/accounts.js'),
  reports: () => import('./ui/reports.js'),
  settings: () => import('./ui/settings.js'),
};

const NAV = [
  { group: 'Money in', items: [
    { view: 'sales', label: 'Sales', icon: ICONS.sales },
    { view: 'contacts', label: 'Contacts', icon: ICONS.contacts },
  ] },
  { group: 'Money out', items: [
    { view: 'purchases', label: 'Purchases', icon: ICONS.purchases },
    { view: 'items', label: 'Items', icon: ICONS.items },
  ] },
  { group: 'Books', items: [
    { view: 'banking', label: 'Banking', icon: ICONS.banking },
    { view: 'recurring', label: 'Recurring', icon: ICONS.recurring },
    { view: 'journal', label: 'Journal', icon: ICONS.journal },
    { view: 'accounts', label: 'Accounts', icon: ICONS.accounts },
  ] },
  { group: 'Understand', items: [
    { view: 'reports', label: 'Reports', icon: ICONS.reports },
    { view: 'settings', label: 'Settings', icon: ICONS.settings },
  ] },
];

const state = {
  db: null,
  ui: new UiState(),
  route: parseRoute(location.hash),
  view: null,
  companyId: null,
  saveError: null,
};

/* --------------------------------------------------------------------- boot */

async function boot() {
  try {
    state.db = await openDatabase();
  } catch (err) {
    document.getElementById('app').appendChild(fatalError(err));
    return;
  }

  // Ask the browser to keep this file rather than treat it as disposable. Deliberately *not*
  // awaited: the first render must never depend on a permission decision, and a browser that
  // does not answer would otherwise leave a blank screen instead of a bookkeeping app. The
  // footer is redrawn when the answer arrives, and the result is reported honestly — if the
  // request is refused, the backup advice in the app is not a nicety, it is the only thing
  // standing between a cleared browser and lost books.
  requestPersistentStorage()
    .then((result) => { state.persist = result; drawSaveState(); })
    .catch(() => {});

  state.ui.applyTheme();
  state.db.subscribe((change) => {
    if (['import', 'wipe', 'seedDemo', 'companyDeleted'].includes(change.action)) render();
  });

  // Save failures must reach the person using the app, not just the console: the
  // debounced autosave used to swallow them, so the footer kept claiming the books
  // were saved in the browser while nothing was being written.
  state.db.onSaveError = (err) => onSaveError(err);
  state.db.onSaved = () => {
    if (state.saveError) {
      state.saveError = null;
      drawSaveState();
    }
  };

  // One writer per browser profile. Every tab writes whole collections back, so two
  // tabs would silently overwrite each other's work; the first tab to boot holds the
  // lease and any other tab is read-only until it deliberately takes over.
  state.lease = createTabLease();
  state.db.readOnly = state.lease.start() === 'reader';
  let wasReader = state.db.readOnly;
  state.lease.onChange(({ role }) => {
    const reader = role === 'reader';
    state.db.readOnly = reader;
    if (reader && !wasReader) toast('Another tab took over this company file', 'error', {
      detail: 'This tab is read-only now, so anything changed here cannot be saved. Take over again to keep it.',
      duration: 12000,
    });
    // Taking the file back — deliberately, or because the other tab crashed — leaves this tab holding the
    // books as they were when it loaded. Writing those would erase whatever the other tab saved in between,
    // so the store is read again before this tab is allowed to write anything at all.
    if (!reader && wasReader) {
      toast('This tab is now saving your books', 'success', { detail: 'Reading the latest books from storage first, so nothing the other tab saved is lost.', duration: 6000 });
      state.db.load()
        .then(() => { render(); })
        .catch((err) => { toast('Could not re-read your books', 'error', { detail: err?.message || 'Take over again, or reload the page.' }); });
    }
    wasReader = reader;
    render();
  });
  state.db.onReadOnlyBlocked = () => { leaseBlockedNotice(); };

  // Automatic backup runs from the shell, not from the settings screen: it has to survive that screen being
  // closed, start without it being visited, and save the company that is open when it fires. The getter is
  // called at every save for exactly that reason.
  startAutosave(() => ({
    db: state.db,
    companyId: state.companyId,
    company: state.db?.get('companies', state.companyId) || null,
  })).then(() => { drawSaveState(); }).catch(() => {});

  // A handle for the end-to-end smoke test (scripts/smoke.mjs) when running
  // against a local server. Never exposed on a deployed host.
  if (['localhost', '127.0.0.1', ''].includes(location.hostname)) {
    window.__rookeepa = { db: state.db, ui: state.ui, state, render, makeCtx };
  }

  const companies = listCompanies(state.db);
  const wanted = state.ui.get('companyId');
  if (companies.length && !companies.some((c) => c.id === wanted)) state.ui.set('companyId', companies[0].id);
  state.companyId = state.ui.get('companyId');

  window.addEventListener('hashchange', () => {
    state.route = parseRoute(location.hash);
    state.ui.set('lastView', state.route.view);
    render();
  });

  // Failures are reported through the onSaveError hook, so these only need to not
  // become unhandled rejections during a page teardown.
  window.addEventListener('pagehide', () => { state.db.flush().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) state.db.flush().catch(() => {}); });

  render();
  state.db.flush().catch(() => {});
}

function onSaveError(err) {
  state.saveError = err;
  toast('Could not save to browser storage', 'error', {
    detail: 'Your changes are still in this tab. Export a backup now (Settings → Backup) so nothing is lost, then reload.',
    duration: 12000,
  });
  drawSaveState();
}

/* ------------------------------------------------------------------ render */

function navigate(hash) {
  if (location.hash === hash) { render(); return; }
  location.hash = hash;
}

function refresh() {
  render();
}

function makeCtx() {
  const db = state.db;
  const company = db.get('companies', state.companyId) || null;
  const companyId = company?.id || null;
  const asOf = state.ui.get('asOf') || todayISO();
  const data = company ? {
    accounts: db.of('accounts', companyId),
    taxCodes: db.of('taxCodes', companyId),
    contacts: db.of('contacts', companyId),
    items: db.of('items', companyId),
    documents: db.of('documents', companyId),
    payments: db.of('payments', companyId),
    entries: db.of('entries', companyId),
    bankTxns: db.of('bankTxns', companyId),
    recurring: db.of('recurring', companyId),
    auditLog: db.of('auditLog', companyId),
  } : {
    accounts: [], taxCodes: [], contacts: [], items: [], documents: [],
    payments: [], entries: [], bankTxns: [], recurring: [], auditLog: [],
  };
  return {
    db,
    ui: state.ui,
    route: state.route,
    company,
    companyId,
    data,
    asOf,
    setAsOf: (iso) => { state.ui.set('asOf', iso); render(); },
    setCompany: (companyId) => {
      if (!db.get('companies', companyId)) return false;
      state.companyId = companyId;
      state.ui.set('companyId', companyId);
      render();
      return true;
    },
    navigate,
    refresh,
    go: (view, segments = [], query = {}) => navigate(buildHash(view, segments, query)),
    toast,
    modal,
    confirm: confirmDialog,
    field,
    input,
    card,
    emptyState,
    kit,
    fmt: kit.fmt,
    save: () => state.db.flush(),
  };
}

async function render() {
  const app = document.getElementById('app');
  const db = state.db;
  const companies = listCompanies(db);

  // A modal must never outlive the screen it belongs to: if the route changed
  // (deep link, back button, a view navigating while a dialog is open), the
  // dialog is stale, so close it.
  const routeKey = `${state.route.path}`;
  const sameRoute = state.renderedRoute === routeKey;
  // Changing a filter, a sort, or categorising a line re-renders this same screen. That is not a
  // navigation: the person is still reading the list they were working through, and losing the
  // scroll position dumped them back at the top of it — which is what "it takes me to the top"
  // was. A genuine navigation still starts at the top.
  // Where the page is scrolled: the document, not #main — the shell's main element is as tall as
  // its content and never scrolls, so scrolling that one would have been a silent no-op.
  const previousScroll = sameRoute ? (document.scrollingElement?.scrollTop || 0) : 0;
  if (state.renderedRoute && !sameRoute) closeAllModals();
  state.renderedRoute = routeKey;

  if (!companies.length) {
    clear(app);
    app.classList.remove('app-shell');
    app.appendChild(welcomeScreen());
    return;
  }

  if (!db.get('companies', state.companyId)) {
    state.companyId = companies[0].id;
    state.ui.set('companyId', state.companyId);
  }

  const route = state.route;
  const loader = VIEWS[route.view] || VIEWS.dashboard;

  app.classList.add('app-shell');
  clear(app);
  app.appendChild(sidebar(companies));

  const main = h('main', { class: 'main', id: 'main' });
  const content = h('div', { class: 'content' });
  main.appendChild(content);
  app.appendChild(main);

  const ctx = makeCtx();
  try {
    const mod = await loader();
    state.view = mod;
    const node = await mod.render(ctx);
    if (node) content.appendChild(node);
  } catch (err) {
    console.error('[rookeepa] view failed', err);
    content.appendChild(errorPanel(err, route.view));
  }
  content.appendChild(saveFooter());

  // The screen is in the DOM: put the person back where they were, if this was a refresh of the
  // screen they were already on. One frame later, because the browser lays the new content out
  // after this task and would otherwise clamp the offset to the old (shorter) page.
  if (previousScroll > 0) {
    requestAnimationFrame(() => {
      if (document.scrollingElement) document.scrollingElement.scrollTop = previousScroll;
    });
  } else if (!sameRoute) {
    // A different screen starts at the top, the way following a link does. Without this the
    // browser kept the old offset clamped to whatever the new screen happened to be tall enough
    // for, so arriving somewhere new dropped the reader into the middle of it.
    requestAnimationFrame(() => {
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    });
  }
}

function renderSoon() {
  // Debounce a full re-render so bulk operations do not thrash the DOM.
  if (renderSoon.timer) clearTimeout(renderSoon.timer);
  renderSoon.timer = setTimeout(() => render(), 30);
}

/* ----------------------------------------------------------------- sidebar */

function sidebar(companies) {
  const db = state.db;
  const companyId = state.companyId;
  const company = db.get('companies', companyId);
  const route = state.route;

  const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' });
  const counts = navCounts(db, companyId);

  for (const group of NAV) {
    nav.appendChild(h('div', { class: 'nav-group-label' }, group.group));
    for (const item of group.items) {
      const isActive = route.view === item.view || (route.view === 'dashboard' && false);
      const link = h('a', {
        class: `nav-item${isActive ? ' is-active' : ''}`,
        href: buildHash(item.view),
        'aria-current': isActive ? 'page' : null,
      }, icon(item.icon, { size: 16 }), h('span', null, item.label));
      const count = counts[item.view];
      if (count) link.appendChild(h('span', { class: `nav-badge${count.alert ? ' alert' : ''}` }, String(count.value)));
      nav.appendChild(link);
    }
  }

  return h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-head' },
      h('a', { class: 'brand', href: buildHash('dashboard') },
        // The mark follows the theme like the rest of the app: the pack ships a light
        // (green and gold) and a dark (white on navy) version, and the wrapper class the
        // pack defines is what switches between them.
        h('span', { class: 'kangaroo-logo brand-mark', 'aria-hidden': 'true' },
          h('img', {
            class: 'kangaroo-light',
            src: assetUrl('assets/kangaroo/light/kangaroo-light-64.png'),
            width: 28, height: 28, alt: '',
          }),
          h('img', {
            class: 'kangaroo-dark',
            src: assetUrl('assets/kangaroo/dark/kangaroo-dark-64.png'),
            width: 28, height: 28, alt: '',
          })),
        h('span', null,
          h('span', { class: 'brand-name' }, 'Rookeepa'),
          h('span', { class: 'brand-tag' }, 'free bookkeeping'))),
      h('button', {
        class: 'company-switcher',
        type: 'button',
        title: 'Switch or manage company files',
        onClick: () => companySwitcher(companies),
      },
        h('span', { class: 'company-name' }, company?.name || 'No company'),
        icon(ICONS.chevronDown, { size: 14 }))),
    nav,
    leaseNotice(),
    h('div', { class: 'sidebar-foot' },
      h('div', { class: 'save-state', id: 'save-state' }, saveStateNode()),
      h('div', { class: 'row', style: { marginTop: '0.45rem' } },
        button({
          label: 'Backup',
          variant: 'ghost',
          size: 'sm',
          icon: ICONS.download,
          onClick: () => {
            const company = state.db.get('companies', state.companyId);
            // Through exportCompany, not db.snapshot: the books backup deliberately carries each attachment's
            // details and not its bytes, and the raw snapshot would put the base64 in the file.
            const snap = exportCompany(state.db, state.companyId);
            downloadJson(backupFilename(company), snap);
            // Remember that a backup was taken: the getting-started card uses it, and it is
            // the one piece of evidence a local-first app can offer that the books are safe.
            state.ui.set('lastBackupAt', new Date().toISOString());
            toast('Backup downloaded', 'success', { detail: 'Keep it somewhere safe — it is your whole company file.' });
          },
        }),
        button({
          label: state.ui.get('theme') === 'dark' ? 'Light' : 'Dark',
          variant: 'ghost',
          size: 'sm',
          onClick: () => {
            state.ui.set('theme', state.ui.get('theme') === 'dark' ? 'light' : 'dark');
            state.ui.applyTheme();
            render();
          },
        }))));
}

function navCounts(db, companyId) {
  const out = {};
  const docs = db.of('documents', companyId);
  const taxCodes = db.of('taxCodes', companyId);
  const payments = db.of('payments', companyId);
  const asOf = todayISO();

  // Count only invoices that are genuinely still owed: a stored status of
  // "open" means "authorised", not "unpaid", so the derived status decides.
  let overdue = 0;
  let salesDrafts = 0;
  let purchaseDrafts = 0;
  for (const d of docs) {
    if (d.status === 'draft') {
      // A draft belongs to the side of the books it will hit: an unfinished quote is money in, an
      // unfinished bill is money out. Counting every draft under Sales told people they had sales
      // work waiting when the unfinished document was a purchase.
      if (d.ledger === 'purchases') purchaseDrafts++;
      else salesDrafts++;
      continue;
    }
    if (d.status !== 'open' || d.type !== 'invoice') continue;
    const s = documentSummary(d, taxCodes, payments, asOf);
    if (s.status === 'overdue') overdue++;
  }
  if (overdue) out.sales = { value: overdue, alert: true };
  else if (salesDrafts) out.sales = { value: salesDrafts, alert: false };
  if (purchaseDrafts) out.purchases = { value: purchaseDrafts, alert: false };

  const unreconciled = db.of('bankTxns', companyId).filter((t) => t.status === 'unreconciled').length;
  if (unreconciled) out.banking = { value: unreconciled, alert: false };
  return out;
}

/* --------------------------------------------------------------- write lease */

/**
 * Shown in the sidebar when this tab is not the one saving the books. It has to be
 * visible and explain itself: the alternative is a tab that quietly accepts edits and
 * never persists them, which is precisely how someone's afternoon disappears.
 */
function leaseNotice() {
  if (!state.lease || state.lease.isHolder()) return null;
  return h('div', { class: 'lease-notice' },
    h('div', { class: 'row' }, h('span', { class: 'save-dot warn' }), h('strong', null, 'Read-only in this tab')),
    h('p', { class: 'small' },
      'This company file is open in another tab, and only one tab can save at a time. '
      + 'Anything you change here stays on screen but is not written to your books.'),
    button({
      label: 'Take over here',
      variant: 'subtle',
      size: 'sm',
      icon: ICONS.check,
      onClick: () => {
        // The toast comes from the lease's change handler, which also re-reads the books first.
        state.lease.claim();
      },
    }));
}

let blockedNoticeShown = false;
function leaseBlockedNotice() {
  // Say why once per tab: a save held back because another tab holds the lease must
  // not look like a storage failure.
  if (blockedNoticeShown) return;
  blockedNoticeShown = true;
  toast('Not saved — another tab is holding this company file', 'error', {
    detail: 'Use "Take over here" in the sidebar to save from this tab, or keep working in the other one.',
    duration: 12000,
  });
}

function saveStateNode() {
  if (state.lease && state.lease.isReader()) {
    return [h('span', { class: 'save-dot warn' }), h('span', null, 'Read-only in this tab')];
  }
  // Read the database's own error, not only the shell's copy of it: a failed autosave
  // sets the former, and the footer used to keep saying "Saved in this browser".
  if (state.saveError || state.db?.lastError) {
    return [h('span', { class: 'save-dot error' }), h('span', null, 'Not saving — export a backup')];
  }
  const kind = state.db?.backend?.kind || 'memory';
  const kept = state.persist?.persisted;
  const folder = state.autosaveFolder;
  const label = {
    indexedDB: kept ? 'Saved in this browser · storage kept' : 'Saved in this browser',
    localStorage: 'Saved in this browser (small storage)',
    memory: 'Not saved — private window',
  }[kind] || kind;
  // This line is where a person looks to know whether their books are safe, and "in this browser" stops being
  // the whole answer once a folder is also being written to. The browser's own promise moves to the tooltip
  // rather than being lost.
  const shown = folder ? `Saved in this browser · auto-backup to “${folder}”` : label;
  const title = folder
    ? `Your books and your files are also written into “${folder}” every fifteen minutes while Rookeepa is open.${kept ? ' The browser has agreed to keep this copy.' : ''}`
    : undefined;
  return [h('span', { class: 'save-dot' }), h('span', { title }, shown)];
}

/**
 * Notice which folder automatic backup is writing to.
 *
 * The handle lives in its own little database, so the answer is a read rather than shared state — and the
 * redraw happens only when the answer has changed, so this cannot loop through drawSaveState.
 */
async function refreshAutosaveState() {
  if (state.autosaveChecking) return;
  state.autosaveChecking = true;
  try {
    const handle = await recallFolder();
    const name = handle ? (handle.name || 'your folder') : null;
    if (name !== state.autosaveFolder) {
      state.autosaveFolder = name;
      drawSaveState();
    }
  } catch {
    // Nothing to say: the line simply keeps saying what it said.
  } finally {
    state.autosaveChecking = false;
  }
}

function drawSaveState() {
  const node = document.getElementById('save-state');
  if (!node) return;
  clear(node);
  append(node, [saveStateNode()]);
  refreshAutosaveState();
}

// The sidebar is drawn once, and the folder is a database read that lands after that first paint — so the line
// would keep its boot-time wording for the whole session. Asking again whenever the hash changes is enough:
// choosing or stopping a folder happens on the settings screen, and leaving that screen is a route change.
window.addEventListener('hashchange', () => { refreshAutosaveState(); });

// A long transactions table is a lot of scrolling back up. One control, shown once the page has moved, which
// scrolls whichever pane is actually scrolling — the shell's own or the window's.
const backToTop = h('button', {
  class: 'to-top', type: 'button', title: 'Back to top', 'aria-label': 'Back to top',
  onClick: () => {
    for (const el of [document.scrollingElement, document.getElementById('content'), document.getElementById('main')]) {
      if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: 'smooth' });
    }
  },
}, '↑');
document.body.appendChild(backToTop);
document.addEventListener('scroll', () => {
  const top = Math.max(document.scrollingElement?.scrollTop || 0, document.getElementById('content')?.scrollTop || 0);
  backToTop.classList.toggle('visible', top > 400);
}, true);

function saveFooter() {
  const db = state.db;
  const stats = db.stats();
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  return h('p', { class: 'report-note', style: { marginTop: '2rem' } },
    `Rookeepa ${'0.1.0'} · ${total} records in this file · stored ${db.backend.kind === 'indexedDB' ? 'in this browser (IndexedDB)' : db.backend.kind}. `,
    'Nothing is sent anywhere — there is no server. Back up regularly from Settings → Backup.');
}

/* ------------------------------------------------------------- switcher */

function companySwitcher(companies) {
  const list = h('div', { class: 'stack' });
  for (const c of companies) {
    const counts = state.db.stats();
    const row = h('button', {
      class: `btn btn-subtle${c.id === state.companyId ? ' is-active' : ''}`,
      type: 'button',
      style: { justifyContent: 'flex-start', textAlign: 'left' },
      onClick: () => {
        state.ui.set('companyId', c.id);
        state.companyId = c.id;
        m.close();
        navigate(buildHash('dashboard'));
        render();
      },
    }, h('span', { class: 'row-title' }, c.name), h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, c.abn || ''),
      c.id === state.companyId ? icon(ICONS.check, { size: 14 }) : null);
    list.appendChild(row);
  }

  const m = modal({
    title: 'Company files',
    subtitle: 'Each file is a separate set of books, kept in this browser.',
    width: 'sm',
    body: h('div', { class: 'stack' }, list,
      h('div', { class: 'divider' }),
      button({
        label: 'New company file',
        icon: ICONS.plus,
        variant: 'primary',
        onClick: () => { m.close(); newCompanyDialog(); },
      }),
      button({
        label: 'Restore from a backup file',
        icon: ICONS.upload,
        onClick: () => { m.close(); restoreDialog(); },
      })),
  });
}

function newCompanyDialog() {
  let name = '';
  let abn = '';
  let fyStartMonth = 7;
  const m = modal({
    title: 'New company file',
    subtitle: 'Rookeepa seeds a full Australian chart of accounts and GST tax codes by default.',
    body: () => h('div', null,
      field({ label: 'Business name', required: true, input: input({ value: name, placeholder: 'e.g. Harbour & Co Pty Ltd', autofocus: true, onInput: (v) => { name = v; } }) }),
      field({ label: 'ABN', hint: 'Optional. Shown on invoices.', input: input({ value: abn, onInput: (v) => { abn = v; } }) }),
      field({
        label: 'Financial year starts',
        input: (() => {
          const sel = document.createElement('select');
          sel.className = 'input select';
          for (let i = 1; i <= 12; i++) {
            const o = document.createElement('option');
            o.value = String(i);
            o.textContent = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][i - 1];
            if (i === 7) o.selected = true;
            sel.appendChild(o);
          }
          sel.addEventListener('change', () => { fyStartMonth = Number(sel.value); });
          return sel;
        })(),
        hint: 'Australia and New Zealand default to 1 July.',
      })),
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({
        label: 'Create company file',
        variant: 'primary',
        onClick: async () => {
          if (!name.trim()) { toast('Give the company file a name.', 'warn'); return; }
          const company = createCompany(state.db, { name: name.trim(), legalName: name.trim(), abn: abn.trim(), fyStartMonth });
          state.ui.set('companyId', company.id);
          state.companyId = company.id;
          await state.db.flush();
          close(company);
          toast(`Created ${company.name}`, 'success', { detail: 'Chart of accounts and tax codes are ready.' });
          navigate(buildHash('accounts'));
          render();
        },
      }),
    ],
  });
}

function restoreDialog() {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'input' });
  const m = modal({
    title: 'Restore from backup',
    subtitle: 'Choose a Rookeepa backup file (.json).',
    width: 'sm',
    body: () => h('div', null,
      field({ label: 'Backup file', input: fileInput }),
      h('p', { class: 'field-hint' }, 'Restoring replaces every company file currently in this browser.')),
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({
        label: 'Restore',
        variant: 'primary',
        onClick: async () => {
          const file = fileInput.files?.[0];
          if (!file) { toast('Choose a backup file first.', 'warn'); return; }
          const data = await readFileAsJson(file);
          const ok = await confirmDialog({
            title: 'Replace everything?',
            message: 'This replaces all company files in this browser with the contents of the backup.',
            confirmLabel: 'Replace and restore',
            danger: true,
          });
          if (!ok) return;
          await importSnapshot(state.db, data, { mode: 'replace' });
          const companies = listCompanies(state.db);
          state.companyId = companies[0]?.id || null;
          state.ui.set('companyId', state.companyId);
          close(true);
          toast('Backup restored', 'success', { detail: `${companies.length} company file(s) loaded.` });
          navigate(buildHash('dashboard'));
          render();
        },
      }),
    ],
  });
}

/* --------------------------------------------------------------- welcome */

/** The kangaroo, half off the edge of a hero card and behind its text. */
function watermark(size = '512') {
  return h('span', { class: 'kangaroo-logo page-watermark', 'aria-hidden': 'true' },
    h('img', { class: 'kangaroo-light', src: assetUrl(`assets/kangaroo/light/kangaroo-light-${size}.png`), alt: '' }),
    h('img', { class: 'kangaroo-dark', src: assetUrl(`assets/kangaroo/dark/kangaroo-dark-${size}.png`), alt: '' }));
}

function welcomeScreen() {
  const wrap = h('div', { class: 'welcome' });
  wrap.appendChild(h('div', { class: 'welcome-card has-watermark' },
    watermark(),
    h('h1', null, 'Free bookkeeping that runs entirely in your browser'),
    h('p', { class: 'welcome-lead' },
      'Rookeepa does the everyday accounting a small business needs — invoices, bills, contacts, bank reconciliation, GST and reports — with no subscription, no account and no server. Your books live in this browser and in the backup files you keep.'),
    h('div', { class: 'welcome-actions' },
      button({
        label: 'Create my company file',
        variant: 'primary',
        size: 'lg',
        icon: ICONS.plus,
        onClick: () => newCompanyDialog(),
      }),
      button({
        label: 'Explore with demo data',
        size: 'lg',
        icon: ICONS.dashboard,
        onClick: async () => {
          const company = seedDemoCompany(state.db);
          state.ui.set('companyId', company.id);
          state.companyId = company.id;
          await state.db.flush();
          toast('Demo company loaded', 'success', { detail: 'A full year of invoices, bills, payments and reports to poke at.' });
          navigate(buildHash('dashboard'));
          render();
        },
      }),
      button({
        label: 'Restore a backup',
        size: 'lg',
        icon: ICONS.upload,
        onClick: () => restoreDialog(),
      })),
    h('ul', { class: 'feature-list' },
      ...[
        'Tax invoices with GST, GST-free and capital tax codes, printable or copyable as text',
        'Bills, supplier payments and customer receipts with proper allocations',
        'Bank statement import by CSV, then categorise or match each line',
        'Double-entry ledger you can inspect: every report is just journal lines',
        'Profit & loss, balance sheet, trial balance, aged debtors and creditors, GST summary',
        'Export everything to JSON or CSV whenever you like — no lock-in',
      ].map((text) => h('li', null, icon(ICONS.check, { size: 15 }), h('span', null, text)))),
    h('p', { class: 'report-note' },
      'Rookeepa is not connected to the ATO and does not lodge anything. It is a bookkeeping tool, not tax advice — check the numbers with your accountant before you lodge.')));
  return wrap;
}

function errorPanel(err, viewName) {
  return card({
    title: `The ${viewName} screen failed to load`,
    body: h('div', null,
      h('p', null, err?.message || 'Unknown error'),
      h('pre', { class: 'mono small', style: { whiteSpace: 'pre-wrap', color: 'var(--text-muted)' } }, String(err?.stack || '')),
      button({ label: 'Reload', variant: 'primary', onClick: () => location.reload() })),
  });
}

function fatalError(err) {
  return h('div', { class: 'welcome' }, h('div', { class: 'welcome-card' },
    h('h1', null, 'Rookeepa could not start'),
    h('p', null, err?.message || String(err)),
    h('p', { class: 'muted' }, 'Try reloading. If it keeps happening, your browser may be blocking storage — a private window with storage disabled will do that.')));
}

boot();
