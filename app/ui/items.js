/**
 * Rookeepa — Items.
 *
 * Items are optional. They exist so that repeatable products and services carry
 * their price, tax code and account with them — pick one on an invoice or bill
 * and the line fills itself in. Nothing forces you to use them, and a one-off
 * line on a document works exactly the same without one.
 *
 * Quantities are stored in thousandths (1.5 units is 1500) and money in cents,
 * exactly as everywhere else in Rookeepa.
 */

import {
  h, clear, icon, card, pageHeader, button, iconButton, table, moneyCell,
  badge, field, input, textarea, select, checkbox, moneyInput, qtyInput, segmented, toolbar,
  emptyState, kpi, modal, toast, ICONS, fmt,
} from './kit.js';
import { mulQty } from '../core/money.js';

export const meta = {
  title: 'Items',
  subtitle: 'Optional products and services. Use them for things you sell or buy again and again, so invoice and bill lines fill themselves in.',
};

/* --------------------------------------------------------------- helpers */

function incomeAccounts(ctx) {
  return ctx.data.accounts
    .filter((a) => a.type === 'income' && a.active !== false)
    .sort((a, b) => a.code.localeCompare(b.code));
}

function inventoryAccounts(ctx) {
  return ctx.data.accounts
    .filter((a) => a.control === 'inventory' && a.active !== false)
    .sort((a, b) => a.code.localeCompare(b.code));
}

function accountName(ctx, code) {
  const acc = ctx.data.accounts.find((a) => a.code === code);
  return acc ? acc.name : (code || '');
}

function isTracked(item) { return item.trackInventory === true; }
function isActive(item) { return item.active !== false; }

/** How many documents carry a line pointing at this item. */
function docReferenceCount(ctx, itemId) {
  return ctx.data.documents.filter((d) => (d.lines || []).some((l) => l.itemId === itemId)).length;
}

function stockValue(items) {
  let total = 0;
  for (const item of items) {
    if (!isTracked(item)) continue;
    total += mulQty(item.qtyOnHand || 0, item.costCents || 0);
  }
  return total;
}

function blankItem(ctx) {
  const incomes = incomeAccounts(ctx);
  const preferred = incomes.find((a) => a.code === (ctx.company && ctx.company.defaultSalesAccount)) || incomes[0];
  const accountCode = preferred ? preferred.code : '';
  const taxCode = (ctx.data.taxCodes.find((t) => t.code === (preferred && preferred.gstDefault)) || ctx.data.taxCodes[0] || { code: 'GST' }).code;
  return {
    companyId: ctx.companyId,
    code: '',
    name: '',
    description: '',
    priceCents: 0,
    costCents: 0,
    taxCode,
    accountCode,
    inventoryAccountCode: (inventoryAccounts(ctx)[0] || {}).code || '',
    trackInventory: false,
    qtyOnHand: 0,
    active: true,
  };
}

/* ------------------------------------------------------------- edit form */

