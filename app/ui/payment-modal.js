/**
 * Rookeepa — receive a payment / pay a supplier.
 *
 * One modal for both directions, because they are the same act seen from
 * opposite sides of the ledger. Money can be applied to specific documents or
 * left sitting on the contact's account (a credit), which is exactly what
 * happens in real life when a customer rounds up or forgets an invoice number.
 */

import {
  h, clear, field, input, select, moneyInput, dateInput, button, iconButton, badge, statusBadge,
  modal, toast, table, moneyCell, ICONS, append,
} from './kit.js';
import { blankPayment, savePayment, voidPayment, documentSummary, computeDocument } from '../core/docs.js';
import { accountByRole } from '../core/coa.js';
import { formatCents } from '../core/money.js';
import { todayISO } from '../core/dates.js';

/**
 * opts: { type: 'customer'|'supplier', contactId?, docId?, amount?:cents, lockType?:bool, onSaved?(payment) }
 */
export function openPaymentModal(ctx, opts = {}) {
  const { db, companyId, company, data } = ctx;
  let type = opts.type || 'customer';

  const bankAccounts = data.accounts.filter((a) => a.control && a.control.startsWith('bank') && a.active !== false);
  const defaultBank = bankAccounts.find((a) => a.code === company.bankAccount)?.code || bankAccounts[0]?.code || '';

  const payment = blankPayment({
    companyId,
    type,
    contactId: opts.contactId || null,
    date: ctx.asOf || todayISO(),
    amount: opts.amount || 0,
    accountCode: defaultBank,
    allocations: [],
  });

  const host = h('div', { class: 'stack' });

  const contactSelect = select({
    options: [{ value: '', label: 'Choose a contact…' }],
    value: payment.contactId || '',
    onChange: (v) => { payment.contactId = v || null; redraw(); },
  });

  const typeSegmented = h('div', { class: 'segmented', role: 'tablist' },
    h('button', {
      type: 'button',
      class: `segmented-item${type === 'customer' ? ' is-active' : ''}`,
      onClick: () => { type = 'customer'; payment.type = 'customer'; redraw(); },
    }, 'Money in'),
    h('button', {
      type: 'button',
      class: `segmented-item${type === 'supplier' ? ' is-active' : ''}`,
      onClick: () => { type = 'supplier'; payment.type = 'supplier'; redraw(); },
    }, 'Money out'));

  const dateField = dateInput({ value: payment.date, onChange: (v) => { payment.date = v; } });
  const bankSelect = select({
    options: bankAccounts.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` })),
    value: payment.accountCode,
    onChange: (v) => { payment.accountCode = v; },
  });
  const methodSelect = select({
    options: ['Bank transfer', 'Cash', 'Card', 'Cheque', 'Direct debit', 'Other'].map((m) => ({ value: m, label: m })),
    value: payment.method,
    onChange: (v) => { payment.method = v; },
  });
  const referenceField = input({ value: payment.reference || '', placeholder: 'Reference or cheque number', onInput: (v) => { payment.reference = v; } });
  const amountField = moneyInput({
    value: payment.amount, code: company.currency,
    onChange: (v) => { payment.amount = v; redrawAllocations(); },
    onEnter: () => save(),
  });

  function openDocuments() {
    const wanted = type === 'customer' ? ['invoice'] : ['bill'];
    const credits = type === 'customer' ? ['credit-note-sale'] : ['credit-note-purchase'];
    return data.documents
      .filter((d) => d.status === 'open' && d.contactId === payment.contactId && (wanted.includes(d.type) || credits.includes(d.type)))
      .sort((a, b) => (a.dueDate || a.date).localeCompare(b.dueDate || b.date));
  }

  function allocatedTotal() {
    return (payment.allocations || []).reduce((a, x) => a + (x.amount || 0), 0);
  }

  /**
   * A note against one allocation — "second half of the March invoice", "includes the call-out fee".
   *
   * It belongs to the allocation rather than to the payment, because that is where the question comes
   * up: the payment as a whole already has a memo. Notes are also kept here rather than only on the
   * allocation, because a note can be typed before the amount that gives it an allocation to belong to,
   * and auto-allocating rebuilds every allocation from scratch.
   *
   * A note never moves money: it is only written onto an allocation, and no amount, posting or report
   * reads it.
   */
  const notesByDoc = new Map();

  function noteFor(docId) {
    const existing = (payment.allocations || []).find((a) => a.docId === docId);
    return existing ? existing.note || '' : (notesByDoc.get(docId) || '');
  }

  function setAllocationNote(docId, note) {
    const text = String(note || '');
    notesByDoc.set(docId, text);
    const existing = (payment.allocations || []).find((a) => a.docId === docId);
    if (existing) existing.note = text;
    // Deliberately no redraw and no summary update: redrawing per keystroke would take the cursor out
    // of the box being typed in, and a note changes no total.
  }

  function setAllocation(docId, amount) {
    payment.allocations = (payment.allocations || []).filter((a) => a.docId !== docId);
    if (amount) {
      const doc = data.documents.find((d) => d.id === docId);
      payment.allocations.push({
        docId, amount, docNumber: doc?.number, docType: doc?.type, note: notesByDoc.get(docId) || '',
      });
    }
  }

  function autoAllocate() {
    let left = payment.amount || 0;
    const allocs = [];
    for (const d of openDocuments()) {
      if (left <= 0) break;
      const s = documentSummary(d, data.taxCodes, data.payments, ctx.asOf || todayISO());
      const credit = d.type.startsWith('credit-note');
      const balance = credit ? -s.balance : s.balance;
      const take = Math.min(left, Math.max(0, balance));
      if (take <= 0) continue;
      allocs.push({ docId: d.id, amount: take, docNumber: d.number, docType: d.type, note: notesByDoc.get(d.id) || '' });
      left -= take;
    }
    payment.allocations = allocs;
    redrawAllocations();
  }

  /**
   * Opened for a particular document — the dashboard's Receive button, and a payment started
   * from an invoice. Pay that document, not merely the contact.
   *
   * Without this the requested document was ignored and the receipt was saved with no
   * allocations at all: money on account that settled nothing. The invoice stayed overdue, the
   * sidebar counter never moved, and the receipt looked as though it had been lost — from a
   * button whose whole purpose was to pay that invoice. The person clicking Receive has already
   * said which document they are paying.
   */
  if (opts.docId) {
    const doc = data.documents.find((d) => d.id === opts.docId);
    if (doc) {
      const balance = documentSummary(doc, data.taxCodes, data.payments, ctx.asOf || todayISO()).balance;
      const take = Math.min(payment.amount || balance, balance);
      if (take > 0) setAllocation(doc.id, take);
    }
  }

  const allocationsHost = h('div');

  function redrawAllocations() {
    clear(allocationsHost);
    if (!payment.contactId) {
      allocationsHost.appendChild(h('p', { class: 'field-hint' }, 'Choose a contact to see what is outstanding.'));
      return;
    }
    const docs = openDocuments();
    const total = allocatedTotal();
    const unapplied = (payment.amount || 0) - total;

    if (!docs.length) {
      allocationsHost.appendChild(h('p', { class: 'field-hint' },
        type === 'customer' ? 'Nothing outstanding for this customer — the money will sit as a credit on their account.' : 'No unpaid bills for this supplier — the money will sit as a prepayment.'));
      return;
    }

    const rows = docs.map((d) => {
      const s = documentSummary(d, data.taxCodes, data.payments, ctx.asOf || todayISO());
      const credit = d.type.startsWith('credit-note');
      const balance = credit ? -s.balance : s.balance;
      const applied = (payment.allocations || []).find((a) => a.docId === d.id)?.amount || 0;
      return { doc: d, summary: s, balance, applied, credit };
    });

    allocationsHost.appendChild(table({
      columns: [
        { key: 'number', label: 'Document', render: (r) => h('div', null,
          h('span', { class: 'mono strong' }, r.doc.number || '—'),
          h('div', { class: 'row-sub' }, `${r.doc.date}${r.doc.dueDate ? ` · due ${r.doc.dueDate}` : ''}${r.credit ? ' · credit note' : ''}`)) },
        { key: 'total', label: 'Total', align: 'right', render: (r) => moneyCell(r.summary.total, { code: company.currency }) },
        { key: 'balance', label: 'Outstanding', align: 'right', render: (r) => moneyCell(r.balance, { code: company.currency }) },
        {
          key: 'apply',
          label: 'Amount to apply',
          align: 'right',
          width: '130px',
          render: (r) => moneyInput({
            value: r.applied,
            code: company.currency,
            onChange: (v) => {
              if (v > r.balance) {
                toast('You cannot apply more than the document balance. Leave the rest on account instead.', 'warn');
                setAllocation(r.doc.id, r.balance);
                redrawAllocations();
                return;
              }
              setAllocation(r.doc.id, v);
              updateSummaryLine();
            },
          }),
        },
        {
          key: 'note',
          label: 'Note',
          // Free text against this one allocation. It is not money and is never read by the posting, so
          // it can be corrected later without touching the books — which is the point of it being here
          // rather than in the payment's memo.
          //
          // Built with the kit's input helper rather than a bare h('input'), because that is what wires
          // onInput up: a hand-made input with an onInput prop looks right and silently does nothing.
          render: (r) => {
            const box = input({
              value: noteFor(r.doc.id),
              placeholder: 'Optional',
              onInput: (v) => setAllocationNote(r.doc.id, v),
            });
            box.classList.add('input-note');
            box.setAttribute('aria-label', `Note on the allocation to ${r.doc.number || 'this document'}`);
            return box;
          },
        },
      ],
      rows,
      compact: true,
    }));

    const summaryHost = h('div', { class: 'row-between', id: 'payment-summary' },
      button({ label: 'Auto-allocate oldest first', variant: 'subtle', size: 'sm', onClick: autoAllocate }),
      button({ label: 'Clear allocations', variant: 'ghost', size: 'sm', onClick: () => { payment.allocations = []; redrawAllocations(); } }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, unapplied > 0
        ? `On account: ${formatCents(unapplied, { code: company.currency })}`
        : `Allocated: ${formatCents(total, { code: company.currency })}`));
    allocationsHost.appendChild(summaryHost);
  }

  function updateSummaryLine() {
    const host2 = document.getElementById('payment-summary');
    if (!host2) return;
    const total = allocatedTotal();
    const unapplied = (payment.amount || 0) - total;
    const label = host2.querySelector('.small.muted');
    if (label) {
      label.textContent = unapplied > 0
        ? `On account: ${formatCents(unapplied, { code: company.currency })}`
        : `Allocated: ${formatCents(total, { code: company.currency })}`;
    }
  }

  function redraw() {
    clear(host);
    const contacts = data.contacts
      .filter((c) => (type === 'customer' ? c.isCustomer !== false : c.isSupplier === true))
      .sort((a, b) => a.name.localeCompare(b.name));
    clear(contactSelect);
    contactSelect.appendChild(h('option', { value: '' }, 'Choose a contact…'));
    for (const c of contacts) contactSelect.appendChild(h('option', { value: c.id }, c.name));
    contactSelect.value = payment.contactId || '';

    const contact = data.contacts.find((c) => c.id === payment.contactId);
    if (contact && !payment.amount) {
      // Sensible default: what is still owed.
      const docs = openDocuments();
      const owed = docs.reduce((a, d) => {
        const s = documentSummary(d, data.taxCodes, data.payments, ctx.asOf || todayISO());
        return a + (d.type.startsWith('credit-note') ? -s.balance : s.balance);
      }, 0);
      if (owed > 0) {
        payment.amount = owed;
        amountField.value = formatCents(owed, { code: company.currency, symbol: false });
      }
    }

    append(host, [
      h('div', { class: 'row-between' },
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Direction'), opts.lockType ? badge(type === 'customer' ? 'Money in' : 'Money out', 'accent') : typeSegmented),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'On the ledger this debits/credits'))),
      h('div', { class: 'form-grid' },
        field({ label: type === 'customer' ? 'Customer' : 'Supplier', required: true, input: contactSelect }),
        field({ label: 'Date', required: true, input: dateField }),
        field({ label: 'Amount', required: true, input: amountField }),
        field({ label: 'Bank account', input: bankSelect }),
        field({ label: 'Method', input: methodSelect }),
        field({ label: 'Reference', input: referenceField })),
      h('div', { class: 'divider' }),
      h('h3', { class: 'card-title', style: { fontSize: 'var(--fs-md)', marginBottom: '0.5rem' } }, 'Apply to outstanding documents'),
      allocationsHost,
    ]);
    redrawAllocations();
  }

  function save() {
    if (!payment.contactId) { toast(`Choose a ${type === 'customer' ? 'customer' : 'supplier'}.`, 'warn'); return; }
    if (!payment.amount) { toast('Enter how much money moved.', 'warn'); return; }
    if (allocatedTotal() > payment.amount) { toast('You have applied more than the payment amount.', 'warn'); return; }
    const bank = data.accounts.find((a) => a.code === payment.accountCode);
    if (!bank) { toast('Choose the bank account the money moved through.', 'warn'); return; }
    try {
      const saved = savePayment(db, { ...payment });
      const contact = data.contacts.find((c) => c.id === payment.contactId);
      toast(`${type === 'customer' ? 'Receipt' : 'Payment'} ${saved.number} recorded`, 'success', {
        detail: `${formatCents(payment.amount, { code: company.currency })} ${type === 'customer' ? 'from' : 'to'} ${contact?.name || ''}.`,
      });
      handle.close(saved);
      opts.onSaved?.(saved);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const handle = modal({
    title: type === 'customer' ? 'Receive a payment' : 'Pay a supplier',
    subtitle: 'This posts straight to the ledger — you can void it later if it was wrong.',
    width: 'lg',
    body: host,
    actions: () => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => handle.close(null) }),
      button({ label: type === 'customer' ? 'Record receipt' : 'Record payment', variant: 'primary', onClick: save }),
    ],
  });

  redraw();
  return handle;
}

/** Void a payment, with a confirm step. Used by the Sales and Purchases lists. */
export async function voidPaymentFlow(ctx, paymentId) {
  const payment = ctx.db.get('payments', paymentId);
  if (!payment) return;
  const { confirmDialog } = await import('./kit.js');
  const ok = await confirmDialog({
    title: `Reverse ${payment.number || 'this payment'}?`,
    message: 'The journal entry is voided and the documents it paid go back to owing money.',
    detail: `${formatCents(payment.amount, { code: ctx.company.currency })} · ${payment.date}`,
    confirmLabel: 'Reverse payment',
    danger: true,
  });
  if (!ok) return;
  voidPayment(ctx.db, paymentId, 'Reversed by user');
  ctx.toast('Payment reversed', 'success');
  ctx.refresh();
}
