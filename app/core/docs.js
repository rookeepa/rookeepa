/**
 * Rookeepa — documents: quotes, invoices, credit notes, bills, payments.
 *
 * A document is the human-facing record (what the customer sees, what you
 * email, what you print). Posting a document writes its journal entry and the
 * two are then linked both ways. Balances are always derived from payments and
 * allocations, never stored on the invoice, so they can never drift.
 */

import {
  sum, mulRate, mulQty, gstOf, splitInclusive, formatCents,
} from './money.js';
import { addDays, todayISO, daysBetween, endOfMonth } from './dates.js';
import { accountByRole, requireRole, termsDays } from './coa.js';
import { dr, cr, postEntry, nextNumber, audit, voidEntry } from './ledger.js';
import { uid as newId } from './db.js';

export const DOC_TYPES = {
  quote: { label: 'Quote', ledger: 'sales', posts: false, prefix: 'quote' },
  invoice: { label: 'Invoice', ledger: 'sales', posts: true, prefix: 'invoice' },
  'credit-note-sale': { label: 'Credit note', ledger: 'sales', posts: true, prefix: 'credit-note-sale' },
  bill: { label: 'Bill', ledger: 'purchases', posts: true, prefix: 'bill' },
  'credit-note-purchase': { label: 'Supplier credit', ledger: 'purchases', posts: true, prefix: 'credit-note-purchase' },
};

export function docTypeMeta(type) {
  return DOC_TYPES[type] || DOC_TYPES.invoice;
}

export function isSales(type) {
  return docTypeMeta(type).ledger === 'sales';
}

export function blankLine(overrides = {}) {
  return {
    id: overrides.id || newId('dl'),
    itemId: overrides.itemId || null,
    description: overrides.description || '',
    accountCode: overrides.accountCode || '',
    qty: overrides.qty === undefined ? 1000 : overrides.qty, // thousandths
    unitPrice: overrides.unitPrice === undefined ? 0 : overrides.unitPrice, // cents, ex-GST
    discountPct: overrides.discountPct || 0, // percent, 2dp
    taxCode: overrides.taxCode || 'GST',
    // Which job this line belongs to. Per line, like the ledger it posts to: one invoice can carry materials
    // for two jobs, and the posting keeps them apart.
    jobCode: overrides.jobCode || null,
  };
}

export function blankDocument(overrides = {}) {
  const type = overrides.type || 'invoice';
  const date = overrides.date || todayISO();
  return {
    id: overrides.id || newId('doc'),
    companyId: overrides.companyId || null,
    type,
    ledger: docTypeMeta(type).ledger,
    contactId: overrides.contactId || null,
    number: overrides.number || '',
    date,
    dueDate: overrides.dueDate || date,
    terms: overrides.terms || 'net14',
    reference: overrides.reference || '',
    poNumber: overrides.poNumber || '',
    memo: overrides.memo || '',
    lines: overrides.lines || [blankLine()],
    priceIncludesTax: overrides.priceIncludesTax === true,
    freightCents: overrides.freightCents || 0,
    status: overrides.status || 'draft', // draft | open | void
    journalId: overrides.journalId || null,
    journalNumber: overrides.journalNumber || null,
    notes: overrides.notes || '',
    sentAt: overrides.sentAt || null,
  };
}

/* ------------------------------------------------------------------ arithmetic */

export function computeLine(input, taxCodes = []) {
  const tc = taxCodes.find((t) => t.code === input.taxCode) || { code: input.taxCode || 'N-T', gstBps: 0 };
  const qty = Math.round(input.qty === undefined ? 1000 : input.qty);
  const unitPrice = Math.round(input.unitPrice || 0);
  const discountBps = Math.round((input.discountPct || 0) * 100);

  let amount = mulQty(qty, unitPrice);
  const discount = mulRate(amount, discountBps);
  amount -= discount;

  // A business that is not registered for GST charges none, so the whole amount is net —
  // whether the price was entered net or gross. The answer travels on the document (stamped
  // from the company that raised it), which is what keeps the on-screen total, the posted
  // journal and every report reading the same number.
  const registered = input.gstRegistered !== false;
  let ex;
  let gst;
  if (!registered) {
    ex = amount;
    gst = 0;
  } else if (input.priceIncludesTax) {
    const parts = splitInclusive(amount, tc);
    ex = parts.ex;
    gst = parts.gst;
  } else {
    ex = amount;
    gst = gstOf(ex, tc);
  }
  return {
    qty,
    unitPrice,
    discountPct: input.discountPct || 0,
    discount,
    ex,
    gst,
    total: ex + gst,
    taxCode: tc.code,
    gstBps: tc.gstBps,
  };
}

/** Totals for a document: subtotal (ex-GST), GST, total, and balances. */
export function computeDocument(doc, taxCodes = []) {
  const rows = (doc.lines || []).map((l) => ({ ...l, ...computeLine({ ...l, priceIncludesTax: doc.priceIncludesTax, gstRegistered: doc.gstRegistered }, taxCodes) }));
  const subtotal = sum(rows.map((r) => r.ex));
  const tax = sum(rows.map((r) => r.gst));
  const freight = doc.freightCents || 0;
  const total = subtotal + tax + freight;
  const taxBreakdown = new Map();
  for (const r of rows) {
    const cur = taxBreakdown.get(r.taxCode) || { ex: 0, gst: 0 };
    cur.ex += r.ex;
    cur.gst += r.gst;
    taxBreakdown.set(r.taxCode, cur);
  }
  return { rows, subtotal, tax, freight, total, taxBreakdown };
}

/**
 * Allocations grouped by the document they settle, built in one pass.
 *
 * allocatedTo() searches every payment, and documentSummary() asks it twice per document (once
 * for itself, once through documentStatus). Reports that walk the invoice list therefore compared
 * every invoice with every receipt: the dashboard took 25 ms at 1,000 documents and 2.16 seconds
 * at 10,000, and it keeps climbing. Building this index once and passing it in turns that back
 * into a single pass. A one-off call can still pass nothing and get the plain scan.
 *
 * Voided receipts are left out here for the same reason allocatedTo skips them.
 */
export function paymentsByDocument(payments = []) {
  const index = new Map();
  for (const payment of payments || []) {
    if (payment.status === 'void') continue;
    for (const a of payment.allocations || []) {
      if (!a.docId) continue;
      let rows = index.get(a.docId);
      if (!rows) { rows = []; index.set(a.docId, rows); }
      rows.push({ date: payment.date || null, amount: a.amount || 0 });
    }
  }
  return index;
}

