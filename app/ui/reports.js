/**
 * Rookeepa — Reports.
 *
 * One screen, nine reports. Every figure on it comes straight out of
 * ../core/reports.js: this file lays the numbers out and does no arithmetic of
 * its own beyond summing a column for a totals row.
 *
 * Reachable as #/reports/<report>?from=…&to=…&code=…
 *   - segments[1] is the report id (defaults to 'pnl')
 *   - the date range, the as-at date, the compare flag and the general-ledger
 *     account all live in the query string so any report is linkable
 *   - the chosen range is also remembered in the UI preferences
 */

import {
  h, card, button, table, moneyCell, badge, field, select, checkbox, segmented,
  emptyState, banner, csvButton, printNode, barChart, pageHeader, icon, dateInput, fmt, ICONS,
} from './kit.js';
import {
  incomeStatement, cashBasisIncomeStatement, monthlyPnl, balanceSheet, trialBalance, generalLedgerReport,
  journalReport, agedReport, basSummary, cashFlow, comparisonPeriod, varianceOf,
} from '../core/reports.js';
import {
  fyStartFor, fyEndFor, startOfMonth, endOfMonth, addMonths, todayISO, addDays,
  daysBetween, monthLabel,
} from '../core/dates.js';
import { ALL_TIME_FROM,
  DATE_PRESETS as CORE_DATE_PRESETS, NON_RANGE_PRESETS, presetRange as corePresetRange,
  matchPreset as coreMatchPreset,
} from '../core/periods.js';
import { sortAccounts } from '../core/coa.js';
import { SOURCE_LABELS } from '../core/ledger.js';
import { sum } from '../core/money.js';

export const meta = {
  title: 'Reports',
  subtitle: 'Profit & loss, balance sheet, trial balance, aged debtors and creditors, GST and cash flow',
};

/* ------------------------------------------------------------------ reports */

const REPORT_GROUPS = [
  { group: 'Performance', items: [
    { id: 'pnl', label: 'Profit & loss' },
    { id: 'pnl-monthly', label: 'Profit & loss by month' },
  ] },
  { group: 'Position', items: [
    { id: 'balance-sheet', label: 'Balance sheet' },
    { id: 'trial-balance', label: 'Trial balance' },
  ] },
  { group: 'Detail', items: [
    { id: 'general-ledger', label: 'General ledger' },
    { id: 'journal', label: 'Journal' },
  ] },
  { group: 'Money owed', items: [
    { id: 'aged-receivables', label: 'Aged receivables' },
    { id: 'aged-payables', label: 'Aged payables' },
  ] },
  { group: 'Tax', items: [
    { id: 'gst', label: 'GST / activity statement' },
  ] },
  { group: 'Cash', items: [
    { id: 'cash-flow', label: 'Cash flow' },
  ] },
];

const KNOWN = new Set(REPORT_GROUPS.flatMap((g) => g.items.map((i) => i.id)));

const ALIASES = {
  gl: 'general-ledger',
  'profit-and-loss': 'pnl',
  'profit-loss': 'pnl',
  pnlmonthly: 'pnl-monthly',
  'pnl-by-month': 'pnl-monthly',
  monthly: 'pnl-monthly',
  bs: 'balance-sheet',
  tb: 'trial-balance',
  ar: 'aged-receivables',
  ap: 'aged-payables',
  'aged-debtors': 'aged-receivables',
  'aged-creditors': 'aged-payables',
  bas: 'gst',
  'activity-statement': 'gst',
  cash: 'cash-flow',
  cashflow: 'cash-flow',
};

/** Reports whose figures are a point-in-time position rather than a period. */
const AS_AT = new Set(['balance-sheet', 'aged-receivables', 'aged-payables']);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isISO = (v) => ISO.test(String(v || ''));
const titleCase = (s) => String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/* -------------------------------------------------------------------- entry */

export async function render(ctx) {
  if (!ctx.company) {
    return h('div', { class: 'stack' },
      pageHeader({ title: meta.title, subtitle: meta.subtitle }),
      card({ body: emptyState({ title: 'No company file', message: 'Create or open a company file to see reports.' }) }));
  }

  const id = resolveId(ctx.route.segments?.[1]);
  const range = resolveRange(ctx);
  const asOf = resolveAsOf(ctx, range);
  const S = {
    id,
    from: range.from,
    to: range.to,
    asOf,
    compare: id === 'pnl' ? resolveCompare(ctx) : 'none',
    basis: id === 'pnl' ? resolveBasis(ctx) : 'accrual',
    includeZero: !resolveHideEmpty(ctx),
    code: ctx.route.query.code || null,
  };

  const model = buildModelFor(ctx, S);

  const el = h('div', { class: 'stack' });
  el.appendChild(pageHeader({ title: meta.title, subtitle: meta.subtitle, actions: reportActions(ctx, model) }));

  const layout = h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '1rem' } });
  layout.appendChild(pickerCard(ctx, S));
  const main = h('div', { class: 'stack', style: { flex: '1 1 460px', minWidth: '0' } });
  main.appendChild(dateBar(ctx, S));
  main.appendChild(reportBody(ctx, S, model));
  layout.appendChild(main);
  el.appendChild(layout);
  return el;
}

/* ------------------------------------------------------------ range helpers */

function resolveRange(ctx) {
  const fm = ctx.company?.fyStartMonth || 7;
  const today = todayISO();
  const q = ctx.route.query || {};
  const defFrom = fyStartFor(today, fm);
  const defTo = today;
  const uiFrom = ctx.ui.get('reportFrom');
  const uiTo = ctx.ui.get('reportTo');
  let from = isISO(q.from) ? q.from : (isISO(uiFrom) ? uiFrom : defFrom);
  let to = isISO(q.to) ? q.to : (isISO(uiTo) ? uiTo : defTo);
  if (from > to) { const swap = from; from = to; to = swap; }
  return { from, to };
}

function resolveAsOf(ctx, range) {
  const q = ctx.route.query || {};
  return isISO(q.asOf) ? q.asOf : range.to;
}

function resolveHideEmpty(ctx) {
  const q = ctx.route.query || {};
  if (q.includeZero === '1') return false;
  if (q.includeZero === '0') return true;
  return ctx.ui.get('hideEmptyReportRows') !== false;
}

function resolveCompare(ctx) {
  const q = ctx.route.query || {};
  if (q.compare === '0' || q.compare === 'none') return 'none';
  if (q.compare === '1' || q.compare === 'prev') return 'prev';
  if (q.compare === 'last-year') return 'last-year';
  const stored = ctx.ui.get('reportCompare');
  if (stored === false || stored === 'none' || stored === undefined) return stored === undefined ? 'prev' : 'none';
  return stored === 'last-year' ? 'last-year' : 'prev';
}

/**
 * Accrual or cash. Accrual is the books as they stand and the default; cash is a view of them,
 * so nothing about this switch changes what has been recorded.
 */
