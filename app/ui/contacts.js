/**
 * Rookeepa — Contacts.
 *
 * A customer and a supplier are the same record: one contact can be both. What
 * they owe you — and what you owe them — is never stored on the contact. It is
 * derived from their open documents, aged from the due date, so the figures on
 * this screen can never disagree with the receivables and payables reports.
 */

import {
  h, clear, append, icon, card, pageHeader, button, iconButton, table, moneyCell,
  badge, statusBadge, field, input, textarea, select, checkbox, segmented, toolbar,
  emptyState, kpi, kv, sectionTitle, modal, toast, ICONS, fmt, avatar, dateInput, printNode,
} from './kit.js';
import { agedReport } from '../core/reports.js';
import { documentSummary, paymentsByDocument } from '../core/docs.js';
import { statementFor } from '../core/statements.js';
import { PAYMENT_TERMS } from '../core/coa.js';
import { daysBetween, todayISO, addMonths } from '../core/dates.js';
import { openPaymentModal } from './payment-modal.js';
import { openDocumentEditor } from './document-editor.js';
import { statementPrintNode } from './print.js';

export const meta = {
  title: 'Contacts',
  subtitle: 'Customers and suppliers, and what each of you owes the other.',
};

const AU_STATES = [
  { value: 'NSW', label: 'New South Wales' },
  { value: 'VIC', label: 'Victoria' },
  { value: 'QLD', label: 'Queensland' },
  { value: 'SA', label: 'South Australia' },
  { value: 'WA', label: 'Western Australia' },
  { value: 'TAS', label: 'Tasmania' },
  { value: 'NT', label: 'Northern Territory' },
  { value: 'ACT', label: 'Australian Capital Territory' },
];

const DOC_LABEL = {
  invoice: 'Invoice',
  bill: 'Bill',
  quote: 'Quote',
  'credit-note-sale': 'Credit note',
  'credit-note-purchase': 'Supplier credit',
};

/** A contact with no explicit flag is treated as a customer, matching the editor. */
function isCustomer(contact) { return contact.isCustomer !== false; }
function isSupplier(contact) { return contact.isSupplier === true; }

function typeLabel(contact) {
  const cust = isCustomer(contact);
  const supp = isSupplier(contact);
  if (cust && supp) return 'Both';
  if (supp) return 'Supplier';
  return 'Customer';
}

function typeVariant(contact) {
  const cust = isCustomer(contact);
  if (cust && isSupplier(contact)) return 'positive';
  return cust ? 'info' : 'accent';
}

function termLabel(id) {
  const t = PAYMENT_TERMS.find((x) => x.id === id);
  return t ? t.label : (id || '—');
}

function stateLabel(value) {
  const s = AU_STATES.find((x) => x.value === value);
  return s ? s.label : (value || '—');
}

/* ------------------------------------------------------------------- ABN */

function abnDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/** Australian ABN checksum. Used only to show a hint — never to block a save. */
function abnValid(value) {
  const digits = abnDigits(value);
  if (digits.length !== 11) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  let total = 0;
  for (let i = 0; i < 11; i++) total += (Number(digits[i]) - (i === 0 ? 1 : 0)) * weights[i];
  return total % 89 === 0;
}

function abnHint(value) {
  const digits = abnDigits(value);
  if (!digits) return 'Optional. 11 digits, printed on the contact’s invoices.';
  if (digits.length !== 11) return `${digits.length} digit${digits.length === 1 ? '' : 's'} so far — an ABN has 11. You can still save.`;
  return abnValid(digits)
    ? 'That checks out as a valid ABN.'
    : 'These digits do not pass the ABN checksum. Check them, or save anyway if you are sure.';
}

/** 12345678901 -> "12 345 678 901" (display only). */
function formatAbn(value) {
  const d = abnDigits(value);
  if (d.length !== 11) return value || '';
  return `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8, 11)}`;
}

/* --------------------------------------------------------------- helpers */

