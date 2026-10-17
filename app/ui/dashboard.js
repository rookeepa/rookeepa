/**
 * Rookeepa — Dashboard.
 *
 * The first screen: what the business is worth, what is owed in and out, what
 * needs doing today, and how the year is tracking. On a brand-new company file
 * there is nothing to report yet, so it shows a short setup checklist instead
 * of a wall of zeroes — and an offer to load a separate demo company file.
 *
 * Everything here is read from ctx.data on every render (never cached) and
 * every number is derived by the core reporting engine, so the dashboard can
 * never disagree with the reports it links to.
 */

import {
  h, card, pageHeader, kpi, table, moneyCell, statusBadge, badge, button,
  emptyState, barChart, banner, ICONS, progressBar,
} from './kit.js';
import { dashboardKpis, monthlyPnl } from '../core/reports.js';
import { documentSummary, paymentsByDocument } from '../core/docs.js';
import { openPaymentModal } from './payment-modal.js';
import { seedDemoCompany } from '../core/sample.js';
import { fyLabel, daysBetween, todayISO } from '../core/dates.js';
import { exportCompany, downloadJson, backupFilename } from '../core/backup.js';
import { dueTemplates, frequencyLabel } from '../core/recurring.js';

export const meta = {
  title: 'Dashboard',
  subtitle: 'Where the business stands and what needs doing',
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM' -> 'Jul'. Bar labels are tiny, so the year would only be noise. */
function monthAbbr(key) {
  const m = Number(String(key).slice(5, 7));
  return MONTH_ABBR[m - 1] || String(key);
}

const ACTION_TONES = {
  create: 'accent',
  insert: 'accent',
  update: 'neutral',
  authorise: 'info',
  post: 'info',
  repost: 'info',
  openingBalances: 'info',
  payment: 'positive',
  void: 'negative',
  delete: 'negative',
};

export async function render(ctx) {
  const { company, data, asOf } = ctx;
  const code = company?.currency || 'AUD';
  const root = h('div');

  root.appendChild(pageHeader({
    title: company?.name || 'Dashboard',
    subtitle: `as at ${ctx.fmt.date(asOf)}`,
    actions: [
      button({ label: 'New invoice', variant: 'primary', size: 'sm', icon: ICONS.plus, onClick: () => ctx.go('sales') }),
      button({
        label: 'Receive money',
        variant: 'subtle',
        size: 'sm',
        onClick: () => openPaymentModal(ctx, { type: 'customer', onSaved: () => ctx.refresh() }),
      }),
    ],
  }));

  // A brand-new company file: no documents and nothing posted to the ledger.
  const isEmpty = (data.documents || []).length === 0 && (data.entries || []).length === 0;
  // The set-up card follows its own progress now: it stays until the steps are done, skipped
  // or hidden, rather than vanishing the moment the first invoice exists.
  const setup = setupCard(ctx);
  if (isEmpty) {
    if (setup) root.appendChild(setup);
    return root;
  }
  if (setup) root.appendChild(setup);

  const k = dashboardKpis({
    accounts: data.accounts,
    entries: data.entries,
    documents: data.documents,
    payments: data.payments,
    taxCodes: data.taxCodes,
    company,
    asOf,
  });

  root.appendChild(kpiRow(ctx, k, code));
  root.appendChild(attentionCard(ctx, k, code));
  root.appendChild(yearGlanceCard(ctx, k, code));
  root.appendChild(recentActivityCard(ctx));
  return root;
}

/* --------------------------------------------------------------------- KPIs */

function kpiRow(ctx, k, code) {
  const taxLabel = ctx.company?.taxLabel || 'GST';
  const gstSub = k.gstBalance > 0
    ? `${taxLabel} owing`
    : k.gstBalance < 0
      ? `${taxLabel} refund due`
      : `Nothing owing or refundable`;

  return h('div', { class: 'stat-grid' },
    kpi({
      label: 'Cash at bank',
      value: moneyCell(k.cash, { code }),
      sub: 'Across your bank accounts',
      onClick: () => ctx.go('reports', ['cash-flow']),
    }),
    kpi({
      label: 'Money owed to you',
      value: moneyCell(k.receivables, { code }),
      sub: k.overdueCount
        ? `${k.overdueCount} overdue · ${ctx.fmt.money(k.overdueTotal, { code })}`
        : 'Nothing overdue',
      tone: k.overdueCount ? 'warn' : 'default',
      onClick: () => ctx.go('reports', ['aged-receivables']),
    }),
    kpi({
      label: 'Money you owe',
      value: moneyCell(k.payables, { code }),
      sub: 'Bills still to pay',
      tone: k.payables > 0 ? 'warn' : 'default',
      onClick: () => ctx.go('reports', ['aged-payables']),
    }),
    kpi({
      label: `${taxLabel} position`,
      value: moneyCell(k.gstBalance, { code }),
      sub: gstSub,
      tone: k.gstBalance > 0 ? 'warn' : (k.gstBalance < 0 ? 'positive' : 'default'),
      onClick: () => ctx.go('reports', ['gst']),
    }),
    kpi({
      label: 'Revenue this year',
      value: moneyCell(k.revenueFy, { code }),
      sub: `Net profit ${ctx.fmt.money(k.netProfitFy, { code })}`,
      tone: k.netProfitFy >= 0 ? 'positive' : 'negative',
      onClick: () => ctx.go('reports', ['pnl']),
    }),
    kpi({
      label: 'Net assets',
      value: moneyCell(k.netAssets, { code }),
      sub: 'Assets less liabilities',
      tone: k.netAssets >= 0 ? 'default' : 'negative',
      onClick: () => ctx.go('reports', ['balance-sheet']),
    }),
  );
}

/* ------------------------------------------------------- needs your attention */

function attentionCard(ctx, k, code) {
  const { data, asOf } = ctx;
  const contactName = (id) => (data.contacts.find((c) => c.id === id) || {}).name || 'Unknown contact';
  // These lists re-summarise documents the dashboard already summarised, so the receipts are
  // indexed once here too rather than scanned again for each one.
  const paymentIndex = paymentsByDocument(data.payments || []);

  const overdue = (k.overdueInvoices || []).map((doc) => ({
    doc,
    summary: documentSummary(doc, data.taxCodes, data.payments, asOf, paymentIndex),
    name: contactName(doc.contactId),
  }));
  const bills = (k.billsDueSoon || []).map((doc) => ({
    doc,
    summary: documentSummary(doc, data.taxCodes, data.payments, asOf, paymentIndex),
    name: contactName(doc.contactId),
  }));
  const dueSchedules = dueTemplates(data.recurring || [], asOf);

  const body = h('div');

  if (!overdue.length && !bills.length && !dueSchedules.length) {
    body.appendChild(emptyState({
      icon: ICONS.check,
      title: 'Nothing needs you right now',
      message: 'No overdue invoices, no bills due in the next seven days, and no recurring transactions waiting.',
    }));
  } else {
    const sections = [];

    if (overdue.length) {
      sections.push(h('div', null,
        subHeading(`Overdue invoices (${overdue.length})`),
        table({
          columns: [
            { key: 'number', label: 'Invoice', render: (r) => h('span', { class: 'mono strong' }, r.doc.number || '—') },
            { key: 'customer', label: 'Customer', render: (r) => r.name },
            { key: 'due', label: 'Due', render: (r) => ctx.fmt.date(r.doc.dueDate || r.doc.date) },
            { key: 'days', label: 'Overdue', align: 'right', render: (r) => `${r.summary.overdueDays} days` },
            { key: 'balance', label: 'Balance', align: 'right', render: (r) => moneyCell(r.summary.balance, { code }) },
            {
              key: 'act',
              label: '',
              align: 'right',
              render: (r) => button({
                label: 'Receive',
                size: 'sm',
                variant: 'subtle',
                onClick: () => openPaymentModal(ctx, {
                  type: 'customer',
                  contactId: r.doc.contactId,
                  docId: r.doc.id,
                  amount: r.summary.balance,
                  onSaved: () => ctx.refresh(),
                }),
              }),
            },
          ],
          rows: overdue,
          compact: true,
        })));
    }

    if (bills.length) {
      sections.push(h('div', null,
        subHeading('Bills due in the next 7 days'),
        table({
          columns: [
            { key: 'number', label: 'Bill', render: (r) => h('span', { class: 'mono strong' }, r.doc.number || '—') },
            { key: 'supplier', label: 'Supplier', render: (r) => r.name },
            { key: 'due', label: 'Due', render: (r) => ctx.fmt.date(r.doc.dueDate || r.doc.date) },
            { key: 'balance', label: 'Balance', align: 'right', render: (r) => moneyCell(r.summary.balance, { code }) },
            {
              key: 'act',
              label: '',
              align: 'right',
              render: (r) => button({
                label: 'Pay',
                size: 'sm',
                variant: 'subtle',
                onClick: () => openPaymentModal(ctx, {
                  type: 'supplier',
                  contactId: r.doc.contactId,
                  docId: r.doc.id,
                  amount: r.summary.balance,
                  onSaved: () => ctx.refresh(),
                }),
              }),
            },
          ],
          rows: bills,
          compact: true,
        })));
    }

    // A schedule is a reminder, not a transaction: nothing has been recorded until you create
    // the draft and authorise it, so this section says what is waiting rather than showing money.
    if (dueSchedules.length) {
      sections.push(h('div', null,
        subHeading(`Recurring to create (${dueSchedules.length})`),
        table({
          columns: [
            { key: 'name', label: 'Schedule', render: (r) => r.name || '(unnamed)' },
            { key: 'contact', label: 'For', render: (r) => contactName(r.contactId) },
            { key: 'due', label: 'Was due', render: (r) => ctx.fmt.date(r.nextDate) },
            { key: 'repeats', label: 'Repeats', render: (r) => frequencyLabel(r.frequency) },
            {
              key: 'act',
              label: '',
              align: 'right',
              render: () => button({
                label: 'Create',
                size: 'sm',
                variant: 'subtle',
                onClick: () => { location.hash = '#/recurring'; },
              }),
            },
          ],
          rows: dueSchedules,
          compact: true,
        })));
    }

    body.appendChild(h('div', { class: 'stack' }, sections));
  }

  // The books live in this browser and nowhere else, so a backup is the only copy that survives a
  // cleared browser, a lost laptop or a change of machine. This sits outside the branches above:
  // a business with nothing overdue is exactly the one whose backup has quietly gone stale.
  const lastBackup = ctx.ui.get('lastBackupAt');
  const backupAge = lastBackup ? daysBetween(String(lastBackup).slice(0, 10), todayISO()) : null;
  if (backupAge === null || backupAge >= 7) {
    body.appendChild(banner({
      kind: backupAge === null ? 'info' : 'warning',
      title: backupAge === null ? 'No backup taken yet' : `Last backup was ${backupAge} days ago`,
      message: 'Your books live in this browser. Download a copy you can keep — it is the whole company file, and restoring it takes one step.',
      actions: [button({
        label: 'Download a backup',
        variant: 'primary',
        onClick: () => {
          const company = ctx.db.get('companies', ctx.companyId);
          downloadJson(backupFilename(company), exportCompany(ctx.db, ctx.companyId));
          ctx.ui.set('lastBackupAt', new Date().toISOString());
          ctx.toast('Backup downloaded', 'success', { detail: 'Keep it somewhere safe — it is your whole company file.' });
          ctx.refresh();
        },
      })],
    }));
  }

  return card({
    title: 'Needs your attention',
    subtitle: 'Overdue invoices, bills coming up, and recurring transactions to create',
    body,
  });
}

/* ------------------------------------------------------- this year at a glance */

function yearGlanceCard(ctx, k, code) {
  const { data, asOf } = ctx;
  const monthly = monthlyPnl({ accounts: data.accounts, entries: data.entries, from: k.fyStart, to: asOf });
  const money = (v) => ctx.fmt.money(v, { code });

  const charts = h('div', { class: 'grid grid-2' },
    h('div', null,
      subHeading('Income'),
      barChart({ points: monthly.map((m) => ({ label: monthAbbr(m.month), value: m.income })), height: 130, format: money, tone: 'series-1' })),
    h('div', null,
      subHeading('Expenses'),
      barChart({ points: monthly.map((m) => ({ label: monthAbbr(m.month), value: m.expenses })), height: 130, format: money, tone: 'series-2' })));

  return card({
    title: 'This year at a glance',
    subtitle: `Income and expenses by month · ${fyLabel(asOf, ctx.company?.fyStartMonth || 7)}`,
    body: charts,
  });
}

/* ------------------------------------------------------------ recent activity */

function recentActivityCard(ctx) {
  const { data } = ctx;
  const rows = [...(data.auditLog || [])]
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, 8);

  let body;
  if (rows.length) {
    body = table({
      columns: [
        { key: 'when', label: 'When', render: (r) => ctx.fmt.date(r.at) },
        { key: 'action', label: 'Action', render: (r) => badge(String(r.action || ''), ACTION_TONES[r.action] || 'neutral') },
        { key: 'detail', label: 'Detail', render: (r) => r.detail || '' },
      ],
      rows,
      compact: true,
    });
  } else {
    const docs = [...(data.documents || [])]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 8);
    body = docs.length
      ? table({
        columns: [
          { key: 'number', label: 'Document', render: (r) => h('span', { class: 'mono' }, r.number || '—') },
          { key: 'date', label: 'Date', render: (r) => ctx.fmt.date(r.date) },
          { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
        ],
        rows: docs,
        compact: true,
      })
      : emptyState({
        title: 'No activity yet',
        message: 'As you raise invoices, record payments and categorise bank lines, they will appear here.',
      });
  }

  return card({
    title: 'Recent activity',
    subtitle: 'The last few things that happened in this company file',
    body,
  });
}