function resolveBasis(ctx) {
  const q = ctx.route.query || {};
  if (q.basis === 'cash') return 'cash';
  if (q.basis === 'accrual') return 'accrual';
  return 'accrual';
}

function resolveId(raw) {
  if (!raw) return 'pnl';
  const id = ALIASES[raw] || raw;
  return KNOWN.has(id) ? id : 'pnl';
}

function startOfQuarter(iso) {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  const qs = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(qs).padStart(2, '0')}-01`;
}

/** Period boundaries for a named range. The arithmetic lives in core/periods.js, once. */
function presetRange(id, fm, today = todayISO()) {
  return corePresetRange(id, { asOf: today, fyStartMonth: fm });
}

/** Which preset a pair of dates is, so the bar can show the choice back. Core does the comparing. */
function matchPreset(from, to, fm) {
  return coreMatchPreset(from, to, { fyStartMonth: fm });
}

/* ---------------------------------------------------------- navigation glue */

function queryFor(S) {
  const q = { from: S.from, to: S.to };
  if (AS_AT.has(S.id) && S.asOf) q.asOf = S.asOf;
  if (S.id === 'general-ledger' && S.code) q.code = S.code;
  if (S.id === 'pnl' && S.compare === 'none') q.compare = '0';
  if (S.id === 'pnl' && S.basis === 'cash') q.basis = 'cash';
  if (S.includeZero) q.includeZero = '1';
  return q;
}

/** Persist the range into UI preferences and reflect it in the URL. */
function goReport(ctx, S, overrides = {}) {
  const next = { ...S, ...overrides };
  ctx.ui.set('reportFrom', next.from);
  ctx.ui.set('reportTo', next.to);
  if (overrides.compare !== undefined) ctx.ui.set('reportCompare', next.compare);
  if (overrides.includeZero !== undefined) ctx.ui.set('hideEmptyReportRows', !next.includeZero);
  ctx.go('reports', [next.id], queryFor(next));
}

/* -------------------------------------------------------------- small parts */

const periodLabel = (S) => `${fmt.date(S.from)} to ${fmt.date(S.to)}`;
const asAtLabel = (S) => `As at ${fmt.date(S.asOf)}`;
const companyName = (ctx) => ctx.company?.legalName || ctx.company?.name || 'Your business';

const mCol = (key, label) => ({
  key,
  label,
  align: 'right',
  render: (r) => ((r[key] === undefined || r[key] === null) ? '' : moneyCell(r[key])),
});
const mColBlank = (key, label) => ({ key, label, align: 'right', render: (r) => (r[key] ? moneyCell(r[key]) : '') });

function totalsCard(entries) {
  return h('div', { class: 'totals-card' }, entries.map(([label, value]) => h('div', { class: 't' },
    h('span', null, label),
    h('strong', null, value))));
}

function checkNode(ok, text) {
  return h('span', { class: `report-check${ok ? '' : ' bad'}` },
    icon(ok ? ICONS.check : ICONS.warning, { size: 14 }), text);
}

function notesNode(notes) {
  if (!notes || !notes.length) return null;
  return h('div', null, notes.filter(Boolean).map((t) => h('p', { class: 'report-note' }, t)));
}

function chartBlock(title, points) {
  return h('div', { class: 'stack', style: { gap: '0.4rem' } },
    h('p', { class: 'small muted' }, title),
    barChart({ points, height: 150, format: (v) => fmt.money(v) }));
}

function rowClassFor(kinds) {
  return (r) => (kinds.includes(r.kind) ? 'strong' : '');
}

/* ------------------------------------------------------------ date-range bar */

function dateBar(ctx, S) {
  const fm = ctx.company?.fyStartMonth || 7;
  // The named ranges live in app/core/periods.js, once, for every screen that offers them. This screen
  // offered six of them; it now offers the shared list, including a week and the previous quarter.
  const presets = [...CORE_DATE_PRESETS, ...NON_RANGE_PRESETS];

  // Kept in the screen's own state, not derived from the range: "Custom range" is a choice, and a range you
  // typed by hand is custom even if it happens to match a named preset. Re-deriving it made both of those
  // light the wrong segment.
  const isCustom = () => ctx.ui.get('reportCustom') === true;
  const setCustom = (on) => { ctx.ui.set('reportCustom', !!on); };

  const seg = segmented({
    options: presets,
    value: isCustom() ? 'custom' : matchPreset(S.from, S.to, fm),
    onChange: (value) => {
      if (value === 'custom') {
        setCustom(true);
        goReport(ctx, S, {});
        // The From/To boxes are always on screen here, but choosing a custom range gave no clue that they
        // were the ones to use. Put the cursor in the first.
        requestAnimationFrame(() => document.getElementById('report-from')?.focus());
        return;
      }
      if (value === 'all') {
        // Not a range the shared list computes — it is the absence of a lower bound. The click used to fall
        // through this branch and return, leaving the report on whatever period it already had (usually the
        // year to date), which looked like the wrong segment being selected.
        setCustom(false);
        const over = { from: ALL_TIME_FROM, to: ctx.asOf };
        if (AS_AT.has(S.id)) over.asOf = ctx.asOf;
        goReport(ctx, S, over);
        return;
      }
      const r = presetRange(value, fm);
      if (!r) return;
      setCustom(false);
      const over = { from: r.from, to: r.to };
      if (AS_AT.has(S.id)) over.asOf = r.to;
      goReport(ctx, S, over);
    },
  });

  const fromField = field({
    label: 'From',
    input: dateInput({
      value: S.from,
      id: 'report-from',
      onChange: (v) => {
        if (!isISO(v)) return;
        setCustom(true);
        const to = v > S.to ? v : S.to;
        const over = { from: v, to };
        if (AS_AT.has(S.id)) over.asOf = to;
        goReport(ctx, S, over);
      },
    }),
  });

  const toField = field({
    label: 'To',
    input: dateInput({
      value: S.to,
      id: 'report-to',
      onChange: (v) => {
        if (!isISO(v)) return;
        setCustom(true);
        const from = v < S.from ? v : S.from;
        const over = { from, to: v };
        if (AS_AT.has(S.id)) over.asOf = v;
        goReport(ctx, S, over);
      },
    }),
  });

  const asAtField = AS_AT.has(S.id)
    ? field({
      label: 'As at',
      hint: 'Used by the balance sheet and aged reports',
      input: dateInput({
        value: S.asOf,
        id: 'report-asat',
        onChange: (v) => {
          if (!isISO(v)) return;
          goReport(ctx, S, { asOf: v });
        },
      }),
    })
    : null;

  const compareBox = S.id === 'pnl'
    ? h('div', { class: 'field-inline' },
      h('label', { class: 'field-label', for: 'report-compare' }, 'Compare to'),
      select({
        id: 'report-compare',
        value: S.compare || 'none',
        options: [
          { value: 'none', label: 'Nothing' },
          { value: 'prev', label: 'Previous period' },
          { value: 'last-year', label: 'Same period last year' },
        ],
        onChange: (v) => goReport(ctx, S, { compare: v }),
      }))
    : null;

  const basisBox = S.id === 'pnl'
    ? h('div', { class: 'field-inline' },
      h('label', { class: 'field-label' }, 'Basis'),
      segmented({
        options: [
          { value: 'accrual', label: 'Accrual' },
          { value: 'cash', label: 'Cash' },
        ],
        value: S.basis,
        onChange: (value) => goReport(ctx, S, { basis: value }),
      }))
    : null;

  const hideBox = checkbox({
    id: 'report-hide-empty',
    label: 'Hide accounts with no activity',
    checked: !S.includeZero,
    onChange: (checked) => goReport(ctx, S, { includeZero: !checked }),
  });

  const body = h('div', { class: 'stack' },
    h('div', { class: 'row' }, seg),
    h('div', { class: 'form-row' }, fromField, toField, asAtField),
    h('div', { class: 'row' }, compareBox, basisBox, hideBox));

  return card({ title: 'Period', body });
}

/* ---------------------------------------------------------------- picker */

function pickerCard(ctx, S) {
  const body = h('div', { class: 'stack', style: { gap: '0.4rem' } },
    REPORT_GROUPS.map((group) => h('div', { class: 'stack', style: { gap: '0.1rem' } },
      h('div', { class: 'small muted', style: { padding: '0.15rem 0.35rem' } }, group.group),
      group.items.map((item) => h('button', {
        type: 'button',
        class: `btn ${item.id === S.id ? 'btn-primary' : 'btn-ghost'} btn-sm`,
        style: { justifyContent: 'flex-start', width: '100%' },
        'aria-current': item.id === S.id ? 'true' : null,
        onClick: () => goReport(ctx, S, { id: item.id }),
      }, item.label)))));
  return card({ title: 'Reports', body });
}

/* ---------------------------------------------------------------- actions */

function reportActions(ctx, model) {
  return [
    button({
      label: 'Print',
      icon: ICONS.print,
      variant: 'ghost',
      onClick: () => printNode(printNodeFor(ctx, model), { title: `${model.title} — ${companyName(ctx)}` }),
    }),
    csvButton({
      filename: model.csv.filename,
      headers: model.csv.headers,
      rows: model.csv.rows,
      label: 'Export CSV',
    }),
    button({ label: 'Refresh', icon: ICONS.refresh, variant: 'ghost', onClick: () => ctx.refresh() }),
  ];
}

/* ------------------------------------------------------------- report frame */

function reportBody(ctx, S, model) {
  const wrap = h('div', { class: 'stack' });

  wrap.appendChild(h('div', { class: 'report-head' },
    h('div', { class: 'report-title-block' },
      h('h2', null, model.title),
      h('p', null, `${companyName(ctx)}${ctx.company?.abn ? ` · ABN ${ctx.company.abn}` : ''}`),
      h('p', { class: 'small muted' }, model.periodLabel)),
    model.checks?.length ? h('div', { class: 'row' }, model.checks) : null));

  if (model.controls) wrap.appendChild(h('div', { class: 'row' }, model.controls));

  wrap.appendChild(table({
    columns: model.columns,
    rows: model.rows,
    footer: model.rows.length ? (model.footer || []) : [],
    empty: model.empty,
    rowClass: model.rowClass,
  }));

  if (model.extras?.length) wrap.appendChild(h('div', { class: 'stack', style: { marginTop: '1rem' } }, model.extras));
  const notes = notesNode(model.notes);
  if (notes) wrap.appendChild(notes);

  return wrap;
}

/* ------------------------------------------------------------- print node */

function printNodeFor(ctx, model) {
  const head = h('div', { class: 'doc-print-head' },
    h('div', { class: 'doc-print-business' },
      h('h2', null, companyName(ctx)),
      ctx.company?.abn ? h('div', { class: 'small' }, `ABN ${ctx.company.abn}`) : null),
    h('div', { class: 'doc-print-title' },
      h('h1', null, model.title),
      h('div', null, model.periodLabel)));

  const tbl = printTable(model.columns, model.rows, model.rows.length ? model.footer : []);

  const totals = model.printTotals?.length
    ? h('div', { class: 'doc-print-totals' },
      h('table', null, h('tbody', null, model.printTotals.map(([label, cents]) => h('tr', null,
        h('td', null, label),
        h('td', { class: 'num' }, fmt.money(cents)))))))
    : null;

  const notes = (model.printNotes || model.notes);
  const foot = notes?.length
    ? h('div', { class: 'doc-print-footer' }, notes.filter(Boolean).map((t) => h('div', null, t)))
    : null;

  return h('div', { class: 'doc-print' }, head, tbl, totals, foot);
}

function printTable(columns, rows, footer) {
  const head = h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.align === 'right' ? 'num' : null }, c.label))));
  const body = h('tbody', null, rows.map((r) => h('tr', null, columns.map((c) => {
    const v = c.render ? c.render(r) : r[c.key];
    return h('td', { class: c.align === 'right' ? 'num' : null }, (v === undefined || v === null || v === '') ? '' : v);
  }))));
  const parts = [head, body];
  if (footer && footer.length) {
    parts.push(h('tfoot', null, footer.map((row) => h('tr', null,
      row.map((cell) => h('td', { class: 'num' }, (cell === undefined || cell === null) ? '' : cell))))));
  }
  return h('table', null, parts);
}

/* ------------------------------------------------------------- dispatcher */

function buildModelFor(ctx, S) {
  switch (S.id) {
    case 'pnl': return buildPnl(ctx, S);
    case 'pnl-monthly': return buildMonthlyPnl(ctx, S);
    case 'balance-sheet': return buildBalanceSheet(ctx, S);
    case 'trial-balance': return buildTrialBalance(ctx, S);
    case 'general-ledger': return buildGeneralLedger(ctx, S);
    case 'journal': return buildJournal(ctx, S);
    case 'aged-receivables': return buildAged(ctx, S, 'receivable');
    case 'aged-payables': return buildAged(ctx, S, 'payable');
    case 'gst': return buildGst(ctx, S);
    case 'cash-flow': return buildCashFlow(ctx, S);
    default: return buildPnl(ctx, S);
  }
}

/* ------------------------------------------------------------ profit & loss */

/**
 * A variance cell: the amount, or its percentage, with the direction of the movement.
 * The colour says whether the movement is good news (more income, or less expense) and the
 * arrow says which way it went, so the meaning does not rest on colour alone. A change with
 * no base to measure against shows a dash rather than a made-up percentage.
 */
function varianceCell(amount, prev, vkind = 'expense', asPercent = false) {
  const v = varianceOf(amount, prev, vkind);
  if (!v) return h('span', { class: 'muted' }, '–');
  const tone = v.favourable === null ? 'muted' : (v.favourable ? 'var-good' : 'var-bad');
  const word = v.favourable === null ? 'unchanged' : (v.favourable ? 'favourable' : 'unfavourable');
  const arrow = v.change === 0 ? '' : (v.up ? '▲' : '▼');
  const detail = `${word}: ${v.change < 0 ? '−' : '+'}${fmt.money(Math.abs(v.change))}`
    + (v.pct === null ? ', no base to compare against' : `, ${v.pct.toFixed(1)}%`);
  if (asPercent) {
    return h('span', { class: `num ${tone}`, title: detail },
      v.pct === null ? '–' : `${v.pct > 0 ? '+' : ''}${v.pct.toFixed(0)}%`,
      arrow ? h('span', { class: 'var-arrow', 'aria-hidden': 'true' }, ` ${arrow}`) : null);
  }
  return h('span', { class: `num ${tone} nowrap`, title: detail },
    moneyCell(v.change),
    arrow ? h('span', { class: 'var-arrow', 'aria-hidden': 'true' }, ` ${arrow}`) : null);
}

function buildPnl(ctx, S) {
  const { accounts, entries, documents, payments, taxCodes } = ctx.data;
  // One engine for both columns: comparing a cash-basis period against an accrual-basis one
  // would be comparing two different measurements and calling the difference a variance.
  const pnl = (from, to) => (S.basis === 'cash'
    ? cashBasisIncomeStatement({ accounts, entries, documents, payments, taxCodes, from, to, includeZero: S.includeZero })
    : incomeStatement({ accounts, entries, from, to, includeZero: S.includeZero }));
  const is = pnl(S.from, S.to);

  const cmp = comparisonPeriod({ from: S.from, to: S.to, mode: S.compare });
  const prev = cmp ? pnl(cmp.from, cmp.to) : null;
  const prevLabel = cmp ? `${fmt.date(cmp.from)} to ${fmt.date(cmp.to)}` : null;

  const prevByCode = new Map();
  if (prev) {
    for (const type of ['income', 'costOfSales', 'expense', 'otherIncome', 'otherExpenses']) {
      for (const r of prev.groups[type]) prevByCode.set(r.code, r.amount);
    }
  }
  const prevOf = (r) => (prev ? (prevByCode.get(r.code) || 0) : null);

  const rows = [];
  const head = (name) => rows.push({ code: '', name, kind: 'section' });
  // `vkind` decides which way is good news for the variance column: more income is
  // favourable, more expense is not.
  const account = (r, vkind) => rows.push({ code: r.code, name: r.name, amount: r.amount, prev: prevOf(r), kind: 'account', vkind });
  const total = (name, amount, prevAmount, vkind) => rows.push({ code: '', name, amount, prev: prev ? prevAmount : null, kind: 'total', vkind });
  const grand = (name, amount, prevAmount, vkind) => rows.push({ code: '', name, amount, prev: prev ? prevAmount : null, kind: 'grand', vkind });

  head('Income');
  is.groups.income.forEach((r) => account(r, 'income'));
  total('Total income', is.totals.income, prev ? prev.totals.income : 0, 'income');

  head('Cost of sales');
  is.groups.costOfSales.forEach((r) => account(r, 'expense'));
  total('Total cost of sales', is.totals.costOfSales, prev ? prev.totals.costOfSales : 0, 'expense');

  grand('Gross profit', is.totals.grossProfit, prev ? prev.totals.grossProfit : 0, 'income');

  head('Expenses');
  is.groups.expense.forEach((r) => account(r, 'expense'));
  total('Total expenses', is.totals.expenses, prev ? prev.totals.expenses : 0, 'expense');

  // Interest and the like, kept out of the trading result so a one-off receipt cannot flatter the margin.
  // Shown once they are used — on either side of a comparison, so the two periods can be read against each
  // other — which means a business that does not separate them sees the report it has always seen.
  const otherIncome = is.totals.otherIncome || 0;
  const otherExpenses = is.totals.otherExpenses || 0;
  const prevOtherIncome = prev ? (prev.totals.otherIncome || 0) : 0;
  const prevOtherExpenses = prev ? (prev.totals.otherExpenses || 0) : 0;
  if (otherIncome || otherExpenses || prevOtherIncome || prevOtherExpenses) {
    grand('Operating profit', is.totals.operatingProfit, prev ? prev.totals.operatingProfit : 0, 'income');
    if (is.groups.otherIncome.length || prevOtherIncome) {
      head('Other income');
      is.groups.otherIncome.forEach((r) => account(r, 'income'));
      total('Total other income', otherIncome, prevOtherIncome, 'income');
    }
    if (is.groups.otherExpenses.length || prevOtherExpenses) {
      head('Other expenses');
      is.groups.otherExpenses.forEach((r) => account(r, 'expense'));
      total('Total other expenses', otherExpenses, prevOtherExpenses, 'expense');
    }
  }

  grand('Net profit', is.totals.netProfit, prev ? prev.totals.netProfit : 0, 'income');

  const columns = [
    { key: 'code', label: 'Code', width: '84px', render: (r) => h('span', { class: 'muted' }, r.code || '') },
    { key: 'name', label: 'Account' },
    mCol('amount', periodLabel(S)),
  ];
  if (prev) {
    columns.push(mCol('prev', prevLabel));
    columns.push({ key: 'variance', label: 'Variance', align: 'right', render: (r) => varianceCell(r.amount, r.prev, r.vkind) });
    columns.push({ key: 'variancePct', label: 'Variance %', align: 'right', render: (r) => varianceCell(r.amount, r.prev, r.vkind, true) });
  }

  const csvHeaders = ['Code', 'Account', periodLabel(S)];
  if (prev) csvHeaders.push(prevLabel, 'Variance', 'Variance %');
  const csvRows = rows.map((r) => {
    const line = [r.code || '', r.name, r.amount === undefined ? '' : fmt.raw(r.amount)];
    if (prev) {
      const v = varianceOf(r.amount, r.prev, r.vkind);
      line.push(r.prev === null || r.prev === undefined ? '' : fmt.raw(r.prev));
      line.push(v ? fmt.raw(v.change) : '');
      line.push(v && v.pct !== null ? v.pct.toFixed(1) : '');
    }
    return line;
  });

  return {
    title: S.basis === 'cash' ? 'Profit & loss (cash basis)' : 'Profit & loss',
    periodLabel: periodLabel(S),
    columns,
    rows,
    footer: [],
    rowClass: rowClassFor(['section', 'total', 'grand']),
    empty: 'No income, cost of sales or expenses in this period.',
    checks: [],
    extras: [
      totalsCard([
        ['Total income', fmt.money(is.totals.income)],
        ['Gross profit', fmt.money(is.totals.grossProfit)],
        ['Total expenses', fmt.money(is.totals.costOfSales + is.totals.expenses)],
        // The parts have to add up to the bottom line. Once a business separates interest, a summary that
        // jumped straight from total expenses to net profit would leave the reader unable to see where the
        // difference came from.
        ...((is.totals.otherIncome || is.totals.otherExpenses) ? [
          ['Operating profit', fmt.money(is.totals.operatingProfit)],
          ['Other income', fmt.money(is.totals.otherIncome)],
          ['Other expenses', fmt.money(is.totals.otherExpenses)],
        ] : []),
        ['Net profit', fmt.money(is.totals.netProfit)],
      ]),
      h('p', { class: 'report-note' }, `Gross margin ${fmt.percent(is.totals.grossMargin)}, net margin ${fmt.percent(is.totals.netMargin)}.`),
    ],
    notes: [
      prev ? `The comparison column is the previous period of the same length (${prevLabel}).` : null,
      S.basis === 'cash'
        ? 'Cash basis: income is counted when a customer\'s money arrived, and expenses when they were paid — not when the document was dated. Money received but not yet applied to an invoice is not income, and GST is excluded as always.'
        : null,
    ].filter(Boolean),
    csv: { filename: `profit-and-loss${S.basis === 'cash' ? '-cash-basis' : ''}-${S.from}-to-${S.to}.csv`, headers: csvHeaders, rows: csvRows },
    printTotals: [
      ['Total income', is.totals.income],
      ['Gross profit', is.totals.grossProfit],
      ['Total expenses', is.totals.costOfSales + is.totals.expenses],
      ...((is.totals.otherIncome || is.totals.otherExpenses) ? [
        ['Operating profit', is.totals.operatingProfit],
        ['Other income', is.totals.otherIncome],
        ['Other expenses', is.totals.otherExpenses],
      ] : []),
      ['Net profit', is.totals.netProfit],
    ],
  };
}

/* ------------------------------------------------------- profit & loss by month */

function buildMonthlyPnl(ctx, S) {
  const { accounts, entries } = ctx.data;
  const data = monthlyPnl({ accounts, entries, from: S.from, to: S.to });
  const rows = data.map((m) => ({
    label: monthLabel(m.month),
    income: m.income,
    costOfSales: m.costOfSales,
    expenses: m.expenses,
    net: m.net,
  }));

  const columns = [
    { key: 'label', label: 'Month' },
    mCol('income', 'Income'),
    mCol('costOfSales', 'Cost of sales'),
    mCol('expenses', 'Expenses'),
    mCol('net', 'Net profit'),
  ];

  const footer = [[
    h('strong', null, 'Total'),
    moneyCell(sum(rows.map((r) => r.income))),
    moneyCell(sum(rows.map((r) => r.costOfSales))),
    moneyCell(sum(rows.map((r) => r.expenses))),
    moneyCell(sum(rows.map((r) => r.net))),
  ]];

  const chartPoints = data.map((m) => ({ label: monthLabel(m.month), value: m.net }));

  return {
    title: 'Profit & loss by month',
    periodLabel: periodLabel(S),
    columns,
    rows,
    footer,
    empty: 'No months in this period.',
    checks: [],
    extras: rows.length ? [chartBlock('Net profit by month', chartPoints)] : [],
    notes: [],
    csv: {
      filename: `profit-and-loss-by-month-${S.from}-to-${S.to}.csv`,
      headers: ['Month', 'Income', 'Cost of sales', 'Expenses', 'Net profit'],
      rows: rows.map((r) => [r.label, fmt.raw(r.income), fmt.raw(r.costOfSales), fmt.raw(r.expenses), fmt.raw(r.net)]),
    },
    printTotals: [
      ['Total income', sum(rows.map((r) => r.income))],
      ['Net profit', sum(rows.map((r) => r.net))],
    ],
  };
}

/* ------------------------------------------------------------ balance sheet */

function buildBalanceSheet(ctx, S) {
  const { accounts, entries } = ctx.data;
  const bs = balanceSheet({
    accounts,
    entries,
    asOf: S.asOf,
    fyStartMonth: ctx.company?.fyStartMonth || 7,
    includeZero: S.includeZero,
  });

  const rows = [];
  const head = (name) => rows.push({ code: '', name, kind: 'section' });
  const account = (r, synthetic) => rows.push({ code: r.code, name: r.name, amount: r.amount, kind: synthetic ? 'synthetic' : 'account' });
  const total = (name, amount) => rows.push({ code: '', name, amount, kind: 'total' });

  head('Assets');
  bs.assets.rows.forEach((r) => account(r));
  total('Total assets', bs.assets.total);

  head('Liabilities');
  bs.liabilities.rows.forEach((r) => account(r));
  total('Total liabilities', bs.liabilities.total);

  head('Equity');
  bs.equity.rows.forEach((r) => account(r, r.synthetic));
  total('Total equity', bs.equity.total);

  rows.push({ code: '', name: 'Net assets', amount: bs.netAssets, kind: 'grand' });

  const columns = [
    { key: 'code', label: 'Code', width: '84px', render: (r) => h('span', { class: 'muted' }, r.code || '') },
    { key: 'name', label: 'Account', render: (r) => (r.kind === 'synthetic' ? h('span', null, r.name, ' ', badge('not closed', 'muted')) : r.name) },
    mCol('amount', 'Amount'),
  ];

  return {
    title: 'Balance sheet',
    periodLabel: asAtLabel(S),
    columns,
    rows,
    footer: [],
    rowClass: rowClassFor(['section', 'total', 'grand']),
    empty: 'Nothing to show — there are no balances at this date.',
    checks: [checkNode(bs.balanced, bs.balanced
      ? 'Balanced — assets equal liabilities plus equity'
      : `Not balanced — out by ${fmt.money(bs.difference)}`)],
    extras: [
      totalsCard([
        ['Total assets', fmt.money(bs.assets.total)],
        ['Total liabilities', fmt.money(bs.liabilities.total)],
        ['Total equity', fmt.money(bs.equity.total)],
        ['Net assets', fmt.money(bs.netAssets)],
      ]),
    ],
    notes: [
      'Rookeepa does not post a closing entry, so profit not yet closed to Retained Earnings appears as its own equity line ("Current year earnings (not yet closed)"). That is what keeps the two sides equal.',
      `Profit for the financial year so far (from ${fmt.date(bs.fyStart)}): ${fmt.money(bs.fyProfit)}.`,
    ],
    csv: {
      filename: `balance-sheet-${S.asOf}.csv`,
      headers: ['Code', 'Account', 'Amount'],
      rows: rows.map((r) => [r.code || '', r.name, r.amount === undefined ? '' : fmt.raw(r.amount)]),
    },
    printTotals: [
      ['Total assets', bs.assets.total],
      ['Total liabilities', bs.liabilities.total],
      ['Total equity', bs.equity.total],
      ['Net assets', bs.netAssets],
    ],
  };
}

/* ------------------------------------------------------------ trial balance */

function buildTrialBalance(ctx, S) {
  const { accounts, entries } = ctx.data;
  const tb = trialBalance({ accounts, entries, from: S.from, to: S.to, includeZero: S.includeZero });

  const rows = tb.rows.map((r) => ({
    code: r.code,
    name: r.name,
    opening: r.opening,
    debit: r.debit,
    credit: r.credit,
    closing: r.closing,
  }));

  const columns = [
    { key: 'code', label: 'Code', width: '84px', render: (r) => h('span', { class: 'muted' }, r.code || '') },
    { key: 'name', label: 'Account' },
    mColBlank('opening', 'Opening'),
    mColBlank('debit', 'Debit'),
    mColBlank('credit', 'Credit'),
    mCol('closing', 'Closing'),
  ];

  const footer = [[
    '', h('strong', null, 'Totals'),
    moneyCell(tb.totals.opening), moneyCell(tb.totals.debit), moneyCell(tb.totals.credit), moneyCell(tb.totals.closing),
  ]];

  return {
    title: 'Trial balance',
    periodLabel: periodLabel(S),
    columns,
    rows,
    footer,
    empty: 'No account movements in this period.',
    checks: [checkNode(tb.balanced, tb.balanced
      ? 'Balanced — debits equal credits'
      : `Out of balance — debits and credits differ by ${fmt.money(tb.totals.debit - tb.totals.credit)}`)],
    extras: [
      totalsCard([
        ['Total debits', fmt.money(tb.totals.debit)],
        ['Total credits', fmt.money(tb.totals.credit)],
        ['Difference', fmt.money(tb.totals.debit - tb.totals.credit)],
      ]),
    ],
    notes: [
      'This is a movement report: opening balances, the period movement, then closing balances. Across every account the opening and closing columns come to zero, because each posted entry balances.',
    ],
    csv: {
      filename: `trial-balance-${S.from}-to-${S.to}.csv`,
      headers: ['Code', 'Account', 'Opening', 'Debit', 'Credit', 'Closing'],
      rows: rows.map((r) => [r.code, r.name, fmt.raw(r.opening), fmt.raw(r.debit), fmt.raw(r.credit), fmt.raw(r.closing)]),
    },
    printTotals: [
      ['Total debits', tb.totals.debit],
      ['Total credits', tb.totals.credit],
      ['Closing', tb.totals.closing],
    ],
  };
}

/* ----------------------------------------------------------- general ledger */

function defaultLedgerCode(ctx, activeAccounts, S) {
  if (S.code && activeAccounts.some((a) => a.code === S.code)) return S.code;
  const touched = new Set();
  for (const e of ctx.data.entries) {
    if (e.status !== 'posted') continue;
    if (e.date < S.from || e.date > S.to) continue;
    for (const l of e.lines) touched.add(l.accountCode);
  }
  const withActivity = activeAccounts.find((a) => touched.has(a.code));
  return withActivity?.code || activeAccounts[0]?.code || null;
}

function buildGeneralLedger(ctx, S) {
  const { accounts, entries } = ctx.data;
  const activeAccounts = sortAccounts(accounts.filter((a) => a.active !== false));
  const code = defaultLedgerCode(ctx, activeAccounts, S);
  const gl = generalLedgerReport({ accounts, entries, from: S.from, to: S.to, code });

  const rows = [];
  rows.push({ kind: 'opening', date: '', number: '', memo: 'Opening balance', debit: 0, credit: 0, running: gl.opening });
  for (const r of gl.rows) {
    rows.push({
      kind: 'move',
      date: r.date,
      number: r.number || r.ref || '',
      memo: r.memo || SOURCE_LABELS[r.source] || titleCase(r.source),
      debit: r.debit,
      credit: r.credit,
      running: gl.opening + r.balance,
    });
  }
  rows.push({ kind: 'closing', date: '', number: '', memo: 'Closing balance', debit: 0, credit: 0, running: gl.closing });

  const columns = [
    { key: 'date', label: 'Date', render: (r) => (r.date ? fmt.date(r.date) : '') },
    { key: 'number', label: 'Number', render: (r) => h('span', { class: 'muted' }, r.number || '') },
    { key: 'memo', label: 'Description', render: (r) => r.memo },
    mColBlank('debit', 'Debit'),
    mColBlank('credit', 'Credit'),
    mCol('running', 'Balance'),
  ];

  const footer = [[
    '', '', h('strong', null, 'Totals'), moneyCell(gl.debit), moneyCell(gl.credit), moneyCell(gl.closing),
  ]];

  const controls = activeAccounts.length
    ? [field({
      label: 'Account',
      input: select({
        options: activeAccounts.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` })),
        value: code || '',
        onChange: (v) => goReport(ctx, S, { code: v }),
      }),
    })]
    : null;

  const noActivity = rows.length === 2 && gl.opening === 0 && gl.rows.length === 0;

  return {
    title: 'General ledger',
    periodLabel: `${periodLabel(S)}${gl.account ? ` · ${gl.account.code} ${gl.account.name}` : ''}`,
    controls,
    columns,
    rows,
    footer,
    rowClass: rowClassFor(['opening', 'closing']),
    empty: code ? 'No activity in this account for the period.' : 'No active accounts to report on.',
    checks: [],
    extras: [
      totalsCard([
        ['Opening balance', fmt.money(gl.opening)],
        ['Debits', fmt.money(gl.debit)],
        ['Credits', fmt.money(gl.credit)],
        ['Closing balance', fmt.money(gl.closing)],
      ]),
      !gl.account ? h('div', { class: 'row' }, checkNode(false, `Account ${code || '—'} was not found in this company file.`)) : null,
    ].filter(Boolean),
    notes: noActivity ? ['This account had no movement in the period; the opening and closing balances are shown for completeness.'] : [],
    csv: {
      filename: `general-ledger-${code || 'account'}-${S.from}-to-${S.to}.csv`,
      headers: ['Date', 'Number', 'Description', 'Debit', 'Credit', 'Balance'],
      rows: rows.map((r) => [r.date || '', r.number || '', r.memo || '', fmt.raw(r.debit || 0), fmt.raw(r.credit || 0), fmt.raw(r.running || 0)]),
    },
    printTotals: [
      ['Opening balance', gl.opening],
      ['Debits', gl.debit],
      ['Credits', gl.credit],
      ['Closing balance', gl.closing],
    ],
  };
}