export function allocatedTo(payments, docId, asOf = null, index = null) {
  if (index) {
    let indexed = 0;
    for (const row of index.get(docId) || []) {
      // As at a past date, money received later had not arrived yet.
      if (asOf && row.date && row.date > asOf) continue;
      indexed += row.amount;
    }
    return indexed;
  }
  let paid = 0;
  for (const p of payments) {
    // A reversed (void) receipt no longer pays for anything. Counting its
    // allocations left an invoice reading "Paid" while the ledger and the ageing
    // both said the money was still owed.
    if (p.status === 'void') continue;
    // As at a past date, money received later had not arrived yet. Counting it made
    // "as at 31 July" ignore an August receipt on one side of the report but not the
    // other, so the ageing stopped tying to the control account.
    if (asOf && p.date && p.date > asOf) continue;
    for (const a of p.allocations || []) {
      if (a.docId === docId) paid += a.amount || 0;
    }
  }
  return paid;
}

/**
 * Status derived from money, not from a flag: draft -> open -> partly paid ->
 * paid, with overdue computed from the due date.
 */
export function documentStatus(doc, payments, asOf = todayISO(), taxCodes = [], index = null) {
  if (doc.status === 'void') return 'void';
  if (doc.status === 'draft') return 'draft';
  // A quote is not money owed — it is a price that may never become one. Judged by balance and
  // due date, an accepted quote read as overdue the moment it was accepted.
  if (!docTypeMeta(doc.type).posts) return 'open';
  const totals = computeDocument(doc, taxCodes);
  const paid = allocatedTo(payments, doc.id, asOf, index);
  const balance = totals.total - paid;
  if (balance <= 0 && totals.total !== 0) return 'paid';
  // Overdue is decided before "partly paid": an invoice that is half paid and past
  // its due date is overdue first. Testing the payment first meant every part-paid
  // overdue invoice disappeared from the overdue totals, counts and attention lists.
  if (balance > 0 && doc.dueDate && doc.dueDate < asOf) return 'overdue';
  if (paid > 0) return 'partly-paid';
  return 'open';
}

export function documentSummary(doc, taxCodes, payments, asOf = todayISO(), index = null) {
  const totals = computeDocument(doc, taxCodes);
  const paid = doc.status === 'draft' ? 0 : allocatedTo(payments, doc.id, asOf, index);
  const balance = totals.total - paid;
  const status = documentStatus(doc, payments, asOf, taxCodes, index);
  const overdueDays = status === 'overdue' ? daysBetween(doc.dueDate, asOf) : 0;
  return { ...totals, paid, balance, status, overdueDays };
}

/* ------------------------------------------------------------------- posting */

/**
 * Build the journal entry for a document. Pure: no database writes, so the same
 * function powers the "what will this post?" preview and the real posting.
 */
export function buildDocumentEntry(doc, ctx) {
  const { accounts, taxCodes, company, items } = ctx;
  const meta = docTypeMeta(doc.type);
  if (!meta.posts) throw new Error(`${meta.label}s are not posted to the ledger.`);
  const totals = computeDocument(doc, taxCodes);
  const sales = meta.ledger === 'sales';
  const control = requireRole(accounts, sales ? 'ar' : 'ap');
  const taxAccountRole = sales ? 'gstCollected' : 'gstPaid';
  const gstAccount = totals.tax !== 0 ? accountByRole(accounts, taxAccountRole) : null;
  if (totals.tax !== 0 && !gstAccount) {
    const err = new Error(`This document has GST, but the company file has no "${taxAccountRole}" account. Add one under Accounts.`);
    err.code = 'MISSING_ROLE';
    throw err;
  }

  const lines = [];
  const contactName = ctx.contactName || '';
  const common = { contactId: doc.contactId, sourceDocId: doc.id, sourceDocType: doc.type };

  // Group the document lines by account **and job**, so the ledger shows tidy per-account postings and an
  // invoice that carries two jobs keeps them apart. Grouping by account alone merged them and quietly dropped
  // the allocation the person had made.
  const byAccount = new Map();
  for (const r of totals.rows) {
    const code = r.accountCode || (sales ? company.defaultSalesAccount : company.defaultPurchaseAccount);
    const key = `${code}\u00a7${r.jobCode || ''}`;
    const cur = byAccount.get(key) || { code, jobCode: r.jobCode || null, ex: 0 };
    cur.ex += r.ex;
    byAccount.set(key, cur);
  }

  const isCredit = doc.type.startsWith('credit-note');
  const reverse = isCredit; // credit notes mirror the invoice/bill

  for (const v of byAccount.values()) {
    const code = v.code;
    if (v.ex === 0) continue;
    const extra = {
      ...common,
      description: `${meta.label} ${doc.number || ''}`.trim(),
      // By account AND job: two lines can share an account while belonging to different jobs with different
      // tax codes, and taking the first line's code labelled the second job's journal line wrongly.
      taxCode: doc.lines.find((l) => l.accountCode === code && (l.jobCode || null) === (v.jobCode || null))?.taxCode
        || doc.lines.find((l) => l.accountCode === code)?.taxCode || null,
      jobCode: v.jobCode,
    };
    if (sales) {
      // Sales: Cr income, unless it is a credit note, which reverses it
      if (reverse) lines.push(dr(code, v.ex, extra)); else lines.push(cr(code, v.ex, extra));
    } else if (reverse) {
      lines.push(cr(code, v.ex, extra));
    } else {
      lines.push(dr(code, v.ex, extra));
    }
  }

  // GST is posted per tax code so the Activity Statement can report G10 vs G11
  // and 1A vs 1B exactly, instead of guessing from a single lump.
  const taxGroups = new Map();
  for (const r of totals.rows) {
    if (!r.gst) continue;
    const cur = taxGroups.get(r.taxCode) || 0;
    taxGroups.set(r.taxCode, cur + r.gst);
  }
  if (taxGroups.size) {
    for (const [taxCode, gst] of taxGroups) {
      const amount = reverse ? -gst : gst;
      const extra = { ...common, description: `${meta.label} ${doc.number || ''} — ${taxCode}`, taxCode };
      if (sales) {
        if (reverse) lines.push(dr(gstAccount.code, -amount, extra)); else lines.push(cr(gstAccount.code, amount, extra));
      } else if (reverse) {
        lines.push(cr(gstAccount.code, -amount, extra));
      } else {
        lines.push(dr(gstAccount.code, amount, extra));
      }
    }
  }

  const controlExtra = { ...common, description: `${contactName || (sales ? 'Customer' : 'Supplier')} — ${doc.number || ''}`.trim() };
  if (totals.total !== 0) {
    if (sales) {
      if (reverse) lines.push(cr(control.code, totals.total, controlExtra)); else lines.push(dr(control.code, totals.total, controlExtra));
    } else if (reverse) {
      lines.push(dr(control.code, totals.total, controlExtra));
    } else {
      lines.push(cr(control.code, totals.total, controlExtra));
    }
  }

  // Per-code summary carried on the entry: the activity statement reads this
  // instead of re-deriving GST from the double entry. Credit notes are negative
  // so they reduce the boxes they came from.
  const taxSummary = [];
  const summaryByCode = new Map();
  for (const r of totals.rows) {
    const cur = summaryByCode.get(r.taxCode) || { taxCode: r.taxCode, side: sales ? 'sales' : 'purchases', net: 0, gst: 0 };
    cur.net += r.ex;
    cur.gst += r.gst;
    summaryByCode.set(r.taxCode, cur);
  }
  for (const v of summaryByCode.values()) {
    const sign = reverse ? -1 : 1;
    if (v.net === 0 && v.gst === 0) continue;
    taxSummary.push({ taxCode: v.taxCode, side: v.side, net: v.net * sign, gst: v.gst * sign });
  }

  // Perpetual inventory: moving stock out on a sale moves its cost to COGS. A credit note
  // (or a void) puts the stock back, so the same two lines post the other way round —
  // without this, a credited sale left the stock gone and the cost in the accounts.
  if (sales && company.perpetualInventory && items?.length) {
    const cogs = accountByRole(accounts, 'cogs') || accounts.find((a) => a.code === '5-0000');
    const inv = accountByRole(accounts, 'inventory');
    if (cogs && inv) {
      let cost = 0;
      for (const r of totals.rows) {
        const item = r.itemId ? items.find((i) => i.id === r.itemId) : null;
        if (item && item.costCents) cost += mulQty(r.qty, item.costCents);
      }
      if (cost !== 0) {
        const ref = doc.number || '';
        if (reverse) {
          lines.push(dr(inv.code, cost, { ...common, description: `Inventory restored — ${ref}`.trim() }));
          lines.push(cr(cogs.code, cost, { ...common, description: `Cost of sales reversed — ${ref}`.trim() }));
        } else {
          lines.push(dr(cogs.code, cost, { ...common, description: `Cost of goods sold — ${ref}`.trim() }));
          lines.push(cr(inv.code, cost, { ...common, description: `Inventory relief — ${ref}`.trim() }));
        }
      }
    }
  }

  return {
    companyId: doc.companyId,
    date: doc.date,
    ref: doc.number || '',
    memo: doc.memo || `${meta.label} ${doc.number || ''} — ${contactName}`.trim(),
    lines,
    taxSummary,
    source: { type: doc.type, id: doc.id },
  };
}

