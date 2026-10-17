import {
  addDays, addMonths, endOfMonth, fyEndFor, fyStartFor, parseISO, startOfMonth, toISO, todayISO,
} from './dates.js';

/*
 * Quick date ranges — "this quarter", "last financial year", and the rest.
 *
 * There were three copies of this: one in the journals screen, one in reports, one in sales. They had
 * drifted, which is what copies do — the same idea under three sets of names (`month` / `this-month`,
 * `quarter` / `this-quarter`, `fy` / `this-fy`), and between them no week and no last financial year.
 * A person asking for the previous quarter got it in some screens and not others.
 *
 * So the ranges live here once. Every one is derived from the app's own date helpers rather than
 * re-implemented, so a preset and the fiscal-year reports can never disagree about when the year
 * starts, and the business's own fyStartMonth is honoured — a business that does not run July to June
 * should not be handed July to June.
 *
 * Weeks start on Monday, which is what "this week" means to the small Australian businesses this is
 * for.
 */

export const DATE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'this-week', label: 'This week' },
  { value: 'last-week', label: 'Last week' },
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'this-quarter', label: 'This quarter' },
  { value: 'last-quarter', label: 'Last quarter' },
  { value: 'this-fy', label: 'This financial year' },
  { value: 'last-fy', label: 'Last financial year' },
  { value: 'ytd', label: 'Year to date' },
];

/** Ranges a screen may still offer that are not a date range at all. */
/**
 * The lower bound "all time" uses. A report needs a real range, and the earliest a ledger can meaningfully
 * hold is a sentinel rather than a computed date — matchPreset recognises this exact value as "all".
 */
export const ALL_TIME_FROM = '1970-01-01';

export const NON_RANGE_PRESETS = [
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

/*
 * Older key names, still understood. A screen holds its choice in UI state, so renaming a key would
 * quietly reset whatever a person had chosen — and a key that meant one thing in one screen and
 * nothing in another is how the copies drifted apart in the first place.
 */
const ALIASES = {
  month: 'this-month',
  'prev-month': 'last-month',
  quarter: 'this-quarter',
  fy: 'this-fy',
  'last-year': 'last-fy',
};

export function canonicalPreset(key) {
  const k = String(key ?? '');
  return ALIASES[k] || k;
}

export function presetLabel(key) {
  const k = canonicalPreset(key);
  const hit = DATE_PRESETS.concat(NON_RANGE_PRESETS).find((p) => p.value === k);
  return hit ? hit.label : k;
}

/** Monday of the week containing this date. */
function startOfWeek(iso) {
  const d = parseISO(iso);
  const sinceMonday = (d.getDay() + 6) % 7;
  return addDays(iso, -sinceMonday);
}

function startOfQuarter(iso) {
  const d = parseISO(iso);
  return toISO(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1));
}

/** The last day of the quarter that starts on this date. */
function endOfQuarter(startISO) {
  return endOfMonth(addMonths(startISO, 2));
}

/**
 * The date range for a preset, as `{ from, to }` — both inclusive.
 *
 * Returns `null` for a key that is not a range at all (`custom`, or anything unrecognised) so a caller
 * can tell "no dates apply" from "an empty range", which are different questions. `all` is a range of
 * no bounds rather than null: the screen asked to filter by dates and the answer is "none of them".
 */
export function presetRange(key, opts = {}) {
  const asOf = opts.asOf || todayISO();
  const fm = opts.fyStartMonth || 7;

  switch (canonicalPreset(key)) {
    case 'today':
      return { from: asOf, to: asOf };
    case 'this-week': {
      const monday = startOfWeek(asOf);
      return { from: monday, to: addDays(monday, 6) };
    }
    case 'last-week': {
      const monday = addDays(startOfWeek(asOf), -7);
      return { from: monday, to: addDays(monday, 6) };
    }
    case 'this-month':
      return { from: startOfMonth(asOf), to: endOfMonth(asOf) };
    case 'last-month': {
      const anchor = addMonths(asOf, -1);
      return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
    }
    case 'this-quarter': {
      const start = startOfQuarter(asOf);
      return { from: start, to: endOfQuarter(start) };
    }
    case 'last-quarter': {
      const start = addMonths(startOfQuarter(asOf), -3);
      return { from: start, to: endOfQuarter(start) };
    }
    case 'this-fy':
      return { from: fyStartFor(asOf, fm), to: fyEndFor(asOf, fm) };
    case 'last-fy': {
      // The day before this year started is, by definition, in the previous one — which avoids doing
      // year arithmetic by hand and getting it wrong either side of a financial year that does not
      // begin in January.
      const anchor = addDays(fyStartFor(asOf, fm), -1);
      return { from: fyStartFor(anchor, fm), to: fyEndFor(anchor, fm) };
    }
    case 'ytd':
      return { from: fyStartFor(asOf, fm), to: asOf };
    case 'all':
      return { from: null, to: null };
    default:
      return null;
  }
}

/** Which preset a pair of dates corresponds to, or null. Used to show the choice back to the user. */
export function matchPreset(from, to, opts = {}) {
  // Checked before the named presets: an all-time range must not be mistaken for one of them, which is how
  // choosing "All time" used to leave "Year to date" lit.
  if (from === ALL_TIME_FROM) return 'all';
  if (from === null && to === null) return 'all';
  for (const p of DATE_PRESETS) {
    const r = presetRange(p.value, opts);
    if (r && r.from === from && r.to === to) return p.value;
  }
  if (from === null && to === null) return 'all';
  return null;
}
