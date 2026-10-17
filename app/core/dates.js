/**
 * Rookeepa — dates.
 * Everything on disk is an ISO date string ("YYYY-MM-DD") in local time.
 * Never use Date#toISOString() for business dates: it shifts by the UTC offset.
 */

export function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayISO() {
  return toISO(new Date());
}

export function parseISO(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function isValidISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  return toISO(parseISO(iso)) === iso;
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export function addMonths(iso, n) {
  const d = parseISO(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISO(d);
}

/**
 * The same date in another year, clamping the day where the month is shorter: 29 February
 * has no counterpart in a common year and lands on the 28th rather than sliding into March
 * (which would silently compare a report against the wrong period).
 */
export function addYears(iso, n) {
  const d = parseISO(iso);
  const day = d.getDate();
  const month = d.getMonth();
  d.setDate(1);
  d.setFullYear(d.getFullYear() + n);
  d.setMonth(month);
  const last = new Date(d.getFullYear(), month + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISO(d);
}

export function startOfMonth(iso) {
  const d = parseISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function endOfMonth(iso) {
  const d = parseISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

export function compareISO(a, b) {
  return a === b ? 0 : (a < b ? -1 : 1);
}

export function inRange(iso, from, to) {
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

/**
 * Australian financial year by default: starts 1 July, ends 30 June.
 * fyStartMonth is 1-12; month 7 === July.
 */
export function fyStartFor(iso, fyStartMonth = 7) {
  const d = parseISO(iso);
  const y = d.getMonth() + 1 >= fyStartMonth ? d.getFullYear() : d.getFullYear() - 1;
  const m = String(fyStartMonth).padStart(2, '0');
  return `${y}-${m}-01`;
}

export function fyEndFor(iso, fyStartMonth = 7) {
  return addDays(addMonths(fyStartFor(iso, fyStartMonth), 12), -1);
}

export function fyLabel(iso, fyStartMonth = 7) {
  const start = parseISO(fyStartFor(iso, fyStartMonth));
  const end = parseISO(fyEndFor(iso, fyStartMonth));
  const short = (d) => `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`;
  const sameYear = start.getFullYear() === end.getFullYear();
  return `FY ${start.getFullYear()}${sameYear ? '' : `/${String(end.getFullYear()).slice(2)}`} (${short(start)} \u2013 ${short(end)} ${end.getFullYear()})`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Display only. Style: 'd MMM yyyy' (default), 'dd/mm/yyyy', 'MMM yyyy', 'iso'. */
export function fmtDate(iso, style = 'd MMM yyyy') {
  if (!iso) return '';
  const d = parseISO(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  switch (style) {
    case 'iso': return iso;
    case 'dd/mm/yyyy': return `${dd}/${mm}/${d.getFullYear()}`;
    case 'dd/mm/yy': return `${dd}/${mm}/${String(d.getFullYear()).slice(2)}`;
    case 'MMM yyyy': return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    case 'd MMM': return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    case 'd MMM yyyy':
    default: return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
}

export function monthKey(iso) {
  return String(iso).slice(0, 7);
}

export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function monthsBetween(fromISO, toISOStr) {
  const out = [];
  let cur = startOfMonth(fromISO);
  const last = startOfMonth(toISOStr);
  let guard = 0;
  while (cur <= last && guard++ < 600) {
    out.push(monthKey(cur));
    cur = addMonths(cur, 1);
  }
  return out;
}

export function relativeDue(dueISO, asOf = todayISO()) {
  const n = daysBetween(asOf, dueISO);
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  if (n > 0) return `due in ${n} days`;
  if (n === -1) return '1 day overdue';
  return `${Math.abs(n)} days overdue`;
}
