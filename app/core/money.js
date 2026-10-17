/**
 * Rookeepa — money.
 *
 * The one rule that keeps the books honest: every amount in Rookeepa is an
 * integer number of cents. Floats are used for nothing but parsing and display.
 * Quantities are integers too, in thousandths of a unit (1.5 units === 1500).
 */

export const CURRENCIES = {
  AUD: { code: 'AUD', symbol: '$', name: 'Australian Dollar', dp: 2 },
  NZD: { code: 'NZD', symbol: '$', name: 'New Zealand Dollar', dp: 2 },
  USD: { code: 'USD', symbol: '$', name: 'US Dollar', dp: 2 },
  GBP: { code: 'GBP', symbol: '\u00a3', name: 'Pound Sterling', dp: 2 },
  EUR: { code: 'EUR', symbol: '\u20ac', name: 'Euro', dp: 2 },
  CAD: { code: 'CAD', symbol: '$', name: 'Canadian Dollar', dp: 2 },
  SGD: { code: 'SGD', symbol: '$', name: 'Singapore Dollar', dp: 2 },
  INR: { code: 'INR', symbol: '\u20b9', name: 'Indian Rupee', dp: 2 },
  ZAR: { code: 'ZAR', symbol: 'R', name: 'South African Rand', dp: 2 },
  JPY: { code: 'JPY', symbol: '\u00a5', name: 'Japanese Yen', dp: 0 },
};

export function currency(code) {
  return CURRENCIES[code] || CURRENCIES.AUD;
}

/** Parse user or CSV input into integer cents. Handles $1,234.56, (1,234.56), 1234.56-, 1.234,56. */
export function toCents(value, dp = 2) {
  if (value === null || value === undefined || value === '') return 0;
  let s = String(value).trim();
  if (s === '') return 0;

  // Parentheses mean negative, the accounting convention.
  let neg = false;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) { neg = true; s = paren[1].trim(); }

  // Keep the sign characters while dropping currency symbols, letter codes, spaces and
  // statement A/B markers. This used to strip everything non-numeric BEFORE looking for
  // a minus, so "$-123.45" — a refund — was read as a payment of +123.45.
  s = s.replace(/[^0-9.,+-]/g, '');
  if ((s.match(/-/g) || []).length % 2 === 1) neg = !neg;
  s = s.replace(/[+-]/g, '');
  if (s === '') return 0;

  // Split on separators and validate any grouping. Reading only the last group (as this
  // did) meant 1,234,567 was taken as "1,234.567" and rounded to the wrong amount, and
  // malformed grouping like 1,23,4 was silently mangled instead of refused.
  //
  // A single separator followed by exactly three digits stays ambiguous, and is read as
  // a thousands group: "1,234" and "1.239" are both 1,234-ish amounts, which is the
  // Australian convention this app documents. Values with more than two decimals are
  // read as decimals and rounded.
  const groups = s.split(/[.,]/);
  const seps = s.match(/[.,]/g) || [];
  let intDigits = '';
  let fracDigits = '';

  if (groups.length === 1) {
    intDigits = groups[0];
  } else if (groups.length === 2) {
    const [head, tail] = groups;
    if (tail.length > 0 && tail.length <= dp) {
      intDigits = head;
      fracDigits = tail;
    } else if (tail.length === 3 && head.length >= 1 && head.length <= 3 && !/^0+$/.test(head)) {
      intDigits = head + tail;
    } else {
      intDigits = head;
      fracDigits = tail;
    }
  } else {
    const tail = groups[groups.length - 1];
    const middle = groups.slice(1, -1);
    const allThousands = seps.every((x) => x === seps[0]) && middle.concat(tail).every((g) => g.length === 3);
    if (allThousands) {
      intDigits = groups.join('');
    } else if (middle.every((g) => g.length === 3) && tail.length > 0 && tail.length <= dp) {
      intDigits = groups.slice(0, -1).join('');
      fracDigits = tail;
    } else {
      throw new TypeError(`"${value}" is not a readable amount — check its thousands separators`);
    }
  }
  if (intDigits === '') intDigits = '0';

  const scale = 10 ** dp;
  let cents = Number(intDigits) * scale + Number((fracDigits + '0'.repeat(dp)).slice(0, dp) || 0);
  if (!Number.isFinite(cents)) throw new TypeError(`Cannot read "${value}" as an amount`);
  // round half-up on the first dropped digit, in integer space
  if (fracDigits.length > dp && fracDigits.charCodeAt(dp) - 48 >= 5) cents += 1;

  return neg ? -cents : cents;
}