/** Everything that building a document's journal needs, gathered in one place. */
export function documentEntryContext(db, doc) {
  return {
    company: db.get('companies', doc.companyId),
    accounts: db.of('accounts', doc.companyId),
    taxCodes: db.of('taxCodes', doc.companyId),
    items: db.of('items', doc.companyId),
    contactName: doc.contactId ? (db.get('contacts', doc.contactId)?.name || '') : '',
  };
}

/** Post (or re-post) the journal for a document and stamp the link on it. */
export function postDocument(db, doc, opts = {}) {
  return postEntry(db, buildDocumentEntry(doc, documentEntryContext(db, doc)));
}

/**
 * Whether GST applies to a document. A draft follows the company's registration as it
 * stands now; a document that has already been posted keeps the treatment it was posted
 * with, so registering — or deregistering — later does not silently rewrite history.
 */
export function gstAppliesTo(company, doc = {}) {
  if (doc.status === 'open' || doc.status === 'void') return doc.gstRegistered !== false;
  return company?.gstRegistered !== false;
}

/**
 * Everything that makes a document acceptable, checked before anything is written.
 * Callers depend on this running first: an edit that is going to be refused must leave the
 * company file exactly as it was, not half-changed.
 */
export function validateDocument(doc, { taxCodes = [] } = {}) {
  if (!doc.companyId) throw new Error('A document needs a company.');
  if (doc.status === 'open' && !doc.contactId) {
    throw new Error(`Choose a ${isSales(doc.type) ? 'customer' : 'supplier'} before authorising.`);
  }
  const lines = doc.lines || [];
  for (const [i, line] of lines.entries()) {
    const n = i + 1;
    const pct = Number(line.discountPct ?? 0);
    if (!Number.isFinite(pct)) throw new Error(`Line ${n}: the discount is not a number.`);
    if (pct < 0) throw new Error(`Line ${n}: a discount cannot be negative.`);
    if (pct > 100) {
      const err = new Error(`Line ${n}: a discount cannot be more than 100% (this one is ${pct}%).`);
      err.code = 'DISCOUNT_RANGE';
      throw err;
    }
    const qty = Number(line.qty ?? 1000);
    if (!Number.isFinite(qty) || qty < 0) throw new Error(`Line ${n}: the quantity cannot be negative.`);
    if (!Number.isFinite(Number(line.unitPrice ?? 0))) throw new Error(`Line ${n}: the price is not a number.`);
    if (line.taxCode && taxCodes.length && !taxCodes.some((t) => t.code === line.taxCode)) {
      throw new Error(`Line ${n}: ${line.taxCode} is not a tax code in this company file.`);
    }
  }
  const freight = Number(doc.freightCents ?? 0);
  if (!Number.isFinite(freight) || freight < 0) throw new Error('Freight cannot be negative.');
  return true;
}

/** Authorise a draft document: assign its number, post the entry, mark it open. */
export function authoriseDocument(db, docOrId, opts = {}) {
  const doc = typeof docOrId === 'string' ? db.get('documents', docOrId) : docOrId;
  if (!doc) throw new Error('Document not found.');
  if (doc.status === 'void') throw new Error('This document has been voided.');
  if (doc.status === 'open' && !opts.force) return doc;

  const company = db.get('companies', doc.companyId);
  const taxCodes = db.of('taxCodes', doc.companyId);
  const candidate = { ...doc, gstRegistered: gstAppliesTo(company, doc) };
  validateDocument(candidate, { taxCodes });
  const totals = computeDocument(candidate, taxCodes);
  if (totals.total === 0) throw new Error('Nothing to post — add at least one line with an amount.');
  if (!candidate.contactId) throw new Error(`Choose a ${isSales(candidate.type) ? 'customer' : 'supplier'} before authorising.`);

  const number = candidate.number || nextNumber(db, candidate.companyId, candidate.type);
  const withNumber = { ...candidate, number };

  if (!docTypeMeta(candidate.type).posts) {
    // A quote is a price, not a transaction. Asking the ledger for an entry threw — "Quotes are
    // not posted to the ledger" — which left an accepted quote stuck as a draft for ever: the
    // button named after the action that would clear it could never succeed, and the sidebar
    // went on counting it as work outstanding. Finalising it records the decision without
    // touching the books.
    const saved = db.put('documents', { ...withNumber, status: 'open', journalId: null, journalNumber: null });
    audit(db, {
      companyId: doc.companyId,
      action: 'authorise',
      entity: 'document',
      entityId: saved.id,
      detail: `Accepted ${docTypeMeta(candidate.type).label} ${number}`,
    });
    return saved;
  }

  const entry = postDocument(db, withNumber);
  const saved = db.put('documents', {
    ...withNumber,
    status: 'open',
    journalId: entry.id,
    journalNumber: entry.number,
  });
  audit(db, {
    companyId: doc.companyId,
    action: 'authorise',
    entity: 'document',
    entityId: saved.id,
    detail: `Authorised ${docTypeMeta(doc.type).label} ${number} (${formatCents(totals.total, { code: 'AUD' })})`,
  });
  return saved;
}

