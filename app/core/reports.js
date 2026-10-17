/**
 * Rookeepa — reports.
 *
 * Every function here is pure: give it arrays, get back a plain object. No
 * database, no DOM, no globals. That is what makes the numbers testable, and
 * every report in the UI is nothing more than a table over one of these.
 */

import { sum, gstOf } from './money.js';
import {
  postedEntries, balancesByAccount, turnoverByAccount, accountLedger,
} from './ledger.js';
import { ACCOUNT_TYPES, sortAccounts, isDebitType } from './coa.js';
import {
  fyStartFor, fyEndFor, todayISO, daysBetween, monthsBetween, monthKey, fyLabel, addDays, addYears, parseISO, compareISO,
} from './dates.js';
import { computeDocument, documentSummary, allocatedTo, paymentsByDocument, overdueBuckets, bucketFor, docTypeMeta, isSales } from './docs.js';

const PNL_TYPES = ['income', 'costOfSales', 'expense', 'otherIncome', 'otherExpenses'];

function naturalOf(account, signed) {
  return isDebitType(account.type) ? signed : -signed;
}

/**
 * Accounts to iterate when reporting. Deactivating an account only removes it from
 * pickers and new postings — it must never hide its history, so this deliberately
 * does not filter on `active`. Filtering here zeroed a deactivated account's
 * revenue, broke the trial balance and left the balance sheet out of balance.
 */
function reportAccounts(accounts) {
  return sortAccounts(accounts);
}

/* --------------------------------------------------------- profit and loss */

/** Income statement for a period. `compare` gives the previous matching period. */
export function incomeStatement({ accounts, entries, from, to, includeZero = false }) {
  const bal = balancesByAccount(entries, { from, to });
  const rows = [];
  for (const acc of reportAccounts(accounts)) {
    if (!PNL_TYPES.includes(acc.type)) continue;
    const amount = naturalOf(acc, bal.get(acc.code) || 0);
    if (amount === 0 && !includeZero) continue;
    rows.push({ code: acc.code, name: acc.name, type: acc.type, amount });
  }
  return pnlShape(rows, from, to, 'accrual');
}

/**
 * One shape for both engines. A cash-basis report has to render, compare, export and print
 * through exactly the same code path as an accrual one; if each engine built its own, the two
 * would drift apart a column at a time.
 */
function pnlShape(rows, from, to, basis) {
  const group = (type) => rows.filter((r) => r.type === type);
  const income = sum(group('income').map((r) => r.amount));
  const costOfSales = sum(group('costOfSales').map((r) => r.amount));
  const expenses = sum(group('expense').map((r) => r.amount));
  // What the business earned by trading, before anything it earned by having money.
  const otherIncome = sum(group('otherIncome').map((r) => r.amount));
  const otherExpenses = sum(group('otherExpenses').map((r) => r.amount));
  const grossProfit = income - costOfSales;
  const operatingProfit = grossProfit - expenses;
  const netProfit = operatingProfit + otherIncome - otherExpenses;
  return {
    basis,
    period: { from, to },
    groups: {
      income: group('income'),
      costOfSales: group('costOfSales'),
      expense: group('expense'),
      otherIncome: group('otherIncome'),
      otherExpenses: group('otherExpenses'),
    },
    totals: {
      income,
      costOfSales,
      grossProfit,
      grossMargin: income ? grossProfit / income : 0,
      expenses,
      operatingProfit,
      otherIncome,
      otherExpenses,
      // With nothing in the two other groups this is exactly grossProfit - expenses, which is what it
      // always was — a company that does not separate interest sees no change at all.
      netProfit,
      netMargin: income ? netProfit / income : 0,
    },
  };
}

/**
 * A profit and loss on a cash basis: income is recognised when a customer's money arrived, and
 * expenses when the money left — not when the invoice or bill was dated.
 *
 * The books stay accrual; this is a view over them, worked out the way a cash-basis report is
 * normally produced:
 *
 *   - A receipt or payment is not income or expense by itself. It settles documents, so the
 *     income and expense recognised is the share of each settled document that the money
 *     covered. Money received but not yet applied to a document is not income — it is still a
 *     credit the customer holds, and recognising it would report income that could still be
 *     refunded or applied to a future invoice.
 *   - Money that moved straight to an income or expense account (a categorised bank line, a
 *     bank fee, a cash purchase) is recognised in full.
 *   - Anything that moves money between balance sheet accounts — a transfer, a loan
 *     repayment, GST — has no effect here.
 *
 * GST is never part of a profit and loss on either basis, and the amounts are the
 * tax-exclusive share of each document. Freight is not attributed: it is rare, and spreading
 * it across the lines of a part-paid document would be a guess.
 */
