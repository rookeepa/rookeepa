/**
 * Rookeepa — UI kit.
 *
 * Every view is built from these pieces, so the app stays consistent and a
 * contributor only has to learn one small vocabulary. No framework, no build
 * step: plain DOM, deliberately.
 */

import { formatCents, formatPlain, formatRaw, formatQty, toCents, currency } from '../core/money.js';
import { fmtDate, todayISO, addDays, fyStartFor, fyEndFor, fyLabel } from '../core/dates.js';

/* ------------------------------------------------------------------ basics */

/** Hyperscript: h('div', { class: 'x' }, 'text', childNode). */
export function h(tag, attrs = null, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') node.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value' && 'value' in node) node.value = value;
      else if (key === 'checked' && 'checked' in node) node.checked = !!value;
      else if (key === 'disabled' && 'disabled' in node) node.disabled = !!value;
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function icon(path, opts = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(opts.size || 16));
  svg.setAttribute('height', String(opts.size || 16));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(opts.weight || 1.8));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path;
  return svg;
}

export const ICONS = {
  dashboard: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 8h6V4h-6z"/>',
  sales: '<path d="M3 7h18v12H3z"/><path d="M3 11h18"/><path d="M7 15h4"/>',
  purchases: '<path d="M6 3h12l2 5H4z"/><path d="M5 8v11h14V8"/><path d="M9 12h6"/>',
  contacts: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><path d="M17 11h4M19 9v4"/>',
  items: '<path d="M4 7l8-4 8 4-8 4z"/><path d="M4 7v10l8 4 8-4V7"/>',
  banking: '<path d="M3 10l9-6 9 6"/><path d="M5 10v9M10 10v9M14 10v9M19 10v9"/><path d="M3 21h18"/>',
  journal: '<path d="M5 3h11l3 3v15H5z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  accounts: '<path d="M4 5h16v14H4z"/><path d="M4 10h16M9 14h7"/>',
  reports: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-5M12 16V7M16 16v-8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  print: '<path d="M7 9V4h10v5"/><path d="M7 18H5v-6h14v6h-2"/><path d="M7 14h10v6H7z"/>',
  download: '<path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 20h14"/>',
  upload: '<path d="M12 20V10"/><path d="M8 13l4-4 4 4"/><path d="M5 4h14"/>',
  trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/>',
  warning: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  bank: '<path d="M4 10h16v9H4z"/><path d="M4 10l8-6 8 6"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  // Recurring: a cycle with an arrowhead, for a schedule that comes round again.
  recurring: '<path d="M4 11a8 8 0 0 1 13.7-5.6L20 7.5"/><path d="M20 3.5v4h-4"/><path d="M20 13a8 8 0 0 1-13.7 5.6L4 16.5"/><path d="M4 20.5v-4h4"/>',
  arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  coins: '<ellipse cx="9" cy="7" rx="5" ry="3"/><path d="M4 7v5c0 1.7 2.2 3 5 3s5-1.3 5-3V7"/><path d="M14 12c0 1.7 2.2 3 5 3s3-1.3 3-3"/>',
};

/* ------------------------------------------------------------- formatting */

export const fmt = {
  money: (cents, opts = {}) => formatCents(cents, opts),
  plain: (cents, dp) => formatPlain(cents, dp),
  raw: (cents, dp) => formatRaw(cents, dp),
  qty: (milli, opts) => formatQty(milli, opts),
  date: (iso, style) => fmtDate(iso, style),
  percent: (value, dp = 1) => `${(value * 100).toFixed(dp)}%`,
  today: () => todayISO(),
};

/* ---------------------------------------------------------------- buttons */