/** Edit a posted document and re-post it — only while nothing is allocated. */
export function saveDocument(db, doc, opts = {}) {
  const company = db.get('companies', doc.companyId);
  const taxCodes = db.of('taxCodes', doc.companyId);
  const existing = doc.id ? db.get('documents', doc.id) : null;
  const payments = db.of('payments', doc.companyId);

  if (existing && existing.status === 'open') {
    const paid = allocatedTo(payments, existing.id);
    if (paid > 0 && opts.allowPosted !== true) {
      const err = new Error('This document has payments applied. Void it and raise a new one instead of editing it.');
      err.code = 'HAS_PAYMENTS';
      throw err;
    }
  }

  const candidate = {
    ...doc,
    companyId: doc.companyId,
    gstRegistered: gstAppliesTo(company, existing || doc),
  };
  validateDocument(candidate, { taxCodes });

  // Post before saving. Posting validates the entry and refuses before it writes anything,
  // so an edit that is going to be rejected leaves the document and the ledger exactly as
  // they were — the old order saved the document first and only then found the posting
  // invalid, which is how a refused edit ended up changing a posted document.
  const entry = candidate.status === 'open'
    ? postEntry(db, buildDocumentEntry(candidate, documentEntryContext(db, candidate)))
    : null;
  const saved = entry
    ? db.put('documents', { ...candidate, journalId: entry.id, journalNumber: entry.number })
    : db.put('documents', candidate);
  return saved;
}

export function voidDocument(db, docOrId, reason = '') {
  const doc = typeof docOrId === 'string' ? db.get('documents', docOrId) : docOrId;
  if (!doc) throw new Error('Document not found.');
  const docId = doc.id;
  const payments = db.of('payments', doc.companyId);
  const paid = allocatedTo(payments, docId);
  if (paid > 0) {
    const err = new Error('Payments are applied to this document. Reverse those payments first, then void it.');
    err.code = 'HAS_PAYMENTS';
    throw err;
  }
  if (doc.journalId) {
    const entry = db.get('entries', doc.journalId);
    if (entry && entry.status === 'posted') voidEntry(db, entry.id, reason || `Voided ${doc.number}`, { notify: false });
  }
  const saved = db.put('documents', { ...doc, status: 'void', voidReason: reason || 'Voided' });
  audit(db, {
    companyId: doc.companyId, action: 'void', entity: 'document', entityId: docId,
    detail: `Voided ${docTypeMeta(doc.type).label} ${doc.number || doc.id}: ${reason || 'no reason given'}`,
  });
  return saved;
}

export function deleteDraft(db, docId) {
  const doc = db.get('documents', docId);
  if (!doc) return false;
  if (doc.status !== 'draft') throw new Error('Only drafts can be deleted. Void an authorised document instead.');
  db.remove('documents', docId);
  audit(db, { companyId: doc.companyId, action: 'delete', entity: 'document', entityId: docId, detail: `Deleted draft ${doc.number || doc.id}` });
  return true;
}

/* ------------------------------------------------------------------ payments */

export function blankPayment(overrides = {}) {
  return {
    id: overrides.id || newId('pay'),
    companyId: overrides.companyId || null,
    type: overrides.type || 'customer', // customer | supplier
    contactId: overrides.contactId || null,
    date: overrides.date || todayISO(),
    amount: overrides.amount || 0,
    accountCode: overrides.accountCode || '',
    method: overrides.method || 'Bank transfer',
    reference: overrides.reference || '',
    number: overrides.number || '',
    memo: overrides.memo || '',
    allocations: overrides.allocations || [],
    journalId: overrides.journalId || null,
    status: overrides.status || 'posted',
  };
}

export function buildPaymentEntry(payment, ctx) {
  const { accounts, company, contactName } = ctx;
  const bank = accounts.find((a) => a.code === payment.accountCode);
  if (!bank) throw new Error('Choose the bank account the money moved through.');
  const receivable = payment.type === 'customer';
  const control = requireRole(accounts, receivable ? 'ar' : 'ap');

  // Allocations are signed: a negative allocation reverses part of a document rather than
  // paying it, and a negative amount is money going the other way (a refund). Taking the
  // absolute value here — as this used to — booked a refund as money received.
  const total = sum((payment.allocations || []).map((a) => a.amount || 0));
  const amount = payment.amount ? payment.amount : total;
  if (amount === 0) throw new Error('A payment needs an amount.');
  if (total !== 0 && Math.sign(total) !== Math.sign(amount)) {
    throw new Error('The amount applied has the opposite sign to the payment. Record a refund as a negative amount applied to a negative receipt.');
  }
  if (Math.abs(total) > Math.abs(amount)) {
    throw new Error('The amount applied to invoices is more than the payment received.');
  }

  const common = { contactId: payment.contactId, sourceDocId: payment.id, sourceDocType: 'payment' };
  const lines = [];
  const applied = Math.abs(total);
  const unapplied = Math.abs(amount) - applied;
  const outgoing = amount < 0;
  const label = `${receivable ? 'Receipt' : 'Payment'} ${payment.number || ''} — ${contactName || ''}`.trim();

  // `put(true, …)` is a debit in the ordinary direction; a negative payment flips every
  // line, which is what makes a refund the exact mirror of the receipt it reverses.
  const put = (debit, code, cents, extra) => {
    if (!cents) return;
    const useDebit = outgoing ? !debit : debit;
    lines.push(useDebit ? dr(code, cents, extra) : cr(code, cents, extra));
  };

  if (receivable) {
    put(true, bank.code, Math.abs(amount), { ...common, description: label });
    put(false, control.code, applied, { ...common, description: `Applied to invoices — ${contactName || ''}`.trim() });
    put(false, control.code, unapplied, { ...common, description: 'Unapplied credit (on account)' });
  } else {
    put(true, control.code, applied, { ...common, description: `Applied to bills — ${contactName || ''}`.trim() });
    put(true, control.code, unapplied, { ...common, description: 'Unapplied prepayment' });
    put(false, bank.code, Math.abs(amount), { ...common, description: label });
  }

  return {
    companyId: payment.companyId,
    date: payment.date,
    ref: payment.number || '',
    memo: payment.memo || label,
    lines,
    source: { type: receivable ? 'customer-payment' : 'supplier-payment', id: payment.id },
  };
}

