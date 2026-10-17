/**
 * Rookeepa — end-to-end smoke test.
 *
 * Drives the real app in a real (headless) Chrome: loads the app, creates a
 * company, walks every screen, raises an invoice through the UI, and then
 * checks the books with the app's own reporting engine — because a screen that
 * renders is not the same as a ledger that balances.
 *
 *   node scripts/smoke.mjs                  # everything, screenshots into .smoke/
 *   node scripts/smoke.mjs --keep-open      # leave the browser tab open
 *   node scripts/smoke.mjs --url http://127.0.0.1:5173/
 *   node scripts/smoke.mjs --shots /tmp/shots
 *
 * Requires Chrome (set CHROME_PATH if it is not in the usual place) and a
 * static server on the app directory, e.g. `python3 -m http.server 5173`.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { newTab, sleep, ensureChrome, closeTab, closeTabs } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = flag('url', 'http://127.0.0.1:5173/app/');
const SHOTS = resolve(flag('shots', '.smoke'));
const KEEP_OPEN = has('keep-open');

mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  const mark = ok ? '  ok  ' : ' FAIL ';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const skipped = [];
function skip(name, why = '') {
  skipped.push({ name, why });
  console.log(`[ skip ] ${name}${why ? ` — ${why}` : ''}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

/**
 * Wait for the current screen to finish drawing its rows before inspecting it.
 * The app boots, opens IndexedDB and renders asynchronously, so a fixed sleep is
 * exactly how a probe ends up confidently reporting on an empty page.
 */
async function waitForRows(selector = '.table tbody tr', tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await session.count(selector)) return true;
    await sleep(150);
  }
  return false;
}

/**
 * Boot on a cleared origin and require the first-run screen.
 *
 * Storage is cleared BEFORE the app has ever loaded in the tab: doing it afterwards
 * races the app's own IndexedDB connection and can leave the next boot hanging behind
 * a pending delete. A cold browser start can also serve a blank page before the
 * module graph is ready, which is a harness race rather than an app fault — so retry,
 * and report what the page actually was instead of only timing out.
 */
async function bootFreshApp() {
  const origin = new URL(BASE).origin;
  await closeTabs((t) => t.url.startsWith(origin));
  await sleep(400); // let Chrome finish closing those connections
  await session.send('Storage.enable').catch(() => {});
  await session.clearStorage(origin);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await session.goto(`${BASE}#/dashboard`);
    try {
      await session.waitFor(`return !!document.querySelector('.welcome')`, { timeout: 15000 });
      return true;
    } catch {
      const state = await session.evaluate(`
        return {
          ready: document.readyState,
          url: location.href,
          chars: document.body ? document.body.innerHTML.length : -1,
          rendered: !!document.querySelector('.welcome, .sidebar, .app'),
        };
      `).catch(() => '(unavailable)');
      console.log(`  boot attempt ${attempt} rendered nothing: ${JSON.stringify(state)}`);
      await sleep(800);
    }
  }
  return false;
}

const VIEWS = [
  ['dashboard', 'Dashboard'],
  ['sales', 'Sales'],
  ['purchases', 'Purchases'],
  ['contacts', 'Contacts'],
  ['items', 'Items'],
  ['banking', 'Banking'],
  ['recurring', 'Recurring'],
  ['journal', 'Journal'],
  ['accounts', 'Accounts'],
  ['reports', 'Reports'],
  ['settings', 'Settings'],
];

const session = await newTab('about:blank');
await session.init();
const closeSelf = () => (KEEP_OPEN
  ? Promise.resolve()
  : session.send('Page.close').catch(() => closeTab(session.targetId)));