export function button({
  label, onClick, variant = 'default', size = 'md', icon: iconPath, title, disabled, type = 'button',
  className = '', busy, href,
} = {}) {
  const node = h(href ? 'a' : 'button', {
    class: `btn btn-${variant} btn-${size} ${className}`.trim(),
    title,
    type: href ? null : type,
    href: href || null,
    disabled: disabled || busy || false,
    'aria-busy': busy ? 'true' : null,
  });
  if (iconPath) node.appendChild(icon(iconPath, { size: size === 'sm' ? 14 : 16 }));
  if (label) node.appendChild(h('span', null, label));
  if (onClick) node.addEventListener('click', async (e) => {
    // Read the LIVE disabled state, not the value captured when the button was
    // built: a button created enabled and later disabled (or vice versa by an
    // enabled/disabled toggle in a form) must behave the way it looks.
    if (node.disabled || busy || node.getAttribute('aria-busy') === 'true') return;
    e.preventDefault();
    try {
      await onClick(e, node);
    } catch (err) {
      console.error(err);
      toast(err?.message || 'Something went wrong.', 'error');
    }
  });
  return node;
}

export function iconButton({ label, onClick, icon: iconPath, variant = 'ghost', size = 'sm', title }) {
  const node = button({ label: '', onClick, variant, size, icon: iconPath, title: title || label, className: 'btn-icon' });
  node.setAttribute('aria-label', label || title || '');
  return node;
}

export function buttonGroup(buttons) {
  return h('div', { class: 'btn-group' }, buttons);
}

/* ------------------------------------------------------------------ cards */

export function card({ title, subtitle, actions, body, className = '', flush = false, id, help } = {}) {
  const node = h('section', { class: `card ${className}`.trim(), id });
  if (title || actions) {
    node.appendChild(h('header', { class: 'card-head' },
      h('div', null,
        h('h2', { class: 'card-title' }, title, help ? helpDot(help) : null),
        subtitle ? h('p', { class: 'card-sub' }, subtitle) : null),
      actions ? h('div', { class: 'card-actions' }, actions) : null));
  }
  const bodyNode = h('div', { class: `card-body${flush ? ' card-body-flush' : ''}` });
  append(bodyNode, [typeof body === 'function' ? body() : body]);
  node.appendChild(bodyNode);
  return node;
}

function helpDot(text) {
  return h('span', { class: 'help-dot', title: text, tabindex: '0', 'aria-label': text }, '?');
}

/* ----------------------------------------------------------------- tables */

/**
 * table({ columns, rows, empty, onRowClick, footer, sort, caption })
 * columns: [{ key, label, align, width, render(row, i), sortable, className, title }]
 * footer:  array of arrays of cell values (or nodes), or [{ cells: [...] }]
 */
export function table({
  columns, rows, empty = 'Nothing here yet.', onRowClick, footer = [], caption, compact = false,
  rowDetail = null,
  sortKey = null, sortDir = 'asc', onSort = null, rowClass, id,
} = {}) {
  const wrap = h('div', { class: `table-wrap${compact ? ' table-compact' : ''}` });
  const tableNode = h('table', { class: 'table', id });

  if (caption) tableNode.appendChild(h('caption', null, caption));

  let currentSort = sortKey ? { key: sortKey, dir: sortDir } : null;
  const data = [...(rows || [])];

  const thead = h('thead');
  const headRow = h('tr');
  for (const col of columns) {
    const th = h('th', {
      class: `col-${col.align || 'left'}${col.sortable ? ' sortable' : ''}${col.className ? ` ${col.className}` : ''}`,
      title: col.title || col.label,
      style: col.width ? { width: col.width } : null,
      scope: 'col',
      tabindex: col.sortable ? '0' : null,
      // The sort the table was *built* with, not only the one clicked in this session. A screen that
      // remembers its sort passes it back in, and a rebuilt table was showing the rows correctly ordered
      // with no indication of which column was doing it.
      'aria-sort': col.sortable && currentSort && currentSort.key === col.key
        ? (currentSort.dir === 'asc' ? 'ascending' : 'descending')
        : null,
    });
    th.appendChild(h('span', { class: 'th-label' }, col.label ?? ''));
    if (col.sortable) {
      th.appendChild(icon('<path d="M8 9l4-4 4 4"/><path d="M8 15l4 4 4-4"/>', { size: 12 }));
      const apply = () => {
        const nextDir = currentSort && currentSort.key === col.key && currentSort.dir === 'asc' ? 'desc' : 'asc';
        currentSort = { key: col.key, dir: nextDir };
        // Tell the screen, so it can remember the sort. A rebuilt table starts unsorted, so without
        // this the column someone just sorted quietly forgets itself the next time the list
        // refreshes — after an allocation, say, which is exactly when they are working through it.
        if (onSort) onSort(currentSort.key, currentSort.dir);
        const sorted = sortRowsFor(data, col, currentSort.dir);
        // Same arguments as the initial render: passing only four dropped onRowClick and
        // rowClass, so sorting a list silently removed its row actions and click-to-open.
        renderBody(tbody, sorted, columns, empty, onRowClick, rowClass, rowDetail);
        for (const other of headRow.querySelectorAll('th')) other.removeAttribute('aria-sort');
        th.setAttribute('aria-sort', nextDir === 'asc' ? 'ascending' : 'descending');
      };
      th.addEventListener('click', apply);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); } });
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  tableNode.appendChild(thead);

  const tbody = h('tbody');
  renderBody(tbody, currentSort ? sortRowsFor(data, columns.find((c) => c.key === currentSort.key), currentSort.dir) : data, columns, empty, onRowClick, rowClass, rowDetail);
  tableNode.appendChild(tbody);

  if (footer.length) {
    const tfoot = h('tfoot');
    for (const rowDef of footer) {
      const cells = Array.isArray(rowDef) ? rowDef : rowDef.cells;
      const tr = h('tr', { class: Array.isArray(rowDef) ? null : rowDef.className });
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const value = cells[i];
        const td = h('td', { class: `col-${col?.align || 'left'}` });
        append(td, [value === undefined || value === null ? null : (value instanceof Node ? value : String(value))]);
        tr.appendChild(td);
      }
      tfoot.appendChild(tr);
    }
    tableNode.appendChild(tfoot);
  }

  wrap.appendChild(tableNode);
  return wrap;
}