/* ----------------------------------------------------------------- journal */

function buildJournal(ctx, S) {
  const { accounts, entries } = ctx.data;
  const jr = journalReport({ accounts, entries, from: S.from, to: S.to });

  const rows = jr.rows.map((r) => ({
    date: r.date,
    number: r.number,
    type: SOURCE_LABELS[r.source] || titleCase(r.source),
    memo: r.memo,
    account: `${r.accountCode} ${r.accountName}`,
    taxCode: r.taxCode,
    debit: r.debit,
    credit: r.credit,
  }));

  const columns = [
    { key: 'date', label: 'Date', render: (r) => fmt.date(r.date) },
    { key: 'number', label: 'Number', render: (r) => h('span', { class: 'muted' }, r.number || '') },
    { key: 'type', label: 'Type' },
    { key: 'memo', label: 'Memo' },
    { key: 'account', label: 'Account' },
    { key: 'taxCode', label: 'Tax' },
    mColBlank('debit', 'Debit'),
    mColBlank('credit', 'Credit'),
  ];

  const footer = [[
    '', '', '', '', '', h('strong', null, 'Totals'), moneyCell(jr.totals.debit), moneyCell(jr.totals.credit),
  ]];

  const balanced = jr.totals.debit === jr.totals.credit;

  return {
    title: 'Journal',
    periodLabel: periodLabel(S),
    columns,
    rows,
    footer,
    empty: 'No posted transactions in this period.',
    checks: [checkNode(balanced, balanced
      ? 'Debits equal credits'
      : `Debits and credits differ by ${fmt.money(jr.totals.debit - jr.totals.credit)}`)],
    extras: [
      totalsCard([
        ['Total debits', fmt.money(jr.totals.debit)],
        ['Total credits', fmt.money(jr.totals.credit)],
      ]),
    ],
    notes: [],
    csv: {
      filename: `journal-${S.from}-to-${S.to}.csv`,
      headers: ['Date', 'Number', 'Type', 'Memo', 'Account', 'Tax code', 'Debit', 'Credit'],
      rows: rows.map((r) => [r.date, r.number || '', r.type, r.memo || '', r.account, r.taxCode || '', fmt.raw(r.debit), fmt.raw(r.credit)]),
    },
    printTotals: [
      ['Total debits', jr.totals.debit],
      ['Total credits', jr.totals.credit],
    ],
  };
}