/**
 * Check a payment against the documents it is applied to, before anything is written.
 *
 * Signed allocations mean the same rules cover a receipt, a refund and a reversal: a
 * positive allocation may take a document to zero but not past it, and a negative one may
 * give back what was actually applied but no more.
 */
export function validateAllocations(db, payment, { accounts, taxCodes } = {}) {
  const docs = db.of('documents', payment.companyId);
  const payments = db.of('payments', payment.companyId);
  const customer = payment.type === 'customer';
  const perDoc = new Map();
  const signs = new Set();
  for (const a of payment.allocations || []) {
    const amount = a.amount || 0;
    if (!a.docId) throw new Error('An allocation is missing the document it applies to.');
    if (!Number.isFinite(amount) || amount === 0) throw new Error('An allocation needs an amount.');
    signs.add(Math.sign(amount));
    perDoc.set(a.docId, (perDoc.get(a.docId) || 0) + amount);
  }
  // One direction per payment: applying +$60 and -$40 on the same receipt is ambiguous
  // (paying one invoice while unpaying another), and it hides arithmetic errors.
  if (signs.size > 1) {
    throw new Error('Apply a payment in one direction. This one mixes positive and negative allocations — record the reversal as its own payment.');
  }

  for (const [docId, amount] of perDoc) {
    const doc = docs.find((d) => d.id === docId);
    if (!doc) throw new Error('An allocation points at a document that no longer exists.');
    const name = doc.number || doc.id;
    if (doc.status === 'void') throw new Error(`${name} has been voided, so it cannot take a payment.`);
    if (doc.status !== 'open') throw new Error(`${name} has not been authorised yet, so it cannot take a payment.`);
    if (doc.contactId !== payment.contactId) throw new Error(`${name} belongs to a different contact.`);
    if (customer && doc.type !== 'invoice') {
      throw new Error(`${name} is a ${docTypeMeta(doc.type).label.toLowerCase()}; a receipt can only be applied to an invoice.`);
    }
    if (!customer && doc.type !== 'bill') {
      throw new Error(`${name} is a ${docTypeMeta(doc.type).label.toLowerCase()}; a payment can only be applied to a bill.`);
    }

    // What the document still owes, ignoring this payment's own earlier allocations so
    // that editing a payment does not double-count it.
    const totals = computeDocument(doc, taxCodes || db.of('taxCodes', payment.companyId));
    const already = allocatedTo(payments.filter((p) => p.id !== payment.id), docId);
    const outstanding = totals.total - already;
    if (amount > 0 && amount > outstanding) {
      const err = new Error(`${name} has ${formatCents(outstanding, { code: 'AUD' })} outstanding, so ${formatCents(amount, { code: 'AUD' })} cannot be applied to it.`);
      err.code = 'OVER_ALLOCATED';
      throw err;
    }
    if (amount < 0 && -amount > already) {
      const err = new Error(`${name} has only ${formatCents(already, { code: 'AUD' })} applied to it, so ${formatCents(-amount, { code: 'AUD' })} cannot be given back.`);
      err.code = 'OVER_ALLOCATED';
      throw err;
    }
  }
  return true;
}

export function savePayment(db, payment) {
  const company = db.get('companies', payment.companyId);
  const accounts = db.of('accounts', payment.companyId);
  const taxCodes = db.of('taxCodes', payment.companyId);
  const contact = payment.contactId ? db.get('contacts', payment.contactId) : null;
  const number = payment.number || nextNumber(db, payment.companyId, payment.type === 'customer' ? 'customer-payment' : 'supplier-payment');
  const candidate = { ...blankPayment(payment), ...payment, number };

  // Same order as documents: check the allocations, then post (posting validates the entry
  // and refuses before it writes), and only then record the payment. A refused payment
  // must not leave either the receipt or the ledger behind.
  validateAllocations(db, candidate, { accounts, taxCodes });
  const entry = postEntry(db, buildPaymentEntry(candidate, { accounts, company, contactName: contact?.name || '' }));
  const saved = db.put('payments', { ...candidate, journalId: entry.id, status: 'posted' });
  audit(db, {
    companyId: payment.companyId, action: 'payment', entity: 'payment', entityId: saved.id,
    detail: `${payment.type === 'customer' ? 'Received' : 'Paid'} ${formatCents(candidate.amount, { code: company?.currency || 'AUD' })} ${contact ? `— ${contact.name}` : ''}`,
  });
  return saved;
}

export function voidPayment(db, paymentId, reason = '') {
  const payment = db.get('payments', paymentId);
  if (!payment) throw new Error('Payment not found.');
  if (payment.journalId) {
    const entry = db.get('entries', payment.journalId);
    if (entry && entry.status === 'posted') voidEntry(db, entry.id, reason || 'Payment reversed', { notify: false });
  }
  const saved = db.put('payments', { ...payment, status: 'void', voidReason: reason || 'Reversed' });
  audit(db, { companyId: payment.companyId, action: 'void', entity: 'payment', entityId: paymentId, detail: `Reversed payment ${payment.number || payment.id}` });
  return saved;
}

/** Auto-allocate a receipt/payment across a contact's open documents, oldest first. */
export function autoAllocate(db, { companyId, contactId, type, amount, asOf = todayISO() }) {
  const taxCodes = db.of('taxCodes', companyId);
  const payments = db.of('payments', companyId);
  const wanted = type === 'customer' ? ['invoice'] : ['bill'];
  const docs = db.of('documents', companyId)
    .filter((d) => d.contactId === contactId && wanted.includes(d.type) && d.status === 'open')
    .sort((a, b) => (a.dueDate || a.date).localeCompare(b.dueDate || b.date));
  const allocations = [];
  let left = amount;
  for (const d of docs) {
    if (left <= 0) break;
    const s = documentSummary(d, taxCodes, payments, asOf);
    const take = Math.min(left, s.balance);
    if (take <= 0) continue;
    allocations.push({ docId: d.id, amount: take, docNumber: d.number, docType: d.type });
    left -= take;
  }
  return allocations;
}

/* -------------------------------------------------------------- bank transactions */

