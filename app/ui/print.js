/**
 * Rookeepa — printable documents.
 *
 * Builds a clean, light-on-white tax invoice / quote / bill / credit note for
 * window.print(). Deliberately plain HTML: it should print the same on a $90
 * laser printer as it looks on a retina screen.
 */

import { h } from './kit.js';
import { formatCents, formatQty } from '../core/money.js';
import { fmtDate } from '../core/dates.js';
import { ACCOUNT_TYPES } from '../core/coa.js';

const TITLES = {
  invoice: 'Tax Invoice',
  quote: 'Quote',
  'credit-note-sale': 'Credit Note',
  bill: 'Supplier Invoice',
  'credit-note-purchase': 'Supplier Credit',
};

/** How a statement line's kind reads in the Type column. */
const STATEMENT_TYPE_LABELS = {
  invoice: 'Invoice',
  'credit-note': 'Credit note',
  receipt: 'Receipt',
};

/** The node handed to kit.printNode(). */
export function documentPrintNode({ company, doc, contact, summary, taxCodes = [], entitlements }) {
  const title = TITLES[doc.type] || 'Document';
  const cur = { code: company.currency || 'AUD' };
  const money = (c) => formatCents(c, cur);

  const addressLines = [
    company.addressLine1, company.addressLine2,
    [company.city, company.state, company.postcode].filter(Boolean).join(' '),
    company.phone, company.email, company.website,
    company.abn ? `ABN ${company.abn}` : null,
  ].filter(Boolean);

  const contactLines = contact ? [
    contact.addressLine1, contact.addressLine2,
    [contact.city, contact.state, contact.postcode].filter(Boolean).join(' '),
    contact.email, contact.phone,
    contact.abn ? `ABN ${contact.abn}` : null,
  ].filter(Boolean) : [];

  const rows = summary.rows.filter((r) => r.description || r.ex || r.gst);
  const isCredit = doc.type.startsWith('credit-note');

  const head = h('div', { class: 'doc-print-head' },
    h('div', { class: 'doc-print-business' },
      company.logoDataUrl
        ? h('img', { class: 'doc-print-logo', src: company.logoDataUrl, alt: '' })
        : null,
      h('h2', null, company.legalName || company.name),
      addressLines.map((l) => h('div', null, l))),
    h('div', { class: 'doc-print-title' },
      h('h1', null, title),
      doc.number ? h('div', null, h('strong', null, doc.number)) : null,
      summary.status === 'paid' ? h('div', { class: 'doc-print-paid' }, 'PAID') : null));

  const meta = h('div', { class: 'doc-print-meta' },
    h('div', null,
      h('div', { class: 'small' }, doc.ledger === 'sales' ? 'Customer' : 'Supplier'),
      h('strong', null, contact?.name || '—'),
      contactLines.map((l) => h('div', { class: 'small' }, l))),
    h('dl', null,
      h('dt', null, 'Date'), h('dd', null, fmtDate(doc.date)),
      doc.dueDate && doc.type !== 'quote' ? h('dt', null, 'Due') : null,
      doc.dueDate && doc.type !== 'quote' ? h('dd', null, fmtDate(doc.dueDate)) : null,
      doc.reference ? h('dt', null, 'Reference') : null,
      doc.reference ? h('dd', null, doc.reference) : null,
      doc.poNumber ? h('dt', null, 'Your PO') : null,
      doc.poNumber ? h('dd', null, doc.poNumber) : null,
      isCredit ? h('dt', null, 'Credits') : null,
      isCredit ? h('dd', null, 'Amount owing reduced') : null));

  const body = h('table', null,
    h('thead', null, h('tr', null,
      h('th', null, 'Description'),
      h('th', { class: 'num' }, 'Qty'),
      h('th', { class: 'num' }, 'Unit price'),
      h('th', { class: 'num' }, 'Disc'),
      h('th', null, 'Tax'),
      h('th', { class: 'num' }, 'Amount'))),
    h('tbody', null, rows.map((r) => h('tr', null,
      h('td', null, r.description || ''),
      h('td', { class: 'num' }, formatQty(r.qty)),
      h('td', { class: 'num' }, money(r.unitPrice)),
      h('td', { class: 'num' }, r.discountPct ? `${r.discountPct}%` : '—'),
      h('td', null, r.taxCode || ''),
      h('td', { class: 'num' }, money(r.ex))))));

  const totalsRows = [
    h('tr', null, h('td', null, 'Subtotal'), h('td', { class: 'num' }, money(summary.subtotal))),
  ];
  for (const [code, v] of summary.taxBreakdown) {
    if (!v.gst) continue;
    const tc = taxCodes.find((t) => t.code === code);
    totalsRows.push(h('tr', null, h('td', null, `${tc?.name || code}`), h('td', { class: 'num' }, money(v.gst))));
  }
  if (!summary.tax) totalsRows.push(h('tr', null, h('td', null, 'GST'), h('td', { class: 'num' }, money(0))));
  if (summary.freight) totalsRows.push(h('tr', null, h('td', null, 'Freight'), h('td', { class: 'num' }, money(summary.freight))));
  totalsRows.push(h('tr', { class: 'grand' }, h('td', null, 'Total'), h('td', { class: 'num' }, money(summary.total))));
  if (summary.paid) {
    totalsRows.push(h('tr', null, h('td', null, 'Paid'), h('td', { class: 'num' }, money(summary.paid))));
    if (summary.balance !== summary.total) totalsRows.push(h('tr', null, h('td', null, 'Balance due'), h('td', { class: 'num' }, money(summary.balance))));
  }

  const totals = h('div', { class: 'doc-print-totals' },
    h('table', null, h('tbody', null, totalsRows)));

  const footBits = [];
  if (doc.memo) footBits.push(doc.memo);
  if (doc.notes) footBits.push(doc.notes);
  if (doc.type === 'invoice' || doc.type === 'bill') footBits.push(company.invoiceFooter || '');
  if (!company.gstRegistered) footBits.push('This business is not registered for GST.');
  if (entitlements?.note) footBits.push(entitlements.note);

  return h('div', { class: 'doc-print' },
    head, meta, body, totals,
    footBits.filter(Boolean).length ? h('div', { class: 'doc-print-footer' }, footBits.filter(Boolean).map((t) => h('div', null, t))) : null);
}