/* ---------------------------------------------------------------- aged */

function buildAged(ctx, S, kind) {
  const { accounts, entries, documents, payments, taxCodes } = ctx.data;
  // agedReport keys each row off `contactId` and reads the display name from the
  // `_contactName` field the caller must attach — passing raw records made every
  // row read "(no contact)", including in the CSV and print output.
  const nameById = new Map((ctx.data.contacts || []).map((c) => [c.id, c.name]));
  const withName = (r) => ({ ...r, _contactName: nameById.get(r.contactId) || '(no contact)' });
  const rep = agedReport({
    accounts, entries, taxCodes, kind, asOf: S.asOf,
    documents: documents.map(withName),
    payments: payments.map(withName),
  });
  const buckets = rep.buckets;

  const columns = [
    { key: 'contactName', label: 'Contact' },
    ...buckets.map((b) => ({
      key: `b_${b.id}`,
      label: b.label,
      align: 'right',
      render: (r) => moneyCell(r.buckets[b.id] || 0),
    })),
    { key: 'total', label: 'Total', align: 'right', render: (r) => moneyCell(r.total) },
  ];

  const footer = [[
    h('strong', null, 'Totals'),
    ...buckets.map((b) => moneyCell(rep.totals[b.id] || 0)),
    moneyCell(rep.totals.total),
  ]];

  const recon = h('div', { class: 'stack' },
    h('div', { class: 'row' }, checkNode(rep.reconciles, rep.reconciles
      ? 'Reconciles with the control account'
      : `Does not reconcile — difference ${fmt.money(rep.difference)}`)),
    totalsCard([
      ['Aged total', fmt.money(rep.totals.total)],
      [rep.controlAccount ? `Control account (${rep.controlAccount.code})` : 'Control account',
        rep.controlAccount ? fmt.money(rep.controlBalance) : 'Not set'],
      ['Difference', fmt.money(rep.difference)],
    ]),
    rep.openingBalance !== 0
      ? h('p', { class: 'report-note' }, `Opening balances of ${fmt.money(rep.openingBalance)} sit directly on the control account with no invoice behind them, so they cannot be aged and are shown separately — that is why they are not in the buckets above.`)
      : null,
    rep.totals.onAccount !== 0
      ? h('p', { class: 'report-note' }, `${kind === 'receivable' ? 'Money received' : 'Prepayments'} but not yet applied to a document: ${fmt.money(rep.totals.onAccount)}.`)
      : null);

  const isAr = kind === 'receivable';

  return {
    title: isAr ? 'Aged receivables' : 'Aged payables',
    periodLabel: asAtLabel(S),
    columns,
    rows: rep.rows,
    footer,
    empty: isAr ? 'No open invoices — nothing is owed to you.' : 'No open bills — you do not owe anything.',
    checks: [],
    extras: [recon],
    notes: [
      `Aged from the due date as at ${fmt.date(rep.asOf)}. The total is built to tie to the control account${rep.controlAccount ? ` (${rep.controlAccount.code} ${rep.controlAccount.name})` : ''}.`,
    ],
    csv: {
      filename: `${isAr ? 'aged-receivables' : 'aged-payables'}-${S.asOf}.csv`,
      headers: ['Contact', ...buckets.map((b) => b.label), 'Total'],
      rows: [
        ...rep.rows.map((r) => [r.contactName, ...buckets.map((b) => fmt.raw(r.buckets[b.id] || 0)), fmt.raw(r.total)]),
        ['Totals', ...buckets.map((b) => fmt.raw(rep.totals[b.id] || 0)), fmt.raw(rep.totals.total)],
      ],
    },
    printTotals: [
      ['Aged total', rep.totals.total],
      ...(rep.controlAccount ? [[`Control account (${rep.controlAccount.code})`, rep.controlBalance]] : []),
      ['Difference', rep.difference],
    ],
  };
}