function sortRowsFor(rows, col, dir) {
  if (!col) return rows;
  const mul = dir === 'desc' ? -1 : 1;
  const value = (row) => {
    const v = col.sortValue ? col.sortValue(row) : row[col.key];
    if (typeof v === 'number') return v;
    return String(v ?? '').toLowerCase();
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return String(va).localeCompare(String(vb)) * mul;
  });
}

function renderBody(tbody, rows, columns, empty, onRowClick, rowClass, rowDetail) {
  clear(tbody);
  if (!rows.length) {
    const tr = h('tr');
    tr.appendChild(h('td', { class: 'table-empty', colspan: String(columns.length) }, typeof empty === 'string' ? empty : empty));
    tbody.appendChild(tr);
    return;
  }
  rows.forEach((row, i) => {
    const tr = h('tr', {
      class: `${onRowClick ? 'clickable' : ''} ${rowClass ? rowClass(row) : ''}`.trim(),
      tabindex: onRowClick ? '0' : null,
    });
    for (const col of columns) {
      const td = h('td', { class: `col-${col.align || 'left'}${col.className ? ` ${col.className}` : ''}` });
      const rendered = col.render ? col.render(row, i) : row[col.key];
      append(td, [rendered === undefined || rendered === null ? '' : rendered]);
      tr.appendChild(td);
    }
    if (onRowClick) {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select, textarea, label')) return;
        onRowClick(row);
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); onRowClick(row); }
      });
    }
    tbody.appendChild(tr);
    // A detail row belongs to the row above it, not to the bottom of the table. A panel that answers "what is
    // this line?" has to sit under the line, or the reader holds the connection across twenty rows.
    if (rowDetail) {
      const detail = rowDetail(row, i);
      if (detail) tbody.appendChild(h('tr', { class: 'row-detail' }, h('td', { colspan: String(columns.length) }, detail)));
    }
  });
}

/**
 * The job a line or a split belongs to.
 *
 * Takes the jobs rather than looking them up, so this stays a control: whichever screen knows the company file
 * fetches them and passes them in, and nothing here needs the database. Returns nothing at all when there are
 * none, so a business that does not use jobs is never shown a field that can only say "No job".
 */
export function jobPicker(jobs, { value, onChange } = {}) {
  if (!jobs || !jobs.length) return null;
  return select({
    options: [{ value: '', label: 'No job' }, ...jobs.map((j) => ({ value: j.code, label: j.code ? `${j.code} ${j.name}` : j.name }))],
    value: value || '',
    onChange,
  });
}