export function blankBankTxn(overrides = {}) {
  return {
    id: overrides.id || newId('btx'),
    companyId: overrides.companyId || null,
    accountCode: overrides.accountCode || '',
    date: overrides.date || todayISO(),
    description: overrides.description || '',
    reference: overrides.reference || '',
    amount: overrides.amount || 0, // signed from the bank's point of view
    balance: overrides.balance === undefined ? null : overrides.balance,
    type: overrides.type || 'unknown', // spend | receive | transfer | payment | unknown
    status: overrides.status || 'unreconciled', // unreconciled | reconciled | excluded | posted
    categoryAccount: overrides.categoryAccount || '',
    taxCode: overrides.taxCode || 'GST',
    // A line may be coded to several accounts at once — a loan repayment is part principal, part
    // interest. Each entry is `{ accountCode, taxCode, amount, note }`, where the amount is the gross
    // (GST-inclusive) share of the bank line, because that is what a person reads off a statement.
    // An empty list means the line is coded to `categoryAccount` alone, which is the ordinary case.
    splits: Array.isArray(overrides.splits) ? overrides.splits.map((s) => ({ ...s })) : [],
    contactId: overrides.contactId || null,
    docId: overrides.docId || null,
    importedFrom: overrides.importedFrom || '',
    importedBatch: overrides.importedBatch || null,
    journalId: overrides.journalId || null,
    matchedEntryId: overrides.matchedEntryId || null,
  };
}

/**
 * Categorise a bank line by hand: it becomes a Spend money / Receive money entry.
 *
 * One account, or several. A loan repayment is the case that made several necessary: $1,000 leaves the
 * bank, of which $800 pays down the principal and $200 is interest — one line on the bank side, two on
 * the other, in a single entry. A single account is simply a list of one, so the two cases cannot drift
 * apart, and a business that never splits anything gets exactly the entry it always got.
 *
 * Split amounts are what left the bank, GST included, because that is what is on the statement. The GST
 * is worked out per split, so a split that is GST-free stays GST-free. The splits must add up to the
 * bank amount exactly: an entry that does not balance is refused with the difference named, rather than
 * posted and left to be found during a reconciliation months later.
 */
export function categoriseBankTxn(db, txn, opts = {}) {
  const company = db.get('companies', txn.companyId);
  const accounts = db.of('accounts', txn.companyId);
  const taxCodes = db.of('taxCodes', txn.companyId);
  const bank = accounts.find((a) => a.code === (txn.accountCode || opts.bankCode));
  if (!bank) throw new Error('This bank transaction has no bank account.');

  const gross = txn.amount || 0;
  const incoming = gross > 0;
  const abs = Math.abs(gross);
  const money = (cents) => formatCents(cents, { code: company?.currency || 'AUD' });

  const named = (Array.isArray(txn.splits) ? txn.splits : []).filter((s) => s && (s.accountCode || s.amount));
  const splits = named.length
    ? named
    : [{ accountCode: txn.categoryAccount, taxCode: txn.taxCode || '', amount: abs, note: '', jobCode: txn.jobCode || null }];
  if (!splits[0] || !splits[0].accountCode) throw new Error('Choose the account this transaction belongs to.');

  const legs = splits.map((s, index) => {
    const account = accounts.find((a) => a.code === s.accountCode);
    if (!account) throw new Error(`Account ${s.accountCode || '(none)'} does not exist.`);
    if (account.code === bank.code) throw new Error('Choose an account other than the bank account itself.');
    const amount = Math.abs(Number(s.amount) || 0);
    if (!amount) throw new Error(`Split ${index + 1} has no amount.`);
    return {
      account,
      amount,
      note: String(s.note || ''),
      taxCode: s.taxCode || account.gstDefault || 'GST',
      // Which job this leg of the money belongs to. It travels with the split, not the whole line, because
      // one bank payment can cover two jobs.
      jobCode: s.jobCode || null,
    };
  });

  const total = legs.reduce((sum, l) => sum + l.amount, 0);
  if (total !== abs) {
    const difference = abs - total;
    throw new Error(total === 0
      ? `The splits add up to nothing, and this line is ${money(abs)}. Give the splits amounts.`
      : `The splits add up to ${money(total)}, which is ${money(Math.abs(difference))} ${difference > 0 ? 'short of' : 'over'} the ${money(abs)} on this line. Adjust them so they match the bank.`);
  }

  const desc = txn.description || `${incoming ? 'Receipt' : 'Payment'} ${txn.reference || ''}`.trim();
  const common = { contactId: txn.contactId, sourceDocId: txn.id, sourceDocType: 'bank' };
  // Every leg's GST is worked out before anything is written, so a missing GST account is reported
  // before a half-formed entry exists.
  const gstRole = incoming ? 'gstCollected' : 'gstPaid';
  const taxable = legs.map((l) => {
    const tc = taxCodes.find((t) => t.code === l.taxCode) || { code: 'N-T', gstBps: 0 };
    // A business that is not registered for GST has no GST in the amount, so the whole of it is net:
    // claiming a credit here would put GST in the accounts that never existed.
    const parts = company?.gstRegistered === false ? { ex: l.amount, gst: 0 } : splitInclusive(l.amount, tc);
    return { ...l, tc, net: parts.ex, gst: parts.gst };
  });
  const gstTotal = taxable.reduce((sum, l) => sum + l.gst, 0);
  const gstAccount = gstTotal && accountByRole(accounts, gstRole) ? accountByRole(accounts, gstRole) : null;
  if (gstTotal && !gstAccount) {
    const err = new Error(`This transaction has ${company?.taxLabel || 'GST'}, but no "${gstRole}" account exists. Add one under Accounts, or set the tax code to N-T.`);
    err.code = 'MISSING_ROLE';
    throw err;
  }

  const lines = [];
  if (incoming) lines.push(dr(bank.code, abs, { ...common, description: desc }));
  for (const l of taxable) {
    // The split's note becomes the line's description, so the reason a split exists is visible in the
    // ledger itself rather than only in the editor that created it.
    const leg = { ...common, description: l.note ? `${desc} — ${l.note}` : desc, taxCode: l.tc.code, jobCode: l.jobCode || null };
    if (l.net) {
      if (incoming) lines.push(cr(l.account.code, l.net, leg));
      else lines.push(dr(l.account.code, l.net, leg));
    }
    if (l.gst) {
      const gstLeg = { ...leg, description: `${leg.description} — ${l.tc.code}` };
      if (incoming) lines.push(cr(gstAccount.code, l.gst, gstLeg));
      else lines.push(dr(gstAccount.code, l.gst, gstLeg));
    }
  }
  if (!incoming) lines.push(cr(bank.code, abs, { ...common, description: desc }));

  const entry = postEntry(db, {
    companyId: txn.companyId,
    date: txn.date,
    ref: txn.reference || '',
    memo: desc,
    lines,
    // Every coded split, not only the ones carrying GST: the report treats a summary as authoritative, so
    // dropping the GST-free halves hides them from the activity statement while the ledger still shows them.
    taxSummary: taxable.map((l) => ({ taxCode: l.tc.code, side: incoming ? 'sales' : 'purchases', net: l.net, gst: l.gst })),
    source: { type: incoming ? 'receive-money' : 'spend-money', id: txn.id },
  });
  const saved = db.put('bankTxns', {
    // A line that came from a statement and has now been given an account and a tax code agrees with
    // the books by definition, so it is reconciled. Lines typed in by hand are not: they wait until a
    // statement confirms them.
    ...txn,
    status: txn.importedFrom ? 'reconciled' : 'posted',
    journalId: entry.id,
    type: incoming ? 'receive' : 'spend',
    // The first split is still recorded as the line's account, so everything that reads a single
    // category — the register, the bank rules, the tax summary — keeps working, with `splits` as the
    // detail. A line that was coded to one account keeps an empty list and is unchanged.
    categoryAccount: taxable[0].account.code,
    taxCode: taxable[0].tc.code,
    splits: named.length
      ? taxable.map((l) => ({ accountCode: l.account.code, taxCode: l.tc.code, amount: l.amount, note: l.note }))
      : [],
  });
  audit(db, {
    companyId: txn.companyId,
    action: 'categorise',
    entity: 'bankTxn',
    entityId: saved.id,
    detail: legs.length > 1
      ? `Categorised ${money(gross)} across ${legs.length} accounts: ${legs.map((l) => `${l.account.code} ${money(l.amount)}`).join(', ')}`
      : `Categorised ${money(gross)} to ${legs[0].account.code} ${legs[0].account.name}`,
  });
  return saved;
}