/* -------------------------------------------------------------- first-run */

/**
 * "Get set up" — the same guidance, but it now knows what has been done. Each step completes
 * from the real data, so the card reads as progress rather than a leaflet, and it stays out
 * of the way once there is nothing left to prompt: a step can be skipped on its own, and the
 * card as a whole can be hidden.
 */
function setupCard(ctx) {
  if (ctx.ui.get('setupHidden')) return null;
  const { contacts = [], items = [], documents = [], bankTxns = [] } = ctx.data || {};
  const company = ctx.company || {};
  const skipped = new Set(ctx.ui.get('setupSkipped') || []);
  const isEmpty = !contacts.length && !items.length && !documents.length && !bankTxns.length;

  const steps = [
    {
      id: 'details',
      title: 'Fill in your business details',
      body: 'Legal name, ABN, and a logo to print on your invoices.',
      label: 'Open settings',
      run: () => ctx.go('settings'),
      done: !!(company.abn || company.legalName || company.logoDataUrl),
    },
    {
      id: 'contacts',
      title: 'Add customers and suppliers',
      body: 'Everyone you invoice or pay. They appear on documents and in reports.',
      label: 'Add contacts',
      run: () => ctx.go('contacts'),
      done: contacts.length > 0,
    },
    {
      id: 'items',
      title: 'Add something you sell',
      body: 'Items carry a price and a tax code so invoices fill themselves in.',
      label: 'Open items',
      run: () => ctx.go('items'),
      done: items.length > 0,
    },
    {
      id: 'invoice',
      title: 'Raise your first invoice',
      body: 'Bill a customer — the ledger and the GST post themselves.',
      label: 'Open sales',
      run: () => ctx.go('sales'),
      done: documents.some((d) => d.type === 'invoice'),
    },
    {
      id: 'bank',
      title: 'Import and categorise a bank statement',
      body: 'Bring in a CSV from your bank, then categorise each line.',
      label: 'Open banking',
      run: () => ctx.go('banking'),
      done: bankTxns.length > 0,
    },
    {
      id: 'backup',
      title: 'Take your first backup',
      body: 'One JSON file holding the whole company file. Keep it somewhere safe — it is your records.',
      label: 'Open backup',
      run: () => ctx.go('settings'),
      done: !!ctx.ui.get('lastBackupAt'),
    },
  ];

  const open = steps.filter((s) => !s.done && !skipped.has(s.id));
  if (!open.length) return null;
  const doneCount = steps.filter((s) => s.done).length;

  const skip = (id) => {
    ctx.ui.set('setupSkipped', [...new Set([...(ctx.ui.get('setupSkipped') || []), id])]);
    ctx.refresh();
  };
  const hide = () => {
    ctx.ui.set('setupHidden', true);
    ctx.refresh();
  };

  const list = h('div', { class: 'stack' },
    steps.map((step, i) => {
      const stepSkipped = skipped.has(step.id);
      if (stepSkipped && !step.done) return null;
      return h('div', { class: `row setup-step${step.done ? ' done' : ''}`, style: { alignItems: 'flex-start' } },
        step.done ? badge('✓', 'positive') : badge(String(i + 1), 'accent'),
        h('div', { class: 'stack', style: { flex: '1', gap: '0.1rem' } },
          h('strong', { class: 'setup-title' }, step.title),
          h('p', { class: 'muted small', style: { margin: '0' } }, step.body)),
        step.done
          ? h('span', { class: 'small muted nowrap' }, 'Done')
          : button({ label: step.label, variant: 'subtle', size: 'sm', onClick: step.run }),
        step.done ? null : button({ label: 'Skip', variant: 'ghost', size: 'sm', onClick: () => skip(step.id) }));
    }));

  const alsoWorthDoing = h('div', { class: 'row' },
    button({ label: 'Set opening balances', variant: 'ghost', size: 'sm', icon: ICONS.accounts, onClick: () => ctx.go('accounts') }),
    button({ label: 'See your reports', variant: 'ghost', size: 'sm', icon: ICONS.reports, onClick: () => ctx.go('reports') }));

  const demo = isEmpty
    ? h('div', { class: 'row-between' },
      h('div', { class: 'stack', style: { gap: '0.1rem', maxWidth: '46rem' } },
        h('strong', null, 'Or explore with demo data'),
        h('p', { class: 'muted small', style: { margin: '0' } },
          'Creates a separate demo company file with a year of invoices, bills, payments and a categorised bank statement. It does not add anything to this company file — open it from the company switcher, or delete it whenever you like.')),
      button({ label: 'Load demo company', variant: 'subtle', icon: ICONS.dashboard, onClick: () => loadDemo(ctx) }))
    : null;

  return card({
    title: 'Get set up',
    subtitle: `${doneCount} of ${steps.length} done`,
    actions: button({ label: 'Hide', variant: 'ghost', size: 'sm', onClick: hide }),
    body: h('div', null,
      progressBar(doneCount, steps.length),
      list,
      h('div', { class: 'divider' }),
      h('p', { class: 'muted small', style: { margin: '0 0 0.4rem' } }, 'Worth doing when you are ready:'),
      alsoWorthDoing,
      demo ? h('div', { class: 'divider' }) : null,
      demo),
  });
}

/** Seeds a brand-new, separate demo company file; leaves the open one alone. */
async function loadDemo(ctx) {
  try {
    seedDemoCompany(ctx.db);
    await ctx.db.flush();
    ctx.toast('Demo company file added', 'success', {
      detail: 'Open it from the company switcher, top left. Your own file is untouched.',
    });
    ctx.refresh();
  } catch (err) {
    ctx.toast(err?.message || 'Could not load the demo data.', 'error');
  }
}

/* -------------------------------------------------------------------- bits */

function subHeading(text) {
  return h('h3', { class: 'card-title', style: { fontSize: 'var(--fs-md)', margin: '0.25rem 0 0.5rem' } }, text);
}