export function moneyCell(cents, opts = {}) {
  const negative = (cents || 0) < 0;
  return h('span', {
    class: `num${negative ? ' neg' : ''}${opts.muted ? ' muted' : ''}`,
  }, formatCents(cents, opts));
}

export function badge(text, variant = 'neutral', opts = {}) {
  return h('span', { class: `badge badge-${variant}${opts.className ? ` ${opts.className}` : ''}`, title: opts.title }, text);
}

const STATUS_VARIANTS = {
  draft: 'muted',
  open: 'info',
  authorised: 'info',
  'partly-paid': 'warn',
  overdue: 'negative',
  paid: 'positive',
  void: 'muted',
  unreconciled: 'warn',
  reconciled: 'positive',
  posted: 'info',
  excluded: 'muted',
};

const STATUS_LABELS = {
  draft: 'Draft',
  open: 'Open',
  'partly-paid': 'Part paid',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Voided',
  unreconciled: 'To review',
  reconciled: 'Reconciled',
  posted: 'Posted',
  excluded: 'Excluded',
};

export function statusBadge(status, label) {
  return badge(label || STATUS_LABELS[status] || status, STATUS_VARIANTS[status] || 'neutral');
}

/* ------------------------------------------------------------------ forms */

export function field({ label, input, hint, error, required, className = '', id, inline = false } = {}) {
  const fieldId = id || input?.id || `f${Math.random().toString(36).slice(2, 8)}`;
  if (input && !input.id) input.id = fieldId;
  const node = h('div', { class: `field${inline ? ' field-inline' : ''} ${className}`.trim() });
  if (label) {
    node.appendChild(h('label', { class: 'field-label', for: fieldId }, label, required ? h('span', { class: 'req' }, '*') : null));
  }
  node.appendChild(input instanceof Node ? input : h('span', null, input));
  if (error) node.appendChild(h('p', { class: 'field-error' }, error));
  else if (hint) node.appendChild(h('p', { class: 'field-hint' }, hint));
  return node;
}

export function input({
  type = 'text', value = '', onInput, onChange, placeholder, name, id, min, max, step, disabled, className = '',
  autofocus, inputmode, list, maxlength, required,
} = {}) {
  const node = h('input', {
    type, value: value ?? '', placeholder, name, id, min, max, step, disabled, class: `input ${className}`.trim(),
    autofocus, inputmode, list, maxlength, required,
  });
  if (onInput) node.addEventListener('input', () => onInput(node.value, node));
  if (onChange) node.addEventListener('change', () => onChange(node.value, node));
  return node;
}

export function textarea({ value = '', onInput, placeholder, rows = 4, id, className = '', name } = {}) {
  const node = h('textarea', { class: `input textarea ${className}`.trim(), placeholder, rows, id, name });
  node.value = value ?? '';
  if (onInput) node.addEventListener('input', () => onInput(node.value, node));
  return node;
}

export function select({ options = [], value, onChange, placeholder, className = '', id, name, disabled } = {}) {
  const node = h('select', { class: `input select ${className}`.trim(), id, name, disabled });
  if (placeholder) node.appendChild(h('option', { value: '' }, placeholder));
  for (const opt of options) {
    const o = h('option', { value: opt.value, disabled: opt.disabled });
    o.textContent = opt.label;
    if (String(opt.value) === String(value ?? '')) o.selected = true;
    node.appendChild(o);
  }
  if (onChange) node.addEventListener('change', () => onChange(node.value, node));
  return node;
}

/**
 * Money input: type freely in dollars, the change handler always receives
 * integer cents. This is the only place in the UI where a decimal exists.
 */
export function moneyInput({ value = 0, onChange, placeholder = '0.00', code = 'AUD', className = '', id, autofocus, onEnter, disabled } = {}) {
  const node = h('input', {
    type: 'text', inputmode: 'decimal', class: `input input-money ${className}`.trim(),
    placeholder, id, autofocus, disabled,
    value: value ? formatRaw(value, currency(code).dp) : '',
  });
  node.addEventListener('focus', () => { if (node.value === '0.00' || node.value === '0') node.value = ''; });
  node.addEventListener('input', () => {
    const cents = toCents(node.value);
    if (onChange) onChange(cents, node);
  });
  node.addEventListener('blur', () => {
    const cents = toCents(node.value);
    node.value = cents ? formatRaw(cents, currency(code).dp) : '';
  });
  if (onEnter) node.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } });
  return node;
}