/* ------------------------------------------------------------------- GST */

function buildGst(ctx, S) {
  const { accounts, entries, taxCodes } = ctx.data;
  const bas = basSummary({ accounts, entries, taxCodes, from: S.from, to: S.to });
  const boxOrder = ['G1', 'G2', 'G3', 'G10', 'G11', '1A', '1B'];

  const rows = boxOrder.map((b) => ({ box: b, label: bas.labels[b], amount: bas.boxes[b] }));

  const columns = [
    { key: 'box', label: 'Box', width: '60px', render: (r) => h('span', { class: 'strong' }, r.box) },
    { key: 'label', label: 'Description' },
    mCol('amount', 'Amount'),
  ];

  const footer = [['', h('strong', null, bas.payable ? 'Net GST payable' : 'Net GST refundable'), moneyCell(bas.netGst)]];

  const codeRows = bas.byTaxCode.map((r) => ({
    code: r.code,
    lines: r.lines,
    sales: r.sales,
    salesGst: r.salesGst,
    purchases: r.purchases,
    purchasesGst: r.purchasesGst,
    net: r.salesGst - r.purchasesGst,
  }));

  const codeColumns = [
    { key: 'code', label: 'Tax code' },
    { key: 'lines', label: 'Lines', align: 'right' },
    mCol('sales', 'Sales (excl. GST)'),
    mCol('salesGst', 'GST on sales'),
    mCol('purchases', 'Purchases (incl. GST)'),
    mCol('purchasesGst', 'GST on purchases'),
    mCol('net', 'Net GST'),
  ];

  const codeFooter = [[
    h('strong', null, 'Total'),
    h('span', { class: 'num' }, String(sum(codeRows.map((r) => r.lines)))),
    moneyCell(sum(codeRows.map((r) => r.sales))),
    moneyCell(sum(codeRows.map((r) => r.salesGst))),
    moneyCell(sum(codeRows.map((r) => r.purchases))),
    moneyCell(sum(codeRows.map((r) => r.purchasesGst))),
    moneyCell(sum(codeRows.map((r) => r.net))),
  ]];

  return {
    title: 'GST / activity statement',
    periodLabel: periodLabel(S),
    columns,
    rows,
    footer,
    empty: 'No reportable GST activity in this period.',
    checks: [],
    extras: [
      totalsCard([
        ['GST on sales (1A)', fmt.money(bas.boxes['1A'])],
        ['GST on purchases (1B)', fmt.money(bas.boxes['1B'])],
        [bas.payable ? 'Net GST payable' : 'Net GST refundable', fmt.money(bas.netGst)],
      ]),
      h('div', { class: 'row' }, badge(bas.lodgement ? 'Lodged' : 'Not lodged', bas.lodgement ? 'positive' : 'muted')),
      bas.journalsWithUnpostedGst
        ? banner({
          kind: 'warn',
          title: `${bas.journalsWithUnpostedGst} journal ${bas.journalsWithUnpostedGst === 1 ? 'entry uses' : 'entries use'} a GST tax code but ${bas.journalsWithUnpostedGst === 1 ? 'posts' : 'post'} no GST`,
          message: 'The boxes below report the GST that was actually posted to your GST accounts, so these entries add no GST to 1A or 1B. To fix one, post the GST as well (credit your GST collected account for a sale, debit your GST paid account for a purchase) — or take the tax code off the line if no GST applies.',
        })
        : null,
      bas.inputTaxedSales
        ? h('p', { class: 'report-note' }, `${fmt.money(bas.inputTaxedSales)} of input-taxed sales (residential rent, financial supplies) is included in G1 and carries no GST.`)
        : null,
      banner({ kind: 'info', title: 'A calculation aid, not a lodgement', message: bas.note }),
      h('p', { class: 'report-note' }, 'Rookeepa is not connected to the ATO and does not lodge anything for you. These figures come from the tax codes stamped on your posted transactions; check them (and any fuel tax credits or PAYG instalments) with your accountant before you lodge.'),
      codeRows.length ? h('div', { class: 'stack', style: { marginTop: '0.5rem' } },
        h('p', { class: 'small muted' }, 'By tax code'),
        table({ columns: codeColumns, rows: codeRows, footer: codeFooter, compact: true })) : null,
    ].filter(Boolean),
    notes: [],
    csv: {
      filename: `gst-activity-statement-${S.from}-to-${S.to}.csv`,
      headers: ['Box', 'Description', 'Amount'],
      rows: boxOrder.map((b) => [b, bas.labels[b], fmt.raw(bas.boxes[b])]),
    },
    printTotals: [
      ['GST on sales (1A)', bas.boxes['1A']],
      ['GST on purchases (1B)', bas.boxes['1B']],
      [bas.payable ? 'Net GST payable' : 'Net GST refundable', bas.netGst],
    ],
    printNotes: [bas.note, 'Rookeepa is not connected to the ATO and does not lodge anything.'],
  };
}

