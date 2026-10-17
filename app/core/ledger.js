/**
 * Rookeepa — the ledger.
 *
 * One source of truth: every dollar that appears in any report is a line in a
 * posted journal entry. Invoices, bills, payments and bank transactions are
 * just friendly ways of writing journal entries; they never carry balances of
 * their own.
 *
 * Sign convention: a line's `debit` or `credit` is a positive integer number of
 * cents and exactly one of them is non-zero. Internally a balance is signed
 * debit-positive, so an overdrawn bank account is simply negative.
 */

import { sum } from './money.js';
import { isValidISO, todayISO } from './dates.js';
import { uid } from './db.js';
import { isDebitType } from './coa.js';

export const SOURCE_LABELS = {
  invoice: 'Sale',
  'credit-note-sale': 'Credit note (sales)',
  bill: 'Purchase',
  'credit-note-purchase': 'Credit note (purchases)',
  'customer-payment': 'Customer payment',
  'supplier-payment': 'Supplier payment',
  'spend-money': 'Spend money',
  'receive-money': 'Receive money',
  transfer: 'Bank transfer',
  'opening-balances': 'Opening balances',
  journal: 'General journal',
  inventory: 'Inventory adjustment',
  depreciation: 'Depreciation',
  payroll: 'Payroll',
};

const SOURCE_PREFIX = {
  invoice: 'INV',
  bill: 'BILL',
  'credit-note-sale': 'CN',
  'credit-note-purchase': 'CNP',
  'customer-payment': 'PMT',
  'supplier-payment': 'SPMT',
  'spend-money': 'SPEND',
  'receive-money': 'RECV',
  transfer: 'TRF',
  'opening-balances': 'OB',
  journal: 'JE',
  inventory: 'INVADJ',
};

/** Build a journal line: exactly one of debit/credit is non-zero. */
export function line(accountCode, debit = 0, credit = 0, extra = {}) {
  return {
    accountCode,
    debit: Math.round(debit || 0),
    credit: Math.round(credit || 0),
    description: extra.description || '',
    taxCode: extra.taxCode || null,
    contactId: extra.contactId || null,
    jobCode: extra.jobCode || null,
    sourceDocId: extra.sourceDocId || null,
    sourceDocType: extra.sourceDocType || null,
  };
}

export function dr(accountCode, cents, extra) { return line(accountCode, cents, 0, extra); }
export function cr(accountCode, cents, extra) { return line(accountCode, 0, cents, extra); }

export function makeEntry(fields = {}) {
  return {
    id: fields.id || null,
    companyId: fields.companyId || null,
    date: fields.date || todayISO(),
    ref: fields.ref || '',
    memo: fields.memo || '',
    lines: fields.lines || [],
    taxSummary: fields.taxSummary || [],
    source: fields.source || { type: 'journal', id: null },
    status: fields.status || 'posted',
    voidReason: fields.voidReason || null,
    voidedAt: fields.voidedAt || null,
    automatic: fields.automatic === true,
    createdAt: fields.createdAt || null,
    updatedAt: fields.updatedAt || null,
  };
}

export function entryTotals(entry) {
  const debit = sum(entry.lines.map((l) => l.debit));
  const credit = sum(entry.lines.map((l) => l.credit));
  return { debit, credit, difference: debit - credit, balanced: debit === credit && debit > 0 };
}

/** Validate before anything touches the database. Returns { ok, errors }. */
export function validateEntry(entry, opts = {}) {
  const errors = [];
  const accounts = opts.accounts || null;
  const codes = accounts ? new Set(accounts.map((a) => a.code)) : null;

  if (!isValidISO(entry.date)) errors.push(`"${entry.date || '(blank)'}" is not a valid date (expected YYYY-MM-DD).`);
  if (!Array.isArray(entry.lines) || entry.lines.length < 2) {
    errors.push('A journal entry needs at least two lines (one debit and one credit).');
  } else {
    entry.lines.forEach((l, i) => {
      const n = i + 1;
      const d = l.debit || 0;
      const c = l.credit || 0;
      if (!l.accountCode) errors.push(`Line ${n} has no account.`);
      else if (codes && !codes.has(l.accountCode)) errors.push(`Line ${n} uses account ${l.accountCode}, which does not exist in this company file.`);
      if (!Number.isInteger(d) || !Number.isInteger(c)) errors.push(`Line ${n} has a fractional amount — money must be whole cents.`);
      if (d < 0 || c < 0) errors.push(`Line ${n} has a negative amount — swap the debit and credit columns instead.`);
      if (d !== 0 && c !== 0) errors.push(`Line ${n} has both a debit and a credit — use one column per line.`);
      if (d === 0 && c === 0) errors.push(`Line ${n} has no amount.`);
    });
  }

  if (entry.lines?.length >= 2) {
    const t = entryTotals(entry);
    if (t.debit !== t.credit) {
      const diff = t.debit - t.credit;
      errors.push(`Out of balance by ${Math.abs(diff)} cents — debits must equal credits.`);
    }
  }
  if (!entry.companyId) errors.push('No company file selected.');
  return { ok: errors.length === 0, errors };
}