export function fromCents(cents, dp = 2) {
  return (cents || 0) / 10 ** dp;
}

/** Integer multiply of cents by a rate expressed in basis points (1000 = 10%). Half-up, away from zero. */
export function mulRate(cents, bps) {
  const n = cents * bps;
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 10000);
  const rem = abs - whole * 10000;
  const out = rem * 2 >= 10000 ? whole + 1 : whole;
  return neg ? -out : out;
}

/** Quantity (thousandths) x unit price (cents) -> cents, half-up away from zero. */
export function mulQty(qtyMilli, unitCents) {
  const n = qtyMilli * unitCents;
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 1000);
  const rem = abs - whole * 1000;
  const out = rem * 2 >= 1000 ? whole + 1 : whole;
  return neg ? -out : out;
}

export function qtyToMilli(value) {
  return toCents(value, 3);
}

export function sum(list) {
  let t = 0;
  for (const v of list) t += v || 0;
  return t;
}

export function sumBy(list, fn) {
  let t = 0;
  for (const v of list) t += fn(v) || 0;
  return t;
}

/** GST component of a GST-exclusive amount, for a tax code's rate. */
export function gstOf(exCents, taxCode) {
  return mulRate(exCents, taxCode?.gstBps || 0);
}

/** Split a GST-inclusive amount into { ex, gst } using the same per-component rounding. */
export function splitInclusive(incCents, taxCode) {
  const bps = taxCode?.gstBps || 0;
  if (!bps) return { ex: incCents, gst: 0 };
  // ex = inc * 10000 / (10000 + bps), rounded half-up, then gst = inc - ex (no leakage)
  const num = incCents * 10000;
  const den = 10000 + bps;
  const neg = num < 0;
  const abs = Math.abs(num);
  let ex = Math.floor(abs / den);
  const rem = abs - ex * den;
  if (rem * 2 >= den) ex += 1;
  if (neg) ex = -ex;
  return { ex, gst: incCents - ex };
}

/** "$1,234.56" / "-$1,234.56" / "($1,234.56)" when parens is set. */
export function formatCents(cents, opts = {}) {
  const cur = currency(opts.code || 'AUD');
  const dp = opts.dp === undefined ? cur.dp : opts.dp;
  const decimals = opts.decimals !== false;
  const symbol = opts.symbol === false ? '' : (opts.symbolText || cur.symbol);
  const neg = (cents || 0) < 0;
  const body = groupDigits(Math.abs(cents || 0), dp, decimals);
  const text = symbol + body;
  if (!neg) return text;
  return opts.parens ? `(${text})` : `-${text}`;
}

/** "1,234.56" — no symbol, thousands grouped. */
export function formatPlain(cents, dp = 2, opts = {}) {
  const neg = (cents || 0) < 0;
  const body = groupDigits(Math.abs(cents || 0), dp, opts.decimals !== false);
  return neg ? `-${body}` : body;
}

/** "1234.56" — no symbol, no grouping. For CSV and form inputs. */
export function formatRaw(cents, dp = 2) {
  return fromCents(cents || 0, dp).toFixed(dp);
}

export function formatQty(qtyMilli, opts = {}) {
  const dp = opts.dp === undefined ? 3 : opts.dp;
  const trimmed = Number(fromCents(qtyMilli || 0, 3).toFixed(dp));
  return trimZeros(trimmed.toFixed(dp));
}

function trimZeros(s) {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function groupDigits(absCents, dp, decimals) {
  let digits = String(Math.abs(absCents)).padStart(dp + 1, '0');
  let whole = digits.slice(0, digits.length - dp) || '0';
  const frac = dp ? digits.slice(digits.length - dp) : '';
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimals && dp ? `${whole}.${frac}` : whole;
}

export const isZero = (cents) => (cents || 0) === 0;
