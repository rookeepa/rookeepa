import { listJobs } from '../core/jobs.js';
/**
 * Rookeepa — the document editor.
 *
 * Shared by Sales and Purchases: an invoice, quote, credit note or bill is the
 * same form with a different direction, so it is one implementation. The editor
 * keeps every amount in cents, recomputes GST on each keystroke, and can show
 * you the exact journal entry it is about to post — the whole point of Rookeepa
 * is that you never have to take the numbers on faith.
 */

import { jobPicker,
  h, clear, append, field, input, textarea, select, moneyInput, qtyInput, dateInput, button, iconButton,
  badge, modal, toast, confirmDialog, promptDialog, table, moneyCell, checkbox, ICONS,
} from './kit.js';
import {
  blankDocument, blankLine, computeDocument, computeLine, saveDocument, authoriseDocument, gstAppliesTo,
  voidDocument, deleteDraft, documentSummary, buildDocumentEntry, dueDateFor, docTypeMeta, isSales,
  computeLine as computeLineFn,
} from '../core/docs.js';
import { PAYMENT_TERMS } from '../core/coa.js';
import { nextNumber } from '../core/ledger.js';
import { formatCents } from '../core/money.js';
import { todayISO } from '../core/dates.js';
import { documentPrintNode, documentPlainText, accountOptions } from './print.js';

const DOC_TITLE = {
  invoice: 'Invoice',
  quote: 'Quote',
  'credit-note-sale': 'Credit note',
  bill: 'Bill',
  'credit-note-purchase': 'Supplier credit',
};

/**
 * Open the editor.
 * opts: { type, docId?, contactId?, onSaved?(doc), onVoid?() }
 * Returns the modal handle { close }.
 */