/** Next document number for a sequence, derived from the data so imports never collide. */
export function nextNumber(db, companyId, kind, opts = {}) {
  const company = db.get('companies', companyId) || {};
  const prefixMap = {
    invoice: company.invoicePrefix,
    bill: company.billPrefix,
    'credit-note-sale': company.creditNotePrefix,
    'credit-note-purchase': company.creditNotePrefix,
    quote: company.quotePrefix,
    'customer-payment': company.paymentPrefix,
    'supplier-payment': company.paymentPrefix,
  };
  const prefix = opts.prefix || prefixMap[kind] || `${(SOURCE_PREFIX[kind] || kind).toUpperCase()}-`;
  const width = opts.width || 4;
  const collections = ['documents', 'payments', 'entries'];
  let max = 0;
  for (const coll of collections) {
    for (const rec of db.of(coll, companyId)) {
      const num = String(rec.number || rec.ref || '');
      if (!num.startsWith(prefix)) continue;
      const tail = num.slice(prefix.length).replace(/[^0-9]/g, '');
      if (!tail) continue;
      const v = parseInt(tail, 10);
      if (Number.isFinite(v) && v > max) max = v;
    }
  }
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}

export function audit(db, fields) {
  try {
    db.put('auditLog', {
      companyId: fields.companyId || null,
      at: new Date().toISOString(),
      action: fields.action,
      entity: fields.entity || null,
      entityId: fields.entityId || null,
      detail: fields.detail || '',
      user: fields.user || 'local user',
    }, { silent: true });
  } catch (err) {
    console.warn('[rookeepa] audit write failed', err);
  }
}

/**
 * Post an entry. Idempotent per source document: posting the same invoice twice
 * replaces the earlier entry instead of doubling the books.
 */
export function postEntry(db, input, opts = {}) {
  const entry = makeEntry({ ...input, id: input.id || null });
  if (!entry.source) entry.source = { type: 'journal', id: null };
  if (!entry.number) entry.number = nextNumber(db, entry.companyId, entry.source.type, opts.numberOpts);

  const accounts = db.of('accounts', entry.companyId);
  const check = validateEntry(entry, { accounts });
  if (!check.ok) {
    const err = new Error(check.errors.join('\n'));
    err.code = 'INVALID_ENTRY';
    err.errors = check.errors;
    throw err;
  }

  let existing = null;
  if (entry.source.id) {
    existing = db.find('entries', (e) => e.companyId === entry.companyId
      && e.source?.id === entry.source.id
      && e.status === 'posted');
  }
  if (existing && existing.id !== entry.id) {
    if (opts.onConflict === 'error') {
      const err = new Error('That transaction is already posted.');
      err.code = 'ALREADY_POSTED';
      throw err;
    }
    entry.id = existing.id;
    entry.createdAt = existing.createdAt;
  }

  const saved = db.put('entries', { ...entry, status: 'posted' });
  audit(db, {
    companyId: entry.companyId,
    action: existing ? 'repost' : 'post',
    entity: 'entry',
    entityId: saved.id,
    detail: `${SOURCE_LABELS[entry.source.type] || entry.source.type} ${saved.number} — ${entry.memo || ''}`.trim(),
  });
  return saved;
}

/** Never delete: void, so the audit trail survives. */
export function voidEntry(db, entryId, reason = '', opts = {}) {
  const entry = db.get('entries', entryId);
  if (!entry) throw new Error('Entry not found.');
  if (entry.status === 'void') return entry;
  const saved = db.put('entries', {
    ...entry,
    status: 'void',
    voidReason: reason || 'Voided',
    voidedAt: new Date().toISOString(),
  });
  audit(db, {
    companyId: entry.companyId,
    action: 'void',
    entity: 'entry',
    entityId: entryId,
    detail: `Voided ${entry.number || entry.id}: ${reason || 'no reason given'}`,
  });
  if (opts.notify !== false) db.notify({ collection: 'entries', action: 'void', id: entryId });
  return saved;
}