export function cashBasisIncomeStatement({ accounts, entries, documents = [], payments = [], taxCodes = [], from, to, includeZero = false }) {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  // Both bank accounts and credit cards hold "money moved" — a card purchase is cash spent.
  const moneyCodes = new Set(accounts.filter((a) => /^bank/.test(String(a.control || ''))).map((a) => a.code));
  const docsById = new Map(documents.map((d) => [d.id, d]));
  const paysById = new Map(payments.map((p) => [p.id, p]));
  const isPnlAccount = (code) => PNL_TYPES.includes(byCode.get(code)?.type);

  // Debit-positive, the same convention balancesByAccount uses, so naturalOf applies unchanged.
  const raw = new Map();
  const add = (code, cents) => {
    if (!cents) return;
    raw.set(code, (raw.get(code) || 0) + cents);
  };

  for (const entry of entries) {
    if (entry.status === 'void') continue;
    if (compareISO(entry.date, from) < 0 || compareISO(entry.date, to) > 0) continue;
    if (!entry.lines.some((l) => moneyCodes.has(l.accountCode))) continue;   // no money moved
    const signed = (l) => (l.debit || 0) - (l.credit || 0);

    if (entry.source?.type === 'customer-payment' || entry.source?.type === 'supplier-payment') {
      const payment = paysById.get(entry.source.id);
      for (const alloc of payment?.allocations || []) {
        const doc = docsById.get(alloc.docId);
        if (!doc || doc.status === 'void') continue;
        const { rows, total } = computeDocument(doc, taxCodes);
        if (!total) continue;
        // Signed, not clamped: a refund allocates a negative amount back to the document, and clamping it to
        // zero left the income from the original receipt standing after the money went back out.
        const covered = Math.sign(alloc.amount || 0) * Math.min(Math.abs(alloc.amount || 0), total);
        // A sale credited income; a bill debited an expense.
        const sign = isSales(doc.type) ? -1 : 1;
        for (const row of rows) {
          if (!isPnlAccount(row.accountCode)) continue;
          add(row.accountCode, sign * Math.round((row.ex * covered) / total));
        }
      }
      continue;   // the payment's own lines move the bank against debtors or creditors
    }

    for (const l of entry.lines) {
      if (moneyCodes.has(l.accountCode) || !isPnlAccount(l.accountCode)) continue;
      add(l.accountCode, signed(l));
    }
  }

  const rows = [];
  for (const acc of reportAccounts(accounts)) {
    if (!PNL_TYPES.includes(acc.type)) continue;
    const amount = naturalOf(acc, raw.get(acc.code) || 0);
    if (amount === 0 && !includeZero) continue;
    rows.push({ code: acc.code, name: acc.name, type: acc.type, amount });
  }
  return pnlShape(rows, from, to, 'cash');
}

/**
 * The period a profit and loss report is compared against: the stretch of time immediately
 * before it, or the same dates a year earlier.
 */
export function comparisonPeriod({ from, to, mode = 'prev' }) {
  if (!mode || mode === 'none') return null;
  if (mode === 'last-year') return { from: addYears(from, -1), to: addYears(to, -1), mode: 'last-year' };
  const len = Math.max(1, daysBetween(from, to) + 1);
  return { from: addDays(from, -len), to: addDays(from, -1), mode: 'prev' };
}

/**
 * The change between two figures: how much, which way, and whether that is good news.
 * More income is favourable and more expense is not, so the colour follows that rather than
 * the arrow. The percentage is left out when there is nothing to compare against — a change
 * from zero has no percentage, and inventing one would mislead.
 */
export function varianceOf(amount, prev, kind = 'expense') {
  if (prev === null || prev === undefined) return null;
  const change = (amount || 0) - (prev || 0);
  const pct = prev === 0 ? null : (change / Math.abs(prev)) * 100;
  const up = change > 0;
  return {
    change,
    pct,
    up,
    favourable: change === 0 ? null : (kind === 'income' ? up : !up),
  };
}