export const qtyInput = ({ value = 1000, onChange, className = '', id } = {}) => {
  const node = h('input', {
    type: 'text', inputmode: 'decimal', class: `input input-qty ${className}`.trim(), id,
    value: formatQty(value, { dp: 3 }),
  });
  node.addEventListener('input', () => {
    const milli = toCents(node.value, 3);
    if (onChange) onChange(milli, node);
  });
  node.addEventListener('blur', () => { node.value = formatQty(toCents(node.value, 3), { dp: 3 }); });
  return node;
};

export function dateInput({ value = todayISO(), onChange, className = '', id, min, max, disabled } = {}) {
  const node = h('input', { type: 'date', class: `input input-date ${className}`.trim(), value, id, min, max, disabled });
  if (onChange) node.addEventListener('change', () => onChange(node.value, node));
  return node;
}

/**
 * An account picker you can type into.
 *
 * A chart of accounts is a long list to scroll, and typing "draw" or "6-07" should find it. The
 * browser's own datalist does the filtering and the keyboard handling, so this stays a text box with a
 * list behind it rather than a hand-built dropdown.
 *
 * The value it hands back is always an account code. What is typed is a label, and it is resolved back
 * to a code before anything is committed — so a half-typed name, or a name that matches nothing, never
 * becomes a posting. Unresolvable text is marked on the box rather than silently ignored.
 */
export function accountPicker({ options = [], value = '', onChange, placeholder = 'Type to search, or pick from the list', id, className = '' }) {
  const listId = `${id || 'accounts'}_${Math.random().toString(36).slice(2, 9)}`;
  const labelFor = (code) => {
    const hit = options.find((o) => String(o.value) === String(code));
    return hit ? hit.label : '';
  };
  const box = h('input', {
    type: 'text',
    class: `input input-account ${className}`.trim(),
    list: listId,
    placeholder,
    value: labelFor(value),
    autocomplete: 'off',
  });
  const list = h('datalist', { id: listId }, ...options.map((o) => h('option', { value: o.label })));
  const wrap = h('div', { class: 'account-picker' }, box, list);

  const commit = () => {
    const typed = String(box.value || '').trim();
    // An exact label, or a code the label starts with ("6-0700"), or nothing.
    const hit = options.find((o) => o.label === typed)
      || options.find((o) => o.value === typed || o.label.startsWith(`${typed} `));
    box.classList.toggle('is-unknown', Boolean(typed) && !hit);
    onChange?.(hit ? hit.value : '', box);
  };
  box.addEventListener('change', commit);
  box.addEventListener('blur', commit);
  return wrap;
}

export function checkbox({ label, checked = false, onChange, id, className = '' }) {
  const box = h('input', { type: 'checkbox', class: 'checkbox', id, checked });
  box.addEventListener('change', () => onChange?.(box.checked, box));
  const wrap = h('label', { class: `checkbox-wrap ${className}`.trim(), for: id }, box, h('span', null, label));
  return wrap;
}

export function radioGroup({ name, options, value, onChange }) {
  const wrap = h('div', { class: 'radio-group', role: 'radiogroup' });
  for (const opt of options) {
    const id = `${name}_${opt.value}`;
    const input_ = h('input', { type: 'radio', name, id, value: opt.value, checked: String(value) === String(opt.value), class: 'radio' });
    input_.addEventListener('change', () => onChange?.(opt.value));
    wrap.appendChild(h('label', { class: 'radio-wrap', for: id }, input_, h('span', null, opt.label)));
  }
  return wrap;
}

export function segmented({ options, value, onChange, className = '' }) {
  const wrap = h('div', { class: `segmented ${className}`.trim(), role: 'tablist' });
  for (const opt of options) {
    const b = h('button', {
      type: 'button',
      class: `segmented-item${String(opt.value) === String(value) ? ' is-active' : ''}`,
      role: 'tab',
      'aria-selected': String(opt.value) === String(value) ? 'true' : 'false',
    }, opt.label);
    b.addEventListener('click', () => onChange?.(opt.value));
    wrap.appendChild(b);
  }
  return wrap;
}