/**
 * The node handed to kit.printNode() for a statement of account.
 *
 * Built the same way as the invoice node and from the same .doc-print-* classes,
 * so the print stylesheet applies unchanged. It is deliberately not a tax
 * invoice: it lists movements and balances, and says so in the footer.
 */
export function statementPrintNode({ company, contact, statement, asOf }) {
  const cur = { code: company.currency || 'AUD' };
  const money = (c) => formatCents(c, cur);

  const addressLines = [
    company.addressLine1, company.addressLine2,
    [company.city, company.state, company.postcode].filter(Boolean).join(' '),
    company.phone, company.email, company.website,
    company.abn ? `ABN ${company.abn}` : null,
  ].filter(Boolean);

  const contactLines = contact ? [
    contact.addressLine1, contact.addressLine2,
    [contact.city, contact.state, contact.postcode].filter(Boolean).join(' '),
    contact.email, contact.phone,
    contact.abn ? `ABN ${contact.abn}` : null,
  ].filter(Boolean) : [];

  const period = (statement.from || statement.to)
    ? `${statement.from ? fmtDate(statement.from) : 'the start'} – ${statement.to ? fmtDate(statement.to) : 'today'}`
    : 'All activity';

  const head = h('div', { class: 'doc-print-head' },
    h('div', { class: 'doc-print-business' },
      company.logoDataUrl
        ? h('img', { class: 'doc-print-logo', src: company.logoDataUrl, alt: '' })
        : null,
      h('h2', null, company.legalName || company.name),
      addressLines.map((l) => h('div', null, l))),
    h('div', { class: 'doc-print-title' },
      h('h1', null, 'Statement of account'),
      contact ? h('div', null, h('strong', null, contact.name)) : null));

  const meta = h('div', { class: 'doc-print-meta' },
    h('div', null,
      h('div', { class: 'small' }, 'Statement for'),
      h('strong', null, contact?.name || '—'),
      contactLines.map((l) => h('div', { class: 'small' }, l))),
    h('dl', null,
      h('dt', null, 'Statement date'), h('dd', null, fmtDate(asOf)),
      h('dt', null, 'Period'), h('dd', null, period)));

  const row = (line) => h('tr', null,
    h('td', null, fmtDate(line.date)),
    h('td', null, STATEMENT_TYPE_LABELS[line.kind] || line.kind),
    h('td', { class: 'mono' }, line.number || ''),
    h('td', { class: 'num' }, line.debit ? money(line.debit) : ''),
    h('td', { class: 'num' }, line.credit ? money(line.credit) : ''),
    h('td', { class: 'num' }, money(line.balance)));

  const openingRow = h('tr', null,
    h('td', null, ''),
    h('td', null, 'Opening balance'),
    h('td', null, ''),
    h('td', { class: 'num' }, ''),
    h('td', { class: 'num' }, ''),
    h('td', { class: 'num' }, money(statement.opening)));

  // The closing row is the last word on the account, so it is set in bold with
  // no new stylesheet rule needed.
  const closingRow = h('tr', null,
    h('td', null, ''),
    h('td', null, h('strong', null, 'Closing balance')),
    h('td', null, ''),
    h('td', { class: 'num' }, ''),
    h('td', { class: 'num' }, ''),
    h('td', { class: 'num' }, h('strong', null, money(statement.closing))));

  const body = h('table', null,
    h('thead', null, h('tr', null,
      h('th', null, 'Date'),
      h('th', null, 'Type'),
      h('th', null, 'Reference'),
      h('th', { class: 'num' }, 'Debit'),
      h('th', { class: 'num' }, 'Credit'),
      h('th', { class: 'num' }, 'Balance'))),
    h('tbody', null, openingRow, statement.lines.map(row), closingRow));

  const totals = h('div', { class: 'doc-print-totals' },
    h('table', null, h('tbody', null,
      h('tr', null, h('td', null, 'Closing balance'), h('td', { class: 'num' }, money(statement.closing))),
      h('tr', { class: 'grand' }, h('td', null, 'Amount due (whole account)'), h('td', { class: 'num' }, money(statement.totalDue))))));

  const footBits = [
    'This is a statement of account, not a tax invoice.',
    company.invoiceFooter || '',
    company.gstRegistered === false ? 'This business is not registered for GST.' : '',
  ].filter(Boolean);

  return h('div', { class: 'doc-print' },
    head, meta, body, totals,
    h('div', { class: 'doc-print-footer' }, footBits.map((t) => h('div', null, t))));
}