/** Revenue, cost of sales, expenses and net profit per calendar month. */
export function monthlyPnl({ accounts, entries, from, to }) {
  const out = [];
  const firstMonth = (from || '').slice(0, 7);
  const lastMonth = (to || '').slice(0, 7);
  for (const key of monthsBetween(from, to)) {
    // Clamp the boundary months to the range that was actually asked for. Expanding
    // each month to its full calendar range put a 31 July sale into a 1–14 July
    // report, where the ordinary profit and loss correctly reported nothing.
    const monthFrom = key === firstMonth ? from : `${key}-01`;
    const monthTo = key === lastMonth ? to : lastDayOfMonth(key);
    const is = incomeStatement({ accounts, entries, from: monthFrom, to: monthTo });
    out.push({
      month: key,
      income: is.totals.income,
      costOfSales: is.totals.costOfSales,
      expenses: is.totals.expenses,
      net: is.totals.netProfit,
    });
  }
  return out;
}

function lastDayOfMonth(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m, 0);
  return `${y}-${String(m).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ------------------------------------------------------------ balance sheet */

/**
 * Balance sheet as at a date. Because Rookeepa never posts a closing entry
 * behind your back, profit that has not been closed to Retained Earnings shows
 * as its own line — so assets always equal liabilities plus equity.
 */
export function balanceSheet({ accounts, entries, asOf, fyStartMonth = 7, includeZero = false }) {
  const bal = balancesByAccount(entries, { to: asOf });
  const rowsFor = (types) => reportAccounts(accounts)
    .filter((a) => types.includes(a.type))
    .map((acc) => ({ code: acc.code, name: acc.name, type: acc.type, amount: naturalOf(acc, bal.get(acc.code) || 0) }))
    .filter((r) => includeZero || r.amount !== 0);

  const assets = rowsFor(['asset']);
  const liabilities = rowsFor(['liability']);
  const equity = rowsFor(['equity']);

  let unclosedProfit = 0;
  for (const acc of accounts) {
    // No `active` test here either: a deactivated income account still holds real
    // profit, and skipping it left the balance sheet out of balance by its amount.
    if (!PNL_TYPES.includes(acc.type)) continue;
    // Profit is the opposite of the signed balance for every profit-and-loss
    // account: income sits on the credit side, costs and expenses on the debit
    // side, so negating the signed balance gives "positive means profit".
    unclosedProfit += -(bal.get(acc.code) || 0);
  }

  const fyStart = fyStartFor(asOf, fyStartMonth);
  // Split that profit into the current year and anything never closed off in earlier
  // years. Labelling the whole figure "current year earnings" was simply wrong once a
  // year had been left unclosed: on 1 July 2027 it showed the prior year's profit.
  const priorBal = balancesByAccount(entries, { to: addDays(fyStart, -1) });
  let priorProfit = 0;
  for (const acc of accounts) {
    if (!PNL_TYPES.includes(acc.type)) continue;
    priorProfit += -(priorBal.get(acc.code) || 0);
  }
  const currentYearProfit = unclosedProfit - priorProfit;
  if (currentYearProfit !== 0) {
    equity.push({
      code: '',
      name: 'Current year earnings (not yet closed)',
      type: 'equity',
      amount: currentYearProfit,
      synthetic: true,
    });
  }
  if (priorProfit !== 0) {
    equity.push({
      code: '',
      name: 'Earlier years (not yet closed)',
      type: 'equity',
      amount: priorProfit,
      synthetic: true,
    });
  }

  const fy = incomeStatement({ accounts, entries, from: fyStart, to: asOf });

  const totalAssets = sum(assets.map((r) => r.amount));
  const totalLiabilities = sum(liabilities.map((r) => r.amount));
  const totalEquity = sum(equity.map((r) => r.amount));
  const difference = totalAssets - (totalLiabilities + totalEquity);
  return {
    asOf,
    assets: { rows: assets, total: totalAssets },
    liabilities: { rows: liabilities, total: totalLiabilities },
    equity: { rows: equity, total: totalEquity },
    netAssets: totalAssets - totalLiabilities,
    difference,
    balanced: difference === 0,
    fyStart,
    fyProfit: fy.totals.netProfit,
    workingCapital: sum(assets.filter((r) => isCurrentAsset(r)).map((r) => r.amount))
      - sum(liabilities.filter((r) => isCurrentLiability(r)).map((r) => r.amount)),
  };
}

function isCurrentAsset(row) {
  // Balance-sheet classification by code series: 1-0xxx and 1-1xxx are current.
  return /^1-[01]/.test(row.code || '');
}

function isCurrentLiability(row) {
  // 2-1xxx is current; 2-2xxx and beyond are longer-term (a bank loan is not
  // working capital, and counting it as such would flatter the figure).
  return /^2-1/.test(row.code || '');
}

/* ------------------------------------------------------------ trial balance */

/**
 * Trial balance. With `from` this is a movement report (opening / debit /
 * credit / closing); without it, closing balances as at the date.
 */
export function trialBalance({ accounts, entries, from = null, to, includeZero = false }) {
  const openingMap = from ? balancesByAccount(entries, { to: addDays(from, -1) }) : new Map();
  const moveMap = turnoverByAccount(entries, { from, to });
  const rows = [];
  for (const acc of reportAccounts(accounts)) {
    const opening = openingMap.get(acc.code) || 0;
    const mv = moveMap.get(acc.code) || { debit: 0, credit: 0 };
    const closing = opening + mv.debit - mv.credit;
    if (!includeZero && opening === 0 && mv.debit === 0 && mv.credit === 0) continue;
    rows.push({
      code: acc.code,
      name: acc.name,
      type: acc.type,
      opening,
      debit: mv.debit,
      credit: mv.credit,
      closing,
      closingDebit: closing > 0 ? closing : 0,
      closingCredit: closing < 0 ? -closing : 0,
    });
  }
  const totals = {
    opening: sum(rows.map((r) => r.opening)),
    debit: sum(rows.map((r) => r.debit)),
    credit: sum(rows.map((r) => r.credit)),
    closing: sum(rows.map((r) => r.closing)),
    closingDebit: sum(rows.map((r) => r.closingDebit)),
    closingCredit: sum(rows.map((r) => r.closingCredit)),
  };
  return {
    from,
    to,
    rows,
    totals,
    balanced: totals.debit === totals.credit && totals.closingDebit === totals.closingCredit && totals.opening === 0,
  };
}

/* --------------------------------------------------------- general ledger */

export function generalLedgerReport({ accounts, entries, from, to, code }) {
  const account = accounts.find((a) => a.code === code);
  let opening = 0;
  if (from) {
    for (const e of postedEntries(entries, { to: addDays(from, -1) })) {
      for (const l of e.lines) if (l.accountCode === code) opening += (l.debit || 0) - (l.credit || 0);
    }
  }
  const rows = accountLedger(entries, code, { from, to });
  const debit = sum(rows.map((r) => r.debit));
  const credit = sum(rows.map((r) => r.credit));
  const closing = opening + debit - credit;
  return { account, opening, rows, debit, credit, closing, from, to };
}

/** Every posted transaction in a period, one row per line — the audit view. */
export function journalReport({ accounts, entries, from, to }) {
  const rows = [];
  for (const e of postedEntries(entries, { from, to }).slice().sort((a, b) => a.date.localeCompare(b.date))) {
    for (const l of e.lines) {
      const acc = accounts.find((a) => a.code === l.accountCode);
      rows.push({
        date: e.date,
        number: e.number || '',
        source: e.source?.type || 'journal',
        memo: l.description || e.memo || '',
        accountCode: l.accountCode,
        accountName: acc ? acc.name : '(deleted account)',
        taxCode: l.taxCode || '',
        debit: l.debit || 0,
        credit: l.credit || 0,
        entryId: e.id,
      });
    }
  }
  return {
    rows,
    totals: { debit: sum(rows.map((r) => r.debit)), credit: sum(rows.map((r) => r.credit)) },
  };
}

/* ------------------------------------------------------- aged debtors/creditors */

/**
 * Aged receivables / payables, aged from the due date into the familiar
 * 1-30 / 31-60 / 61-90 / 90+ buckets.
 *
 * The grand total is built to reconcile with the control account: open invoices
 * less credit notes, less any payment received but not yet applied to a
 * document. `controlBalance` is returned alongside so the UI (and the tests)
 * can prove the two agree.
 */
export function agedReport({ accounts, entries, documents, payments, taxCodes, kind = 'receivable', asOf = todayISO(), contactId = null }) {
  const buckets = overdueBuckets();
  const docTypes = kind === 'receivable' ? ['invoice'] : ['bill'];
  const creditTypes = kind === 'receivable' ? ['credit-note-sale'] : ['credit-note-purchase'];
  const paymentType = kind === 'receivable' ? 'customer' : 'supplier';
  const controlRole = kind === 'receivable' ? 'ar' : 'ap';
  // One pass over the receipts, instead of every document searching all of them.
  const paymentIndex = paymentsByDocument(payments);

  const openDocs = documents.filter((d) => d.status === 'open'
    && (docTypes.includes(d.type) || creditTypes.includes(d.type))
    // As at a date, a document dated after it does not exist yet: ageing an invoice
    // from 10 July at 1 July put money in a period it was never owed in.
    && (!asOf || !d.date || d.date <= asOf)
    && (!contactId || d.contactId === contactId));

  const byContact = new Map();
  const ensure = (id, name) => {
    if (!byContact.has(id)) {
      byContact.set(id, {
        contactId: id,
        contactName: name || '(no contact)',
        total: 0,
        onAccount: 0,
        buckets: Object.fromEntries(buckets.map((b) => [b.id, 0])),
        docs: [],
      });
    }
    return byContact.get(id);
  };

  for (const d of openDocs) {
    const s = documentSummary(d, taxCodes, payments, asOf, paymentIndex);
    const credit = creditTypes.includes(d.type);
    const amount = credit ? -s.balance : s.balance;
    const due = d.dueDate || d.date;
    const daysPast = Math.max(0, daysBetween(due, asOf));
    const bucket = credit ? buckets[0] : bucketFor(daysPast, buckets);
    const row = ensure(d.contactId, d._contactName);
    row.total += amount;
    row.buckets[bucket.id] += amount;
    row.docs.push({
      id: d.id, number: d.number, type: d.type, date: d.date, dueDate: due,
      total: s.total, paid: s.paid, balance: amount, daysPast, bucket: bucket.id,
      credit,
    });
  }

  // Money received but not applied to a document still reduces what is owed.
  for (const p of payments) {
    if (p.status === 'void' || p.type !== paymentType) continue;
    if (contactId && p.contactId !== contactId) continue;
    // Same as-at rule as the allocations above: money that arrives later cannot
    // reduce what was owed at an earlier date.
    if (asOf && p.date && p.date > asOf) continue;
    const applied = sum((p.allocations || []).map((a) => a.amount || 0));
    const unapplied = (p.amount || 0) - applied;
    if (unapplied === 0) continue;
    const row = ensure(p.contactId, p._contactName);
    row.onAccount -= unapplied;
    row.buckets[buckets[0].id] -= unapplied;
    row.total -= unapplied;
    row.docs.push({
      id: p.id, number: p.number, type: 'payment', date: p.date, dueDate: p.date,
      total: unapplied, paid: 0, balance: -unapplied, daysPast: 0, bucket: buckets[0].id, credit: true,
    });
  }

  const rows = [...byContact.values()]
    .filter((r) => r.total !== 0 || r.docs.length)
    .sort((a, b) => b.total - a.total);
  for (const r of rows) r.docs.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));

  const totals = { total: sum(rows.map((r) => r.total)), onAccount: sum(rows.map((r) => r.onAccount)) };
  for (const b of buckets) totals[b.id] = sum(rows.map((r) => r.buckets[b.id]));

  // Reconcile against the control account so a mismatch can never hide.
  // Opening balances entered straight against debtors or creditors have no
  // document behind them and so cannot be aged; they are excluded here and
  // reported separately rather than being allowed to create a phantom gap.
  const control = accounts.find((a) => a.control === controlRole);
  let controlSigned = 0;
  let openingOnControl = 0;
  if (control) {
    for (const e of postedEntries(entries, { to: asOf })) {
      for (const l of e.lines) {
        if (l.accountCode !== control.code) continue;
        const amt = (l.debit || 0) - (l.credit || 0);
        controlSigned += amt;
        if (e.source?.type === 'opening-balances') openingOnControl += amt;
      }
    }
  }
  const ageableSigned = controlSigned - openingOnControl;
  const controlBalance = kind === 'receivable' ? ageableSigned : -ageableSigned;
  const openingBalance = kind === 'receivable' ? openingOnControl : -openingOnControl;

  return {
    kind,
    asOf,
    buckets,
    rows,
    totals,
    controlAccount: control || null,
    controlBalance,
    openingBalance,
    reconciles: controlBalance === totals.total,
    difference: totals.total - controlBalance,
  };
}

/* ------------------------------------------------------ activity statement */

/**
 * GST / Activity Statement summary for a period.
 *
 * Uses the per-tax-code summary stamped on each entry when it was posted, and
 * falls back to reading tax codes off journal lines for hand-written journals.
 * Rookeepa deliberately does not lodge anything: no ATO connection, no SBR.
 * This is the arithmetic; you or your accountant lodge it.
 */
export function basSummary({ accounts, entries, taxCodes, from, to, fuelTaxCredits = 0 }) {
  const boxes = { G1: 0, G2: 0, G3: 0, G10: 0, G11: 0, '1A': 0, '1B': 0 };
  const byCode = new Map();
  const byCodeTouch = (code) => {
    if (!byCode.has(code)) byCode.set(code, { code, sales: 0, salesGst: 0, purchases: 0, purchasesGst: 0, lines: 0 });
    return byCode.get(code);
  };
  const gstRole = new Map(accounts
    .filter((a) => a.control === 'gstCollected' || a.control === 'gstPaid')
    .map((a) => [a.code, a.control]));
  let journalGstOnSales = 0;
  let journalGstOnPurchases = 0;
  let journalsWithUnpostedGst = 0;

  for (const e of postedEntries(entries, { from, to })) {
    const authoritative = !!(e.taxSummary && e.taxSummary.length);
    const items = authoritative ? e.taxSummary : deriveTaxItems(e, accounts, taxCodes);
    for (const it of items) {
      if (!it.taxCode) continue;
      const tc = taxCodes.find((t) => t.code === it.taxCode) || { bas: {} };
      const bas = tc.bas || {};
      const row = byCodeTouch(it.taxCode);
      row.lines += 1;
      if (it.side === 'sales') {
        if (bas.salesG1) boxes.G1 += it.net;
        if (bas.salesG2) boxes.G2 += it.net;
        if (bas.salesG3) boxes.G3 += it.net;
        boxes['1A'] += it.gst || 0;
        row.sales += it.net;
        row.salesGst += it.gst || 0;
      } else {
        const inclusive = (it.net || 0) + (it.gst || 0);
        if (bas.purchasesG10) boxes.G10 += inclusive;
        if (bas.purchasesG11) boxes.G11 += inclusive;
        boxes['1B'] += it.gst || 0;
        row.purchases += inclusive;
        row.purchasesGst += it.gst || 0;
      }
    }

    if (!authoritative) {
      // A hand-written journal reports the GST it actually posted to the control
      // accounts. Applying the tax code's *rate* invented a liability the ledger never
      // recorded: Dr bank 100 / Cr sales 100 labelled "GST" produced $10 at 1A with no
      // GST anywhere in the books, and the boxes stopped tying to the GST accounts.
      let salesGst = 0;
      let purchaseGst = 0;
      for (const l of e.lines) {
        const role = gstRole.get(l.accountCode);
        if (!role) continue;
        const credit = (l.credit || 0) - (l.debit || 0);
        if (role === 'gstCollected') salesGst += credit;
        else purchaseGst += -credit;
      }
      boxes['1A'] += salesGst;
      boxes['1B'] += purchaseGst;
      journalGstOnSales += salesGst;
      journalGstOnPurchases += purchaseGst;
      if (!salesGst && !purchaseGst && items.some((it) => it.impliedGst)) journalsWithUnpostedGst += 1;
    }
  }

  // Keep the per-tax-code breakdown reconciling to 1A and 1B: journal GST cannot be
  // attributed to one tax code, so it is shown as its own line rather than dropped.
  if (journalGstOnSales || journalGstOnPurchases) {
    byCode.set('(journals)', {
      code: '(journals)', sales: 0, salesGst: journalGstOnSales,
      purchases: 0, purchasesGst: journalGstOnPurchases, lines: 0, derived: true,
    });
  }

  const totalSales = boxes.G1;
  const totalPurchases = boxes.G10 + boxes.G11;
  const netGst = boxes['1A'] - boxes['1B'] - (fuelTaxCredits || 0);
  const inputTaxedSales = (byCode.get('ITS') || {}).sales || 0;
  return {
    from,
    to,
    labels: {
      G1: 'Total sales (GST-exclusive)',
      G2: 'Export sales',
      G3: 'Other GST-free sales',
      G10: 'Capital purchases (incl. GST)',
      G11: 'Non-capital purchases (incl. GST)',
      '1A': 'GST on sales',
      '1B': 'GST on purchases',
    },
    boxes,
    // G1 is the one label where the ATO lets you choose: this app reports
    // GST-exclusive amounts (the accounts method), so say so on the report.
    gstBasis: 'exclusive',
    inputTaxedSales,
    journalsWithUnpostedGst,
    totalSales,
    totalPurchases,
    netGst,
    payable: netGst > 0,
    byTaxCode: [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : 1)),
    note: 'A calculation aid only. Rookeepa does not connect to the ATO and does not lodge. '
      + 'G1 is reported GST-exclusive (amounts reported at every other label follow the same basis). '
      + 'Check the figures (and any fuel tax credits or PAYG instalments) with your accountant before lodging.',
    lodgement: false,
  };
}

/**
 * Tax detail for a hand-written journal, taken from the journal itself.
 *
 * The lines are the only evidence, so the GST reported for a journal is what actually
 * moved on the GST control accounts (see basSummary). `impliedGst` records what the
 * tax code's rate would have suggested, purely so the summary can warn when a journal
 * carries a GST code but posts no GST at all — that journal is wrong, and the fix is
 * to post the GST, not to let the report invent it.
 */
function deriveTaxItems(entry, accounts, taxCodes) {
  const out = [];
  for (const l of entry.lines) {
    if (!l.taxCode) continue;
    const acc = accounts.find((a) => a.code === l.accountCode);
    if (!acc || acc.control) continue;
    const tc = taxCodes.find((t) => t.code === l.taxCode) || { gstBps: 0 };
    // Other income is sales too: interest received is turnover on the activity statement, not a purchase.
    const sales = acc.type === 'income' || acc.type === 'otherIncome';
    const net = sales
      ? (l.credit || 0) - (l.debit || 0)
      : (l.debit || 0) - (l.credit || 0);
    out.push({
      taxCode: l.taxCode, side: sales ? 'sales' : 'purchases', net,
      gst: 0, impliedGst: gstOf(net, tc), derived: true,
    });
  }
  return out;
}

/* ------------------------------------------------------------------- cash */

/**
 * Cash movement. Bank accounts are anything flagged with a bank control role,
 * so a business with a credit card feed gets that accounted for as cash too.
 */
export function cashFlow({ accounts, entries, from, to }) {
  const bankCodes = new Set(accounts.filter((a) => a.control && a.control.startsWith('bank')).map((a) => a.code));
  const all = postedEntries(entries, { to });
  let opening = 0;
  for (const e of all) {
    if (from && e.date >= from) continue;
    for (const l of e.lines) if (bankCodes.has(l.accountCode)) opening += (l.debit || 0) - (l.credit || 0);
  }

  const months = new Map();
  const byCategory = new Map();
  let inflows = 0;
  let outflows = 0;

  for (const e of postedEntries(entries, { from, to })) {
    const bankLines = e.lines.filter((l) => bankCodes.has(l.accountCode));
    if (!bankLines.length) continue;
    const net = sum(bankLines.map((l) => (l.debit || 0) - (l.credit || 0)));
    if (net > 0) inflows += net; else if (net < 0) outflows += net;

    const key = monthKey(e.date);
    const m = months.get(key) || { month: key, in: 0, out: 0, net: 0 };
    if (net > 0) m.in += net; else m.out += net;
    m.net += net;
    months.set(key, m);

    for (const l of e.lines) {
      if (bankCodes.has(l.accountCode)) continue;
      const acc = accounts.find((a) => a.code === l.accountCode);
      if (!acc) continue;
      const amount = (l.debit || 0) - (l.credit || 0);
      const cat = byCategory.get(acc.code) || { code: acc.code, name: acc.name, type: acc.type, amount: 0 };
      cat.amount -= amount; // a credit to income brings cash in
      byCategory.set(acc.code, cat);
    }
  }

  const monthRows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  let run = opening;
  for (const m of monthRows) { run += m.net; m.closing = run; }

  const net = inflows + outflows;
  return {
    from,
    to,
    bankCodes: [...bankCodes],
    opening,
    inflows,
    outflows,
    net,
    closing: opening + net,
    months: monthRows,
    byCategory: [...byCategory.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    byClass: (() => {
      const groups = { operating: 0, investing: 0, financing: 0 };
      for (const c of byCategory.values()) {
        if (c.type === 'income' || c.type === 'expense' || c.type === 'costOfSales') groups.operating += c.amount;
        else if (c.type === 'asset') groups.investing += c.amount;
        else groups.financing += c.amount;
      }
      return groups;
    })(),
  };
}

/* -------------------------------------------------------------- dashboard */

export function dashboardKpis({ accounts, entries, documents, payments, taxCodes, company, asOf = todayISO() }) {
  const fyStart = fyStartFor(asOf, company?.fyStartMonth || 7);
  // The overdue and due-soon lists below summarise every open document, so the receipts are
  // indexed once rather than searched once per document.
  const paymentIndex = paymentsByDocument(payments);
  const is = incomeStatement({ accounts, entries, from: fyStart, to: asOf });
  const bs = balanceSheet({ accounts, entries, asOf, fyStartMonth: company?.fyStartMonth || 7 });
  const bankCodes = accounts.filter((a) => a.control && a.control.startsWith('bank')).map((a) => a.code);
  const bal = balancesByAccount(entries, { to: asOf });
  const cash = sum(bankCodes.map((c) => bal.get(c) || 0));

  const ar = agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'receivable', asOf });
  const ap = agedReport({ accounts, entries, documents, payments, taxCodes, kind: 'payable', asOf });

  const taxCollected = accounts.find((a) => a.control === 'gstCollected');
  const taxPaid = accounts.find((a) => a.control === 'gstPaid');
  const gstBalance = taxCollected || taxPaid
    ? -(bal.get(taxCollected?.code) || 0) - (bal.get(taxPaid?.code) || 0)
    : 0;

  const overdue = documents
    .filter((d) => d.status === 'open' && d.type === 'invoice')
    .map((d) => ({ doc: d, summary: documentSummary(d, taxCodes, payments, asOf, paymentIndex) }))
    .filter((r) => r.summary.status === 'overdue' && r.summary.balance > 0);

  // Bills genuinely still to pay in the next week — a bill that is already
  // settled keeps a stored status of "open", so the derived status and the
  // balance decide, not the date alone.
  const billsDue = documents
    .filter((d) => d.status === 'open' && d.type === 'bill' && d.dueDate)
    .map((d) => ({ doc: d, summary: documentSummary(d, taxCodes, payments, asOf, paymentIndex) }))
    .filter((r) => r.summary.balance > 0 && r.doc.dueDate <= addDays(asOf, 7))
    .sort((a, b) => a.doc.dueDate.localeCompare(b.doc.dueDate));

  return {
    asOf,
    fyStart,
    revenueFy: is.totals.income,
    expensesFy: is.totals.costOfSales + is.totals.expenses,
    netProfitFy: is.totals.netProfit,
    grossProfitFy: is.totals.grossProfit,
    cash,
    receivables: ar.totals.total,
    payables: ap.totals.total,
    overdueCount: overdue.length,
    overdueTotal: sum(overdue.map((r) => r.summary.balance)),
    overdueInvoices: overdue.map((r) => r.doc),
    billsDueSoon: billsDue.map((r) => r.doc),
    billsDueSoonTotal: sum(billsDue.map((r) => r.summary.balance)),
    gstBalance,
    netAssets: bs.netAssets,
    balanced: bs.balanced,
    periodic: {
      income: is.totals.income,
      netProfit: is.totals.netProfit,
    },
  };
}