export function voidEntriesForSource(db, companyId, sourceId, reason = '') {
  const list = db.filter('entries', (e) => e.companyId === companyId && e.source?.id === sourceId && e.status === 'posted');
  for (const e of list) voidEntry(db, e.id, reason, { notify: false });
  if (list.length) db.notify({ collection: 'entries', action: 'voidMany', count: list.length });
  return list.length;
}

/* ------------------------------------------------------------------- queries */

export function postedEntries(entries, opts = {}) {
  const { from, to, companyId, includeVoid = false } = opts;
  return entries.filter((e) => {
    if (!includeVoid && e.status !== 'posted') return false;
    if (companyId && e.companyId !== companyId) return false;
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    return true;
  });
}

export function linesFor(entries, predicate) {
  const out = [];
  for (const e of entries) {
    for (const l of e.lines) if (predicate(l, e)) out.push({ ...l, entry: e, date: e.date });
  }
  return out;
}

/** Signed balance (debit positive) of one account within a date window. */
export function accountBalance(entries, code, opts = {}) {
  let bal = 0;
  for (const e of postedEntries(entries, opts)) {
    for (const l of e.lines) {
      if (l.accountCode !== code) continue;
      bal += (l.debit || 0) - (l.credit || 0);
    }
  }
  return bal;
}

/** Map of accountCode -> signed balance (debit positive) for a window. */
export function balancesByAccount(entries, opts = {}) {
  const map = new Map();
  for (const e of postedEntries(entries, opts)) {
    for (const l of e.lines) {
      map.set(l.accountCode, (map.get(l.accountCode) || 0) + (l.debit || 0) - (l.credit || 0));
    }
  }
  return map;
}

/** Map of accountCode -> { debit, credit } totals (unsigned turnover). */
export function turnoverByAccount(entries, opts = {}) {
  const map = new Map();
  for (const e of postedEntries(entries, opts)) {
    for (const l of e.lines) {
      const cur = map.get(l.accountCode) || { debit: 0, credit: 0 };
      cur.debit += l.debit || 0;
      cur.credit += l.credit || 0;
      map.set(l.accountCode, cur);
    }
  }
  return map;
}

export function movementFor(entries, code, opts = {}) {
  let debit = 0;
  let credit = 0;
  for (const e of postedEntries(entries, opts)) {
    for (const l of e.lines) {
      if (l.accountCode !== code) continue;
      debit += l.debit || 0;
      credit += l.credit || 0;
    }
  }
  return { debit, credit, net: debit - credit };
}

/** Display balance: positive for a normal balance, e.g. income shown as a credit. */
export function naturalBalance(signedCents, type) {
  return isDebitType(type) ? signedCents : -signedCents;
}

export function documentPostingDate(entry) {
  return entry.date;
}

/** Group lines by tax code for a window — used by the GST summary and audit checks. */
export function taxTotals(entries, opts = {}) {
  const out = new Map();
  for (const e of postedEntries(entries, opts)) {
    for (const l of e.lines) {
      if (!l.taxCode) continue;
      const cur = out.get(l.taxCode) || { debit: 0, credit: 0, lines: 0 };
      cur.debit += l.debit || 0;
      cur.credit += l.credit || 0;
      cur.lines++;
      out.set(l.taxCode, cur);
    }
  }
  return out;
}

/** Every entry that touches an account, oldest first, with a running balance. */
export function accountLedger(entries, code, opts = {}) {
  const rows = [];
  let running = 0;
  const sorted = postedEntries(entries, opts).slice().sort((a, b) => (a.date === b.date ? (a.createdAt || '').localeCompare(b.createdAt || '') : a.date.localeCompare(b.date)));
  for (const e of sorted) {
    for (const l of e.lines) {
      if (l.accountCode !== code) continue;
      const amt = (l.debit || 0) - (l.credit || 0);
      running += amt;
      rows.push({
        date: e.date,
        entryId: e.id,
        number: e.number || '',
        ref: e.ref || '',
        memo: l.description || e.memo || '',
        source: e.source?.type || 'journal',
        debit: l.debit || 0,
        credit: l.credit || 0,
        amount: amt,
        balance: running,
      });
    }
  }
  return rows;
}

export function lastReconciled(db, companyId) {
  const meta = db.meta.reconciled || {};
  return meta[companyId] || null;
}

export function newEntryId() {
  return uid('ent');
}
