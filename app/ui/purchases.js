/**
 * Rookeepa — purchases.
 *
 * The money-out side of the business: supplier bills, supplier credits and the
 * payments that settle them. Nothing here stores a balance or a status — every
 * figure is derived with documentSummary(), so this screen can never disagree
 * with the aged creditors report or the ledger behind it.
 *
 * Supplier credits are shown as the positive amount of credit you hold against
 * a supplier, because that is how you think about them while entering them.
 */

import {
  h, append, clear, table, moneyCell, statusBadge, badge, button, iconButton, icon, ICONS,
  field, input, textarea, select, dateInput, checkbox, kpi, toolbar, tabs, pageHeader,
  emptyState, modal, toast, printNode,
} from './kit.js';
import { computeDocument, documentSummary, authoriseDocument, voidDocument, docTypeMeta } from '../core/docs.js';
import { agedReport, basSummary } from '../core/reports.js';
import { openDocumentEditor } from './document-editor.js';
import { openPaymentModal, voidPaymentFlow } from './payment-modal.js';
import { documentPrintNode, documentPlainText } from './print.js';
import { fyStartFor, fyEndFor, fyLabel, todayISO, startOfMonth, endOfMonth, addMonths } from '../core/dates.js';

export const meta = { title: 'Purchases', subtitle: 'Supplier bills, credits and payments' };

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'open', label: 'Open' },
  { value: 'partly-paid', label: 'Part paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

const RANGE_OPTIONS = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'this-quarter', label: 'This quarter' },
  { value: 'this-fy', label: 'This financial year' },
  { value: 'custom', label: 'Custom range' },
  { value: 'all', label: 'All time' },
];

/**
 * Filter state lives at module scope on purpose: every write re-renders the
 * whole route, and the list you were reading should still be on screen when it
 * comes back. It is reset whenever the open company file changes.
 */
const state = {
  companyId: null,
  tab: 'bills', // bills | credits | payments
  status: 'all',
  contactId: 'all',
  range: 'all',
  from: '',
  to: '',
  search: '',
  showVoidPayments: false,
};

const plural = (n, one, many) => (n === 1 ? one : many);

/** The three-month block of the financial year that contains asOf. */
function quarterRange(asOf, fyStartMonth) {
  const fyStart = fyStartFor(asOf, fyStartMonth);
  const [ay, am] = fyStart.split('-').map(Number);
  const [by, bm] = startOfMonth(asOf).split('-').map(Number);
  const monthsIn = Math.max(0, (by - ay) * 12 + (bm - am));
  const from = addMonths(fyStart, Math.floor(monthsIn / 3) * 3);
  return { from, to: endOfMonth(addMonths(from, 2)) };
}

