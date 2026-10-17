/**
 * Rookeepa — Recurring transactions.
 *
 * The screen is a list of schedules rather than an automation console: what is next, what is
 * overdue, and a button that creates the draft you were going to type anyway.
 *
 * Nothing here writes to your books. A schedule produces a *draft*, and a draft becomes an
 * entry only when you authorise it — which is why the screen says so more than once.
 */

import {
  h, card, pageHeader, button, iconButton, table, moneyCell, badge, field, input, textarea,
  select, checkbox, moneyInput, qtyInput, dateInput, emptyState, banner, modal, toast, ICONS, fmt,
} from './kit.js';
import {
  FREQUENCIES, documentTypes, frequencyLabel, blankRecurring, dueTemplates, upcomingTemplates,
  createNext, skipNext, overdueCount, isDue,
} from '../core/recurring.js';
import { todayISO, fmtDate, compareISO, addDays } from '../core/dates.js';
import { blankLine } from '../core/docs.js';

export const meta = {
  title: 'Recurring',
  subtitle: 'Invoices and bills you raise again on a schedule — rent, a subscription, a regular fee. Rookeepa creates the draft; you check it and authorise it.',
};

/* --------------------------------------------------------------- helpers */

function templates(ctx) {
  return ctx.db.of('recurring', ctx.companyId)
    .slice()
    .sort((a, b) => compareISO(a.nextDate, b.nextDate) || String(a.name).localeCompare(String(b.name)));
}

function contactName(ctx, id) {
  const c = (ctx.data.contacts || []).find((x) => x.id === id);
  return c ? c.name : '—';
}

/** The ex-GST value of what the schedule raises. GST is worked out on the document itself. */
function scheduleValue(template) {
  return (template.lines || []).reduce((total, l) => total + Math.round(((l.qty || 0) * (l.unitPrice || 0)) / 1000), 0);
}

function dueLabel(template, asOf) {
  const behind = overdueCount(template, asOf);
  if (!behind) return fmtDate(template.nextDate);
  return badge(behind > 1 ? `Due — ${behind} behind` : 'Due', 'warning');
}

/* ------------------------------------------------------------ the screen */

export async function render(ctx) {
  const asOf = todayISO();
  const el = h('div', { class: 'stack' });
  const all = templates(ctx);
  const due = dueTemplates(all, asOf);

  el.appendChild(pageHeader({
    title: meta.title,
    subtitle: meta.subtitle,
    actions: [button({
      label: 'New recurring',
      variant: 'primary',
      icon: ICONS.plus,
      onClick: () => openForm(ctx, null),
    })],
  }));

  if (due.length) {
    el.appendChild(banner({
      kind: 'warning',
      title: due.length === 1 ? 'One is due' : `${due.length} are due`,
      message: 'Rookeepa will create the drafts — one occurrence each. You authorise them in Sales or Purchases.',
      actions: [button({
        label: due.length === 1 ? 'Create the draft' : `Create ${due.length} drafts`,
        variant: 'primary',
        onClick: () => {
          // One occurrence per schedule, never a loop to catch up: a template months behind is
          // a decision to make deliberately, not something to discover as a pile of drafts.
          for (const t of due) createNext(ctx.db, t.id);
          toast(`${due.length} draft${due.length === 1 ? '' : 's'} created — check and authorise them.`, 'success');
          ctx.refresh();
        },
      })],
    }));
  }

  if (!all.length) {
    el.appendChild(card({
      title: 'Schedules',
      body: emptyState({
        title: 'Nothing repeating yet',
        message: 'If you raise the same invoice or bill regularly, set it up once here and Rookeepa will have the draft ready on the day.',
        action: button({ label: 'New recurring transaction', variant: 'primary', onClick: () => openForm(ctx, null) }),
        icon: ICONS.recurring,
      }),
    }));
    return el;
  }

  el.appendChild(card({
    title: 'Schedules',
    body: table({
      columns: [
        {
          key: 'name',
          label: 'Name',
          render: (r) => h('div', null,
            h('span', null, r.name),
            r.active ? null : h('span', { class: 'muted small' }, ' (paused)')),
        },
        { key: 'contact', label: 'For' },
        { key: 'type', label: 'Type' },
        { key: 'amount', label: 'Each time (ex GST)', align: 'right', render: (r) => moneyCell(r.amount) },
        { key: 'frequency', label: 'Repeats' },
        { key: 'due', label: 'Next', render: (r) => dueLabel(r.raw, asOf) },
        { key: 'last', label: 'Last created' },
        {
          key: 'actions',
          label: '',
          align: 'right',
          render: (r) => h('div', { class: 'table-actions' },
            button({
              label: 'Create now',
              size: 'sm',
              onClick: () => {
                const { document } = createNext(ctx.db, r.id);
                toast(`Draft for ${fmtDate(document.date)} created — authorise it in ${document.type === 'bill' ? 'Purchases' : 'Sales'}.`, 'success');
                ctx.refresh();
              },
            }),
            button({
              label: 'Skip',
              size: 'sm',
              variant: 'ghost',
              onClick: () => {
                skipNext(ctx.db, r.id);
                toast('Skipped this one — the next date has moved on.');
                ctx.refresh();
              },
            }),
            iconButton({ icon: ICONS.edit, label: `Edit ${r.name}`, onClick: () => openForm(ctx, r.raw) })),
        },
      ],
      rows: all.map((t) => ({
        id: t.id,
        name: t.name || '(unnamed)',
        contact: contactName(ctx, t.contactId),
        type: t.type === 'bill' ? 'Bill' : 'Invoice',
        amount: scheduleValue(t),
        frequency: frequencyLabel(t.frequency),
        last: t.lastPostedAt ? fmtDate(t.lastPostedAt) : '—',
        active: t.active !== false,
        raw: t,
      })),
      rowClass: (r) => (r.active ? '' : 'row-muted'),
      empty: 'No recurring transactions yet.',
    }),
  }));

  const soon = upcomingTemplates(all, 5, asOf);
  if (soon.length) {
    el.appendChild(card({
      title: 'Coming up',
      body: table({
        columns: [
          { key: 'next', label: 'Date', render: (r) => fmtDate(r.next) },
          { key: 'name', label: 'Name' },
          { key: 'frequency', label: 'Repeats' },
        ],
        rows: soon.map((t) => ({ id: t.id, next: t.nextDate, name: t.name || '(unnamed)', frequency: frequencyLabel(t.frequency) })),
        empty: '',
      }),
    }));
  }

  return el;
}