function openItemForm(ctx, { item = null, onSaved } = {}) {
  const draft = item ? { ...item } : blankItem(ctx);
  const cur = (ctx.company && ctx.company.currency) || 'AUD';
  const incomes = incomeAccounts(ctx);
  const inventories = inventoryAccounts(ctx);

  const codeInput = input({ value: draft.code || '', placeholder: 'e.g. CONSULT', onInput: (v) => { draft.code = v; } });
  const nameInput = input({ value: draft.name || '', autofocus: true, placeholder: 'What it is', onInput: (v) => { draft.name = v; } });
  const descInput = textarea({ value: draft.description || '', rows: 2, placeholder: 'Wording that appears on the line', onInput: (v) => { draft.description = v; } });

  const priceInput = moneyInput({ value: draft.priceCents || 0, code: cur, onChange: (v) => { draft.priceCents = v; } });
  const costInput = moneyInput({ value: draft.costCents || 0, code: cur, onChange: (v) => { draft.costCents = v; } });

  const taxSelect = select({
    options: ctx.data.taxCodes.map((t) => ({ value: t.code, label: `${t.code} — ${t.name}` })),
    value: draft.taxCode || 'GST',
    onChange: (v) => { draft.taxCode = v; },
  });

  const incomeSelect = select({
    options: [{ value: '', label: 'Choose an income account…' }, ...incomes.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` }))],
    value: draft.accountCode || '',
    placeholder: 'Choose an income account…',
    onChange: (v) => { draft.accountCode = v; },
  });

  const trackBox = checkbox({
    label: 'Track inventory for this item',
    checked: isTracked(draft),
    onChange: (v) => { draft.trackInventory = v; drawStock(); },
  });

  const activeBox = checkbox({
    label: 'Active',
    checked: isActive(draft),
    onChange: (v) => { draft.active = v; },
  });

  const stockHost = h('div', { class: 'form-grid' });

  function drawStock() {
    clear(stockHost);
    if (!isTracked(draft)) return;
    stockHost.appendChild(field({
      label: 'Stock on hand',
      input: qtyInput({ value: draft.qtyOnHand || 0, onChange: (v) => { draft.qtyOnHand = v; } }),
      hint: 'Quantities carry three decimal places — 1.5 is entered as 1.5.',
    }));
    stockHost.appendChild(field({
      label: 'Inventory account',
      input: select({
        options: [{ value: '', label: 'Choose an inventory account…' }, ...inventories.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` }))],
        value: draft.inventoryAccountCode || '',
        placeholder: 'Choose an inventory account…',
        onChange: (v) => { draft.inventoryAccountCode = v; },
      }),
      hint: inventories.length ? 'Where this stock sits on the balance sheet.' : 'No account is flagged as an inventory account — add one under Accounts.',
    }));
  }

  function save(close) {
    if (!draft.name || !draft.name.trim()) {
      toast('An item needs a name.', 'warn');
      return;
    }
    const record = {
      ...draft,
      companyId: ctx.companyId,
      name: draft.name.trim(),
      code: (draft.code || '').trim(),
      trackInventory: isTracked(draft),
      qtyOnHand: isTracked(draft) ? (draft.qtyOnHand || 0) : 0,
      active: isActive(draft),
    };
    const saved = ctx.db.put('items', record);
    toast(item ? `${saved.name} saved` : `${saved.name} added`, 'success');
    close(saved);
    ctx.refresh();
    onSaved && onSaved(saved);
  }

  modal({
    title: item ? 'Edit item' : 'New item',
    subtitle: 'Item details are copied onto a document line when you pick the item, and can still be edited there.',
    width: 'lg',
    body: () => h('div', null,
      h('div', { class: 'form-grid' },
        field({ label: 'Code', input: codeInput }),
        field({ label: 'Name', required: true, input: nameInput }),
        field({ label: 'Sell price', input: priceInput, hint: 'The default price used on new sales lines.' }),
        field({ label: 'Cost', input: costInput, hint: 'Used for stock value and, with perpetual inventory, cost of goods sold.' }),
        field({ label: 'Tax code', input: taxSelect }),
        field({ label: 'Income account', input: incomeSelect, hint: 'The account a sale of this item posts to.' })),
      field({ label: 'Description', input: descInput }),
      h('div', { class: 'divider' }),
      field({ label: 'Inventory', input: trackBox }),
      stockHost,
      h('div', { class: 'divider' }),
      field({ label: 'Status', input: activeBox })),
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({ label: item ? 'Save item' : 'Add item', variant: 'primary', onClick: () => save(close) }),
    ],
  });

  drawStock();
}

/* ---------------------------------------------------------------- delete */

async function removeItem(ctx, itemId, onDone) {
  const item = ctx.data.items.find((i) => i.id === itemId);
  if (!item) return;

  const used = docReferenceCount(ctx, itemId);
  if (used > 0) {
    const ok = await ctx.confirm({
      title: `Cannot delete ${item.name}`,
      message: `${used} document${used === 1 ? '' : 's'} use${used === 1 ? 's' : ''} this item. Deleting it would leave those lines pointing at nothing.`,
      detail: 'Deactivate the item instead — it stops appearing on new documents while existing ones keep working.',
      confirmLabel: 'Deactivate',
    });
    if (!ok) return;
    ctx.db.put('items', { ...item, active: false });
    toast(`${item.name} deactivated`, 'success');
    ctx.refresh();
    onDone && onDone();
    return;
  }

  const ok = await ctx.confirm({
    title: `Delete ${item.name}?`,
    message: 'This item is not used on any document, so nothing in the ledger changes.',
    confirmLabel: 'Delete item',
    danger: true,
  });
  if (!ok) return;
  ctx.db.remove('items', itemId);
  toast(`${item.name} deleted`, 'success');
  ctx.refresh();
  onDone && onDone();
}

/* ----------------------------------------------------------------- screen */