export function openDocumentEditor(ctx, opts = {}) {
  const { db, companyId, company, data } = ctx;
  const type = opts.type || 'invoice';
  const sales = isSales(type);
  const meta = docTypeMeta(type);
  const existing = opts.docId ? db.get('documents', opts.docId) : null;
  const taxCodes = data.taxCodes;
  const accounts = data.accounts;

  const defaults = () => {
    const date = ctx.asOf || todayISO();
    const accountCode = sales ? company.defaultSalesAccount : company.defaultPurchaseAccount;
    const taxCode = accounts.find((a) => a.code === accountCode)?.gstDefault || 'GST';
    return {
      terms: company.defaultTerms || 'net14',
      accountCode,
      taxCode,
    };
  };

  const draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : blankDocument({
      companyId,
      type,
      contactId: opts.contactId || null,
      date: ctx.asOf || todayISO(),
      terms: company.defaultTerms || 'net14',
      dueDate: dueDateFor(ctx.asOf || todayISO(), company.defaultTerms || 'net14'),
      lines: [blankLine({ accountCode: defaults().accountCode, taxCode: defaults().taxCode, qty: 1000 })],
      status: 'draft',
    });
  // A draft follows the company's registration as it stands now (so the live totals, the
  // saved document and the posted journal all agree); a posted document keeps the tax
  // treatment it was posted with.
  draft.gstRegistered = gstAppliesTo(company, draft);

  const lines = draft.lines.map((l) => ({ ...l }));

  /* --------------------------------------------------------------- helpers */

  const contacts = data.contacts
    .filter((c) => (sales ? c.isCustomer !== false : c.isSupplier === true) && c.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name));

  const accountList = accountOptions(accounts, { types: sales ? ['income'] : ['expense', 'costOfSales', 'otherExpenses', 'asset'], all: true });

  function readHead() {
    draft.contactId = contactSelect.value || null;
    draft.date = dateField.value;
    draft.terms = termsSelect.value;
    draft.dueDate = dueField.value;
    draft.reference = refField.value.trim();
    draft.poNumber = poField.value.trim();
    draft.memo = memoField.value.trim();
    draft.priceIncludesTax = !!includesTaxInput?.checked;
  }

  function totals() {
    return computeDocument({ ...draft, lines }, taxCodes);
  }

  function touch() {
    contactField.classList.toggle('field-error', false);
  }

  /* ------------------------------------------------------------- form head */

  const contactSelect = select({
    options: [
      { value: '', label: sales ? 'Choose a customer…' : 'Choose a supplier…' },
      ...contacts.map((c) => ({ value: c.id, label: c.name })),
    ],
    value: draft.contactId || '',
    onChange: () => { draft.contactId = contactSelect.value || null; updateTotals(); },
  });

  const addContactBtn = button({
    label: 'New',
    variant: 'ghost',
    size: 'sm',
    icon: ICONS.plus,
    title: 'Add a new contact without leaving this form',
    onClick: () => newContactInline(),
  });

  const contactField = field({
    label: sales ? 'Customer' : 'Supplier',
    required: true,
    input: h('div', { class: 'row', style: { gap: '0.35rem', flexWrap: 'nowrap' } }, contactSelect, addContactBtn),
  });

  const dateField = dateInput({ value: draft.date, onChange: () => {
    draft.date = dateField.value;
    if (linkedDue) {
      draft.dueDate = dueDateFor(draft.date, draft.terms);
      dueField.value = draft.dueDate;
    }
  } });

  const termsSelect = select({
    options: PAYMENT_TERMS.map((t) => ({ value: t.id, label: t.label })),
    value: draft.terms || 'net14',
    onChange: () => {
      draft.terms = termsSelect.value;
      linkedDue = true;
      draft.dueDate = dueDateFor(draft.date, draft.terms);
      dueField.value = draft.dueDate;
    },
  });

  const dueField = dateInput({ value: draft.dueDate, onChange: () => { linkedDue = false; draft.dueDate = dueField.value; } });
  let linkedDue = true;

  const refField = input({ value: draft.reference || '', placeholder: 'Their reference', onInput: (v) => { draft.reference = v; } });
  const poField = input({ value: draft.poNumber || '', placeholder: 'PO number', onInput: (v) => { draft.poNumber = v; } });
  const memoField = input({ value: draft.memo || '', placeholder: 'Shown on the printed document', onInput: (v) => { draft.memo = v; } });

  const includesTaxBox = checkbox({
    label: 'Prices I type include GST',
    checked: !!draft.priceIncludesTax,
    onChange: (checked) => { draft.priceIncludesTax = !!checked; redrawLines(); },
  });
  // checkbox() returns the <label> wrapper, not the input — reading `.checked`
  // off the wrapper is `undefined`, which silently treated every GST-inclusive
  // document as exclusive and changed its total when it was re-saved.
  const includesTaxInput = includesTaxBox.querySelector('input');

  const head = h('div', { class: 'doc-head-grid' },
    contactField,
    field({ label: 'Date', required: true, input: dateField }),
    field({ label: 'Terms', input: termsSelect }),
    field({ label: 'Due date', input: dueField, hint: draft.type === 'quote' ? 'Quotes have a validity date' : null }),
    field({ label: 'Reference', input: refField }),
    field({ label: 'PO number', input: poField }),
    field({ label: 'Description', input: memoField, className: 'wide-field' }),
    field({
      label: 'Number',
      input: h('div', { class: 'row', style: { gap: '0.4rem' } },
        h('strong', { class: 'mono' }, draft.number || previewNumber()),
        existing?.status === 'open' ? badge('Posted', 'info') : null),
      hint: existing?.status === 'open' ? 'Changing this document updates its journal entry.' : 'A preview — the real number is assigned when you authorise.',
    }),
    field({ label: 'Amounts', input: includesTaxBox }));

  function previewNumber() {
    try {
      return nextNumber(db, companyId, type);
    } catch {
      return '—';
    }
  }

  /* ------------------------------------------------------------ line rows */

  const linesHost = h('div', { class: 'doc-lines' });
  const totalsHost = h('div', { class: 'doc-totals' });

  // The jobs for this company file. Fetched in redrawLines and held here because lineRow is a function of its
  // own and has to see the same list — a `const` inside redrawLines would leave it undefined there.
  let jobs = [];

  function redrawLines() {
    clear(linesHost);
    jobs = listJobs(ctx.db, ctx.companyId);
    linesHost.appendChild(h('div', { class: 'line-row header' },
      h('span', null, 'Description'),
      h('span', null, 'Account'),
      h('span', { class: 'col-right' }, 'Qty'),
      h('span', { class: 'col-right' }, 'Unit price'),
      h('span', { class: 'col-right col-discount' }, 'Disc %'),
      h('span', null, 'Tax'),
      jobs.length ? h('span', null, 'Job') : h('span', null, ''),
      h('span', { class: 'col-right' }, 'Amount'),
      h('span', null, '')));

    lines.forEach((line, index) => {
      linesHost.appendChild(lineRow(line, index));
    });

    linesHost.appendChild(h('div', { class: 'row', style: { padding: '0.6rem 0.75rem', gap: '0.5rem' } },
      button({ label: 'Add line', variant: 'subtle', size: 'sm', icon: ICONS.plus, onClick: () => addLine() }),
      button({ label: 'Add from item list', variant: 'ghost', size: 'sm', icon: ICONS.items, onClick: () => pickItem() }),
      h('span', { class: 'spacer' }),
      lines.length > 1 ? button({ label: 'Clear all lines', variant: 'ghost', size: 'sm', onClick: async () => {
        if (await confirmDialog({ title: 'Clear all lines?', message: 'Every line on this document will be removed. The document itself stays.', confirmLabel: 'Clear lines', danger: true })) {
          lines.length = 0;
          addLine();
        }
      } }) : null));
    updateTotals();
  }

  function lineRow(line, index) {
    const amountCell = h('span', { class: 'num strong' }, formatCents(computeLineFn({ ...line, priceIncludesTax: draft.priceIncludesTax }, taxCodes).ex + computeLineFn({ ...line, priceIncludesTax: draft.priceIncludesTax }, taxCodes).gst, { code: company.currency }));
    const row = h('div', { class: 'line-row' });

    const descInput = input({
      value: line.description || '',
      placeholder: 'What you sold or bought',
      className: 'line-desc',
      onInput: (v) => { line.description = v; updateTotals(); },
    });
    descInput.setAttribute('list', 'rookeepa-items');
    descInput.addEventListener('change', () => {
      const match = data.items.find((i) => i.name.toLowerCase() === descInput.value.trim().toLowerCase());
      if (match && !line.itemId) applyItem(line, match);
    });

    const accountSelect = select({
      options: [{ value: '', label: 'Choose account…' }, ...accountList],
      value: line.accountCode || '',
      onChange: (v) => {
        line.accountCode = v;
        const acc = accounts.find((a) => a.code === v);
        if (acc?.gstDefault && !line.taxCodeManual) {
          line.taxCode = acc.gstDefault;
          taxSelect.value = acc.gstDefault;
        }
        updateTotals();
      },
    });

    const qty = qtyInput({ value: line.qty, onChange: (v) => { line.qty = v; updateLineAmount(row, line, amountCell); updateTotals(); } });
    const price = moneyInput({
      value: line.unitPrice, code: company.currency,
      onChange: (v) => { line.unitPrice = v; updateLineAmount(row, line, amountCell); updateTotals(); },
      onEnter: () => focusLastLine(index),
    });
    const disc = moneyInput({
      value: Math.round((line.discountPct || 0) * 100), code: 'AUD',
      placeholder: '0', className: 'col-discount',
      onChange: (v) => { line.discountPct = (v || 0) / 100; updateLineAmount(row, line, amountCell); updateTotals(); },
    });

    const taxSelect = select({
      options: taxCodes.map((t) => ({ value: t.code, label: t.code })),
      value: line.taxCode || 'GST',
      onChange: (v) => { line.taxCode = v; line.taxCodeManual = true; updateLineAmount(row, line, amountCell); updateTotals(); },
    });
    taxSelect.title = taxCodes.map((t) => `${t.code}: ${t.description}`).join('\n');

    // The job belongs to the line, like the account: one invoice can carry materials for two jobs, and the
    // posting keeps them apart.
    const job = jobPicker(jobs, { value: line.jobCode, onChange: (v) => { line.jobCode = v || null; } });
    if (job) job.title = 'The job this line belongs to';

    const remove = iconButton({
      label: `Remove line ${index + 1}`,
      icon: ICONS.trash,
      onClick: () => {
        if (lines.length === 1) { toast('A document needs at least one line.', 'warn'); return; }
        lines.splice(index, 1);
        redrawLines();
      },
    });

    append(row, [
      descInput,
      accountSelect,
      qty,
      price,
      disc,
      taxSelect,
      job || h('span'),
      amountCell,
      remove,
    ]);
    return row;
  }

  function updateLineAmount(row, line, cell) {
    const r = computeLineFn({ ...line, priceIncludesTax: draft.priceIncludesTax }, taxCodes);
    cell.textContent = formatCents(r.ex + r.gst, { code: company.currency });
    cell.classList.toggle('neg', r.ex + r.gst < 0);
  }

  function focusLastLine(index) {
    const rows = linesHost.querySelectorAll('.line-row');
    const target = rows[index + 1];
    if (target) target.querySelector('input')?.focus();
    else {
      addLine();
      const next = linesHost.querySelectorAll('.line-row');
      next[next.length - 1]?.querySelector('input')?.focus();
    }
  }

  function addLine() {
    const last = lines[lines.length - 1];
    lines.push(blankLine({
      accountCode: last?.accountCode || defaults().accountCode,
      taxCode: last?.taxCode || defaults().taxCode,
      qty: 1000,
    }));
    redrawLines();
  }

  function applyItem(line, item) {
    line.itemId = item.id;
    line.description = item.name;
    line.accountCode = item.accountCode;
    line.unitPrice = item.priceCents;
    line.taxCode = item.taxCode;
    line.qty = line.qty || 1000;
    redrawLines();
  }

  function pickItem() {
    const rows = data.items.filter((i) => i.active !== false);
    const m = modal({
      title: 'Add items',
      width: 'md',
      body: () => {
        if (!rows.length) {
          return h('div', { class: 'empty' },
            h('h3', null, 'No items yet'),
            h('p', null, 'Items are optional — useful when you sell the same products repeatedly. Add them under Items.'),
            button({ label: 'Go to Items', variant: 'primary', onClick: () => { m.close(); ctx.go('items'); } }));
        }
        return table({
          columns: [
            { key: 'code', label: 'Code', className: 'mono small' },
            { key: 'name', label: 'Item' },
            { key: 'priceCents', label: 'Price', align: 'right', render: (r) => moneyCell(r.priceCents, { code: company.currency }) },
            { key: 'taxCode', label: 'Tax', render: (r) => badge(r.taxCode, 'muted') },
          ],
          rows,
          onRowClick: (item) => { applyItem(lines[lines.length - 1] || blankLine(), item); m.close(); },
        });
      },
      actions: ({ close }) => [button({ label: 'Close', variant: 'ghost', onClick: () => close(null) })],
    });
  }

  /* --------------------------------------------------------------- totals */

  function updateTotals() {
    readHeadSafely();
    const t = totals();
    clear(totalsHost);
    const grid = h('div', { class: 'totals-table' });
    grid.appendChild(h('span', null, 'Subtotal'));
    grid.appendChild(h('span', { class: 'num' }, formatCents(t.subtotal, { code: company.currency })));
    for (const [code, v] of t.taxBreakdown) {
      if (!v.gst) continue;
      grid.appendChild(h('span', { class: 'muted' }, `${code}`));
      grid.appendChild(h('span', { class: 'num' }, formatCents(v.gst, { code: company.currency })));
    }
    if (!t.tax) {
      grid.appendChild(h('span', { class: 'muted' }, company.taxLabel || 'GST'));
      grid.appendChild(h('span', { class: 'num' }, formatCents(0, { code: company.currency })));
    }
    grid.appendChild(h('span', { class: 'total-row' }, 'Total'));
    grid.appendChild(h('span', { class: 'num total-row' }, formatCents(t.total, { code: company.currency })));

    const summary = documentSummary({ ...draft, lines }, taxCodes, data.payments, todayISO());
    if (existing && existing.status === 'open') {
      grid.appendChild(h('span', { class: 'muted' }, 'Already paid'));
      grid.appendChild(h('span', { class: 'num' }, formatCents(summary.paid, { code: company.currency })));
      grid.appendChild(h('span', null, 'Balance'));
      grid.appendChild(h('span', { class: 'num strong' }, formatCents(summary.balance, { code: company.currency })));
    }
    totalsHost.appendChild(grid);
    totalsHost.appendChild(h('div', { class: 'stack', style: { gap: '0.35rem' } },
      button({ label: 'Show the journal entry', variant: 'ghost', size: 'sm', icon: ICONS.journal, onClick: showJournalPreview }),
      h('span', { class: 'tax-breakdown' }, `${(company.taxLabel || 'GST')} ${formatCents(t.tax, { code: company.currency })}`)));
    saveButton.disabled = t.total === 0;
  }

  function readHeadSafely() {
    try { readHead(); } catch { /* fields not built yet */ }
  }

  function showJournalPreview() {
    readHead();
    const check = validate(true);
    if (check) { toast(check, 'warn'); return; }
    let entry;
    try {
      entry = buildDocumentEntry({ ...draft, lines }, {
        accounts, taxCodes, company, items: data.items,
        contactName: contacts.find((c) => c.id === draft.contactId)?.name || '',
      });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const dr = entry.lines.reduce((a, l) => a + l.debit, 0);
    const cr = entry.lines.reduce((a, l) => a + l.credit, 0);
    modal({
      title: 'What this will post',
      subtitle: 'Every transaction in Rookeepa is a double-entry journal. This is the one your document creates.',
      width: 'lg',
      body: () => h('div', null,
        table({
          columns: [
            {
              key: 'accountCode',
              label: 'Account',
              render: (r) => h('div', null,
                h('span', { class: 'mono' }, r.accountCode),
                ' ',
                h('span', { class: 'muted small' }, accounts.find((a) => a.code === r.accountCode)?.name || '')),
            },
            { key: 'description', label: 'Description' },
            { key: 'taxCode', label: 'Tax', render: (r) => (r.taxCode ? badge(r.taxCode, 'muted') : '') },
            { key: 'debit', label: 'Debit', align: 'right', render: (r) => (r.debit ? moneyCell(r.debit, { code: company.currency }) : '') },
            { key: 'credit', label: 'Credit', align: 'right', render: (r) => (r.credit ? moneyCell(r.credit, { code: company.currency }) : '') },
          ],
          rows: entry.lines,
          footer: [[
            '', 'Totals', '',
            h('span', { class: 'num' }, formatCents(dr, { code: company.currency })),
            h('span', { class: 'num' }, formatCents(cr, { code: company.currency })),
          ]],
          compact: true,
        }),
        h('p', { class: 'report-note' }, dr === cr
          ? 'Debits equal credits — this entry balances.'
          : 'This entry does not balance, which should be impossible. Please report it.')),
    });
  }

  /* ---------------------------------------------------------------- saving */

  function validate(forPreview = false) {
    if (!draft.contactId) return `Choose a ${sales ? 'customer' : 'supplier'} first.`;
    if (!draft.date) return 'Pick a date.';
    const t = totals();
    if (t.total === 0 && !forPreview) return 'Add at least one line with an amount.';
    const missingAccount = lines.find((l) => !l.accountCode);
    if (missingAccount) return 'Every line needs an account.';
    const negative = lines.find((l) => (l.unitPrice || 0) < 0 || (l.qty || 0) < 0);
    if (negative) return 'Quantities and prices cannot be negative — use a credit note instead.';
    return null;
  }

  function persist() {
    const error = validate();
    if (error) { toast(error, 'warn'); return null; }
    readHead();
    const payload = { ...draft, lines: lines.map((l) => ({ ...l })) };
    try {
      const saved = saveDocument(db, payload);
      return saved;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  }

  async function saveAndAuthorise() {
    const saved = persist();
    if (!saved) return;
    try {
      const open = authoriseDocument(db, saved.id);
      ctx.toast(`${DOC_TITLE[type]} ${open.number} authorised`, 'success', {
        detail: 'Its journal entry is posted and reports have been updated.',
      });
      handle.close(open);
      opts.onSaved?.(open);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function saveOnly() {
    const saved = persist();
    if (!saved) return;
    toast(`${DOC_TITLE[type]} saved as a draft`, 'success', { detail: 'Drafts do not touch the ledger until you authorise them.' });
    handle.close(saved);
    opts.onSaved?.(saved);
    ctx.refresh();
  }

  async function doVoid() {
    if (!existing) return;
    const reason = await promptDialog({
      title: `Void ${existing.number || DOC_TITLE[type]}?`,
      label: 'Reason (kept in the audit trail)',
      message: 'Voiding reverses the journal entry. Nothing is deleted, so you can always see what happened.',
      confirmLabel: 'Void this document',
    });
    if (reason === null) return;
    try {
      voidDocument(db, existing.id, reason || 'Voided by user');
      toast(`${existing.number || 'Document'} voided`, 'success');
      handle.close(null);
      opts.onVoid?.();
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function doDelete() {
    if (!existing) return;
    const ok = await confirmDialog({
      title: 'Delete this draft?',
      message: 'Drafts were never posted to the ledger, so deleting one changes no balances.',
      confirmLabel: 'Delete draft',
      danger: true,
    });
    if (!ok) return;
    try {
      deleteDraft(db, existing.id);
      toast('Draft deleted', 'success');
      handle.close(null);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function doPrint() {
    readHead();
    const contact = data.contacts.find((c) => c.id === draft.contactId);
    const summary = documentSummary({ ...draft, lines }, taxCodes, data.payments, todayISO());
    import('./kit.js').then(({ printNode }) => {
      printNode(documentPrintNode({ company, doc: draft, contact, summary, taxCodes }), { title: `${DOC_TITLE[type]} ${draft.number || ''}` });
    });
  }

  async function copyText() {
    readHead();
    const contact = data.contacts.find((c) => c.id === draft.contactId);
    const summary = documentSummary({ ...draft, lines }, taxCodes, data.payments, todayISO());
    const text = documentPlainText({ company, doc: draft, contact, summary, taxCodes });
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', 'success', { detail: 'Paste it into an email — no attachments needed.' });
    } catch {
      modal({ title: 'Copy this text', width: 'md', body: () => textarea({ value: text, rows: 16 }) });
    }
  }

  /* ----------------------------------------------------------------- modal */

  const saveButton = button({
    label: existing?.status === 'open' ? 'Save changes' : 'Save as draft',
    variant: 'subtle',
    onClick: saveOnly,
  });

  const footerAction = (() => {
    if (existing?.status === 'open') return null;
    return button({
      label: meta.posts ? (type === 'quote' ? 'Save quote' : `Authorise ${DOC_TITLE[type].toLowerCase()}`) : 'Save',
      variant: 'primary',
      onClick: saveAndAuthorise,
    });
  })();

  const warnings = [];
  if (existing?.status === 'open') {
    warnings.push(h('p', { class: 'field-hint' }, 'This document is already posted. Saving changes updates its journal entry; void it if it was wrong.'));
  }
  if (existing && draft.paymentsNote) warnings.push(h('p', { class: 'field-hint' }, draft.paymentsNote));

  const body = h('div', { class: 'doc-editor' },
    head,
    warnings.length ? h('div', { style: { padding: '0.6rem 1rem 0' } }, warnings) : null,
    linesHost,
    totalsHost,
    h('datalist', { id: 'rookeepa-items' }, data.items.map((i) => h('option', { value: i.name }))));

  const handle = modal({
    title: `${existing ? 'Edit' : 'New'} ${DOC_TITLE[type].toLowerCase()}`,
    subtitle: existing?.status === 'open' ? `Posted as ${existing.number}` : 'Nothing touches your books until you authorise it.',
    width: 'xl',
    className: 'modal-doc',
    body,
    actions: () => [
      existing && existing.status === 'draft' ? button({ label: 'Delete draft', variant: 'ghost', onClick: doDelete }) : null,
      existing && existing.status === 'open' ? button({ label: 'Void', variant: 'ghost', icon: ICONS.trash, onClick: doVoid }) : null,
      button({ label: 'Print', variant: 'ghost', icon: ICONS.print, onClick: doPrint }),
      button({ label: 'Copy as text', variant: 'ghost', icon: ICONS.file, onClick: copyText }),
      h('span', { class: 'spacer' }),
      button({ label: 'Cancel', variant: 'ghost', onClick: () => handle.close(null) }),
      saveButton,
      footerAction,
    ].filter(Boolean),
    onClose: () => opts.onClosed?.(),
  });

  function newContactInline() {
    let name = '';
    let email = '';
    const m = modal({
      title: sales ? 'New customer' : 'New supplier',
      width: 'sm',
      body: () => h('div', null,
        field({ label: 'Name', required: true, input: input({ value: name, autofocus: true, onInput: (v) => { name = v; } }) }),
        field({ label: 'Email', input: input({ value: email, onInput: (v) => { email = v; } }) })),
      actions: ({ close }) => [
        button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
        button({
          label: 'Add contact',
          variant: 'primary',
          onClick: () => {
            if (!name.trim()) { toast('A contact needs a name.', 'warn'); return; }
            const contact = db.put('contacts', {
              companyId, name: name.trim(), email: email.trim(),
              isCustomer: sales, isSupplier: !sales, terms: company.defaultTerms || 'net14', active: true,
            });
            const opt = h('option', { value: contact.id }, contact.name);
            contactSelect.appendChild(opt);
            contactSelect.value = contact.id;
            draft.contactId = contact.id;
            contacts.push(contact);
            close(contact);
            updateTotals();
          },
        }),
      ],
    });
  }

  redrawLines();
  return handle;
}

/** A small reusable "pick a contact" modal, used by lists and reports. */
export function pickContactModal(ctx, { sales = true, title } = {}) {
  return new Promise((resolve) => {
    const contacts = ctx.data.contacts
      .filter((c) => (sales ? c.isCustomer !== false : c.isSupplier === true))
      .sort((a, b) => a.name.localeCompare(b.name));
    const m = modal({
      title: title || (sales ? 'Choose a customer' : 'Choose a supplier'),
      width: 'md',
      body: () => (contacts.length
        ? table({
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'email', label: 'Email', className: 'muted small' },
            { key: 'terms', label: 'Terms', className: 'muted small' },
          ],
          rows: contacts,
          onRowClick: (c) => { resolve(c); m.close(c); },
        })
        : h('div', { class: 'empty' }, h('h3', null, 'No contacts yet'), h('p', null, 'Add one under Contacts, or from the document editor.'))),
      actions: ({ close }) => [button({ label: 'Cancel', variant: 'ghost', onClick: () => { resolve(null); close(null); } })],
      onClose: () => resolve(null),
    });
  });
}