/** Match a bank line to a transaction that is already in the ledger (invoice paid, etc.). */
export function matchBankTxn(db, txnId, entryId) {
  const txn = db.get('bankTxns', txnId);
  if (!txn) throw new Error('Bank transaction not found.');
  const saved = db.put('bankTxns', { ...txn, status: 'reconciled', matchedEntryId: entryId });
  audit(db, { companyId: txn.companyId, action: 'match', entity: 'bankTxn', entityId: txnId, detail: `Matched to entry ${entryId}` });
  return saved;
}

export function bankTxnToPayment(db, txn, opts = {}) {
  const company = db.get('companies', txn.companyId);
  const allocations = autoAllocate(db, {
    companyId: txn.companyId,
    contactId: txn.contactId,
    type: txn.amount > 0 ? 'customer' : 'supplier',
    amount: Math.abs(txn.amount),
  });
  const payment = savePayment(db, blankPayment({
    companyId: txn.companyId,
    type: txn.amount > 0 ? 'customer' : 'supplier',
    contactId: txn.contactId,
    date: txn.date,
    amount: Math.abs(txn.amount),
    accountCode: txn.accountCode || company.bankAccount,
    reference: txn.reference,
    memo: txn.description,
    allocations,
  }));
  db.put('bankTxns', { ...txn, status: 'reconciled', journalId: payment.journalId, docId: allocations[0]?.docId || null, type: txn.amount > 0 ? 'payment' : 'spend' });
  return payment;
}

/**
 * Tick a line off against a statement because its own entry is what the bank shows.
 *
 * The mirror of unreconcileBankTxn, and the reason it exists: a line that has been coded — a Spend money or
 * Receive money entry, posted to an account — is still waiting to be ticked off against the statement it came
 * from, and until now nothing could do that. Matching is for a line that belongs to a record already in the
 * books; this is for one whose own entry *is* the record. Nothing is posted either way: the entry is already
 * there, and this only records that the bank agrees with it.
 */
export function reconcileBankTxn(db, txn) {
  const row = typeof txn === 'string' ? db.get('bankTxns', txn) : txn;
  if (!row) throw new Error('Bank transaction not found.');
  if (row.status === 'reconciled') return row;
  if (row.status === 'excluded') throw new Error('This line is excluded from reconciliation. Reinstate it first.');
  if (!row.journalId) {
    throw new Error('This line has no entry of its own — match it to something already in your books, or categorise it first.');
  }
  const saved = db.put('bankTxns', { ...row, status: 'reconciled' });
  audit(db, {
    companyId: row.companyId,
    action: 'reconcile',
    entity: 'bankTxn',
    entityId: row.id,
    detail: 'Ticked off against the statement — its own entry was already posted',
  });
  return saved;
}

/**
 * Undo a reconciliation, so a line can be edited and reconciled again.
 *
 * Reconciling never posted anything: matching ticks a line off against something already in the
 * books, and a payment match records a payment that was real money. So un-reconciling clears the tick
 * and leaves the books exactly as they were — including the payment, and including the line's own
 * entry if it has one. A line that posted its own entry goes back to `posted` (categorised, waiting to
 * be ticked off); one that only matched goes back to `unreconciled`, where the whole action set
 * returns.
 */
export function unreconcileBankTxn(db, txn) {
  const row = typeof txn === 'string' ? db.get('bankTxns', txn) : txn;
  if (!row) throw new Error('Bank transaction not found.');
  if (row.status !== 'reconciled') throw new Error('Only a reconciled line can be un-reconciled.');
  const saved = db.put('bankTxns', {
    ...row,
    status: row.journalId ? 'posted' : 'unreconciled',
    matchedEntryId: null,
    docId: null,
  });
  audit(db, {
    companyId: row.companyId,
    action: 'unreconcile',
    entity: 'bankTxn',
    entityId: row.id,
    detail: row.journalId
      ? 'Un-reconciled — its entry stays posted, the line is no longer ticked off'
      : 'Un-reconciled and back to review',
  });
  return saved;
}

/**
 * Undo the categorisation of a line, so its account or tax code can be changed.
 *
 * The entry is voided rather than deleted, the way every other reversal in the app works: the ledger
 * keeps the record that something was posted and then taken back, and the line returns to review
 * where categorising it again is allowed. Voiding is what makes that safe — a live entry is still
 * what the reports count, so a voided one cannot be counted twice.
 */
