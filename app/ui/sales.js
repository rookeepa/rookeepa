/**
 * Rookeepa — Sales.
 *
 * Invoices, quotes and credit notes, and the customer receipts that pay them.
 * The screen is a filtered view over documents; every derived figure — paid,
 * balance, status, overdue days — comes from documentSummary in core, never
 * from a field stored on the record. Filtering is local UI state, so it
 * survives a re-render; anything that writes to the books goes through core
 * helpers and is followed by ctx.refresh().
 */

import {
  h, clear, append, button, iconButton, icon, pageHeader, table, moneyCell,
  statusBadge, badge, select, input, dateInput, field, toolbar, tabs, emptyState,
  kpi, toast, modal, textarea, promptDialog, checkbox, printNode, ICONS,
} from './kit.js';
import {
  documentSummary, authoriseDocument, voidDocument, deleteDraft, docTypeMeta,
} from '../core/docs.js';
import { incomeStatement, dashboardKpis } from '../core/reports.js';
import {
  fyStartFor, fyEndFor, todayISO, startOfMonth, endOfMonth, addMonths, parseISO,
} from '../core/dates.js';
import {
  DATE_PRESETS as CORE_DATE_PRESETS, NON_RANGE_PRESETS, presetRange as corePresetRange,
} from '../core/periods.js';
import { openDocumentEditor } from './document-editor.js';
import { openPaymentModal, voidPaymentFlow } from './payment-modal.js';
import { documentPrintNode, documentPlainText } from './print.js';

export const meta = {
  title: 'Sales',
  subtitle: 'Invoices, quotes and credit notes — and the money your customers have paid.',
};

/* Document tabs mirror the sales document types; the payments tab is a
 * different shape of record and gets its own table. */