export async function render(ctx) {
  syncState(ctx);

  const el = h('div');
  const tabsHost = h('div');
  const toolbarHost = h('div');
  const tableHost = h('div');

  const code = ctx.company?.currency || 'AUD';
  const fyStartMonth = ctx.company?.fyStartMonth || 7;
  const moneyCellFor = (cents) => moneyCell(cents, { code });

  /* ------------------------------------------------------------ period helpers */

  function resolvedRange() {
    const asOf = ctx.asOf || todayISO();
    switch (state.range) {
      case 'this-month':
        return { from: startOfMonth(asOf), to: endOfMonth(asOf), label: 'This month' };
      case 'last-month': {
        const prev = addMonths(asOf, -1);
        return { from: startOfMonth(prev), to: endOfMonth(prev), label: 'Last month' };
      }
      case 'this-quarter': {
        const q = quarterRange(asOf, fyStartMonth);
        return { ...q, label: 'This quarter' };
      }
      case 'this-fy':
        return { from: fyStartFor(asOf, fyStartMonth), to: fyEndFor(asOf, fyStartMonth), label: 'This financial year' };
      case 'custom':
        return { from: state.from || null, to: state.to || null, label: 'Custom range' };
      case 'all':
      default:
        return { from: null, to: null, label: 'All time' };
    }
  }

  function applyPresetDates() {
    const r = resolvedRange();
    state.from = r.from || '';
    state.to = r.to || '';
  }

  function inRange(date) {
    const r = resolvedRange();
    if (r.from && date < r.from) return false;
    if (r.to && date > r.to) return false;
    return true;
  }

  function contactMatches(contactId) {
    return state.contactId === 'all' || contactId === state.contactId;
  }

  function textMatches(haystack) {
    const q = state.search.trim().toLowerCase();
    return !q || String(haystack).toLowerCase().includes(q);
  }

  /* ------------------------------------------------------------------ rows */

  function docRows(type) {
    const asOf = ctx.asOf || todayISO();
    const { taxCodes, payments, contacts } = ctx.data;
    const isCredit = type === 'credit-note-purchase';
    return ctx.data.documents
      .filter((d) => d.type === type)
      .map((d) => {
        const summary = documentSummary(d, taxCodes, payments, asOf);
        const contact = contacts.find((c) => c.id === d.contactId);
        // A supplier credit is never "overdue" — it is simply unused or used up.
        let status = summary.status;
        if (isCredit) {
          if (d.status === 'void') status = 'void';
          else if (d.status === 'draft') status = 'draft';
          else status = summary.balance <= 0 ? 'paid' : 'open';
        }
        return {
          doc: d,
          summary,
          number: d.number || (d.status === 'draft' ? '(draft)' : '—'),
          date: d.date,
          dueDate: d.dueDate || '',
          contactName: contact?.name || '—',
          reference: d.reference || '',
          memo: d.memo || '',
          total: summary.total,
          balance: summary.balance,
          status,
        };
      });
  }

  function docMatches(row) {
    if (state.status !== 'all' && row.status !== state.status) return false;
    if (!contactMatches(row.doc.contactId)) return false;
    if (!inRange(row.date)) return false;
    return textMatches(`${row.number} ${row.reference} ${row.contactName} ${row.memo}`);
  }

  function paymentRows() {
    const { contacts } = ctx.data;
    return ctx.data.payments
      .filter((p) => p.type === 'supplier')
      .filter((p) => state.showVoidPayments || p.status !== 'void')
      .map((p) => {
        const applied = (p.allocations || []).reduce((a, x) => a + (x.amount || 0), 0);
        // What each part of this payment settled, in the words of whoever recorded it.
        const notes = (p.allocations || []).map((x) => x.note).filter(Boolean);
        const contact = contacts.find((c) => c.id === p.contactId);
        return {
          payment: p,
          number: p.number || '—',
          date: p.date,
          contactName: contact?.name || '—',
          amount: p.amount || 0,
          method: p.method || '',
          applied,
          notes,
          onAccount: (p.amount || 0) - applied,
          status: p.status || 'posted',
          reference: p.reference || '',
        };
      });
  }

  function paymentMatches(row) {
    if (!contactMatches(row.payment.contactId)) return false;
    if (!inRange(row.date)) return false;
    return textMatches(`${row.number} ${row.reference} ${row.contactName}`);
  }

  /* ---------------------------------------------------------------- KPIs */

  function buildKpis() {
    const asOf = ctx.asOf || todayISO();
    const { accounts, entries, documents, payments, taxCodes } = ctx.data;

    const ap = agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'payable', asOf });
    const bills = docRows('bill');
    const unpaid = bills.filter((r) => r.status !== 'void' && r.status !== 'draft' && r.balance > 0);
    const overdue = bills.filter((r) => r.status === 'overdue');
    const overdueAmount = overdue.reduce((a, r) => a + r.balance, 0);

    const fyFrom = fyStartFor(asOf, fyStartMonth);
    const fyTo = fyEndFor(asOf, fyStartMonth);
    const purchasesFy = bills
      .filter((r) => r.status !== 'void' && r.status !== 'draft' && r.date >= fyFrom && r.date <= fyTo)
      .reduce((a, r) => a + computeDocument(r.doc, taxCodes).total, 0);

    const range = resolvedRange();
    const bas = basSummary({
      accounts, entries, taxCodes,
      from: range.from || undefined,
      to: range.to || asOf,
    });

    return h('div', { class: 'stat-grid' },
      kpi({
        label: 'Owed to suppliers',
        value: ctx.fmt.money(ap.totals.total, { code }),
        sub: `${unpaid.length} unpaid ${plural(unpaid.length, 'bill', 'bills')}`,
      }),
      kpi({
        label: 'Overdue bills',
        value: ctx.fmt.money(overdueAmount, { code }),
        sub: `${overdue.length} past ${plural(overdue.length, 'due date', 'due dates')}`,
        tone: overdueAmount > 0 ? 'negative' : 'default',
        onClick: () => { state.tab = 'bills'; state.status = 'overdue'; refreshAll(); },
      }),
      kpi({
        label: 'Purchases this financial year',
        value: ctx.fmt.money(purchasesFy, { code }),
        sub: fyLabel(asOf, fyStartMonth),
      }),
      kpi({
        label: 'GST credits this period',
        value: ctx.fmt.money(bas.boxes['1B'], { code }),
        sub: range.label,
      }));
  }

  /* -------------------------------------------------------------- actions */

  function newBill() {
    openDocumentEditor(ctx, { type: 'bill', onSaved: () => ctx.refresh() });
  }

  function newCredit() {
    openDocumentEditor(ctx, { type: 'credit-note-purchase', onSaved: () => ctx.refresh() });
  }

  function paySupplier() {
    openPaymentModal(ctx, { type: 'supplier', lockType: true, onSaved: () => ctx.refresh() });
  }

  function openDoc(doc) {
    openDocumentEditor(ctx, { type: doc.type, docId: doc.id, onSaved: () => ctx.refresh() });
  }

  function printDoc(doc, summary) {
    const contact = ctx.data.contacts.find((c) => c.id === doc.contactId);
    printNode(documentPrintNode({ company: ctx.company, doc, contact, summary, taxCodes: ctx.data.taxCodes }), {
      title: `${docTypeMeta(doc.type).label} ${doc.number || ''}`.trim(),
    });
  }

  async function copyDoc(doc, summary) {
    const contact = ctx.data.contacts.find((c) => c.id === doc.contactId);
    const text = documentPlainText({ company: ctx.company, doc, contact, summary, taxCodes: ctx.data.taxCodes });
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', 'success', { detail: 'Paste it into an email or a note.' });
    } catch {
      modal({ title: 'Copy this text', width: 'md', body: () => textarea({ value: text, rows: 16 }) });
    }
  }

  async function authorise(doc) {
    try {
      const open = authoriseDocument(ctx.db, doc.id);
      toast(`${docTypeMeta(doc.type).label} ${open.number} authorised`, 'success', {
        detail: 'Its journal entry is posted and reports have been updated.',
      });
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function payDoc(doc, summary) {
    openPaymentModal(ctx, {
      type: 'supplier',
      contactId: doc.contactId,
      docId: doc.id,
      amount: summary.balance,
      lockType: true,
      onSaved: () => ctx.refresh(),
    });
  }

  function voidFlow(doc) {
    let reason = '';
    const m = modal({
      title: `Void ${doc.number || 'this document'}?`,
      subtitle: 'Voiding reverses the journal entry — nothing is deleted.',
      width: 'sm',
      body: () => h('div', null,
        h('p', { class: 'confirm-message' },
          'The entry this document posted is reversed and the document is marked void. If payments are applied to it, reverse those first.'),
        field({
          label: 'Reason',
          hint: 'Kept in the audit trail.',
          input: input({
            value: '',
            placeholder: 'e.g. entered twice',
            autofocus: true,
            onInput: (v) => { reason = v; },
          }),
        })),
      actions: ({ close }) => [
        button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
        button({
          label: 'Void document',
          variant: 'danger',
          onClick: () => {
            try {
              voidDocument(ctx.db, doc.id, reason || 'Voided by user');
              toast(`${doc.number || docTypeMeta(doc.type).label} voided`, 'success');
              close(true);
              ctx.refresh();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }),
      ],
    });
    return m;
  }

  /* --------------------------------------------------------------- toolbar */

  function supplierOptions() {
    const suppliers = ctx.data.contacts
      .filter((c) => c.isSupplier === true)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: c.name }));
    return [{ value: 'all', label: 'All suppliers' }, ...suppliers];
  }

  function scheduleSearch() {
    if (scheduleSearch.timer) clearTimeout(scheduleSearch.timer);
    scheduleSearch.timer = setTimeout(refreshTable, 220);
  }

  function buildToolbar() {
    const range = resolvedRange();
    const left = [];

    if (state.tab !== 'payments') {
      left.push(field({
        label: 'Status',
        input: select({
          options: STATUS_OPTIONS,
          value: state.status,
          onChange: (v) => { state.status = v; refreshTable(); },
        }),
      }));
    }

    left.push(field({
      label: 'Supplier',
      input: select({
        options: supplierOptions(),
        value: state.contactId,
        onChange: (v) => { state.contactId = v; refreshTable(); },
      }),
    }));

    left.push(field({
      label: 'Period',
      input: select({
        options: RANGE_OPTIONS,
        value: state.range,
        onChange: (v) => { state.range = v; applyPresetDates(); refreshAll(); },
      }),
    }));

    left.push(field({
      label: 'From',
      input: dateInput({
        value: range.from || '',
        onChange: (v) => { state.from = v; state.range = 'custom'; refreshAll(); },
      }),
    }));

    left.push(field({
      label: 'To',
      input: dateInput({
        value: range.to || '',
        onChange: (v) => { state.to = v; state.range = 'custom'; refreshAll(); },
      }),
    }));

    const searchInput = input({
      id: 'purchases-search',
      value: state.search,
      placeholder: 'Number, reference, supplier or memo',
      onInput: (v) => { state.search = v; scheduleSearch(); },
    });
    left.push(field({
      label: 'Search',
      id: 'purchases-search',
      input: h('div', { class: 'search-box', id: 'purchases-search-box' }, icon(ICONS.search, { size: 15 }), searchInput),
    }));

    const right = [];
    if (state.tab === 'payments') {
      right.push(checkbox({
        label: 'Show reversed',
        checked: state.showVoidPayments,
        onChange: (v) => { state.showVoidPayments = v; refreshTable(); },
      }));
    }

    return toolbar({ left, right });
  }

  /* ---------------------------------------------------------------- tables */

  function docsColumns(type) {
    const isCredit = type === 'credit-note-purchase';
    const cols = [
      { key: 'number', label: 'Number', sortable: true, render: (r) => h('span', { class: 'mono strong' }, r.number) },
      { key: 'date', label: 'Date', sortable: true, render: (r) => ctx.fmt.date(r.date) },
      { key: 'contactName', label: 'Supplier', sortable: true },
      { key: 'dueDate', label: 'Due', sortable: true, render: (r) => (r.dueDate ? ctx.fmt.date(r.dueDate) : '—') },
      { key: 'reference', label: 'Reference', sortable: true, render: (r) => r.reference || '—' },
      { key: 'total', label: 'Total', align: 'right', sortable: true, render: (r) => moneyCellFor(r.total) },
      { key: 'balance', label: 'Balance', align: 'right', sortable: true, render: (r) => moneyCellFor(r.balance) },
      { key: 'status', label: 'Status', sortable: true, render: (r) => statusBadge(r.status) },
      { key: 'actions', label: 'Actions', align: 'right', render: (r) => h('div', { class: 'table-actions' }, docActions(r)) },
    ];
    // A supplier credit has no due date to speak of.
    return isCredit ? cols.filter((c) => c.key !== 'dueDate') : cols;
  }

  function docActions(row) {
    const doc = row.doc;
    const btns = [
      iconButton({ label: 'Print', icon: ICONS.print, onClick: () => printDoc(doc, row.summary) }),
      iconButton({ label: 'Copy as text', icon: ICONS.file, onClick: () => copyDoc(doc, row.summary) }),
    ];
    if (doc.status === 'draft') {
      btns.push(iconButton({ label: 'Authorise', icon: ICONS.check, onClick: () => authorise(doc) }));
    }
    if (['open', 'partly-paid', 'overdue'].includes(row.status) && row.balance > 0) {
      btns.push(iconButton({ label: 'Pay', icon: ICONS.coins, onClick: () => payDoc(doc, row.summary) }));
    }
    if (doc.status === 'open') {
      btns.push(iconButton({ label: 'Void', icon: ICONS.trash, onClick: () => voidFlow(doc) }));
    }
    return btns;
  }

  function docsFooter(columns, rows) {
    const total = rows.reduce((a, r) => a + r.total, 0);
    const balance = rows.reduce((a, r) => a + r.balance, 0);
    const cells = columns.map((c) => {
      if (c.key === 'total') return moneyCellFor(total);
      if (c.key === 'balance') return moneyCellFor(balance);
      if (c.key === 'reference') return h('span', { class: 'muted' }, 'Totals');
      return '';
    });
    return [cells];
  }

  function docsBody(type) {
    const all = docRows(type);
    const noun = type === 'bill' ? 'bill' : 'supplier credit';

    if (!all.length) {
      return emptyState({
        title: type === 'bill' ? 'No bills yet' : 'No supplier credits yet',
        message: type === 'bill'
          ? 'Enter a supplier invoice to start tracking what you owe.'
          : 'Record a supplier credit when a supplier refunds you or corrects a bill.',
        action: button({
          label: type === 'bill' ? 'Enter bill' : 'Enter supplier credit',
          variant: 'primary',
          icon: ICONS.plus,
          onClick: () => (type === 'bill' ? newBill() : newCredit()),
        }),
      });
    }

    const rows = all.filter(docMatches);
    const columns = docsColumns(type);
    const count = rows.length === all.length
      ? `${all.length} ${plural(all.length, noun, `${noun}s`)}`
      : `${rows.length} of ${all.length} ${plural(all.length, noun, `${noun}s`)}`;

    return h('div', null,
      h('p', { class: 'small muted' }, count),
      table({
        columns,
        rows,
        empty: `No ${noun}s match these filters.`,
        footer: docsFooter(columns, rows),
        onRowClick: (r) => openDoc(r.doc),
        sortKey: 'date',
        sortDir: 'desc',
      }));
  }

  function paymentColumns() {
    return [
      { key: 'number', label: 'Number', sortable: true, render: (r) => h('span', { class: `mono strong${r.status === 'void' ? ' muted' : ''}` }, r.number) },
      { key: 'date', label: 'Date', sortable: true, render: (r) => ctx.fmt.date(r.date) },
      { key: 'contactName', label: 'Supplier', sortable: true },
      { key: 'amount', label: 'Amount', align: 'right', sortable: true, render: (r) => moneyCellFor(r.amount) },
      { key: 'method', label: 'Method', sortable: true, render: (r) => (r.method ? badge(r.method, 'muted') : '—') },
      {
        key: 'applied',
        label: 'Applied',
        align: 'right',
        sortable: true,
        render: (r) => h('div', null,
          moneyCellFor(r.applied),
          ...(r.notes || []).map((note) => h('div', { class: 'row-sub' }, note))),
      },
      { key: 'onAccount', label: 'On account', align: 'right', sortable: true, render: (r) => moneyCellFor(r.onAccount) },
      {
        key: 'actions',
        label: 'Actions',
        align: 'right',
        render: (r) => h('div', { class: 'table-actions' },
          r.status === 'void'
            ? statusBadge('void')
            : iconButton({ label: 'Reverse payment', icon: ICONS.refresh, onClick: () => voidPaymentFlow(ctx, r.payment.id) })),
      },
    ];
  }

  function paymentsFooter(columns, rows) {
    const amount = rows.reduce((a, r) => a + r.amount, 0);
    const applied = rows.reduce((a, r) => a + r.applied, 0);
    const onAccount = rows.reduce((a, r) => a + r.onAccount, 0);
    const cells = columns.map((c) => {
      if (c.key === 'amount') return moneyCellFor(amount);
      if (c.key === 'applied') return moneyCellFor(applied);
      if (c.key === 'onAccount') return moneyCellFor(onAccount);
      if (c.key === 'contactName') return h('span', { class: 'muted' }, 'Totals');
      return '';
    });
    return [cells];
  }

  function paymentsBody() {
    const all = paymentRows();
    if (!all.length) {
      return emptyState({
        title: 'No supplier payments yet',
        message: 'Pay a supplier to settle a bill, or leave the money on their account for later.',
        action: button({ label: 'Pay a supplier', variant: 'primary', icon: ICONS.coins, onClick: () => paySupplier() }),
      });
    }

    const rows = all.filter(paymentMatches);
    const columns = paymentColumns();
    const count = rows.length === all.length
      ? `${all.length} ${plural(all.length, 'payment', 'payments')}`
      : `${rows.length} of ${all.length} payments`;

    return h('div', null,
      h('p', { class: 'small muted' }, count),
      table({
        columns,
        rows,
        empty: 'No payments match these filters.',
        footer: paymentsFooter(columns, rows),
        sortKey: 'date',
        sortDir: 'desc',
      }));
  }

  /* --------------------------------------------------------- render driving */

  function buildTabs() {
    const docs = ctx.data.documents;
    const payments = ctx.data.payments;
    const billCount = docs.filter((d) => d.type === 'bill' && d.status !== 'void').length;
    const creditCount = docs.filter((d) => d.type === 'credit-note-purchase' && d.status !== 'void').length;
    const paymentCount = payments.filter((p) => p.type === 'supplier' && p.status !== 'void').length;
    return tabs({
      items: [
        { id: 'bills', label: 'Bills', count: billCount },
        { id: 'credits', label: 'Supplier credits', count: creditCount },
        { id: 'payments', label: 'Payments made', count: paymentCount },
      ],
      active: state.tab,
      onChange: (id) => { state.tab = id; refreshAll(); },
    });
  }

  function buildTableBody() {
    if (state.tab === 'payments') return paymentsBody();
    return docsBody(state.tab === 'credits' ? 'credit-note-purchase' : 'bill');
  }

  function refreshTable() {
    clear(tableHost);
    tableHost.appendChild(buildTableBody());
  }

  function refreshAll() {
    clear(tabsHost);
    tabsHost.appendChild(buildTabs());
    clear(toolbarHost);
    toolbarHost.appendChild(buildToolbar());
    refreshTable();
  }

  /* ------------------------------------------------------------------ head */

  const header = pageHeader({
    title: meta.title,
    subtitle: meta.subtitle,
    actions: [
      button({ label: 'Enter bill', variant: 'primary', icon: ICONS.plus, onClick: () => newBill() }),
      button({ label: 'Enter supplier credit', variant: 'default', onClick: () => newCredit() }),
      button({ label: 'Pay a supplier', variant: 'default', icon: ICONS.coins, onClick: () => paySupplier() }),
    ],
  });

  const kpis = buildKpis();
  refreshAll();

  append(el, [header, kpis, tabsHost, toolbarHost, tableHost]);
  return el;
}

function syncState(ctx) {
  if (state.companyId !== ctx.companyId) {
    state.companyId = ctx.companyId;
    state.tab = 'bills';
    state.status = 'all';
    state.contactId = 'all';
    state.range = 'all';
    state.from = '';
    state.to = '';
    state.search = '';
    state.showVoidPayments = false;
  }
  if (!state.tab) state.tab = 'bills';
  if (!state.range) state.range = 'all';
}
