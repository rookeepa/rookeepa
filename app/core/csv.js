/**
 * Rookeepa — CSV in and out.
 *
 * Bank feeds are the one place where every institution invents its own format,
 * so parsing is deliberately forgiving: any delimiter, quoted fields, BOMs,
 * "1,234.56" or "(1,234.56)" or "1234.56-", DD/MM/YYYY or YYYY-MM-DD, and a
 * single signed Amount column or separate Debit/Credit columns.
 */

import { toCents } from './money.js';

/** Parse CSV text into an array of rows (each an array of strings). */
export function parseCsv(text, opts = {}) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const delimiter = opts.delimiter || sniffDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export function sniffDelimiter(text) {
  const sample = String(text).split(/\r?\n/).slice(0, 5).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  for (const ch of sample) if (ch in counts) counts[ch]++;
  let best = ',';
  for (const [d, n] of Object.entries(counts)) if (n > counts[best]) best = d;
  return best;
}

/**
 * Excel and LibreOffice execute a cell whose text begins with =, +, - or @, and will
 * happily run one that arrived inside an exported file. A bank memo or a supplier's
 * description is untrusted text, so it must never be able to become a formula: a
 * leading apostrophe makes the spreadsheet show it literally.
 *
 * Plain numbers are deliberately exempt. A negative amount such as -1234.56 is data,
 * and quoting it would turn the column into text and break the accountant's sums.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\$?\d[\d,]*(?:\.\d+)?$/;
const defuse = (s) => (FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s);

export function toCsv(rows, opts = {}) {
  const delimiter = opts.delimiter || ',';
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : defuse(String(v));
    return /["\n\r]|,|;|\t/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(escape).join(delimiter)).join('\r\n');
}

/* ------------------------------------------------------------ dates in CSVs */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Interpret a date from a bank file. Returns ISO date or null. */
export function parseLooseDate(input, opts = {}) {
  const s = String(input ?? '').trim().replace(/^"|"$/g, '');
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const order = opts.dateOrder || 'auto';
    if (order === 'mdy') { const t = a; a = b; b = t; }
    else if (order === 'auto') {
      // Day-first (Australian) unless only one of the two can be a month.
      if (a > 12 && b <= 12) { /* a is the day, keep as is */ }
      else if (b > 12 && a <= 12) { const t = a; a = b; b = t; }
    }
    return iso(y, b, a);
  }

  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) {
      let y = +m[3];
      if (y < 100) y += y < 70 ? 2000 : 1900;
      return iso(y, mo, +m[1]);
    }
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return iso(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }
  return null;
}

function iso(y, m, d) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1) return null;
  // Validate against the real length of the month: the old check was `d <= 31`, so
  // 31 February, 31 April and 29 February 2027 were all accepted as dates.
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysIn = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > daysIn[m - 1]) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Work out one date order for the whole file.
 *
 * A bank statement uses one convention throughout, but the old code re-guessed the
 * order on every row: in the same file 03/14/2026 forced month-first while 03/04/2026
 * was read day-first, so rows ended up months apart. Look at every date cell instead,
 * and when the file contradicts itself say so rather than picking one quietly.
 */
export function detectDateOrder(values) {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const s = String(v ?? '').trim().replace(/^"|"$/g, '');
    const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!m) continue;
    const a = +m[1];
    const b = +m[2];
    if (a > 12 && b <= 12) dmy += 1;
    else if (b > 12 && a <= 12) mdy += 1;
  }
  if (dmy && mdy) return { order: null, conflict: true, assumed: false };
  if (mdy) return { order: 'mdy', conflict: false, assumed: false };
  if (dmy) return { order: 'dmy', conflict: false, assumed: false };
  // Every row could be either (03/04/2026): fall back to the Australian convention,
  // but flag it as an assumption so the import can say so out loud.
  return { order: 'dmy', conflict: false, assumed: true };
}

/* ------------------------------------------------------- bank statement import */

const HEADER_HINTS = {
  date: ['date', 'transaction date', 'value date', 'posted', 'effective date', 'date processed',
    'datum', 'transaktionsdatum', 'buchungstag', 'fecha', 'fecha valor', 'data', 'dato'],
  description: ['description', 'narrative', 'details', 'transaction description', 'memo', 'particulars', 'reference',
    'beschrijving', 'omschrijving', 'mededelingen', 'beschreibung', 'verwendungszweck', 'buchungstext',
    'concepto', 'descripcion', 'descripción', 'libelle', 'libellé', 'texte'],
  reference: ['reference', 'ref', 'cheque', 'transaction id', 'receipt no', 'kenmerk', 'belegnummer'],
  amount: ['amount', 'value', 'transaction amount', 'net amount', 'bedrag', 'betrag', 'importe', 'montant', 'belopp'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'paid out', 'money out', 'amount debit', 'dr',
    'af', 'debet', 'soll', 'cargo', 'debit amount'],
  credit: ['credit', 'deposit', 'deposits', 'paid in', 'money in', 'amount credit', 'cr',
    'bij', 'krediet', 'haben', 'abono', 'credit amount'],
  balance: ['balance', 'running balance', 'closing balance', 'account balance',
    'saldo', 'kontostand', 'nouveau solde', 'saldo contable'],
};