const TABS = [
  { id: 'invoices', label: 'Invoices', type: 'invoice', noun: 'invoice' },
  { id: 'quotes', label: 'Quotes', type: 'quote', noun: 'quote' },
  { id: 'credit-notes', label: 'Credit notes', type: 'credit-note-sale', noun: 'credit note' },
  { id: 'payments', label: 'Payments', type: null, noun: 'receipt' },
];

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'open', label: 'Open' },
  { value: 'partly-paid', label: 'Part paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

// The named ranges live in app/core/periods.js, once, for every screen that offers them, with the two
// that are not ranges at all (all time, custom) alongside.
const PRESETS = [...CORE_DATE_PRESETS, ...NON_RANGE_PRESETS];

/* UI-only filter state. It is never book data, so it is safe to keep it across
 * re-renders so a receipt does not reset your place in the list. */
let filters = null;
let filtersForCompany = null;

/** Period boundaries for a named preset. FY bounds come from core/dates. */
/** Period boundaries for a named range. The arithmetic lives in core/periods.js, once. */
function presetRange(id, company, asOf) {
  const range = corePresetRange(id, { asOf, fyStartMonth: company?.fyStartMonth || 7 });
  // Callers here expect a range object even for a preset that is not one, so the empty range stands in.
  return range || { from: '', to: '' };
}

function defaultFilters(ctx) {
  const asOf = ctx.asOf || todayISO();
  const range = presetRange('this-fy', ctx.company, asOf);
  return {
    tab: 'invoices',
    status: 'all',
    contactId: '',
    preset: 'this-fy',
    from: range.from,
    to: range.to,
    q: '',
    includeVoided: false,
  };
}

function currentFilters(ctx) {
  if (!filters || filtersForCompany !== ctx.companyId) {
    filters = defaultFilters(ctx);
    filtersForCompany = ctx.companyId;
  }
  return filters;
}

/** @param {object} ctx  @returns {Node|Promise<Node>} */
export async function render(ctx) {
  const f = currentFilters(ctx);
  const data = ctx.data;
  const company = ctx.company;
  const cur = company?.currency || 'AUD';
  const asOf = ctx.asOf || todayISO();

  const contactById = (id) => data.contacts.find((c) => c.id === id) || null;
  const byDateDesc = (key) => (a, b) => String(key(b) || '').localeCompare(String(key(a) || ''));
  const activeTab = () => TABS.find((t) => t.id === f.tab) || TABS[0];
  const activeType = () => activeTab().type;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const inRange = (date) => (!f.from || date >= f.from) && (!f.to || date <= f.to);

  function matchesQuery(parts) {
    if (!f.q) return true;
    const hay = parts.filter(Boolean).join(' ').toLowerCase();
    return hay.includes(f.q.toLowerCase());
  }

  /* ------------------------------------------------------------- row data */

  function docRows(type) {
    return data.documents
      .filter((d) => d.type === type)
      .map((d) => ({
        doc: d,
        summary: documentSummary(d, data.taxCodes, data.payments, asOf),
        contact: contactById(d.contactId),
      }))
      .filter((r) => f.status === 'all' || r.summary.status === f.status)
      .filter((r) => !f.contactId || r.doc.contactId === f.contactId)
      .filter((r) => inRange(r.doc.date))
      .filter((r) => matchesQuery([r.doc.number, r.doc.reference, r.contact?.name, r.doc.memo]))
      .sort(byDateDesc((r) => r.doc.date));
  }

  function paymentRows() {
    return data.payments
      .filter((p) => p.type === 'customer')
      .filter((p) => f.includeVoided || p.status !== 'void')
      .filter((p) => !f.contactId || p.contactId === f.contactId)
      .filter((p) => inRange(p.date))
      .filter((p) => matchesQuery([p.number, p.reference, contactById(p.contactId)?.name, p.memo]))
      .map((p) => ({
        pay: p,
        contact: contactById(p.contactId),
        applied: (p.allocations || []).reduce((a, x) => a + (x.amount || 0), 0),
        // The notes written against each allocation when the payment was made — "second half of the
        // March invoice" — carried to where the applied amount is shown, because that is what they
        // explain. A payment with no notes carries an empty list and renders exactly as before.
        notes: (p.allocations || []).map((x) => x.note).filter(Boolean),
      }))
      .sort(byDateDesc((r) => r.pay.date));
  }

  /* ----------------------------------------------------------------- KPIs */

  function periodLabel() {
    if (!f.from && !f.to) return 'All time';
    const from = f.from ? ctx.fmt.date(f.from) : 'earliest';
    const to = f.to ? ctx.fmt.date(f.to) : 'today';
    return `${from} – ${to}`;
  }

  function kpiNodes() {
    const totals = dashboardKpis({
      accounts: data.accounts,
      entries: data.entries,
      documents: data.documents,
      payments: data.payments,
      taxCodes: data.taxCodes,
      company,
      asOf,
    });
    const received = data.payments
      .filter((p) => p.type === 'customer' && p.status !== 'void' && inRange(p.date))
      .reduce((a, p) => a + (p.amount || 0), 0);
    const invoiced = incomeStatement({
      accounts: data.accounts,
      entries: data.entries,
      from: f.from || undefined,
      to: f.to || undefined,
    }).totals.income;

    let draftTotal = 0;
    let draftCount = 0;
    for (const d of data.documents) {
      if (d.status !== 'draft') continue;
      draftCount += 1;
      draftTotal += documentSummary(d, data.taxCodes, data.payments, asOf).total;
    }
    const openInvoices = data.documents.filter((d) => d.type === 'invoice' && d.status === 'open').length;

    return [
      kpi({
        label: 'Outstanding',
        value: ctx.fmt.money(totals.receivables, { code: cur }),
        sub: `across ${plural(openInvoices, 'open invoice')}`,
        tone: 'accent',
      }),
      kpi({
        label: 'Overdue',
        value: ctx.fmt.money(totals.overdueTotal, { code: cur }),
        sub: totals.overdueCount ? `${plural(totals.overdueCount, 'invoice')} past due` : 'Nothing past due',
        tone: totals.overdueCount ? 'negative' : 'default',
        onClick: () => { setStatus('overdue'); setTab('invoices'); },
      }),
      kpi({
        label: 'Received in period',
        value: ctx.fmt.money(received, { code: cur }),
        sub: periodLabel(),
      }),
      kpi({
        label: 'Invoiced in period',
        value: ctx.fmt.money(invoiced, { code: cur }),
        sub: periodLabel(),
      }),
      kpi({
        label: 'Drafts',
        value: ctx.fmt.money(draftTotal, { code: cur }),
        sub: draftCount ? `${plural(draftCount, 'document')} not yet authorised` : 'Nothing waiting',
        tone: draftCount ? 'warn' : 'default',
        onClick: () => { setStatus('draft'); setTab('invoices'); },
      }),
    ];
  }

  /* -------------------------------------------------------------- controls */

  const statusSelect = select({
    options: STATUS_OPTIONS,
    value: f.status,
    onChange: (v) => { f.status = v; redraw(); },
  });
  statusSelect.setAttribute('aria-label', 'Filter by status');

  const customerOptions = [
    { value: '', label: 'All customers' },
    ...data.contacts
      .filter((c) => c.isCustomer !== false && c.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: c.name })),
  ];
  const contactSelect = select({
    options: customerOptions,
    value: f.contactId,
    onChange: (v) => { f.contactId = v; redraw(); },
  });
  contactSelect.setAttribute('aria-label', 'Filter by customer');

  const fromInput = dateInput({
    value: f.from || '',
    onChange: (v) => { f.from = v; markCustom(); redraw(); },
  });
  const toInput = dateInput({
    value: f.to || '',
    onChange: (v) => { f.to = v; markCustom(); redraw(); },
  });

  const presetSelect = select({
    options: PRESETS,
    value: f.preset,
    onChange: (v) => applyPreset(v),
  });
  presetSelect.setAttribute('aria-label', 'Date range preset');

  const searchInput = input({
    type: 'search',
    enterkeyhint: 'search',
    value: f.q,
    placeholder: 'Number, reference, customer, memo',
    onInput: (v) => { f.q = v; redraw(); },
  });
  searchInput.setAttribute('aria-label', 'Search sales');
  const searchBox = h('div', { class: 'search-box' }, icon(ICONS.search, { size: 15 }), searchInput);

  const voidedBox = checkbox({
    label: 'Include voided',
    checked: f.includeVoided,
    onChange: (v) => { f.includeVoided = v; redraw(); },
  });

  function applyPreset(id) {
    if (id === 'custom') { f.preset = 'custom'; redraw(); return; }
    const range = presetRange(id, company, asOf);
    f.preset = id;
    f.from = range.from;
    f.to = range.to;
    fromInput.value = range.from;
    toInput.value = range.to;
    redraw();
  }

  function markCustom() {
    f.preset = 'custom';
    presetSelect.value = 'custom';
  }

  function setTab(id) { f.tab = id; redraw(); }
  function setStatus(v) { f.status = v; statusSelect.value = v; redraw(); }

  function clearFilters() {
    const range = presetRange('this-fy', company, asOf);
    f.status = 'all';
    f.contactId = '';
    f.q = '';
    f.includeVoided = false;
    f.preset = 'this-fy';
    f.from = range.from;
    f.to = range.to;
    statusSelect.value = 'all';
    contactSelect.value = '';
    searchInput.value = '';
    presetSelect.value = 'this-fy';
    fromInput.value = range.from;
    toInput.value = range.to;
    redraw();
  }

  const fld = (label, control) => field({ label, input: control, inline: true });

  const toolbarNode = toolbar({
    left: [
      fld('Search', searchBox),
      fld('Status', statusSelect),
      fld('Customer', contactSelect),
    ],
    right: [
      fld('Period', presetSelect),
      fld('From', fromInput),
      fld('To', toInput),
      voidedBox,
    ],
  });

  /* --------------------------------------------------------------- tables */

  function statusCell(r) {
    const s = r.summary.status;
    const parts = [statusBadge(s)];
    if (s === 'overdue' && r.summary.overdueDays) {
      parts.push(h('span', { class: 'small muted' }, `${r.summary.overdueDays}d`));
    }
    return h('div', { class: 'row', style: { gap: '0.3rem', flexWrap: 'nowrap' } }, parts);
  }

  function docActions(r) {
    const actions = [
      iconButton({ label: 'Print', icon: ICONS.print, onClick: () => printRow(r) }),
      iconButton({ label: 'Copy as text', icon: ICONS.file, onClick: () => copyRow(r) }),
    ];
    if (r.doc.type === 'invoice' && r.doc.status !== 'void') {
      actions.push(iconButton({ label: 'Receive payment', icon: ICONS.coins, onClick: () => receivePayment(r) }));
    }
    if (r.doc.status === 'draft' && docTypeMeta(r.doc.type).posts) {
      actions.push(iconButton({ label: 'Authorise', icon: ICONS.check, onClick: () => authoriseRow(r) }));
    }
    if (r.doc.status === 'draft') {
      actions.push(iconButton({ label: 'Delete draft', icon: ICONS.trash, onClick: () => deleteRow(r) }));
    }
    if (r.doc.status === 'open') {
      actions.push(iconButton({ label: 'Void', icon: ICONS.close, onClick: () => voidRow(r) }));
    }
    return h('div', { class: 'table-actions' }, actions);
  }

  function docColumns() {
    return [
      {
        key: 'number', label: 'Number', sortable: true, sortValue: (r) => r.doc.number || '',
        render: (r) => h('span', { class: 'mono strong' }, r.doc.number || '—'),
      },
      {
        key: 'date', label: 'Date', sortable: true, sortValue: (r) => r.doc.date || '',
        render: (r) => ctx.fmt.date(r.doc.date),
      },
      {
        key: 'customer', label: 'Customer', sortable: true, sortValue: (r) => r.contact?.name || '',
        render: (r) => h('div', null,
          h('span', { class: 'row-title' }, r.contact?.name || '(no customer)'),
          r.contact?.email ? h('div', { class: 'row-sub' }, r.contact.email) : null),
      },
      {
        key: 'due', label: 'Due', sortable: true, sortValue: (r) => r.doc.dueDate || '',
        render: (r) => (r.doc.dueDate ? ctx.fmt.date(r.doc.dueDate) : h('span', { class: 'faint' }, '—')),
      },
      {
        key: 'reference', label: 'Reference', sortable: true, sortValue: (r) => r.doc.reference || '',
        render: (r) => (r.doc.reference || h('span', { class: 'faint' }, '—')),
      },
      {
        key: 'total', label: 'Total', align: 'right', sortable: true, sortValue: (r) => r.summary.total,
        render: (r) => moneyCell(r.summary.total, { code: cur }),
      },
      {
        key: 'balance', label: 'Balance', align: 'right', sortable: true, sortValue: (r) => r.summary.balance,
        render: (r) => moneyCell(r.summary.balance, { code: cur }),
      },
      { key: 'status', label: 'Status · age', render: statusCell },
      { key: 'actions', label: 'Actions', align: 'right', render: docActions },
    ];
  }

  function noMatchState() {
    return emptyState({
      title: 'No documents match these filters',
      message: 'Loosen the status, customer or date range, or clear the filters to see everything.',
      action: button({ label: 'Clear filters', variant: 'subtle', onClick: clearFilters }),
    });
  }

  function documentsTable() {
    const type = activeType();
    const tab = activeTab();
    if (!data.documents.some((d) => d.type === type)) {
      return emptyState({
        title: `No ${tab.label.toLowerCase()} yet`,
        message: `Create your first ${tab.noun} to start tracking what you are owed.`,
        action: button({ label: `New ${tab.noun}`, variant: 'primary', icon: ICONS.plus, onClick: () => newDoc(type) }),
      });
    }
    const rows = docRows(type);
    if (!rows.length) return noMatchState();

    const total = rows.reduce((a, r) => a + (r.summary.total || 0), 0);
    const balance = rows.reduce((a, r) => a + (r.summary.balance || 0), 0);
    return table({
      columns: docColumns(),
      rows,
      id: 'sales-table',
      sortKey: 'date',
      sortDir: 'desc',
      onRowClick: (r) => openDocumentEditor(ctx, { docId: r.doc.id, onSaved: () => ctx.refresh() }),
      footer: [[
        '', '', '', '',
        h('span', { class: 'muted' }, `Totals (${rows.length})`),
        moneyCell(total, { code: cur }),
        moneyCell(balance, { code: cur }),
        '', '',
      ]],
    });
  }

  function paymentActions(r) {
    if (r.pay.status === 'void') return h('span', { class: 'faint small' }, 'Voided');
    return h('div', { class: 'table-actions' },
      iconButton({ label: 'Reverse payment', icon: ICONS.refresh, onClick: () => voidPaymentFlow(ctx, r.pay.id) }));
  }

  function paymentColumns() {
    return [
      {
        key: 'number', label: 'Number', sortable: true, sortValue: (r) => r.pay.number || '',
        render: (r) => h('div', null,
          h('span', { class: 'mono strong' }, r.pay.number || '—'),
          r.pay.status === 'void' ? badge('Voided', 'muted') : null),
      },
      {
        key: 'date', label: 'Date', sortable: true, sortValue: (r) => r.pay.date || '',
        render: (r) => ctx.fmt.date(r.pay.date),
      },
      {
        key: 'customer', label: 'Customer', sortable: true, sortValue: (r) => r.contact?.name || '',
        render: (r) => r.contact?.name || '(no customer)',
      },
      {
        key: 'amount', label: 'Amount', align: 'right', sortable: true, sortValue: (r) => r.pay.amount || 0,
        render: (r) => moneyCell(r.pay.amount || 0, { code: cur }),
      },
      {
        key: 'method', label: 'Method', sortable: true, sortValue: (r) => r.pay.method || '',
        render: (r) => (r.pay.method || h('span', { class: 'faint' }, '—')),
      },
      {
        key: 'applied', label: 'Applied', align: 'right', sortable: true, sortValue: (r) => r.applied,
        render: (r) => h('div', null,
          moneyCell(r.applied, { code: cur }),
          ...(r.notes || []).map((note) => h('div', { class: 'row-sub' }, note))),
      },
      {
        key: 'onAccount', label: 'On account', align: 'right', sortable: true,
        sortValue: (r) => (r.pay.amount || 0) - r.applied,
        render: (r) => moneyCell((r.pay.amount || 0) - r.applied, { code: cur, muted: (r.pay.amount || 0) - r.applied === 0 }),
      },
      { key: 'actions', label: 'Actions', align: 'right', render: paymentActions },
    ];
  }

  function paymentsTable() {
    const rows = paymentRows();
    if (!rows.length) {
      return emptyState({
        title: 'No receipts match these filters',
        message: f.includeVoided
          ? 'Try a wider date range or a different customer.'
          : 'Voided receipts are hidden — tick "Include voided" to see them, or widen the filters.',
        action: button({ label: 'Receive payment', variant: 'primary', icon: ICONS.coins, onClick: () => receivePayment() }),
      });
    }
    const amountTotal = rows.reduce((a, r) => a + (r.pay.amount || 0), 0);
    const appliedTotal = rows.reduce((a, r) => a + r.applied, 0);
    return table({
      columns: paymentColumns(),
      rows,
      sortKey: 'date',
      sortDir: 'desc',
      footer: [[
        '', '',
        h('span', { class: 'muted' }, `Totals (${rows.length})`),
        moneyCell(amountTotal, { code: cur }),
        '',
        moneyCell(appliedTotal, { code: cur }),
        moneyCell(amountTotal - appliedTotal, { code: cur }),
        '',
      ]],
    });
  }

  /* --------------------------------------------------------------- actions */

  function newDoc(type) {
    openDocumentEditor(ctx, { type, onSaved: () => ctx.refresh() });
  }

  function receivePayment(row) {
    const opts = { type: 'customer', lockType: true, onSaved: () => ctx.refresh() };
    if (row) {
      opts.contactId = row.doc.contactId;
      opts.docId = row.doc.id;
      opts.amount = row.summary.balance;
    }
    openPaymentModal(ctx, opts);
  }

  function printRow(row) {
    printNode(
      documentPrintNode({ company, doc: row.doc, contact: row.contact, summary: row.summary, taxCodes: data.taxCodes }),
      { title: row.doc.number || 'Document' },
    );
  }

  async function copyRow(row) {
    const text = documentPlainText({ company, doc: row.doc, contact: row.contact, summary: row.summary, taxCodes: data.taxCodes });
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', 'success', { detail: 'Paste it into an email — no attachment needed.' });
    } catch {
      modal({ title: 'Copy this text', width: 'md', body: () => textarea({ value: text, rows: 16 }) });
    }
  }

  function authoriseRow(row) {
    try {
      const saved = authoriseDocument(ctx.db, row.doc.id);
      toast(`${saved.number || 'Document'} authorised`, 'success', {
        detail: 'Its journal entry is posted and the reports are updated.',
      });
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function voidRow(row) {
    const reason = await promptDialog({
      title: `Void ${row.doc.number || 'this document'}?`,
      label: 'Reason (kept in the audit trail)',
      message: 'Voiding reverses the journal entry. Nothing is deleted, so the history stays visible.',
      confirmLabel: 'Void this document',
    });
    if (reason === null) return;
    try {
      voidDocument(ctx.db, row.doc.id, reason || 'Voided by user');
      toast(`${row.doc.number || 'Document'} voided`, 'success');
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteRow(row) {
    const ok = await ctx.confirm({
      title: 'Delete this draft?',
      message: 'Drafts were never posted to the ledger, so deleting one changes no balances.',
      confirmLabel: 'Delete draft',
      danger: true,
    });
    if (!ok) return;
    try {
      deleteDraft(ctx.db, row.doc.id);
      toast('Draft deleted', 'success');
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* --------------------------------------------------------------- drawing */

  const kpiHost = h('div', { class: 'stat-grid' });
  const tabsHost = h('div');
  const tableHost = h('div');
  const noteHost = h('p', { class: 'report-note' });

  function redraw() {
    clear(kpiHost);
    append(kpiHost, kpiNodes());

    const counts = {
      invoices: docRows('invoice').length,
      quotes: docRows('quote').length,
      'credit-notes': docRows('credit-note-sale').length,
      payments: paymentRows().length,
    };
    clear(tabsHost);
    tabsHost.appendChild(tabs({
      items: TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] })),
      active: f.tab,
      onChange: (id) => setTab(id),
    }));

    voidedBox.classList.toggle('hidden', f.tab !== 'payments');

    clear(tableHost);
    tableHost.appendChild(f.tab === 'payments' ? paymentsTable() : documentsTable());

    noteHost.textContent = f.tab === 'payments'
      ? 'Receipts are customer payments. Each one posts a journal entry and is applied to the invoices it pays; reversing one returns those invoices to owing money.'
      : `Outstanding and overdue are as at today and agree with the debtors control account. Paid and invoiced only count the selected period (${periodLabel()}). Every figure is derived from posted journal entries — open a document to inspect its entry.`;
  }

  const root = h('div', { class: 'sales-view' },
    pageHeader({
      title: meta.title,
      subtitle: meta.subtitle,
      actions: [
        button({ label: 'New invoice', variant: 'primary', icon: ICONS.plus, onClick: () => newDoc('invoice') }),
        button({ label: 'New quote', variant: 'subtle', onClick: () => newDoc('quote') }),
        button({ label: 'New credit note', variant: 'subtle', onClick: () => newDoc('credit-note-sale') }),
        button({ label: 'Receive payment', variant: 'subtle', icon: ICONS.coins, onClick: () => receivePayment() }),
      ],
    }),
    kpiHost,
    tabsHost,
    toolbarNode,
    tableHost,
    noteHost);

  redraw();
  return root;
}