/** Plain-text version for pasting into an email. */
export function documentPlainText({ company, doc, contact, summary, taxCodes = [] }) {
  const money = (c) => formatCents(c, { code: company.currency || 'AUD' });
  const lines = [];
  lines.push(company.legalName || company.name);
  if (company.abn) lines.push(`ABN ${company.abn}`);
  if (company.email) lines.push(company.email);
  lines.push('');
  lines.push(`${TITLES[doc.type] || 'Document'}${doc.number ? ` ${doc.number}` : ''}`);
  lines.push(`Date: ${fmtDate(doc.date)}`);
  if (doc.dueDate) lines.push(`Due: ${fmtDate(doc.dueDate)}`);
  lines.push('');
  lines.push(`${doc.ledger === 'sales' ? 'To' : 'From'}: ${contact?.name || ''}`);
  lines.push('');
  for (const r of summary.rows) {
    if (!r.description && !r.ex) continue;
    lines.push(`${r.description || 'Item'} — ${formatQty(r.qty)} x ${money(r.unitPrice)} (${r.taxCode}) = ${money(r.ex)}`);
  }
  lines.push('');
  lines.push(`Subtotal: ${money(summary.subtotal)}`);
  for (const [code, v] of summary.taxBreakdown) {
    if (v.gst) lines.push(`${code}: ${money(v.gst)}`);
  }
  lines.push(`Total: ${money(summary.total)}`);
  if (summary.paid) lines.push(`Paid: ${money(summary.paid)}  Balance: ${money(summary.balance)}`);
  lines.push('');
  if (doc.memo) lines.push(doc.memo);
  if (company.invoiceFooter) lines.push(company.invoiceFooter);
  return lines.join('\n');
}

export function accountLabel(accounts, code) {
  const a = accounts.find((x) => x.code === code);
  return a ? `${a.code} ${a.name}` : code || '';
}

export function accountOptions(accounts, opts = {}) {
  const types = opts.types || ['income'];
  const allowAll = opts.all !== false;
  return accounts
    .filter((a) => a.active !== false && (types.includes(a.type) || (allowAll && opts.all)))
    .map((a) => ({ value: a.code, label: `${a.code} — ${a.name}`, group: ACCOUNT_TYPES[a.type]?.label }))
    .sort((a, b) => a.value.localeCompare(b.value));
}