function blankContact(ctx, preset = null) {
  return {
    companyId: ctx.companyId,
    name: '',
    isCustomer: !!(preset && preset.isCustomer),
    isSupplier: !!(preset && preset.isSupplier),
    email: '',
    phone: '',
    abn: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postcode: '',
    terms: (ctx.company && ctx.company.defaultTerms) || 'net14',
    notes: '',
    active: true,
  };
}

/**
 * Everything owed either way for one contact, summed from their documents.
 * Returns { sales: {...}, purchases: {...}, oldest: {...} }.
 */
function contactTotals(ctx, contact) {
  const asOf = ctx.asOf;
  const docs = ctx.data.documents.filter((d) => d.contactId === contact.id);
  // One pass over the receipts, shared by every document summarised on this screen.
  const paymentIndex = paymentsByDocument(ctx.data.payments || []);
  const sales = { invoiced: 0, paid: 0, outstanding: 0 };
  const purchases = { billed: 0, paid: 0, outstanding: 0 };
  let oldest = null;

  for (const d of docs) {
    if (d.status === 'void') continue;
    const s = documentSummary(d, ctx.data.taxCodes, ctx.data.payments, asOf, paymentIndex);
    const credit = d.type.startsWith('credit-note');
    const signedTotal = credit ? -s.total : s.total;
    const bucket = d.ledger === 'sales' ? sales : purchases;
    if (d.ledger === 'sales') sales.invoiced += signedTotal;
    else purchases.billed += signedTotal;
    bucket.paid += s.paid || 0;

    if (d.status === 'open') {
      const balance = credit ? -s.balance : s.balance;
      bucket.outstanding += balance;
      if (balance > 0) {
        const due = d.dueDate || d.date;
        const age = Math.max(0, daysBetween(due, asOf));
        if (!oldest || age > oldest.days) {
          oldest = { days: age, doc: d, dueDate: due, type: d.type, number: d.number };
        }
      }
    }
  }
  return { sales, purchases, oldest };
}

/* ------------------------------------------------------------- edit form */

