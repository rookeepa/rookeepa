/**
 * Rookeepa — the general journal.
 *
 * The raw double-entry view. Every invoice, bill, payment, bank line and
 * opening balance is a posted journal entry underneath; this screen shows them
 * all, lets you read the lines behind any figure, and lets you write an entry
 * by hand when a spreadsheet would otherwise be involved.
 */

import {
  h, clear, append, card, pageHeader, button, iconButton, icon, ICONS, table, moneyCell, badge,
  statusBadge, field, input, select, moneyInput, dateInput, checkbox, toolbar, emptyState, banner,
  modal, confirmDialog, promptDialog, toast, printNode, fmt, kv, paginate, pager,
} from './kit.js';
import { postEntry, voidEntry, entryTotals, line, SOURCE_LABELS } from '../core/ledger.js';
import {
  todayISO, fyStartFor, fyEndFor, startOfMonth, endOfMonth, addMonths, parseISO, toISO,
} from '../core/dates.js';
import {
  DATE_PRESETS as CORE_DATE_PRESETS, NON_RANGE_PRESETS, presetRange as corePresetRange,
} from '../core/periods.js';

export const meta = {
  title: 'Journal',
  subtitle: 'The raw double-entry view: every invoice, bill, payment and bank line ends up here',
};

/* --------------------------------------------------------------- view state */

// The named ranges live in app/core/periods.js — one copy for every screen that offers them, because
// three copies is how the previous quarter came to be missing from this screen and present in others.
// This screen adds the two that are not ranges at all, since it has a custom from/to of its own.
const DATE_PRESETS = [...CORE_DATE_PRESETS, ...NON_RANGE_PRESETS];

const SOURCE_OPTIONS = [
  { value: 'all', label: 'All source types' },
  { value: 'invoice', label: 'Sale' },
  { value: 'bill', label: 'Purchase' },
  { value: 'customer-payment', label: 'Customer payment' },
  { value: 'supplier-payment', label: 'Supplier payment' },
  { value: 'spend-money', label: 'Spend money' },
  { value: 'receive-money', label: 'Receive money' },
  { value: 'transfer', label: 'Bank transfer' },
  { value: 'opening-balances', label: 'Opening balances' },
  { value: 'journal', label: 'General journal' },
];

// Kept at module scope so a full re-render (after ctx.refresh) keeps the filters
// the user chose. These are UI preferences, not data: the entries themselves are
// always read fresh from ctx.data on every render.
const viewState = {
  preset: 'fy',
  from: null,
  to: null,
  source: 'all',
  search: '',
  includeVoid: false,
  page: 1,
  perPage: 50,
};

/* ------------------------------------------------------------------ helpers */

/** Period boundaries for a named range. The arithmetic lives in core/periods.js, once. */
function presetRange(preset, fyStartMonth, today) {
  return corePresetRange(preset, { asOf: today, fyStartMonth });
}

function currentRange(ctx) {
  const today = ctx.asOf || todayISO();
  if (viewState.preset === 'custom') return { from: viewState.from, to: viewState.to };
  return presetRange(viewState.preset, ctx.company?.fyStartMonth || 7, today);
}

function sourceLabel(entry) {
  const type = entry.source?.type || 'journal';
  return SOURCE_LABELS[type] || type;
}

function filteredEntries(ctx) {
  const { from, to } = currentRange(ctx);
  const q = viewState.search.trim().toLowerCase();
  return ctx.data.entries
    .filter((e) => (viewState.includeVoid ? true : e.status === 'posted'))
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .filter((e) => viewState.source === 'all' || (e.source?.type || 'journal') === viewState.source)
    .filter((e) => {
      if (!q) return true;
      return `${e.memo || ''} ${e.ref || ''} ${e.number || ''}`.toLowerCase().includes(q);
    })
    .sort((a, b) => (a.date === b.date
      ? String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      : b.date.localeCompare(a.date)));
}

function openLedger(ctx, code, from, to) {
  if (!code) return;
  const query = { code };
  if (from) query.from = from;
  if (to) query.to = to;
  ctx.go('reports', ['gl'], query);
}