export function toolbar({ left = [], right = [] } = {}) {
  return h('div', { class: 'toolbar' },
    h('div', { class: 'toolbar-left' }, left),
    h('div', { class: 'toolbar-right' }, right));
}

export function tabs({ items, active, onChange }) {
  const wrap = h('div', { class: 'tabs', role: 'tablist' });
  for (const item of items) {
    const b = h('button', {
      type: 'button',
      class: `tab${item.id === active ? ' is-active' : ''}`,
      role: 'tab',
      'aria-selected': item.id === active ? 'true' : 'false',
    }, item.label);
    if (item.count !== undefined && item.count !== null) b.appendChild(h('span', { class: 'tab-count' }, String(item.count)));
    b.addEventListener('click', () => onChange?.(item.id));
    wrap.appendChild(b);
  }
  return wrap;
}

/* ----------------------------------------------------------------- chrome */

export function pageHeader({ title, subtitle, actions, back, breadcrumb }) {
  const head = h('header', { class: 'page-head' });
  if (breadcrumb) head.appendChild(breadcrumb);
  head.appendChild(h('div', { class: 'page-head-main' },
    back ? button({ label: back.label, icon: null, variant: 'ghost', size: 'sm', onClick: back.onClick, className: 'btn-back' }) : null,
    h('h1', { class: 'page-title' }, title),
    subtitle ? h('p', { class: 'page-sub' }, subtitle) : null));
  if (actions) head.appendChild(h('div', { class: 'page-actions' }, actions));
  return head;
}

export function emptyState({ title, message, action, icon: iconPath = ICONS.file }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconPath, { size: 22 })),
    h('h3', null, title),
    message ? h('p', null, message) : null,
    action ? h('div', { class: 'empty-action' }, action) : null);
}

export function banner({ kind = 'info', title, message, actions, onDismiss } = {}) {
  return h('div', { class: `banner banner-${kind}` },
    h('span', { class: 'banner-icon' }, icon(kind === 'warning' ? ICONS.warning : ICONS.info, { size: 16 })),
    h('div', { class: 'banner-body' }, title ? h('strong', null, title) : null, message ? h('p', null, message) : null),
    actions ? h('div', { class: 'banner-actions' }, actions) : null,
    onDismiss ? iconButton({ label: 'Dismiss', icon: ICONS.close, onClick: onDismiss }) : null);
}

export function kpi({ label, value, sub, tone = 'default', onClick, id }) {
  const node = h(onClick ? 'button' : 'div', {
    class: `kpi kpi-${tone}${onClick ? ' clickable' : ''}`,
    type: onClick ? 'button' : null,
    id,
  },
  h('span', { class: 'kpi-label' }, label),
  h('span', { class: 'kpi-value' }, value),
  sub ? h('span', { class: 'kpi-sub' }, sub) : null);
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

export function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.map(([k, v]) => frag(h('dt', null, k), h('dd', null, v))));
}

export function sectionTitle(text, sub) {
  return h('div', { class: 'section-title' },
    h('h2', null, text),
    sub ? h('p', null, sub) : null);
}

/* ----------------------------------------------------------------- modals */

let modalStack = [];

/** Close every open modal (used when the route changes under them). */
export function closeAllModals() {
  for (const close of [...modalStack].reverse()) close(null);
}