/* ---------------------------------------------------------------- the form */

function openForm(ctx, existing) {
  const isBill = () => draft.type === 'bill';

  const accountOptions = () => (ctx.data.accounts || [])
    .filter((a) => a.active !== false && (isBill() ? ['expense', 'costOfSales', 'otherExpenses'].includes(a.type) : ['income', 'otherIncome'].includes(a.type)))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }));

  const contactOptions = () => (ctx.data.contacts || [])
    .filter((c) => c.active !== false && (isBill() ? c.isSupplier !== false : c.isCustomer !== false))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((c) => ({ value: c.id, label: c.name }));

  const taxOptions = () => (ctx.data.taxCodes || []).map((t) => ({ value: t.code, label: `${t.code} ${t.name || ''}`.trim() }));

  const draft = existing
    ? { ...existing, lines: (existing.lines || []).map((l) => blankLine(l)) }
    : blankRecurring({ companyId: ctx.companyId, nextDate: todayISO(), startDate: todayISO() });

  if (!draft.lines.length) {
    draft.lines.push(blankLine({ description: '', accountCode: accountOptions()[0]?.value || '', taxCode: 'GST', qty: 1000 }));
  }

  const linesHost = h('div', { class: 'stack' });

  const redrawLines = () => {
    linesHost.replaceChildren();
    draft.lines.forEach((l, index) => {
      const first = index === 0;
      const label = (text) => (first ? text : '');
      const described = (node, what, n) => {
        // Only the first row carries visible labels, so every row gets an accessible name.
        if (!first) node.setAttribute('aria-label', `${what} of line ${n}`);
        return node;
      };
      linesHost.appendChild(h('div', { class: 'row repeat-line' },
        field({
          label: label('Description'),
          className: 'grow',
          input: described(input({
            value: l.description,
            placeholder: 'Rent for the month',
            onChange: (v) => { l.description = v; },
          }), 'Description', index + 1),
        }),
        field({
          label: label('Qty'),
          input: described(qtyInput({ value: l.qty, onChange: (v) => { l.qty = v; } }), 'Quantity', index + 1),
        }),
        field({
          label: label('Unit price'),
          input: described(moneyInput({ value: l.unitPrice, code: ctx.company.currency || 'AUD', onChange: (v) => { l.unitPrice = v; } }), 'Unit price', index + 1),
        }),
        field({
          label: label('Account'),
          input: described(select({
            value: l.accountCode || '',
            options: accountOptions(),
            onChange: (v) => { l.accountCode = v; },
          }), 'Account', index + 1),
        }),
        field({
          label: label('GST'),
          input: described(select({
            value: l.taxCode || 'GST',
            options: taxOptions(),
            onChange: (v) => { l.taxCode = v; },
          }), 'GST code', index + 1),
        }),
        iconButton({
          icon: ICONS.trash,
          label: `Remove line ${index + 1}`,
          onClick: () => {
            draft.lines.splice(index, 1);
            if (!draft.lines.length) {
              draft.lines.push(blankLine({ accountCode: accountOptions()[0]?.value || '', taxCode: 'GST', qty: 1000 }));
            }
            redrawLines();
          },
        })));
    });
  };
  redrawLines();

  const save = () => {
    if (!String(draft.name).trim()) { toast('Give the schedule a name so you recognise it later.', 'error'); return false; }
    if (!draft.contactId) { toast(`Choose the ${isBill() ? 'supplier' : 'customer'} this is for.`, 'error'); return false; }
    const usable = draft.lines.filter((l) => String(l.description).trim() && l.unitPrice);
    if (!usable.length) { toast('Add at least one line with a description and a price.', 'error'); return false; }

    ctx.db.put('recurring', {
      ...draft,
      lines: usable,
      companyId: ctx.companyId,
      // A new schedule starts where you put it; an edited one keeps its own place in the run so
      // editing a name cannot silently reschedule it.
      nextDate: existing ? existing.nextDate : draft.nextDate,
      startDate: existing ? existing.startDate : draft.nextDate,
    });
    toast(existing ? 'Schedule updated.' : 'Saved. Rookeepa will have the draft ready when it is due.', 'success');
    return true;
  };

  const body = h('div', { class: 'stack' },
    h('div', { class: 'form-row' },
      field({
        label: 'Name',
        required: true,
        hint: 'Only you see this',
        input: input({ value: draft.name, placeholder: 'Office rent', onChange: (v) => { draft.name = v; } }),
      }),
      field({
        label: 'Type',
        input: select({
          value: draft.type,
          options: documentTypes(),
          onChange: (v) => {
            draft.type = v;
            // The accounts that make sense change with the type, so they are reset rather than
            // leaving a sales account sitting on a bill.
            const options = accountOptions();
            draft.lines.forEach((l) => { l.accountCode = options[0]?.value || ''; });
            redrawLines();
          },
        }),
      })),
    h('div', { class: 'form-row' },
      field({
        label: 'For',
        required: true,
        input: select({
          value: draft.contactId || '',
          options: [{ value: '', label: 'Choose…' }, ...contactOptions()],
          onChange: (v) => { draft.contactId = v || null; },
        }),
      }),
      field({
        label: 'Repeats',
        input: select({ value: draft.frequency, options: FREQUENCIES, onChange: (v) => { draft.frequency = v; } }),
      })),
    h('div', { class: 'form-row' },
      field({
        label: 'Next date',
        hint: existing ? 'Kept by the schedule' : 'The first one',
        input: dateInput({
          value: draft.nextDate,
          disabled: !!existing,
          onChange: (v) => { if (v) draft.nextDate = v; },
        }),
      }),
      field({
        label: 'Stop after',
        hint: 'Optional',
        input: dateInput({ value: draft.endDate || '', min: addDays(draft.nextDate, 0), onChange: (v) => { draft.endDate = v || null; } }),
      })),
    h('div', { class: 'field' },
      h('label', { class: 'field-label' }, 'Lines'),
      linesHost),
    h('div', { class: 'row' },
      button({
        label: 'Add another line',
        icon: ICONS.plus,
        onClick: () => {
          draft.lines.push(blankLine({ accountCode: accountOptions()[0]?.value || '', taxCode: 'GST', qty: 1000 }));
          redrawLines();
        },
      })),
    field({
      label: 'Note',
      hint: 'Copied onto each draft',
      input: textarea({ value: draft.note, rows: 2, onInput: (v) => { draft.note = v; } }),
    }),
    checkbox({
      label: 'Active',
      checked: draft.active !== false,
      onChange: (checked) => { draft.active = checked; },
    }));

  modal({
    title: existing ? 'Edit recurring transaction' : 'New recurring transaction',
    subtitle: 'This is a schedule, not a document. It creates drafts you check before they reach your books.',
    width: 'lg',
    body,
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({
        label: existing ? 'Save changes' : 'Save schedule',
        variant: 'primary',
        onClick: () => {
          if (!save()) return;
          close(null);
          ctx.refresh();
        },
      }),
    ],
  });
}