export function undoBankTxnCategorisation(db, txn) {
  const row = typeof txn === 'string' ? db.get('bankTxns', txn) : txn;
  if (!row) throw new Error('Bank transaction not found.');
  if (!row.journalId) throw new Error('This line has not been categorised, so there is nothing to undo.');
  if (row.status === 'reconciled') throw new Error('Un-reconcile this line before undoing its categorisation.');
  // A coded bank line can be a payment. Undoing it only voided the journal, so the payment stayed live and
  // the invoice stayed marked paid while its control account went back to zero. Void the payment and clear
  // its allocations, which is what "this did not happen" means to everything that reads them.
  const coded = db.get('entries', row.journalId);
  const source = coded && coded.source;
  if (source && (source.type === 'customer-payment' || source.type === 'supplier-payment') && source.id) {
    const payment = db.get('payments', source.id);
    if (payment && payment.status !== 'void') {
      db.put('payments', {
        ...payment,
        status: 'void',
        allocations: [],
        voidedAt: new Date().toISOString(),
        voidReason: 'Its bank line was un-categorised',
      }, { silent: true });
      audit(db, {
        companyId: row.companyId,
        action: 'void',
        entity: 'payment',
        entityId: payment.id,
        detail: 'Payment voided because the bank line it came from was un-categorised',
      });
    }
  }
  voidEntry(db, row.journalId, 'Undone from the transactions screen');
  const saved = db.put('bankTxns', {
    ...row,
    status: 'unreconciled',
    journalId: null,
    categoryAccount: null,
    taxCode: null,
    contactId: null,
  });
  audit(db, {
    companyId: row.companyId,
    action: 'uncategorise',
    entity: 'bankTxn',
    entityId: row.id,
    detail: `Reversed entry ${row.journalId}; the line is back in review`,
  });
  return saved;
}

/**
 * Set a line aside, and bring it back.
 *
 * Excluded lines are skipped by reconciliation: personal spending on a business account, or something
 * belonging to another period. Excluding is not deleting and not voiding — the ledger does not change,
 * and a line that was already categorised stays categorised. The reason is kept on the line, because
 * "why was this excluded" is exactly the question asked six months later.
 *
 * A reconciled line cannot be excluded: it has already been agreed with the bank, and setting it aside
 * afterwards would leave the reconciliation saying one thing and the line another.
 */
export function excludeBankTxn(db, txn, note = '') {
  const row = typeof txn === 'string' ? db.get('bankTxns', txn) : txn;
  if (!row) throw new Error('Bank transaction not found.');
  if (row.status === 'reconciled') throw new Error('Un-reconcile this line before excluding it.');
  if (row.status === 'excluded') return row;
  const saved = db.put('bankTxns', { ...row, status: 'excluded', note: note || 'Excluded' });
  audit(db, {
    companyId: row.companyId,
    action: 'exclude',
    entity: 'bankTxn',
    entityId: row.id,
    detail: note ? `Excluded — ${note}` : 'Excluded from reconciliation',
  });
  return saved;
}

/**
 * Put an excluded line back where it was.
 *
 * Where it was matters: a line that had posted its own entry returns to `posted`, not to `unreconciled`.
 * Returning a categorised line to review would offer to categorise it a second time, and categorising it
 * again posts a second entry — the money would be in the ledger twice.
 */
export function reinstateBankTxn(db, txn) {
  const row = typeof txn === 'string' ? db.get('bankTxns', txn) : txn;
  if (!row) throw new Error('Bank transaction not found.');
  if (row.status !== 'excluded') throw new Error('Only an excluded line can be reinstated.');
  const saved = db.put('bankTxns', { ...row, status: row.journalId ? 'posted' : 'unreconciled', note: '' });
  audit(db, {
    companyId: row.companyId,
    action: 'reinstate',
    entity: 'bankTxn',
    entityId: row.id,
    detail: row.journalId ? 'Reinstated — still categorised' : 'Reinstated and back to review',
  });
  return saved;
}

/**
 * Bank reconciliation summary for one bank account.
 *
 * Two different numbers are being compared, and it matters which is which:
 * the ledger balance is what the books say the account holds; the cleared
 * balance is the statement's opening balance plus every line that has been
 * reconciled against a statement. They agree when the reconciliation is done.
 *
 * The statement's opening balance lives in `db.meta.statementOpening` (per
 * company, per account) because it is a fact about the bank's paperwork, not
 * about the ledger.
 */
export function reconciliation(db, companyId, accountCode, asOf = todayISO()) {
  const accounts = db.of('accounts', companyId);
  const entries = db.of('entries', companyId);
  const txns = db.of('bankTxns', companyId).filter((t) => t.accountCode === accountCode);
  const account = accounts.find((a) => a.code === accountCode);

  let ledger = 0;
  for (const e of entries) {
    if (e.status !== 'posted' || e.date > asOf) continue;
    for (const l of e.lines) {
      if (l.accountCode !== accountCode) continue;
      ledger += (l.debit || 0) - (l.credit || 0);
    }
  }

  const openingBalance = Number(db.meta.statementOpening?.[companyId]?.[accountCode] || 0);
  const clearedMovement = txns
    .filter((t) => t.status === 'reconciled')
    .reduce((a, t) => a + (t.amount || 0), 0);
  const clearedBalance = openingBalance + clearedMovement;

  const outstanding = txns.filter((t) => t.status === 'unreconciled' || t.status === 'posted');
  const excluded = txns.filter((t) => t.status === 'excluded');

  return {
    account,
    asOf,
    ledgerBalance: ledger,
    openingBalance,
    clearedMovement,
    clearedBalance,
    statementBalance: clearedBalance,
    unreconciledCount: outstanding.length,
    unreconciledTotal: outstanding.reduce((a, t) => a + (t.amount || 0), 0),
    excludedCount: excluded.length,
    difference: ledger - clearedBalance,
    reconciles: ledger === clearedBalance,
    hasStatementData: openingBalance !== 0 || clearedMovement !== 0 || txns.length > 0,
  };
}

/** Remember the statement's opening balance for an account. */
export function setStatementOpening(db, companyId, accountCode, cents) {
  const meta = { ...(db.meta.statementOpening || {}) };
  meta[companyId] = { ...(meta[companyId] || {}), [accountCode]: Math.round(cents || 0) };
  db.meta.statementOpening = meta;
  db.markDirty('meta');
  db.notify({ collection: 'meta', action: 'update', id: accountCode });
  return meta[companyId][accountCode];
}

export function dueDateFor(date, terms) {
  const days = termsDays(terms);
  if (days === null) return endOfMonth(date);
  return addDays(date, days);
}

export function overdueBuckets() {
  return [
    { id: 'current', label: 'Current', min: -1e9, max: 0 },
    { id: 'd1_30', label: '1–30 days', min: 1, max: 30 },
    { id: 'd31_60', label: '31–60 days', min: 31, max: 60 },
    { id: 'd61_90', label: '61–90 days', min: 61, max: 90 },
    { id: 'd90plus', label: '90+ days', min: 91, max: 1e9 },
  ];
}

export function bucketFor(daysOverdue, buckets = overdueBuckets()) {
  return buckets.find((b) => daysOverdue >= b.min && daysOverdue <= b.max) || buckets[buckets.length - 1];
}

export function newDocumentId() { return newId('doc'); }
export function newLineId() { return newId('dl'); }
