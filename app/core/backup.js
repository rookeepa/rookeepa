/**
 * Rookeepa — backup, restore and export.
 *
 * There is no server and no account, so your data is yours to hold: an export
 * is a single JSON file you can keep in Dropbox, on a USB stick, or in a
 * private git repo. Import can replace everything or merge alongside what you
 * already have — your choice, never silently.
 */

import { formatRaw, formatPlain } from './money.js';
import { toCsv } from './csv.js';
import { computeDocument, documentSummary, allocatedTo, docTypeMeta } from './docs.js';
import { sortAccounts, ACCOUNT_TYPES, blankAccount } from './coa.js';
import { todayISO } from './dates.js';
import { stripFileData, preserveFiles } from './attachments.js';

/* --------------------------------------------------------------- browser I/O */

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadJson(filename, obj) {
  downloadBlob(filename, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
}

export function downloadCsv(filename, rows, headers) {
  const lines = headers ? [headers, ...rows] : rows;
  downloadBlob(filename, new Blob([`\uFEFF${toCsv(lines)}`], { type: 'text/csv;charset=utf-8' }));
}

export function slugify(text) {
  return String(text || 'rookeepa').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'rookeepa';
}

export function backupFilename(company) {
  return `${slugify(company?.name)}-rookeepa-${todayISO()}.json`;
}

/**
 * Read a file as a data URL, for the things the app stores inside the database itself — an attachment's
 * contents, or the logo on a printed invoice. A data URL is bigger than the bytes by a third, which is why
 * attachments are capped, and it is the form that survives a JSON-shaped store.
 */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`${file?.name || 'That file'} could not be read.`));
    reader.readAsDataURL(file);
  });
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