function openContactForm(ctx, { contact = null, preset = null, onSaved } = {}) {
  const draft = contact ? { ...contact } : blankContact(ctx, preset);
  const cur = (ctx.company && ctx.company.currency) || 'AUD';

  const nameInput = input({
    value: draft.name || '',
    autofocus: true,
    placeholder: 'Business or person',
    onInput: (v) => { draft.name = v; },
  });

  const customerBox = checkbox({
    label: 'Customer — you invoice them',
    checked: isCustomer(draft),
    onChange: (v) => { draft.isCustomer = v; },
  });

  const supplierBox = checkbox({
    label: 'Supplier — they bill you',
    checked: isSupplier(draft),
    onChange: (v) => { draft.isSupplier = v; },
  });

  const emailInput = input({ value: draft.email || '', type: 'email', placeholder: 'name@example.com', onInput: (v) => { draft.email = v; } });
  const phoneInput = input({ value: draft.phone || '', placeholder: 'Phone', onInput: (v) => { draft.phone = v; } });

  const abnHintNode = h('p', { class: 'field-hint' }, abnHint(draft.abn));
  const abnInput = input({
    value: draft.abn || '',
    inputmode: 'numeric',
    placeholder: '11 111 111 111',
    onInput: (v) => { draft.abn = v; abnHintNode.textContent = abnHint(v); },
  });
  const abnField = field({ label: 'ABN', input: abnInput });
  abnField.appendChild(abnHintNode);

  const addr1 = input({ value: draft.addressLine1 || '', placeholder: 'Street address', onInput: (v) => { draft.addressLine1 = v; } });
  const addr2 = input({ value: draft.addressLine2 || '', placeholder: 'Suite, unit, floor', onInput: (v) => { draft.addressLine2 = v; } });
  const cityInput = input({ value: draft.city || '', placeholder: 'Suburb or city', onInput: (v) => { draft.city = v; } });
  const stateSelect = select({
    options: AU_STATES,
    value: draft.state || '',
    placeholder: 'Choose a state',
    onChange: (v) => { draft.state = v; },
  });
  const postcodeInput = input({ value: draft.postcode || '', inputmode: 'numeric', maxlength: 4, placeholder: '0000', onInput: (v) => { draft.postcode = v; } });

  const termsSelect = select({
    options: PAYMENT_TERMS.map((t) => ({ value: t.id, label: t.label })),
    value: draft.terms || 'net14',
    onChange: (v) => { draft.terms = v; },
  });

  const notesInput = textarea({ value: draft.notes || '', rows: 3, placeholder: 'Anything worth remembering', onInput: (v) => { draft.notes = v; } });

  const activeBox = checkbox({
    label: 'Active',
    checked: draft.active !== false,
    onChange: (v) => { draft.active = v; },
  });

  function save(close) {
    if (!draft.name || !draft.name.trim()) {
      toast('A contact needs a name.', 'warn');
      return;
    }
    const record = {
      ...draft,
      companyId: ctx.companyId,
      name: draft.name.trim(),
      isCustomer: isCustomer(draft),
      isSupplier: isSupplier(draft),
      active: draft.active !== false,
    };
    const saved = ctx.db.put('contacts', record);
    toast(contact ? `${saved.name} saved` : `${saved.name} added`, 'success');
    close(saved);
    ctx.refresh();
    onSaved && onSaved(saved);
  }

  modal({
    title: contact ? 'Edit contact' : (isSupplier(draft) && !isCustomer(draft) ? 'New supplier' : 'New customer'),
    subtitle: 'A contact can be both a customer and a supplier.',
    width: 'lg',
    body: () => h('div', null,
      h('div', { class: 'form-grid' },
        field({ label: 'Name', required: true, input: nameInput }),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, 'Type'),
          h('div', { class: 'stack', style: { gap: '0.35rem' } }, customerBox, supplierBox)),
        field({ label: 'Email', input: emailInput }),
        field({ label: 'Phone', input: phoneInput }),
        abnField,
        field({ label: 'Default terms', input: termsSelect })),
      h('div', { class: 'divider' }),
      h('div', { class: 'form-grid' },
        field({ label: 'Address', input: addr1 }),
        field({ label: 'Address line 2', input: addr2 }),
        field({ label: 'City', input: cityInput }),
        field({ label: 'State', input: stateSelect }),
        field({ label: 'Postcode', input: postcodeInput })),
      h('div', { class: 'divider' }),
      field({ label: 'Notes', input: notesInput }),
      field({ label: 'Status', input: activeBox })),
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({ label: contact ? 'Save contact' : 'Add contact', variant: 'primary', onClick: () => save(close) }),
    ],
  });
}

/* ---------------------------------------------------------- detail modal */