export function modal({ title, subtitle, body, actions, width = 'md', onClose, dismissible = true, className = '' } = {}) {
  const overlays = document.getElementById('overlays') || document.body;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const dialog = h('div', {
    class: `modal modal-${width} ${className}`.trim(),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || 'Dialog',
  });

  const close = (result) => {
    backdrop.remove();
    modalStack = modalStack.filter((m) => m !== close);
    if (!modalStack.length) document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onKey);
    onClose?.(result);
  };
  const onKey = (e) => {
    // Escape belongs to the topmost modal only, and Tab must not escape it.
    const isTop = modalStack[modalStack.length - 1] === close;
    if (e.key === 'Escape' && dismissible && isTop) { e.stopPropagation(); close(null); }
    if (e.key === 'Tab' && isTop) trapFocus(e, dialog);
  };

  dialog.appendChild(h('header', { class: 'modal-head' },
    h('div', null,
      h('h2', { class: 'modal-title' }, title),
      subtitle ? h('p', { class: 'modal-sub' }, subtitle) : null),
    dismissible ? iconButton({ label: 'Close', icon: ICONS.close, onClick: () => close(null) }) : null));

  const bodyNode = h('div', { class: 'modal-body' });
  append(bodyNode, [typeof body === 'function' ? body({ close }) : body]);
  dialog.appendChild(bodyNode);

  if (actions) {
    const foot = h('footer', { class: 'modal-foot' });
    const list = typeof actions === 'function' ? actions({ close }) : actions;
    append(foot, list);
    dialog.appendChild(foot);
  }

  backdrop.appendChild(dialog);
  if (dismissible) backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });
  overlays.appendChild(backdrop);
  document.body.classList.add('modal-open');
  modalStack.push(close);
  document.addEventListener('keydown', onKey);

  const first = dialog.querySelector('input, select, textarea, button.btn-primary');
  if (first) setTimeout(() => first.focus(), 30);

  return { close, dialog, body: bodyNode };
}

function trapFocus(e, container) {
  const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, detail }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = modal({
      title,
      width: 'sm',
      body: h('div', null,
        h('p', { class: 'confirm-message' }, message),
        detail ? h('div', { class: 'confirm-detail' }, detail) : null),
      actions: ({ close }) => [
        button({ label: cancelLabel, variant: 'ghost', onClick: () => { done(false); close(false); } }),
        button({ label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => { done(true); close(true); } }),
      ],
      onClose: () => done(false),
    });
    m.dialog.classList.add('modal-confirm');
  });
}

export function promptDialog({ title, label, message, value = '', placeholder, confirmLabel = 'Save', multiline = false, type = 'text' }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let control;
    const getValue = () => control.value;
    const m = modal({
      title,
      width: 'sm',
      body: () => {
        const body = h('div', null, message ? h('p', { class: 'confirm-message' }, message) : null);
        control = multiline
          ? textarea({ value, rows: 3 })
          : input({ type, value, placeholder, autofocus: true });
        control.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !multiline) { e.preventDefault(); done(getValue()); m.close(getValue()); }
        });
        body.appendChild(field({ label, input: control }));
        return body;
      },
      actions: ({ close }) => [
        button({ label: 'Cancel', variant: 'ghost', onClick: () => { done(null); close(null); } }),
        button({
          label: confirmLabel,
          variant: 'primary',
          onClick: () => { done(getValue()); close(getValue()); },
        }),
      ],
      onClose: () => done(null),
    });
  });
}

export function toast(message, kind = 'info', opts = {}) {
  const host = document.getElementById('toasts') || document.body;
  const node = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast-icon' }, icon(kind === 'error' ? ICONS.warning : kind === 'success' ? ICONS.check : ICONS.info, { size: 16 })),
    h('div', { class: 'toast-body' },
      h('span', { class: 'toast-message' }, message),
      opts.detail ? h('span', { class: 'toast-detail' }, opts.detail) : null),
    opts.actionLabel ? button({ label: opts.actionLabel, variant: 'ghost', size: 'sm', onClick: () => { opts.onAction?.(); node.remove(); } }) : null);
  host.appendChild(node);
  const life = opts.duration || (kind === 'error' ? 9000 : 4000);
  setTimeout(() => { node.classList.add('leaving'); setTimeout(() => node.remove(), 250); }, life);
  return node;
}

/* --------------------------------------------------------------- printing */

/**
 * Print a node on its own page. Everything else on screen is hidden by the
 * print stylesheet, so an invoice prints like an invoice, not a screenshot.
 */
