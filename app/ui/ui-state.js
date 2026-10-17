/**
 * Rookeepa — UI state.
 *
 * Small, boring, persistent UI preferences (which company file is open, the
 * date range you last looked at, light or dark). Kept apart from the books
 * themselves so that clearing it can never damage your data.
 */

const KEY = 'rookeepa:ui';

const DEFAULTS = {
  companyId: null,
  theme: 'system',
  asOf: null,
  reportFrom: null,
  reportTo: null,
  reportCompare: true,
  sidebarCollapsed: false,
  bankAccount: null,
  lastView: 'dashboard',
  hideEmptyReportRows: true,
};

function read() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export class UiState {
  constructor(initial = {}) {
    this.values = { ...read(), ...initial };
    this.listeners = new Set();
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    if (this.values[key] === value) return value;
    this.values[key] = value;
    this.save();
    return value;
  }

  patch(partial) {
    Object.assign(this.values, partial);
    this.save();
  }

  save() {
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(this.values));
    } catch { /* private mode: preferences just will not persist */ }
  }

  get theme() { return this.values.theme; }

  applyTheme() {
    const root = document.documentElement;
    const theme = this.values.theme;
    root.dataset.theme = theme === 'system' ? '' : theme;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }
}

/** Route shapes:
 *   #/dashboard
 *   #/sales?status=open
 *   #/sales/invoice/<id>
 *   #/reports/pnl?from=2026-07-01&to=2026-09-30
 */
export function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = {};
  for (const [k, v] of new URLSearchParams(queryPart || '')) query[k] = v;
  return {
    view: segments[0] || 'dashboard',
    segments,
    query,
    path: `#/${segments.join('/')}${queryPart ? `?${queryPart}` : ''}`,
  };
}

export function buildHash(view, segments = [], query = {}) {
  const path = [view, ...segments].filter(Boolean).join('/');
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const s = qs.toString();
  return `#/${path}${s ? `?${s}` : ''}`;
}