try {
  /* ------------------------------------------------------------ fresh start */
  section('Starting fresh');
  // Clear the origin's storage BEFORE the app has ever loaded in this tab (see
  // bootFreshApp for why, and for the retry that keeps a cold browser start from
  // looking like an application failure).
  if (!(await bootFreshApp())) {
    throw new Error('the app never rendered its first-run screen after 3 attempts — see the diagnostics above');
  }
  check('first-run welcome screen renders', await session.count('.welcome-card') === 1);
  check('welcome explains the app is offline-first', (await session.text('.welcome-lead')).includes('no server'));
  await session.screenshot(join(SHOTS, '01-welcome.png'));

  /* ---------------------------------------------------------- demo company */
  section('Creating a company file with demo data');

  // A deployed build deliberately does not expose a handle to its database
  // (only localhost does). Detect that once, here, and let every later section
  // decide whether it can assert against the ledger or must use the interface.
  const DEBUG = await session.evaluate('return !!(window.__rookeepa && window.__rookeepa.db);');
  if (!DEBUG) {
    console.log('  Deployed build: no debug handle, so ledger-level assertions will be');
    console.log('  replaced by checks driven through the interface.');
  }

  await session.clickText('Explore with demo data', { tag: 'button' });
  await session.waitFor(`return !!document.querySelector('.sidebar')`, { timeout: 15000 });
  await session.waitFor(`return document.querySelectorAll('.nav-item').length >= 8`, { timeout: 8000 });
  check('sidebar renders with all sections', await session.count('.nav-item') >= 8);
  await sleep(400);
  // Read the open company file off the sidebar, which is what a user sees.
  const companyName = (await session.text('.company-name')).trim();
  check('demo company created', companyName.length > 0, companyName);
  if (DEBUG) {
    const dbName = await session.evaluate(`return window.__rookeepa.db.all('companies')[0].name`);
    check('the sidebar names the company file that is actually open', dbName === companyName, `${companyName} vs ${dbName}`);
  }
  await session.waitFor(`return document.querySelectorAll('.kpi, .card').length > 0`, { timeout: 8000 });

  /* -------------------------------------------------------------- walk views */
  section('Walking every screen');
  for (const [view, label] of VIEWS) {
    session.clearErrors();
    await session.evaluate(`location.hash = '#/${view}'; return true;`);
    await sleep(700);
    const hasContent = await session.evaluate(`
      const content = document.querySelector('.content');
      if (!content) return false;
      // Every screen renders a page title, and a screen with an empty state has still rendered:
      // an empty state used to count as a failure here, so "no bank rules yet" and "nothing
      // repeating yet" failed the suite that exists to notice a screen rendering nothing.
      return !!document.querySelector('.page-title') && content.textContent.trim().length > 40;
    `);
    const title = await session.text('.page-title').catch(() => '');
    await session.screenshot(join(SHOTS, `10-${view}.png`));
    const errors = session.errors().filter((e) => !/favicon|net::ERR_FILE/.test(e));
    check(`${label} screen renders`, hasContent, `title="${title.trim().slice(0, 40)}"`);
    check(`${label} screen has no console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  }

  /* ------------------------------------------------------------- the books */
  section('Checking the books with the app engine');

  let ledgerCheck = null;
  if (DEBUG) {
    ledgerCheck = await session.evaluate(`
    const { db } = window.__rookeepa;
    const company = db.all('companies')[0];
    const accounts = db.of('accounts', company.id);
    const entries = db.of('entries', company.id);
    const documents = db.of('documents', company.id);
    const payments = db.of('payments', company.id);
    const taxCodes = db.of('taxCodes', company.id);
    const reports = await import(new URL('core/reports.js', document.baseURI).href);
    const ledger = await import(new URL('core/ledger.js', document.baseURI).href);
    const asOf = new Date().toISOString().slice(0, 10);

    const unbalanced = entries.filter((e) => e.status === 'posted'
      && ledger.entryTotals(e).debit !== ledger.entryTotals(e).credit);
    const tb = reports.trialBalance({ accounts, entries, to: asOf });
    const bs = reports.balanceSheet({ accounts, entries, asOf, fyStartMonth: company.fyStartMonth });
    const ar = reports.agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'receivable', asOf });
    const ap = reports.agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'payable', asOf });
    const from = reports.incomeStatement({ accounts, entries, to: asOf }).period.from || null;
    const bas = reports.basSummary({ accounts, entries, taxCodes, to: asOf });
    const docsModule = await import(new URL('core/docs.js', document.baseURI).href);
    const bank = docsModule.reconciliation(db, company.id, '1-0000', asOf);
    return {
      entries: entries.length,
      documents: documents.length,
      unbalanced: unbalanced.length,
      trialBalanced: tb.balanced,
      closing: tb.totals.closing,
      bsDifference: bs.difference,
      arTotal: ar.totals.total,
      arControl: ar.controlBalance,
      arReconciles: ar.reconciles,
      apReconciles: ap.reconciles,
      gst1A: bas.boxes['1A'],
      gst1B: bas.boxes['1B'],
      netGst: bas.netGst,
      bankReconciles: bank.reconciles,
      bankDifference: bank.difference,
    };
  `);

    check('demo books posted entries', ledgerCheck.entries > 10, `${ledgerCheck.entries} entries`);
    check('no unbalanced entries', ledgerCheck.unbalanced === 0, `${ledgerCheck.unbalanced} bad`);
    check('trial balance balances', ledgerCheck.trialBalanced === true, `closing ${ledgerCheck.closing}`);
    check('balance sheet balances', ledgerCheck.bsDifference === 0, `difference ${ledgerCheck.bsDifference}`);
    check('aged receivables reconcile to the control account', ledgerCheck.arReconciles === true,
      `${ledgerCheck.arTotal} vs ${ledgerCheck.arControl}`);
    check('aged payables reconcile to the control account', ledgerCheck.apReconciles === true);
    check('GST figures computed', ledgerCheck.gst1A !== 0 || ledgerCheck.gst1B !== 0,
      `1A ${ledgerCheck.gst1A}, 1B ${ledgerCheck.gst1B}, net ${ledgerCheck.netGst}`);
    check('the bank account reconciles against its statement', ledgerCheck.bankReconciles === true,
      `out by ${ledgerCheck.bankDifference} cents`);
  } else {
    for (const name of [
      'demo books posted entries', 'no unbalanced entries', 'trial balance balances',
      'balance sheet balances', 'aged receivables reconcile to the control account',
      'aged payables reconcile to the control account', 'GST figures computed',
      'the bank account reconciles against its statement',
    ]) skip(name, 'ledger-level: needs the debug handle, which deployed builds do not expose');
  }

  /* -------------------------------------------------- raise an invoice in the UI */
  section('Raising an invoice through the interface');
  session.clearErrors();
  await session.evaluate(`location.hash = '#/sales'; return true;`);
  await sleep(700);
  // Count invoices through the interface when there is no debug handle, so the
  // deployed build is checked the way a visitor would experience it.
  const invoiceRows = async () => session.evaluate(`
    const rows = [...document.querySelectorAll('.content table tbody tr')];
    return rows
      .map((tr) => [...tr.children].map((td) => td.textContent.replace(/\\s+/g, ' ').trim()))
      .filter((cells) => /^INV-\\d+$/.test(cells[0] || ''));
  `);
  const beforeCount = DEBUG
    ? await session.evaluate(`
        const { db } = window.__rookeepa;
        return db.of('documents', db.all('companies')[0].id).filter((d) => d.type === 'invoice').length;
      `)
    : (await invoiceRows()).length;

  await session.clickText('New invoice', { tag: 'button' });
  await session.waitFor(`return !!document.querySelector('.modal .doc-editor')`, { timeout: 8000 });
  check('invoice editor opens', await session.count('.modal .doc-editor') === 1);

  // customer
  await session.selectOption('.modal select', await session.evaluate(`
    const sel = document.querySelector('.modal select');
    const opt = [...sel.options].find((o) => o.value && o.value !== '');
    return opt ? opt.value : '';
  `));
  // description / qty / price on the first line
  await session.fill('.modal .line-row .line-desc', 'Consulting services');
  await session.fill('.modal .line-row .input-qty', '2');
  await session.fill('.modal .line-row .input-money', '500');
  await session.waitFor(`return document.querySelector('.modal .total-row') !== null`, { timeout: 5000 });
  const shownTotal = await session.text('.modal .totals-table');
  check('editor recomputes GST live', /1,100\.00/.test(shownTotal.replace(/\s+/g, ' ')),
    shownTotal.replace(/\s+/g, ' ').slice(0, 80));
  await session.screenshot(join(SHOTS, '30-invoice-editor.png'));

  await session.clickText('Show the journal entry', { tag: 'button' });
  await sleep(500);
  const preview = await session.text('.modal-backdrop:last-of-type .modal-body');
  check('journal preview shows the double entry', /Accounts Receivable|Debtors/i.test(preview));
  await session.screenshot(join(SHOTS, '31-journal-preview.png'));
  // Close the preview (the topmost modal) and make sure the editor survived.
  await session.clickText('Close', { tag: 'button', within: '.modal-backdrop:last-of-type .modal-foot' }).catch(async () => {
    await session.evaluate(`
      const backs = [...document.querySelectorAll('.modal-backdrop')];
      const last = backs[backs.length - 1];
      const btn = [...last.querySelectorAll('button')].find((b) => /close/i.test(b.textContent));
      if (btn) btn.click();
      return true;
    `);
  });
  await sleep(400);
  check('the editor is still open after closing the preview', await session.count('.modal .doc-editor') === 1);

  await session.clickText('Authorise invoice', { tag: 'button' });
  await sleep(900);

  if (!DEBUG) {
    // Deployed build: read the result off the sales list, as a user would.
    await session.evaluate(`location.hash = '#/sales'; return true;`);
    await sleep(700);
    const rows = (await invoiceRows()).sort((a, b) => a[0].localeCompare(b[0]));
    const newest = rows[rows.length - 1] || [];
    const joined = newest.join(' | ');
    check('a new invoice appears in the sales list', rows.length === beforeCount + 1, `${beforeCount} -> ${rows.length}`);
    check('it is numbered and shows as open', /^INV-\d+$/.test(newest[0] || '') && /open/i.test(joined), `${newest[0]} — ${joined.slice(0, 70)}`);
    check('its total is right for 2 x $500 + GST', /1,100\.00/.test(joined), joined.slice(0, 90));
    check('and its balance is the same amount, unpaid', (joined.match(/1,100\.00/g) || []).length >= 2, joined.slice(0, 90));
  } else {
    const after = await session.evaluate(`
      const { db } = window.__rookeepa;
      const company = db.all('companies')[0];
      const docs = db.of('documents', company.id).filter((d) => d.type === 'invoice');
      const newest = docs[docs.length - 1];
      const entries = db.of('entries', company.id);
      const ledger = await import(new URL('core/ledger.js', document.baseURI).href);
      const docsModule = await import(new URL('core/docs.js', document.baseURI).href);
      const taxCodes = db.of('taxCodes', company.id);
      const payments = db.of('payments', company.id);
      const summary = docsModule.documentSummary(newest, taxCodes, payments, new Date().toISOString().slice(0, 10));
      const entry = entries.find((e) => e.source && e.source.id === newest.id);
      return {
        count: docs.length,
        number: newest.number,
        status: newest.status,
        total: summary.total,
        gst: summary.tax,
        balanced: entry ? ledger.entryTotals(entry).balanced : false,
        lines: entry ? entry.lines.length : 0,
      };
    `);
    check('a new invoice was created', after.count === beforeCount + 1, `${beforeCount} -> ${after.count}`);
    check('invoice was numbered and authorised', after.status === 'open' && /^INV-/.test(after.number || ''), `${after.number} (${after.status})`);
    check('invoice total is right for 2 x $500 + GST', after.total === 110000, `${after.total} cents`);
    check('invoice GST is right', after.gst === 10000, `${after.gst} cents`);
    check('its journal entry balances', after.balanced === true, `${after.lines} lines`);

    const stillGood = await session.evaluate(`
      const { db } = window.__rookeepa;
      const company = db.all('companies')[0];
      const reports = await import(new URL('core/reports.js', document.baseURI).href);
      const accounts = db.of('accounts', company.id);
      const entries = db.of('entries', company.id);
      const bs = reports.balanceSheet({ accounts, entries, asOf: new Date().toISOString().slice(0, 10), fyStartMonth: company.fyStartMonth });
      const tb = reports.trialBalance({ accounts, entries, to: new Date().toISOString().slice(0, 10) });
      return { bsDifference: bs.difference, trialBalanced: tb.balanced };
    `);
    check('the books still balance after the UI posted an invoice',
      stillGood.bsDifference === 0 && stillGood.trialBalanced === true,
      `bs diff ${stillGood.bsDifference}`);
  }
  await session.screenshot(join(SHOTS, '32-sales-after-invoice.png'));

  // The balanced indicators are on-screen too: check them through the interface
  // when the ledger itself is out of reach. Read the indicator elements rather
  // than the whole page, so a report's own verdict is what is being asserted.
  if (!DEBUG) {
    const indicator = async (slug) => {
      await session.evaluate(`location.hash = '#/reports/${slug}'; return true;`);
      await sleep(700);
      return session.evaluate(`
        const flags = [...document.querySelectorAll('.content .report-check')]
          .map((n) => n.textContent.replace(/\\s+/g, ' ').trim());
        return { tables: document.querySelectorAll('.content table').length, flags };
      `);
    };

    const bs = await indicator('balance-sheet');
    check('the live balance sheet reports that it balances',
      bs.tables >= 1 && bs.flags.some((f) => /balanc/i.test(f)) && !bs.flags.some((f) => /does not|out by/i.test(f)),
      bs.flags.join(' | ') || 'no indicator found');

    const tb = await indicator('trial-balance');
    check('the live trial balance reports that it balances',
      tb.tables >= 1 && tb.flags.some((f) => /balanc/i.test(f)) && !tb.flags.some((f) => /does not|out by/i.test(f)),
      tb.flags.join(' | ') || 'no indicator found');

    const ar = await indicator('aged-receivables');
    check('the live aged receivables report reconciles to its control account',
      ar.tables >= 1 && ar.flags.some((f) => /reconcil/i.test(f)) && !ar.flags.some((f) => /does not|out by|mismatch/i.test(f)),
      ar.flags.join(' | ') || 'no indicator found');
  } else {
    skip('the live balance sheet reports that it balances', 'checked against the ledger above');
    skip('the live trial balance reports that it balances', 'checked against the ledger above');
    skip('the live aged receivables report reconciles to its control account', 'checked against the ledger above');
  }

  /* ---------------------------------------------------------------- reports */
  section('Reports screens');
  for (const [id, label] of [['pnl', 'Profit & loss'], ['balance-sheet', 'Balance sheet'],
    ['trial-balance', 'Trial balance'], ['general-ledger', 'General ledger'], ['aged-receivables', 'Aged receivables'],
    ['aged-payables', 'Aged payables'], ['gst', 'Activity statement'], ['cash-flow', 'Cash flow'], ['journal', 'Journal']]) {
    session.clearErrors();
    await session.evaluate(`location.hash = '#/reports/${id}'; return true;`);
    await sleep(650);
    const ok = await session.evaluate(`
      const c = document.querySelector('.content');
      return !!c && c.textContent.length > 120 && c.querySelectorAll('table').length >= 1;
    `);
    const errors = session.errors();
    await session.screenshot(join(SHOTS, `20-report-${id}.png`));
    check(`report "${label}" renders a table`, ok);
    if (errors.length) check(`report "${label}" console clean`, false, errors.slice(0, 2).join(' | '));
  }

  /* --------------------------------- money in and out, through the interface */
  // These four checks exist because the unit suite and the module-parse check both
  // passed happily while paying or receiving money was *impossible* (a helper was
  // called without being imported, so the dialog rendered with an empty body) and
  // while every GST-inclusive document silently changed amount when re-saved.
  section('Money in and out through the interface');
  await session.goto(`${BASE}#/sales`);
  await waitForRows();
  session.clearErrors();

  const opened = await session.evaluate(`
    const b = [...document.querySelectorAll('button')].find((x) => /Receive payment/i.test(x.textContent));
    if (!b) return false;
    b.click(); return true;
  `);
  await sleep(1100);
  const dialog = await session.evaluate(`
    const m = document.querySelector('.modal');
    return m ? { selects: m.querySelectorAll('select').length, inputs: m.querySelectorAll('input').length } : null;
  `);
  // A dialog element that exists but carries no fields is the failure mode, so test
  // for the fields themselves — not merely for a .modal being present.
  const dialogOk = !!dialog && dialog.selects >= 1 && dialog.inputs >= 2;
  check('the receive-payment dialog renders its actual fields', opened && dialogOk,
    dialog ? `selects ${dialog.selects}, inputs ${dialog.inputs}` : 'the dialog body did not render');
  check('opening the receive-payment dialog raises no errors', session.errors().length === 0,
    session.errors().slice(0, 2).join(' | '));
  await session.screenshot(join(SHOTS, '33-receive-dialog.png'));

  // Complete a receipt for real: choose the customer, then save. If the dialog body
  // did not render (the defect above), skip the dependent steps rather than crashing,
  // so one failure still produces a full report instead of hiding every later check.
  if (dialogOk) {
    session.clearErrors();
    await session.evaluate(`
      const m = document.querySelector('.modal');
      const sel = m.querySelector('select');
      const opt = [...sel.options].find((o) => o.value);
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);
    await sleep(900);
    for (let attempt = 0; attempt < 3; attempt++) {
      const clicked = await session.evaluate(`
        const b = [...document.querySelectorAll('.modal button')]
          .find((x) => /Record (receipt|payment)|Confirm|Yes|Save/i.test(x.textContent.trim()));
        if (!b) return false;
        b.click(); return true;
      `);
      if (!clicked) break;
      await sleep(1000);
    }
    const stillOpen = await session.count('.modal');
    check('recording a receipt completes with no errors', session.errors().length === 0,
      session.errors().slice(0, 2).join(' | '));
    check('the receipt dialog closes once the money is recorded', stillOpen === 0, `${stillOpen} dialog(s) left open`);
  } else {
    await session.evaluate(`
      const b = [...document.querySelectorAll('.modal button')].find((x) => /Cancel/i.test(x.textContent));
      if (b) b.click(); return true;
    `);
    skip('recording a receipt completes with no errors', 'the dialog body never rendered');
    skip('the receipt dialog closes once the money is recorded', 'the dialog body never rendered');
  }

  // GST-inclusive pricing: type 110 with "prices include GST" ticked and the total
  // must stay 110.00. Tick the box and the document must not silently become 121.00.
  await session.goto(`${BASE}#/sales`);
  await waitForRows();
  await session.evaluate(`
    const b = [...document.querySelectorAll('button')].find((x) => /New invoice/i.test(x.textContent));
    b.click(); return true;
  `);
  await sleep(1100);
  const inclusiveTotal = await session.evaluate(`
    const m = document.querySelector('.modal');
    const box = m.querySelector('input.checkbox');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const desc = m.querySelector('.line-desc');
    desc.value = 'Inclusive pricing check';
    desc.dispatchEvent(new Event('input', { bubbles: true }));
    const price = m.querySelector('.input-money:not(.col-discount)');
    price.value = '110';
    price.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(900);
  const totalsText = await session.evaluate(`
    const t = document.querySelector('.modal .totals-table');
    return t ? t.textContent.replace(/\\s+/g, ' ').trim() : '';
  `);
  check('a GST-inclusive line keeps the amount you typed (110 stays 110.00, not 121.00)',
    inclusiveTotal && totalsText.includes('$110.00') && !totalsText.includes('$121.00'),
    totalsText || 'no totals table');
  await session.screenshot(join(SHOTS, '34-inclusive-pricing.png'));
  await session.evaluate(`
    const b = [...document.querySelectorAll('.modal button')].find((x) => /Cancel/i.test(x.textContent));
    if (b) b.click(); return true;
  `);

  // The lists must line amounts up, and the aged reports must name who owes what.
  await session.goto(`${BASE}#/sales`);
  await waitForRows();
  const align = await session.evaluate(`
    const td = document.querySelector('.table tbody td.col-right');
    return td ? getComputedStyle(td).textAlign : 'none';
  `);
  check('money columns in the list tables are right-aligned', align === 'right', `computed text-align: ${align}`);

  await session.evaluate(`location.hash = '#/reports/aged-receivables'; return true;`);
  await sleep(900);
  const aged = await session.evaluate(`
    const rows = [...document.querySelectorAll('.content tbody tr')].map((tr) => tr.textContent.replace(/\\s+/g, ' ').trim());
    return { count: rows.length, anonymous: rows.filter((r) => /no contact/i.test(r)).length, sample: rows.slice(0, 2) };
  `);
  check('the aged receivables report names the customers who owe money',
    aged.count > 0 && aged.anonymous === 0,
    `${aged.anonymous} of ${aged.count} rows read "(no contact)" | ${aged.sample.join(' ; ')}`);
  await session.screenshot(join(SHOTS, '21-report-aged-named.png'));

  /* ----------------------------------------------------------- sorting a list */
  // Sorting re-rendered the body without the row options, so every action button and
  // the click-to-open behaviour disappeared the moment a header was clicked.
  section('Sorting a list');
  await session.goto(`${BASE}#/sales`);
  await waitForRows();
  const beforeSort = await session.evaluate(`
    const row = document.querySelector('.table tbody tr');
    return row ? {
      actions: row.querySelectorAll('.table-actions button').length,
      clickable: row.classList.contains('clickable'),
      tabindex: row.getAttribute('tabindex'),
    } : null;
  `);
  const clickedSort = await session.evaluate(`
    const th = document.querySelector('.table thead th.sortable');
    if (!th) return false;
    th.click(); return true;
  `);
  await sleep(700);
  const afterSort = await session.evaluate(`
    const row = document.querySelector('.table tbody tr');
    return row ? {
      actions: row.querySelectorAll('.table-actions button').length,
      clickable: row.classList.contains('clickable'),
      tabindex: row.getAttribute('tabindex'),
    } : null;
  `);
  // What sorting actually broke was the row interaction: the action buttons are column
  // content and survived, but the row stopped being clickable and lost its tabindex, so
  // clicking or keyboarding into an invoice stopped working after touching a header.
  check('sorting a list keeps its rows clickable and keyboard-reachable',
    clickedSort && beforeSort && afterSort
      && afterSort.clickable === beforeSort.clickable && afterSort.tabindex === beforeSort.tabindex,
    `clickable ${beforeSort ? beforeSort.clickable : '?'} -> ${afterSort ? afterSort.clickable : '?'}, `
      + `tabindex ${beforeSort ? beforeSort.tabindex : '?'} -> ${afterSort ? afterSort.tabindex : '?'}`);
  check('and the row actions are still rendered after sorting (a guard)',
    clickedSort && beforeSort && afterSort && afterSort.actions === beforeSort.actions && afterSort.actions > 0,
    `${beforeSort ? beforeSort.actions : '?'} actions before, ${afterSort ? afterSort.actions : '?'} after`);
  await session.screenshot(join(SHOTS, '35-after-sort.png'));

  /* --------------------------------------------------------------- persistence */
  section('Persistence');
  await session.goto(`${BASE}#/sales`);
  await sleep(800);
  const persisted = await session.evaluate(`
    const raw = await new Promise((res) => {
      const req = indexedDB.open('rookeepa');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('collections', 'readonly');
        const get = tx.objectStore('collections').get('documents');
        get.onsuccess = () => res(Array.isArray(get.result) ? get.result.length : 0);
        get.onerror = () => res(-1);
      };
      req.onerror = () => res(-1);
    });
    return raw;
  `);
  check('documents are persisted to IndexedDB', persisted > 10, `${persisted} stored`);

  /* ------------------------------------------------------------------ summary */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n================ ${results.length - failed.length}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''} ================`);
  if (skipped.length) {
    console.log('Skipped (and why):');
    for (const s of skipped) console.log(` - ${s.name}${s.why ? ` (${s.why})` : ''}`);
  }
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }
  console.log(`Screenshots: ${SHOTS}`);
  await closeSelf();
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error('\nSmoke test crashed:', err.message);
  try { await session.screenshot(join(SHOTS, '99-crash.png')); } catch { /* ignore */ }
  console.error(`A screenshot of the failure is in ${SHOTS}/99-crash.png`);
  await closeSelf();
  process.exit(2);
}