function openContactDetail(ctx, contactId) {
  const cur = (ctx.company && ctx.company.currency) || 'AUD';
  const body = h('div', { class: 'stack' });

  function draw() {
    clear(body);
    const contact = ctx.data.contacts.find((c) => c.id === contactId);
    if (!contact) {
      body.appendChild(emptyState({ title: 'Contact not found', message: 'It may have been deleted.' }));
      return;
    }

    const totals = contactTotals(ctx, contact);
    const netOwed = totals.sales.outstanding - totals.purchases.outstanding;

    const detailPairs = [
      ['Email', contact.email ? h('a', { class: 'link', href: `mailto:${contact.email}` }, contact.email) : '—'],
      ['Phone', contact.phone || '—'],
      ['ABN', contact.abn ? formatAbn(contact.abn) : '—'],
      ['Address', [
        contact.addressLine1, contact.addressLine2,
        [contact.city, contact.state, contact.postcode].filter(Boolean).join(' '),
      ].filter(Boolean).join(', ') || '—'],
      ['Default terms', termLabel(contact.terms)],
      ['Status', contact.active !== false ? badge('Active', 'positive') : badge('Inactive', 'muted')],
    ];

    const kpis = [];
    if (isCustomer(contact)) {
      kpis.push(kpi({ label: 'Invoiced', value: fmt.money(totals.sales.invoiced, { code: cur }) }));
    }
    if (isSupplier(contact)) {
      kpis.push(kpi({ label: 'Billed', value: fmt.money(totals.purchases.billed, { code: cur }) }));
    }
    if (isCustomer(contact)) {
      kpis.push(kpi({ label: 'Received', value: fmt.money(totals.sales.paid, { code: cur }) }));
    }
    if (isSupplier(contact)) {
      kpis.push(kpi({ label: 'Paid', value: fmt.money(totals.purchases.paid, { code: cur }) }));
    }
    kpis.push(kpi({
      label: 'Outstanding',
      value: moneyCell(netOwed, { code: cur }),
      sub: netOwed === 0 ? 'nothing outstanding' : (netOwed < 0 ? 'you owe them' : 'owed to you'),
      tone: netOwed < 0 ? 'warn' : 'default',
    }));
    kpis.push(kpi({
      label: 'Oldest debt',
      value: totals.oldest ? `${totals.oldest.days} day${totals.oldest.days === 1 ? '' : 's'}` : '—',
      sub: totals.oldest ? `${DOC_LABEL[totals.oldest.type] || 'Document'} ${totals.oldest.number || ''}`.trim() : 'nothing to collect',
    }));

    const recentDocs = ctx.data.documents
      .filter((d) => d.contactId === contact.id && d.status !== 'void')
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 8);

    // Summarised once per row here. Three columns each asked for the same summary, so every
    // receipt was searched three times per document to render one table.
    const recentDocRows = recentDocs.map((r) => ({
      ...r,
      summary: documentSummary(r, ctx.data.taxCodes, ctx.data.payments, ctx.asOf, paymentsByDocument(ctx.data.payments || [])),
    }));

    const recentPayments = ctx.data.payments
      .filter((p) => p.contactId === contact.id && p.status !== 'void')
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 8);

    append(body, [
      h('div', { class: 'row', style: { gap: '0.6rem' } },
        avatar(contact.name),
        h('div', null,
          h('strong', null, contact.name),
          h('div', { class: 'row-sub' }, `${typeLabel(contact)} · ${termLabel(contact.terms)}`))),
      kv(detailPairs),
      contact.notes ? h('p', { class: 'field-hint' }, contact.notes) : null,
      h('div', { class: 'stat-grid' }, kpis),

      sectionTitle('Recent documents', 'Invoices, bills and credit notes for this contact.'),
      recentDocs.length
        ? table({
          columns: [
            { key: 'number', label: 'Number', render: (r) => h('span', { class: 'mono' }, r.number || '—') },
            { key: 'type', label: 'Type', render: (r) => DOC_LABEL[r.type] || r.type },
            { key: 'date', label: 'Date', render: (r) => fmt.date(r.date) },
            { key: 'status', label: 'Status', render: (r) => statusBadge(r.summary.status) },
            { key: 'total', label: 'Total', align: 'right', render: (r) => moneyCell(r.summary.total, { code: cur }) },
            { key: 'balance', label: 'Balance', align: 'right', render: (r) => moneyCell(r.summary.balance, { code: cur }) },
          ],
          rows: recentDocRows,
          onRowClick: (r) => openDocumentEditor(ctx, { type: r.type, docId: r.id }),
          compact: true,
        })
        : h('p', { class: 'field-hint' }, 'No documents for this contact yet.'),

      sectionTitle('Recent payments', 'Money received from or paid to this contact.'),
      recentPayments.length
        ? table({
          columns: [
            { key: 'number', label: 'Number', render: (r) => h('span', { class: 'mono' }, r.number || '—') },
            { key: 'type', label: 'Direction', render: (r) => (r.type === 'customer' ? badge('Received', 'positive') : badge('Paid', 'info')) },
            { key: 'date', label: 'Date', render: (r) => fmt.date(r.date) },
            { key: 'method', label: 'Method' },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => moneyCell(r.amount, { code: cur }) },
          ],
          rows: recentPayments,
          compact: true,
        })
        : h('p', { class: 'field-hint' }, 'No payments recorded for this contact yet.'),
    ]);
  }

  draw();

  const handle = modal({
    title: 'Contact',
    width: 'xl',
    body,
    actions: ({ close }) => {
      const contact = ctx.data.contacts.find((c) => c.id === contactId);
      if (!contact) return [button({ label: 'Close', variant: 'ghost', onClick: () => close(null) })];
      const buttons = [
        button({ label: 'Delete', variant: 'ghost', icon: ICONS.trash, onClick: () => removeContact(ctx, contact.id, () => { close(null); }) }),
        button({
          label: contact.active === false ? 'Activate' : 'Deactivate',
          variant: 'ghost',
          onClick: () => {
            ctx.db.put('contacts', { ...contact, active: contact.active === false });
            toast(contact.active === false ? `${contact.name} activated` : `${contact.name} deactivated`, 'success');
            ctx.refresh();
            draw();
          },
        }),
        h('span', { class: 'spacer' }),
        button({ label: 'Close', variant: 'ghost', onClick: () => close(null) }),
        button({
          label: 'Edit',
          variant: 'subtle',
          icon: ICONS.edit,
          onClick: () => openContactForm(ctx, { contact, onSaved: () => draw() }),
        }),
      ];
      if (isCustomer(contact)) {
        buttons.push(button({
          label: 'New invoice',
          variant: 'ghost',
          onClick: () => openDocumentEditor(ctx, { type: 'invoice', contactId: contact.id }),
        }));
        buttons.push(button({
          label: 'Receive payment',
          variant: 'primary',
          icon: ICONS.coins,
          onClick: () => openPaymentModal(ctx, { type: 'customer', contactId: contact.id, onSaved: () => draw() }),
        }));
        buttons.push(button({
          label: 'Statement',
          variant: 'ghost',
          icon: ICONS.print,
          onClick: () => openStatementDialog(ctx, contact),
        }));
      }
      if (isSupplier(contact)) {
        buttons.push(button({
          label: 'New bill',
          variant: 'ghost',
          onClick: () => openDocumentEditor(ctx, { type: 'bill', contactId: contact.id }),
        }));
        buttons.push(button({
          label: 'Pay supplier',
          variant: 'primary',
          onClick: () => openPaymentModal(ctx, { type: 'supplier', contactId: contact.id, onSaved: () => draw() }),
        }));
      }
      return buttons;
    },
  });

  return handle;
}