function headerKey(cell) {
  const c = String(cell || '').trim().toLowerCase().replace(/[^a-z ]/g, '');
  // A Revolut Business export carries both "Orig amount" (the amount in the original currency,
  // unsigned) and "Amount" (signed, in the account's currency). Matching the first of those by
  // substring read a £42.10 card payment as money IN, which would have turned spending into
  // income silently. Nothing about the original currency belongs in a single-currency import, so
  // these headers are not mapped at all and the signed column wins.
  if (/^orig(inal)?\s/.test(c) || c === 'orig' || c === 'original') return null;
  for (const [key, hints] of Object.entries(HEADER_HINTS)) {
    if (hints.includes(c)) return key;
  }
  for (const [key, hints] of Object.entries(HEADER_HINTS)) {
    if (hints.some((h) => c.includes(h))) return key;
  }
  return null;
}

/** Work out which column is which. */
export function detectBankColumns(rows) {
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const cols = {};
    rows[r].forEach((cell, idx) => {
      const key = headerKey(cell);
      if (key && cols[key] === undefined) cols[key] = idx;
    });
    const score = Object.keys(cols).length;
    if (!best || score > best.score) best = { headerRow: r, cols, score };
  }
  // Note the === undefined: column index 0 is a perfectly good column, and
  // `!best.cols.date` would throw it away.
  if (!best || best.cols.date === undefined) return null;
  return best;
}

/**
 * Parse a bank statement export.
 * Returns { rows, skipped, columns } where each row is
 * { date, description, reference, amount (signed cents), balance }.
 */
export function parseBankStatement(text, opts = {}) {
  const table = parseCsv(text, opts);
  if (!table.length) return { rows: [], skipped: [], columns: null, balanceColumn: null };

  const detected = detectBankColumns(table);
  const columns = detected?.cols || manualColumns(opts);
  const headerRow = detected?.headerRow ?? 0;
  const out = [];
  const skipped = [];

  // With no date column there is nothing to interpret: refuse the file rather
  // than importing a pile of guesses.
  if (columns.date === undefined) {
    return { rows: [], skipped: [], columns: null, headerRow: null, unrecognised: true };
  }

  // Decide the date order once for the file, from every date cell — never per row.
  const dateCells = [];
  for (let r = headerRow + 1; r < table.length; r++) dateCells.push(table[r][columns.date]);
  const order = opts.dateOrder
    ? { order: opts.dateOrder, conflict: false, assumed: false }
    : detectDateOrder(dateCells);
  if (order.conflict) {
    return {
      rows: [],
      skipped: [],
      columns,
      headerRow,
      dateOrderConflict: true,
      problem: 'The dates in this file contradict each other: some only make sense as day/month and others only as month/day. Set the date order for this file and import again — Rookeepa will not guess.',
    };
  }
  const rowOpts = { ...opts, dateOrder: order.order };

  for (let r = headerRow + 1; r < table.length; r++) {
    const cells = table[r];
    const date = parseLooseDate(cells[columns.date], rowOpts);
    let amount = 0;
    if (columns.amount !== undefined) {
      amount = toCents(cells[columns.amount]);
    } else {
      const debit = columns.debit !== undefined ? toCents(cells[columns.debit]) : 0;
      const credit = columns.credit !== undefined ? toCents(cells[columns.credit]) : 0;
      amount = Math.abs(credit) - Math.abs(debit);
    }
    const description = columns.description !== undefined ? String(cells[columns.description] || '').trim() : '';
    const reference = columns.reference !== undefined ? String(cells[columns.reference] || '').trim() : '';
    const balance = columns.balance !== undefined && String(cells[columns.balance] ?? '').trim() !== ''
      ? toCents(cells[columns.balance])
      : null;

    if (!date) { skipped.push({ row: r, reason: 'No readable date', raw: cells }); continue; }
    if (amount === 0) { skipped.push({ row: r, reason: 'Zero or unreadable amount', raw: cells }); continue; }
    out.push({ date, description, reference, amount, balance });
  }
  return {
    rows: out,
    skipped,
    columns,
    headerRow,
    dateOrder: order.order,
    dateOrderAssumed: order.assumed,
  };
}

function manualColumns(opts) {
  const cols = {};
  if (opts.dateColumn !== undefined) cols.date = opts.dateColumn;
  if (opts.descriptionColumn !== undefined) cols.description = opts.descriptionColumn;
  if (opts.amountColumn !== undefined) cols.amount = opts.amountColumn;
  if (opts.debitColumn !== undefined) cols.debit = opts.debitColumn;
  if (opts.creditColumn !== undefined) cols.credit = opts.creditColumn;
  if (opts.balanceColumn !== undefined) cols.balance = opts.balanceColumn;
  return cols;
}

/** A ready-to-download CSV of arbitrary rows. */
export function rowsToCsvBlob(rows, headers) {
  const lines = [];
  if (headers) lines.push(headers);
  for (const r of rows) lines.push(r);
  return new Blob([toCsv(lines)], { type: 'text/csv;charset=utf-8' });
}