export async function render(ctx) {
  const cur = (ctx.company && ctx.company.currency) || 'AUD';
  const el = h('div');

  el.appendChild(pageHeader({
    title: meta.title,
    subtitle: meta.subtitle,
    actions: [button({
      label: 'New item',
      variant: 'primary',
      icon: ICONS.plus,
      onClick: () => openItemForm(ctx),
    })],
  }));

  const items = ctx.data.items.slice();
  const tracked = items.filter(isTracked);

  el.appendChild(h('div', { class: 'stat-grid' },
    kpi({ label: 'Items', value: String(items.length), sub: 'products and services', tone: 'accent' }),
    kpi({ label: 'Stock tracked', value: String(tracked.length), sub: 'items with inventory' }),
    kpi({ label: 'Stock value', value: fmt.money(stockValue(items), { code: cur }), sub: 'quantity on hand at cost' })));

  let segmentValue = 'all';
  let query = '';

  const tableHost = h('div');

  function rowsFor() {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (segmentValue === 'tracked' && !isTracked(item)) return false;
      if (segmentValue === 'untracked' && isTracked(item)) return false;
      if (segmentValue === 'inactive' && isActive(item)) return false;
      if (!needle) return true;
      return [item.code, item.name, item.description].some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }

  function drawTable() {
    clear(tableHost);
    if (!items.length) {
      tableHost.appendChild(emptyState({
        title: 'No items yet',
        message: 'Items are optional. Add one when you find yourself typing the same description, price and account over and over.',
        action: button({ label: 'New item', variant: 'primary', icon: ICONS.plus, onClick: () => openItemForm(ctx) }),
      }));
      return;
    }
    const rows = rowsFor();
    if (!rows.length) {
      tableHost.appendChild(emptyState({ title: 'Nothing matches', message: 'No items match the current filter or search.' }));
      return;
    }
    tableHost.appendChild(table({
      columns: [
        {
          key: 'code', label: 'Code', sortable: true, className: 'mono',
          sortValue: (r) => r.code, render: (r) => (r.code ? h('span', { class: 'mono' }, r.code) : '—'),
        },
        {
          key: 'name', label: 'Name', sortable: true,
          sortValue: (r) => r.name,
          render: (r) => {
            const refs = docReferenceCount(ctx, r.id);
            return h('div', null,
              h('span', { class: 'strong' }, r.name),
              refs ? h('div', { class: 'row-sub' }, `Used on ${refs} document${refs === 1 ? '' : 's'}`) : null);
          },
        },
        { key: 'priceCents', label: 'Sell price', align: 'right', sortable: true, render: (r) => moneyCell(r.priceCents, { code: cur }) },
        { key: 'costCents', label: 'Cost', align: 'right', sortable: true, render: (r) => moneyCell(r.costCents, { code: cur }) },
        { key: 'taxCode', label: 'Tax code', render: (r) => badge(r.taxCode || 'N-T', 'muted') },
        { key: 'accountCode', label: 'Income account', sortable: true, sortValue: (r) => accountName(ctx, r.accountCode), render: (r) => accountName(ctx, r.accountCode) || '—' },
        {
          key: 'qtyOnHand', label: 'Stock on hand', align: 'right', sortable: true,
          sortValue: (r) => (isTracked(r) ? (r.qtyOnHand || 0) : -1),
          render: (r) => (isTracked(r) ? h('span', { class: 'num' }, fmt.qty(r.qtyOnHand)) : h('span', { class: 'muted' }, '—')),
        },
        {
          key: 'active', label: 'Status', sortable: true,
          sortValue: (r) => (isActive(r) ? 'Active' : 'Inactive'),
          render: (r) => (isActive(r) ? badge('Active', 'positive') : badge('Inactive', 'muted')),
        },
        {
          key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'table-actions' },
            iconButton({ label: `Edit ${r.name}`, icon: ICONS.edit, onClick: () => openItemForm(ctx, { item: r }) }),
            iconButton({ label: `Delete ${r.name}`, icon: ICONS.trash, onClick: () => removeItem(ctx, r.id) })),
        },
      ],
      rows,
      onRowClick: (r) => openItemForm(ctx, { item: r }),
    }));
  }

  const searchBox = h('div', { class: 'search-box' },
    icon(ICONS.search, { size: 16 }),
    input({
      type: 'search',
      placeholder: 'Search code, name or description',
      onInput: (v) => { query = v; drawTable(); },
    }));

  const segmentControl = segmented({
    options: [
      { value: 'all', label: 'All' },
      { value: 'tracked', label: 'Tracked' },
      { value: 'untracked', label: 'Untracked' },
      { value: 'inactive', label: 'Inactive' },
    ],
    value: segmentValue,
    onChange: (v) => { segmentValue = v; drawTable(); },
  });

  el.appendChild(toolbar({
    left: [segmentControl, searchBox],
    right: [h('span', { class: 'small muted' }, `${items.length} item${items.length === 1 ? '' : 's'}`)],
  }));

  el.appendChild(card({ flush: true, body: tableHost }));

  drawTable();
  return el;
}