/* -------------------------------------------------------------- statement */

/**
 * A statement of account for one contact, over a date range they choose. It is
 * built from the same documents and payments the screen already holds, then
 * handed to the print stylesheet, exactly like a document is printed.
 */
function openStatementDialog(ctx, contact) {
  const today = todayISO();
  let from = addMonths(today, -12); // the last 12 months, by default
  let to = today;

  const fromInput = dateInput({ value: from, onChange: (v) => { from = v; } });
  const toInput = dateInput({ value: to, onChange: (v) => { to = v; } });

  function build() {
    return statementFor({
      documents: ctx.data.documents,
      payments: ctx.data.payments,
      contactId: contact.id,
      from,
      to,
      taxCodes: ctx.data.taxCodes,
      contact,
    });
  }

  function doPrint() {
    if (from && to && from > to) {
      toast('The “from” date is after the “to” date.', 'warn');
      return;
    }
    const statement = build();
    printNode(statementPrintNode({
      company: ctx.company,
      contact,
      statement,
      asOf: to || today,
    }), { title: `Statement of account — ${contact.name}` });
  }

  modal({
    title: 'Statement of account',
    subtitle: `Invoices, credit notes and receipts for ${contact.name}.`,
    width: 'sm',
    body: () => h('div', { class: 'stack' },
      h('div', { class: 'form-grid' },
        field({ label: 'From', input: fromInput }),
        field({ label: 'To', input: toInput })),
      h('p', { class: 'field-hint' },
        'Shows the balance carried in, then every movement in the range, running the balance forward. It is a statement of account, not a tax invoice.')),
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({ label: 'Print statement', variant: 'primary', icon: ICONS.print, onClick: doPrint }),
    ],
  });
}