export async function readFileAsJson(file) {
  const text = await readFileAsText(file);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file.name} is not valid JSON. Choose a file exported from Rookeepa (Settings → Backup).`);
  }
}

/* ------------------------------------------------------------------- backup */

export function exportCompany(db, companyId) {
  // Attachments travel in their own file: the books backup describes each one (name, size, what it is
  // attached to) and leaves the contents on the device. See app/core/attachments.js.
  const snapshot = stripFileData(db.snapshot(companyId));
  snapshot.scope = companyId ? 'company' : 'everything';
  snapshot.companyId = companyId;
  // When it was taken, so a folder holding several backups can be read without guessing from filenames.
  snapshot.savedAt = new Date().toISOString();
  return snapshot;
}

export async function importSnapshot(db, snapshot, opts = {}) {
  const mode = opts.mode || 'replace';
  // A restore replaces every collection, and the backup does not carry the attachment contents — so without
  // this it would delete the files that are already on this device. Carry them across by id.
  if (snapshot && snapshot.data) {
    snapshot = { ...snapshot, data: { ...snapshot.data, files: preserveFiles(db, snapshot.data.files) } };
  }
  if (mode === 'replace') {
    await db.replaceAll(snapshot, { replace: true });
  } else {
    await db.replaceAll(snapshot, { replace: false });
  }
  return db.snapshot();
}

/* ------------------------------------------------------------------- exports */

export function accountsCsv(db, companyId) {
  const accounts = sortAccounts(db.of('accounts', companyId));
  const headers = ['Code', 'Name', 'Type', 'Tax code', 'Description', 'Active'];
  const rows = accounts.map((a) => [a.code, a.name, ACCOUNT_TYPES[a.type]?.label || a.type, a.gstDefault || '', a.description || '', a.active === false ? 'No' : 'Yes']);
  return { headers, rows };
}

export function contactsCsv(db, companyId) {
  const headers = ['Name', 'Type', 'Email', 'Phone', 'ABN', 'Address', 'City', 'State', 'Postcode', 'Terms'];
  const rows = db.of('contacts', companyId).map((c) => [
    c.name, c.isCustomer && c.isSupplier ? 'Customer and supplier' : (c.isCustomer ? 'Customer' : 'Supplier'),
    c.email || '', c.phone || '', c.abn || '', c.addressLine1 || '', c.city || '', c.state || '', c.postcode || '', c.terms || '',
  ]);
  return { headers, rows };
}

export function documentsCsv(db, companyId, opts = {}) {
  const taxCodes = db.of('taxCodes', companyId);
  const payments = db.of('payments', companyId);
  const contacts = new Map(db.of('contacts', companyId).map((c) => [c.id, c.name]));
  const headers = ['Type', 'Number', 'Date', 'Due', 'Contact', 'Subtotal', 'GST', 'Total', 'Paid', 'Balance', 'Status'];
  const docs = db.of('documents', companyId)
    .filter((d) => !opts.type || d.type === opts.type)
    .sort((a, b) => a.date.localeCompare(b.date));
  const rows = docs.map((d) => {
    const s = documentSummary(d, taxCodes, payments);
    return [
      docTypeMeta(d.type).label, d.number || '', d.date, d.dueDate || '', contacts.get(d.contactId) || '',
      formatRaw(s.subtotal), formatRaw(s.tax), formatRaw(s.total), formatRaw(s.paid), formatRaw(s.balance), s.status,
    ];
  });
  return { headers, rows };
}

export function transactionsCsv(db, companyId, opts = {}) {
  const accounts = new Map(db.of('accounts', companyId).map((a) => [a.code, a]));
  const headers = ['Date', 'Number', 'Type', 'Reference', 'Memo', 'Account code', 'Account', 'Debit', 'Credit', 'Tax code'];
  const rows = [];
  const entries = db.of('entries', companyId)
    .filter((e) => e.status === 'posted' && (!opts.from || e.date >= opts.from) && (!opts.to || e.date <= opts.to))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push([
        e.date, e.number || '', docTypeMeta(e.source?.type)?.label || e.source?.type || 'Journal', e.ref || '',
        l.description || e.memo || '', l.accountCode, accounts.get(l.accountCode)?.name || '',
        formatRaw(l.debit || 0), formatRaw(l.credit || 0), l.taxCode || '',
      ]);
    }
  }
  return { headers, rows };
}

export function journalCsv(db, companyId) {
  const { rows } = transactionsCsv(db, companyId);
  return { headers: ['Date', 'Number', 'Type', 'Reference', 'Memo', 'Account code', 'Account', 'Debit', 'Credit', 'Tax code'], rows };
}

/** Printable plain-text quote/invoice for the clipboard or a text file. */
export function documentText(company, doc, contact, summary, taxCodes) {
  const cur = company.currency || 'AUD';
  const curSym = { AUD: '$', NZD: '$', USD: '$', GBP: '\u00a3', EUR: '\u20ac', JPY: '\u00a5' }[cur] || '';
  const fmt = (c) => `${curSym}${formatPlain(c)}`;
  const lines = [];
  lines.push(company.legalName || company.name || '');
  if (company.abn) lines.push(`ABN ${company.abn}`);
  const addr = [company.addressLine1, company.addressLine2, [company.city, company.state, company.postcode].filter(Boolean).join(' ')].filter(Boolean);
  lines.push(...addr);
  lines.push('');
  lines.push(`${docTypeMeta(doc.type).label.toUpperCase()} ${doc.number || ''}`);
  lines.push(`Date: ${doc.date}`);
  if (doc.dueDate) lines.push(`Due: ${doc.dueDate}`);
  lines.push('');
  lines.push(`To: ${contact?.name || ''}`);
  if (contact?.email) lines.push(`    ${contact.email}`);
  lines.push('');
  for (const r of summary.rows) {
    lines.push(`${r.description || ''}`);
    lines.push(`  ${r.qty / 1000} x ${fmt(r.unitPrice)}${r.discountPct ? ` less ${r.discountPct}%` : ''} ${r.taxCode}  = ${fmt(r.ex)}`);
  }
  lines.push('');
  lines.push(`Subtotal (ex ${company.taxLabel || 'GST'}): ${fmt(summary.subtotal)}`);
  lines.push(`${company.taxLabel || 'GST'}: ${fmt(summary.tax)}`);
  lines.push(`Total: ${fmt(summary.total)}`);
  if (summary.paid) lines.push(`Paid: ${fmt(summary.paid)}`);
  if (summary.balance !== summary.total) lines.push(`Balance due: ${fmt(summary.balance)}`);
  if (company.invoiceFooter) { lines.push(''); lines.push(company.invoiceFooter); }
  return lines.join('\n');
}