/* -------------------------------------------------------------- cash flow */

function buildCashFlow(ctx, S) {
  const { accounts, entries } = ctx.data;
  const cf = cashFlow({ accounts, entries, from: S.from, to: S.to });

  const rows = cf.months.map((m) => ({
    label: monthLabel(m.month),
    in: m.in,
    out: m.out,
    net: m.net,
    closing: m.closing,
  }));

  const columns = [
    { key: 'label', label: 'Month' },
    mCol('in', 'Money in'),
    mCol('out', 'Money out'),
    mCol('net', 'Net'),
    mCol('closing', 'Closing balance'),
  ];

  const footer = rows.length ? [[
    h('strong', null, 'Total'),
    moneyCell(cf.inflows),
    moneyCell(cf.outflows),
    moneyCell(cf.net),
    moneyCell(cf.closing),
  ]] : [];

  const classRows = [
    { label: 'Operating activities', amount: cf.byClass.operating },
    { label: 'Investing activities', amount: cf.byClass.investing },
    { label: 'Financing activities', amount: cf.byClass.financing },
  ];
  const classColumns = [
    { key: 'label', label: 'Category' },
    mCol('amount', 'Amount'),
  ];

  const catColumns = [
    { key: 'name', label: 'Account', render: (r) => `${r.code} ${r.name}` },
    mCol('amount', 'Amount'),
  ];

  const extras = [
    totalsCard([
      ['Opening cash', fmt.money(cf.opening)],
      ['Money in', fmt.money(cf.inflows)],
      ['Money out', fmt.money(cf.outflows)],
      ['Closing cash', fmt.money(cf.closing)],
    ]),
    rows.length ? chartBlock('Net cash movement by month', cf.months.map((m) => ({ label: monthLabel(m.month), value: m.net }))) : null,
    h('div', { class: 'stack', style: { marginTop: '0.5rem' } },
      h('p', { class: 'small muted' }, 'Operating, investing and financing'),
      table({ columns: classColumns, rows: classRows, compact: true })),
    cf.byCategory.length ? h('div', { class: 'stack', style: { marginTop: '0.5rem' } },
      h('p', { class: 'small muted' }, 'Where the cash came from and went'),
      table({ columns: catColumns, rows: cf.byCategory, compact: true })) : null,
  ].filter(Boolean);

  return {
    title: 'Cash flow',
    periodLabel: periodLabel(S),
    columns,
    rows,
    footer,
    empty: cf.bankCodes.length
      ? 'No cash movement in this period.'
      : 'No bank accounts are set up, so there is no cash to report.',
    checks: [],
    extras,
    notes: [
      'Cash is every account flagged with a bank control role, so a credit card feed is counted as cash too.',
    ],
    csv: {
      filename: `cash-flow-${S.from}-to-${S.to}.csv`,
      headers: ['Month', 'Money in', 'Money out', 'Net', 'Closing balance'],
      rows: rows.map((r) => [r.label, fmt.raw(r.in), fmt.raw(r.out), fmt.raw(r.net), fmt.raw(r.closing)]),
    },
    printTotals: [
      ['Opening cash', cf.opening],
      ['Money in', cf.inflows],
      ['Money out', cf.outflows],
      ['Closing cash', cf.closing],
    ],
  };
}