/* ---------------------------------------------------------------- delete */

async function removeContact(ctx, contactId, onDone) {
  const contact = ctx.data.contacts.find((c) => c.id === contactId);
  if (!contact) return;

  const docs = ctx.data.documents.filter((d) => d.contactId === contactId);
  const payments = ctx.data.payments.filter((p) => p.contactId === contactId && p.status !== 'void');

  if (docs.length || payments.length) {
    const ok = await ctx.confirm({
      title: `Cannot delete ${contact.name}`,
      message: `${contact.name} is used by ${docs.length} document${docs.length === 1 ? '' : 's'} and ${payments.length} payment${payments.length === 1 ? '' : 's'}. Deleting would orphan them.`,
      detail: 'Deactivate the contact instead — they disappear from new documents but their history stays intact.',
      confirmLabel: 'Deactivate',
    });
    if (!ok) return;
    ctx.db.put('contacts', { ...contact, active: false });
    toast(`${contact.name} deactivated`, 'success');
    ctx.refresh();
    onDone && onDone();
    return;
  }

  const ok = await ctx.confirm({
    title: `Delete ${contact.name}?`,
    message: 'This contact has no documents or payments, so nothing in the ledger changes.',
    confirmLabel: 'Delete contact',
    danger: true,
  });
  if (!ok) return;
  ctx.db.remove('contacts', contactId);
  toast(`${contact.name} deleted`, 'success');
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
    actions: [
      button({
        label: 'New customer',
        variant: 'ghost',
        icon: ICONS.plus,
        onClick: () => openContactForm(ctx, { preset: { isCustomer: true, isSupplier: false } }),
      }),
      button({
        label: 'New supplier',
        variant: 'primary',
        icon: ICONS.plus,
        onClick: () => openContactForm(ctx, { preset: { isCustomer: false, isSupplier: true } }),
      }),
    ],
  }));

  const ar = agedReport({
    accounts: ctx.data.accounts, entries: ctx.data.entries, documents: ctx.data.documents,
    payments: ctx.data.payments, taxCodes: ctx.data.taxCodes, kind: 'receivable', asOf: ctx.asOf,
  });
  const ap = agedReport({
    accounts: ctx.data.accounts, entries: ctx.data.entries, documents: ctx.data.documents,
    payments: ctx.data.payments, taxCodes: ctx.data.taxCodes, kind: 'payable', asOf: ctx.asOf,
  });

  const contacts = ctx.data.contacts.slice();
  const customerCount = contacts.filter(isCustomer).length;
  const supplierCount = contacts.filter(isSupplier).length;

  el.appendChild(h('div', { class: 'stat-grid' },
    kpi({ label: 'Customers', value: String(customerCount), sub: 'contacts you invoice', tone: 'accent' }),
    kpi({ label: 'Suppliers', value: String(supplierCount), sub: 'contacts who bill you' }),
    kpi({ label: 'Owed to you', value: fmt.money(ar.totals.total, { code: cur }), sub: 'aged receivables', tone: 'positive' }),
    kpi({ label: 'You owe', value: fmt.money(ap.totals.total, { code: cur }), sub: 'aged payables', tone: 'warn' })));

  const arByContact = new Map(ar.rows.map((r) => [r.contactId, r.total]));
  const apByContact = new Map(ap.rows.map((r) => [r.contactId, r.total]));
  const owedFor = (contact) => (arByContact.get(contact.id) || 0) - (apByContact.get(contact.id) || 0);

  let segmentValue = 'all';
  let query = '';

  const tableHost = h('div');


  function rowsFor() {
    const needle = query.trim().toLowerCase();
    return contacts
      .filter((c) => {
        if (segmentValue === 'customers' && !isCustomer(c)) return false;
        if (segmentValue === 'suppliers' && !isSupplier(c)) return false;
        if (!needle) return true;
        return [c.name, c.email, c.abn, c.city].some((v) => String(v || '').toLowerCase().includes(needle));
      })
      .map((c) => ({ contact: c, owed: owedFor(c) }));
  }

  function drawTable() {
    clear(tableHost);
    const rows = rowsFor();
    if (!contacts.length) {
      tableHost.appendChild(emptyState({
        title: 'No contacts yet',
        message: 'Add the people and businesses you trade with. A contact can be a customer, a supplier, or both.',
      }));
      return;
    }
    if (!rows.length) {
      tableHost.appendChild(emptyState({
        title: 'Nothing matches',
        message: 'No contacts match the current filter or search.',
      }));
      return;
    }
    tableHost.appendChild(table({
      columns: [
        {
          key: 'name', label: 'Name', sortable: true,
          sortValue: (r) => r.contact.name,
          render: (r) => h('div', { class: 'row', style: { gap: '0.5rem' } },
            avatar(r.contact.name),
            h('span', { class: 'strong' }, r.contact.name)),
        },
        {
          key: 'type', label: 'Type', sortable: true,
          sortValue: (r) => typeLabel(r.contact),
          render: (r) => badge(typeLabel(r.contact), typeVariant(r.contact)),
        },
        { key: 'email', label: 'Email', sortable: true, sortValue: (r) => r.contact.email, render: (r) => (r.contact.email ? h('a', { class: 'link', href: `mailto:${r.contact.email}` }, r.contact.email) : '—') },
        { key: 'phone', label: 'Phone', render: (r) => r.contact.phone || '—' },
        { key: 'abn', label: 'ABN', render: (r) => (r.contact.abn ? h('span', { class: 'mono' }, formatAbn(r.contact.abn)) : '—') },
        { key: 'terms', label: 'Terms', sortable: true, sortValue: (r) => termLabel(r.contact.terms), render: (r) => termLabel(r.contact.terms) },
        {
          key: 'owed', label: 'Owed', align: 'right', sortable: true,
          sortValue: (r) => r.owed,
          title: 'Positive is owed to you, negative is what you owe them.',
          render: (r) => moneyCell(r.owed, { code: cur, muted: r.owed === 0 }),
        },
        {
          key: 'actions', label: '', align: 'right', render: (r) => h('div', { class: 'table-actions' },
            iconButton({
              label: `Edit ${r.contact.name}`,
              icon: ICONS.edit,
              onClick: () => openContactForm(ctx, { contact: r.contact }),
            })),
        },
      ],
      rows,
      onRowClick: (r) => openContactDetail(ctx, r.contact.id),
    }));
  }

  const searchBox = h('div', { class: 'search-box' },
    icon(ICONS.search, { size: 16 }),
    input({
      type: 'search',
      placeholder: 'Search name, email, ABN or city',
      onInput: (v) => { query = v; drawTable(); },
    }));

  // Rebuilt on every change. The segmented helper bakes `is-active` in when it is constructed, so a control
  // built once shows the choice it was born with — which is why clicking Customers filtered the table while
  // "All" stayed lit.
  const segHost = h('div');
  const drawSegments = () => {
    clear(segHost);
    segHost.appendChild(segmented({
      options: [
      { value: 'all', label: 'All' },
      { value: 'customers', label: 'Customers' },
      { value: 'suppliers', label: 'Suppliers' },
    ],
      value: segmentValue,
      onChange: (v) => { segmentValue = v; drawSegments(); drawTable(); },
    }));
  };

  el.appendChild(toolbar({
    left: [segHost, searchBox],
    right: [h('span', { class: 'small muted' }, `${contacts.length} contact${contacts.length === 1 ? '' : 's'}`)],
  }));

  el.appendChild(card({ flush: true, body: tableHost }));

  drawSegments();
  drawTable();
  return el;
}