export function printNode(node, opts = {}) {
  let host = document.getElementById('print-root');
  if (!host) {
    host = h('div', { id: 'print-root', class: 'print-root' });
    document.body.appendChild(host);
  }
  clear(host);
  host.appendChild(node);
  const previousTitle = document.title;
  if (opts.title) document.title = opts.title;
  document.body.classList.add('printing');
  const cleanup = () => {
    document.body.classList.remove('printing');
    document.title = previousTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 60);
  setTimeout(cleanup, 4000);
}

/* ---------------------------------------------------------------- exports */

export function csvButton({ label = 'Export CSV', filename, headers, rows, variant = 'ghost' }) {
  return button({
    label,
    icon: ICONS.download,
    variant,
    onClick: async () => {
      const { downloadCsv } = await import('../core/backup.js');
      downloadCsv(filename, rows, headers);
      toast(`Exported ${rows.length} rows to ${filename}`, 'success');
    },
  });
}

export function paginate({ rows, page = 1, perPage = 25 }) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * perPage;
  return { rows: rows.slice(start, start + perPage), page: current, pages, total, perPage, from: total ? start + 1 : 0, to: Math.min(start + perPage, total) };
}

export function pager({ page, pages, total, from, to, onChange }) {
  if (total === 0) return h('span');
  return h('div', { class: 'pager' },
    h('span', { class: 'pager-info' }, `${from}–${to} of ${total}`),
    button({ label: 'Previous', variant: 'ghost', size: 'sm', disabled: page <= 1, onClick: () => onChange(page - 1) }),
    h('span', { class: 'pager-page' }, `Page ${page} of ${pages}`),
    button({ label: 'Next', variant: 'ghost', size: 'sm', disabled: page >= pages, onClick: () => onChange(page + 1) }));
}

export function fiscalYearOptions(company, asOf = todayISO(), years = 5) {
  const out = [];
  for (let i = -years + 1; i <= 1; i++) {
    const anchor = addDays(asOf, i * 365);
    const from = fyStartFor(anchor, company?.fyStartMonth || 7);
    const to = fyEndFor(anchor, company?.fyStartMonth || 7);
    const label = fyLabel(anchor, company?.fyStartMonth || 7);
    if (!out.some((o) => o.from === from)) out.push({ from, to, label });
  }
  return out.sort((a, b) => b.from.localeCompare(a.from));
}

export function monthOptions(asOf = todayISO(), months = 18) {
  const out = [];
  for (let i = 0; i < months; i++) {
    const d = new Date();
    const [y, m] = asOf.split('-').map(Number);
    const dt = new Date(y, m - 1 - i, 1);
    const from = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-01`;
    const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
    const to = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
    out.push({ from, to, label: fmtDate(from, 'MMM yyyy') });
  }
  return out;
}

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

export function avatar(name) {
  return h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name));
}

export function link(text, onClick) {
  return h('button', { class: 'link', type: 'button', onClick }, text);
}

export function spinner(label = 'Loading…') {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', null, label));
}

export function sortBy(rows, key, dir = 'asc', map = (r) => r[key]) {
  const mul = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = map(a);
    const vb = map(b);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return String(va ?? '').localeCompare(String(vb ?? '')) * mul;
  });
}

export function sumField(rows, mapper) {
  return rows.reduce((a, r) => a + (mapper(r) || 0), 0);
}

export function progressBar(value, max, opts = {}) {
  const pct = max ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)) },
    h('div', { class: `progress-fill ${opts.className || ''}`.trim(), style: { width: `${pct}%` } }));
}

export function barChart({ points, height = 120, labelKey = 'label', valueKey = 'value', format = (v) => String(v), tone = 'accent' }) {
  const max = Math.max(1, ...points.map((p) => Math.abs(p[valueKey])));
  const chart = h('div', { class: 'bar-chart', style: { height: `${height}px` } });
  for (const p of points) {
    const v = p[valueKey];
    const hPct = (Math.abs(v) / max) * 100;
    const col = h('div', { class: 'bar-col', title: `${p[labelKey]}: ${format(v)}` },
      h('div', { class: 'bar-track' },
        h('div', { class: `bar-fill bar-${v < 0 ? 'negative' : tone}`, style: { height: `${Math.max(2, hPct)}%` } })),
      h('span', { class: 'bar-label' }, p[labelKey]));
    chart.appendChild(col);
  }
  return chart;
}