/* ------------------------------------------------------------ entry actions */

async function voidFlow(ctx, entry) {
  if (entry.status === 'void') {
    toast('That entry is already voided.', 'info');
    return;
  }
  const reason = await promptDialog({
    title: `Void ${entry.number || 'this entry'}?`,
    label: 'Reason (kept in the audit trail)',
    message: 'Voiding keeps the entry and its audit trail but takes it out of the reports. Nothing is deleted.',
    confirmLabel: 'Void entry',
  });
  if (reason === null) return;
  // An entry a document owns is that document's bookkeeping, not a free-standing journal. Voiding it here
  // left the invoice or bill open against a control account that no longer carried it; the document is the
  // thing to void, and doing so voids its entry properly.
  if (entry.source && entry.source.id) {
    const what = String(entry.source.type || 'record').replace(/-/g, ' ');
    toast('That entry belongs to another record', 'error', {
      detail: `It is the bookkeeping for ${what}, so void that instead — it takes its entry with it and keeps the two in step.`,
    });
    return;
  }
  try {
    voidEntry(ctx.db, entry.id, reason || 'Voided by user');
    toast('Entry voided', 'success', { detail: 'The books still balance — a voided entry is simply left out of the totals.' });
    ctx.refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function printEntry(ctx, entry) {
  const accounts = ctx.data.accounts;
  const cur = { code: ctx.company?.currency || 'AUD' };
  const totals = entryTotals(entry);
  const node = h('div', { class: 'doc-print' },
    h('div', { class: 'doc-print-head' },
      h('div', { class: 'doc-print-business' },
        h('h2', null, ctx.company?.legalName || ctx.company?.name || 'Company'),
        ctx.company?.abn ? h('div', null, `ABN ${ctx.company.abn}`) : null),
      h('div', { class: 'doc-print-title' },
        h('h1', null, 'Journal entry'),
        h('div', null, h('strong', null, entry.number || '')))),
    h('div', { class: 'doc-print-meta' },
      h('div', null,
        h('div', { class: 'small' }, sourceLabel(entry)),
        h('strong', null, ctx.fmt.date(entry.date))),
      h('dl', null,
        entry.ref ? [h('dt', null, 'Reference'), h('dd', null, entry.ref)] : null,
        entry.memo ? [h('dt', null, 'Memo'), h('dd', null, entry.memo)] : null)),
    h('table', null,
      h('thead', null, h('tr', null,
        h('th', null, 'Account'), h('th', null, 'Description'), h('th', null, 'Tax'),
        h('th', { class: 'num' }, 'Debit'), h('th', { class: 'num' }, 'Credit'))),
      h('tbody', null, entry.lines.map((l) => {
        const acc = accounts.find((a) => a.code === l.accountCode);
        return h('tr', null,
          h('td', null, `${l.accountCode}${acc ? ` ${acc.name}` : ''}`),
          h('td', null, l.description || ''),
          h('td', null, l.taxCode || ''),
          h('td', { class: 'num' }, l.debit ? fmt.money(l.debit, cur) : ''),
          h('td', { class: 'num' }, l.credit ? fmt.money(l.credit, cur) : ''));
      })),
      h('tfoot', null, h('tr', { class: 'grand' },
        h('td', null, 'Totals'), h('td', null, ''), h('td', null, ''),
        h('td', { class: 'num' }, fmt.money(totals.debit, cur)),
        h('td', { class: 'num' }, fmt.money(totals.credit, cur))))),
    h('div', { class: 'doc-print-footer' },
      entry.status === 'void' ? `VOIDED — ${entry.voidReason || 'no reason given'}` : (entry.memo || '')),
  );
  printNode(node, { title: `Journal ${entry.number || ''}`.trim() });
}

function openEntryDetail(ctx, entry) {
  const accounts = ctx.data.accounts;
  const cur = { code: ctx.company?.currency || 'AUD' };
  const { from, to } = currentRange(ctx);
  const totals = entryTotals(entry);
  const rows = entry.lines.map((l) => {
    const acc = accounts.find((a) => a.code === l.accountCode);
    return { ...l, accountName: acc ? acc.name : '(deleted account)' };
  });

  let handle;
  const detail = table({
    columns: [
      { key: 'accountCode', label: 'Account', render: (r) => h('div', null,
        h('span', { class: 'mono' }, r.accountCode),
        h('div', { class: 'row-sub' }, r.accountName)) },
      { key: 'description', label: 'Description', render: (r) => (r.description || h('span', { class: 'faint' }, '—')) },
      { key: 'taxCode', label: 'Tax', render: (r) => (r.taxCode ? badge(r.taxCode, 'muted') : '') },
      { key: 'debit', label: 'Debit', align: 'right', render: (r) => (r.debit ? moneyCell(r.debit, cur) : '') },
      { key: 'credit', label: 'Credit', align: 'right', render: (r) => (r.credit ? moneyCell(r.credit, cur) : '') },
      { key: 'gl', label: '', align: 'right', render: (r) => iconButton({
        label: `Open ${r.accountCode} in the general ledger`,
        icon: ICONS.arrowRight,
        onClick: () => { handle?.close(null); openLedger(ctx, r.accountCode, from, to); },
      }) },
    ],
    rows,
    footer: [[
      '', 'Totals', '',
      h('span', { class: 'num' }, fmt.money(totals.debit, cur)),
      h('span', { class: 'num' }, fmt.money(totals.credit, cur)),
      '',
    ]],
    compact: true,
  });

  handle = modal({
    title: `Journal entry ${entry.number || ''}`.trim(),
    subtitle: `${sourceLabel(entry)} · ${ctx.fmt.date(entry.date)}`,
    width: 'lg',
    body: () => h('div', null,
      kv([
        ['Date', ctx.fmt.date(entry.date)],
        ['Type', sourceLabel(entry)],
        ['Reference', entry.ref || '—'],
        ['Memo', entry.memo || '—'],
        ['Status', entry.status === 'void' ? statusBadge('void') : statusBadge('posted')],
      ]),
      h('div', { class: 'divider' }),
      detail,
      h('p', { class: `report-check${totals.balanced ? '' : ' bad'}`, style: { marginTop: '0.6rem' } },
        icon(totals.balanced ? ICONS.check : ICONS.warning, { size: 15 }),
        h('span', null, totals.balanced
          ? 'Balanced — debits equal credits'
          : `Out of balance by ${fmt.money(Math.abs(totals.difference), cur)}`)),
      entry.status === 'void'
        ? banner({ kind: 'warning', title: 'This entry is voided', message: entry.voidReason || 'Voided.' })
        : null),
    actions: () => [
      button({ label: 'Print', variant: 'ghost', icon: ICONS.print, onClick: () => printEntry(ctx, entry) }),
      button({ label: 'Close', variant: 'ghost', onClick: () => handle.close(null) }),
    ],
  });
  return handle;
}

function rowActions(ctx, entry) {
  const { from, to } = currentRange(ctx);
  const primary = entry.lines[0]?.accountCode;
  const btns = [];
  if (primary) {
    btns.push(iconButton({
      label: `Open ${primary} in the general ledger`,
      icon: ICONS.accounts,
      onClick: () => openLedger(ctx, primary, from, to),
    }));
  }
  if (entry.status === 'posted') {
    btns.push(iconButton({ label: 'Void this entry', icon: ICONS.trash, onClick: () => voidFlow(ctx, entry) }));
  }
  btns.push(iconButton({ label: 'Print this entry', icon: ICONS.print, onClick: () => printEntry(ctx, entry) }));
  return h('div', { class: 'table-actions' }, btns);
}

/* ------------------------------------------------------------- new entry UI */

function openNewEntry(ctx) {
  const { db, companyId } = ctx;
  const cur = { code: ctx.company?.currency || 'AUD' };
  const accounts = ctx.data.accounts
    .filter((a) => a.active !== false)
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));
  const taxCodes = ctx.data.taxCodes;
  const accountOptions = [
    { value: '', label: 'Choose account…' },
    ...accounts.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` })),
  ];
  const taxOptions = taxCodes.map((t) => ({ value: t.code, label: t.code }));

  let date = ctx.asOf || todayISO();
  let memo = '';
  let ref = '';
  let suspenseAcknowledged = false;
  const rows = [blankRow(), blankRow()];

  function blankRow() {
    return { accountCode: '', description: '', taxCode: 'N-T', debit: 0, credit: 0, taxManual: false };
  }

  const dateField = dateInput({ value: date, onChange: (v) => { date = v; } });
  const refField = input({ value: '', placeholder: 'Reference', onInput: (v) => { ref = v; } });
  const memoField = input({ value: '', placeholder: 'Why this entry exists', onInput: (v) => { memo = v; } });

  const linesHost = h('div', { class: 'doc-lines' });
  const totalsHost = h('div', { class: 'doc-totals', style: { justifyContent: 'space-between', alignItems: 'center' } });
  const saveButton = button({ label: 'Post entry', variant: 'primary', onClick: save });
  saveButton.disabled = true;

  const JCOLS = '30px 176px minmax(150px, 2.4fr) 74px 102px 102px 34px';

  function headerRow() {
    return h('div', { class: 'line-row header', style: { gridTemplateColumns: JCOLS } },
      h('span', null, '#'),
      h('span', null, 'Account'),
      h('span', null, 'Description'),
      h('span', null, 'Tax'),
      h('span', { class: 'col-right' }, 'Debit'),
      h('span', { class: 'col-right' }, 'Credit'),
      h('span', null, ''));
  }

  function lineRow(row, index) {
    const accountSelect = select({
      options: accountOptions,
      value: row.accountCode,
      onChange: (v) => {
        row.accountCode = v;
        const acc = accounts.find((a) => a.code === v);
        if (acc && acc.gstDefault && !row.taxManual) {
          row.taxCode = acc.gstDefault;
          taxSelect.value = acc.gstDefault;
        }
        updateTotals();
      },
    });
    const descInput = input({ value: row.description, placeholder: 'What this line is for', onInput: (v) => { row.description = v; } });
    const taxSelect = select({ options: taxOptions, value: row.taxCode || 'N-T', onChange: (v) => { row.taxCode = v; row.taxManual = true; } });
    const debitInput = moneyInput({
      value: row.debit,
      code: cur.code,
      onChange: (v) => { row.debit = v; if (v) { row.credit = 0; creditInput.value = ''; } updateTotals(); },
    });
    const creditInput = moneyInput({
      value: row.credit,
      code: cur.code,
      onChange: (v) => { row.credit = v; if (v) { row.debit = 0; debitInput.value = ''; } updateTotals(); },
    });
    const remove = iconButton({
      label: `Remove line ${index + 1}`,
      icon: ICONS.trash,
      onClick: () => {
        if (rows.length <= 2) { toast('A journal entry needs at least two lines.', 'warn'); return; }
        rows.splice(index, 1);
        redrawLines();
      },
    });
    return h('div', { class: 'line-row', style: { gridTemplateColumns: JCOLS } },
      h('span', { class: 'line-num' }, String(index + 1)),
      accountSelect, descInput, taxSelect, debitInput, creditInput, remove);
  }

  function addLine() {
    rows.push(blankRow());
    redrawLines();
    const all = linesHost.querySelectorAll('.line-row');
    const target = all[all.length - 1];
    if (target) target.querySelector('select')?.focus();
  }

  function redrawLines() {
    clear(linesHost);
    linesHost.appendChild(headerRow());
    rows.forEach((row, i) => linesHost.appendChild(lineRow(row, i)));
    linesHost.appendChild(h('div', { class: 'row', style: { padding: '0.55rem 0.6rem' } },
      button({ label: 'Add line', variant: 'subtle', size: 'sm', icon: ICONS.plus, onClick: addLine }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, `${rows.length} line${rows.length === 1 ? '' : 's'}`)));
    updateTotals();
  }

  function updateTotals() {
    const dr = rows.reduce((a, r) => a + (r.debit || 0), 0);
    const cr = rows.reduce((a, r) => a + (r.credit || 0), 0);
    const diff = dr - cr;
    const balanced = dr === cr && dr > 0;
    clear(totalsHost);
    append(totalsHost, [
      h('div', { class: 'totals-table' },
        h('span', null, 'Total debits'), h('span', { class: 'num' }, fmt.money(dr, cur)),
        h('span', null, 'Total credits'), h('span', { class: 'num' }, fmt.money(cr, cur)),
        h('span', { class: 'total-row' }, 'Difference'), h('span', { class: `num total-row${diff ? ' neg' : ''}` }, fmt.money(diff, cur))),
      h('div', { class: `report-check${balanced ? '' : ' bad'}` },
        icon(balanced ? ICONS.check : ICONS.warning, { size: 15 }),
        h('span', null, balanced ? 'Balanced — debits equal credits' : `Out of balance by ${fmt.money(Math.abs(diff), cur)}`)),
    ]);
    if (saveButton) saveButton.disabled = !balanced;
  }

  async function save() {
    const prepared = rows
      .filter((r) => r.accountCode || r.debit || r.credit || r.description)
      .map((r) => line(r.accountCode, r.debit || 0, r.credit || 0, {
        description: r.description,
        taxCode: r.taxCode || null,
      }));

    const usesSuspense = prepared.some((l) => accounts.find((a) => a.code === l.accountCode)?.control === 'suspense');
    if (usesSuspense && !suspenseAcknowledged) {
      const ok = await confirmDialog({
        title: 'Post to a suspense account?',
        message: 'One of the lines uses the Suspense / Ask My Accountant account. That is a fine placeholder, but reports will keep the amount under suspense until you reclassify it.',
        confirmLabel: 'Post anyway',
      });
      if (!ok) return;
      suspenseAcknowledged = true;
    }

    try {
      postEntry(db, {
        companyId,
        date,
        memo,
        ref,
        lines: prepared,
        source: { type: 'journal', id: null },
      });
      const total = prepared.reduce((a, l) => a + l.debit, 0);
      toast('Journal entry posted', 'success', { detail: `${fmt.money(total, cur)} posted to the ledger.` });
      handle.close(true);
      ctx.refresh();
    } catch (err) {
      const message = String(err?.message || 'The entry could not be posted.');
      const [first, ...rest] = message.split('\n').filter(Boolean);
      toast(first || message, 'error', rest.length ? { detail: rest.join(' ') } : undefined);
    }
  }

  const handle = modal({
    title: 'New journal entry',
    subtitle: 'A general journal entry. Debits must equal credits, and nothing posts until you choose Post entry.',
    width: 'xl',
    className: 'modal-doc',
    body: h('div', { class: 'doc-editor' },
      h('div', { class: 'doc-head-grid' },
        field({ label: 'Date', required: true, input: dateField }),
        field({ label: 'Reference', input: refField }),
        field({ label: 'Memo', input: memoField, className: 'wide-field' })),
      linesHost,
      totalsHost),
    actions: () => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => handle.close(null) }),
      saveButton,
    ],
  });

  redrawLines();
  return handle;
}

/* -------------------------------------------------------------------- screen */

export async function render(ctx) {
  const wrap = h('div');
  const cur = { code: ctx.company?.currency || 'AUD' };
  const range = currentRange(ctx);

  const searchInput = input({
    value: viewState.search,
    placeholder: 'Search memo, reference or number',
    onInput: (v) => { viewState.search = v; viewState.page = 1; drawTable(); },
  });
  const searchBox = h('div', { class: 'search-box' }, icon(ICONS.search, { size: 15 }), searchInput);

  const fromField = dateInput({
    value: range.from || '',
    onChange: (v) => {
      viewState.preset = 'custom';
      viewState.from = v || null;
      presetSelect.value = 'custom';
      viewState.page = 1;
      drawTable();
    },
  });
  const toField = dateInput({
    value: range.to || '',
    onChange: (v) => {
      viewState.preset = 'custom';
      viewState.to = v || null;
      presetSelect.value = 'custom';
      viewState.page = 1;
      drawTable();
    },
  });
  fromField.style.width = '10.5rem';
  toField.style.width = '10.5rem';

  const presetSelect = select({
    options: DATE_PRESETS,
    value: viewState.preset,
    onChange: (v) => {
      viewState.preset = v;
      const r = presetRange(v === 'custom' ? 'all' : v, ctx.company?.fyStartMonth || 7, ctx.asOf || todayISO());
      viewState.from = r.from;
      viewState.to = r.to;
      fromField.value = r.from || '';
      toField.value = r.to || '';
      viewState.page = 1;
      drawTable();
      // Choosing a custom range used to leave you looking at two date boxes with nothing saying they were
      // the point. Put the cursor in the first one.
      if (v === 'custom') requestAnimationFrame(() => fromField.focus());
    },
  });

  const sourceSelect = select({
    options: SOURCE_OPTIONS,
    value: viewState.source,
    onChange: (v) => { viewState.source = v; viewState.page = 1; drawTable(); },
  });

  const voidToggle = checkbox({
    label: 'Include voided entries',
    checked: viewState.includeVoid,
    onChange: (c) => { viewState.includeVoid = c; viewState.page = 1; drawTable(); },
  });

  const rangeRow = h('div', { class: 'row', style: { gap: '0.35rem' } },
    h('span', { class: 'small muted' }, 'From'), fromField,
    h('span', { class: 'small muted' }, 'To'), toField);

  const bar = toolbar({
    left: [searchBox, sourceSelect],
    right: [presetSelect, rangeRow, voidToggle],
  });

  const header = pageHeader({
    title: meta.title,
    subtitle: meta.subtitle,
    actions: [button({
      label: 'New journal entry',
      icon: ICONS.plus,
      variant: 'primary',
      onClick: () => openNewEntry(ctx),
    })],
  });

  const tableHost = h('div');

  function drawTable() {
    const rows = filteredEntries(ctx);
    const page = paginate({ rows, page: viewState.page, perPage: viewState.perPage });
    viewState.page = page.page;
    const sumDebit = rows.reduce((a, e) => a + entryTotals(e).debit, 0);
    clear(tableHost);

    if (!rows.length) {
      tableHost.appendChild(emptyState({
        title: 'No journal entries here',
        message: 'Nothing matches this date range, source type or search. Widen the dates, clear the filters, or post the first entry by hand.',
        action: button({ label: 'New journal entry', variant: 'primary', icon: ICONS.plus, onClick: () => openNewEntry(ctx) }),
      }));
      return;
    }

    tableHost.appendChild(card({
      flush: true,
      body: table({
        columns: [
          { key: 'date', label: 'Date', render: (r) => ctx.fmt.date(r.date) },
          { key: 'number', label: 'Number', render: (r) => h('span', { class: 'mono' }, r.number || '—') },
          { key: 'type', label: 'Type', render: (r) => sourceLabel(r) },
          { key: 'memo', label: 'Reference / memo', render: (r) => h('div', null,
            r.ref ? h('span', { class: 'strong' }, r.ref) : null,
            r.memo ? h('div', { class: 'row-sub' }, r.memo) : (r.ref ? null : h('span', { class: 'faint' }, '—'))) },
          { key: 'amount', label: 'Amount', align: 'right', render: (r) => moneyCell(entryTotals(r).debit, cur) },
          { key: 'lines', label: 'Lines', align: 'right', render: (r) => String(r.lines.length) },
          { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
          { key: 'actions', label: '', align: 'right', render: (r) => rowActions(ctx, r) },
        ],
        rows: page.rows,
        footer: [[
          h('span', { class: 'strong' }, `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`),
          '', '', '', moneyCell(sumDebit, cur), '', '', '',
        ]],
        onRowClick: (entry) => openEntryDetail(ctx, entry),
        rowClass: (r) => (r.status === 'void' ? 'muted' : ''),
      }),
    }));

    if (page.pages > 1) {
      tableHost.appendChild(pager({
        page: page.page,
        pages: page.pages,
        total: page.total,
        from: page.from,
        to: page.to,
        onChange: (p) => { viewState.page = p; drawTable(); },
      }));
    }
  }

  wrap.appendChild(header);
  wrap.appendChild(bar);
  wrap.appendChild(tableHost);
  drawTable();
  return wrap;
}
