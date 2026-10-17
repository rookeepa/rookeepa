/**
 * Rookeepa — banking.
 *
 * The bank screen is where the ledger meets reality. A statement arrives as a
 * CSV, every line lands as a bank transaction, and then each one is dealt with:
 * categorised (which posts a Spend money / Receive money journal), matched to
 * something already in the books, turned into a customer receipt or supplier
 * payment, or excluded because it is not yours to book.
 *
 * Nothing here invents a balance. Account cards and the cash summary read the
 * same journal entries every other report reads, and every write goes through
 * postEntry (or a core helper that does), so debits always equal credits.
 */

import {
  h, clear, append, field, input, select, moneyInput, dateInput, button, iconButton,
  card, pageHeader, table, moneyCell, badge, statusBadge, modal, toast, confirmDialog,
  promptDialog, emptyState, banner, kpi, segmented, toolbar, barChart, checkbox, accountPicker,
  icon, ICONS, fmt, sectionTitle,
} from './kit.js';
import {
  blankBankTxn, categoriseBankTxn, matchBankTxn, bankTxnToPayment, reconciliation, setStatementOpening,
  reconcileBankTxn,
  unreconcileBankTxn, undoBankTxnCategorisation, excludeBankTxn, reinstateBankTxn,
} from '../core/docs.js';
import {
  blankBankRule, suggestFor, applyRules, listBankRules, saveBankRule, deleteBankRule, ruleConditions,
} from '../core/bank-rules.js';
import { parseBankStatement, rowsToCsvBlob } from '../core/csv.js';
import { suggestAccount, similarity, normaliseDescription } from '../core/history.js';
import { listJobs, jobLabel, saveJob, setJobActive } from '../core/jobs.js';
import { jobPicker as kitJobPicker } from './kit.js';
import { readFileAsText, readFileAsDataUrl, downloadBlob } from '../core/backup.js';
import { attachFile, removeFile, filesFor, formatBytes } from '../core/attachments.js';
import { splitInclusive, sum } from '../core/money.js';
import { accountByRole, bankAccounts } from '../core/coa.js';
import { dr, cr, postEntry, accountLedger, accountBalance, SOURCE_LABELS } from '../core/ledger.js';
import {
  todayISO, fyStartFor, addMonths, startOfMonth, endOfMonth, monthsBetween, daysBetween,
} from '../core/dates.js';
import { cashFlow } from '../core/reports.js';
import { uid } from '../core/db.js';
import { accountOptions } from './print.js';

export const meta = {
  title: 'Banking',
  subtitle: 'Bank accounts, statement import, categorising, matching and reconciliation',
};

/** How close two amounts must be, in cents, before a ledger line looks like a match. */
const MATCH_TOLERANCE_CENTS = 5;
/** How many days either side of a bank line a candidate match may sit. */
const MATCH_WINDOW_DAYS = 14;

/* ------------------------------------------------------------------ helpers */

/** Money for display, in the company's currency. */
function money(ctx, cents) {
  return fmt.money(cents, { code: ctx.company?.currency || 'AUD' });
}

function accountName(accounts, code) {
  const a = accounts.find((x) => x.code === code);
  return a ? `${a.code} ${a.name}` : (code || '');
}

function currencyCode(ctx) {
  return ctx.company?.currency || 'AUD';
}

/** The key that makes two bank lines "probably the same thing". */
function dupKey(date, amount, description) {
  return `${date}|${Math.round(amount || 0)}|${String(description || '').trim().toLowerCase()}`;
}

/**
 * The journal a categorised line or a Spend/Receive money entry will post.
 * Pure: it reads the same accounts, tax codes and splitInclusive the core uses,
 * so the preview cannot drift from what categoriseBankTxn / postEntry writes.
 *
 * Returns { lines, net, gst, debit, credit, missingGst, effectiveTaxCode }.
 * When the tax code carries GST but the company file has no GST account, it
 * falls back to not-reportable (the full amount to the target account) and
 * flags `missingGst` so the caller can explain why.
 */
function moneyLines({ direction, total, bankCode, targetCode, taxCode, accounts, taxCodes, gstRegistered = true }) {
  const incoming = direction === 'receive';
  const target = accounts.find((a) => a.code === targetCode);
  const tc = taxCodes.find((t) => t.code === taxCode) || { code: 'N-T', gstBps: 0 };
  // A business that is not registered for GST has no GST inside these amounts, so the
  // whole amount goes to the target account — matching what categorising actually posts.
  const parts = gstRegistered ? splitInclusive(Math.abs(total || 0), tc) : { ex: Math.abs(total || 0), gst: 0 };
  const gstRole = incoming ? 'gstCollected' : 'gstPaid';
  const gstAccount = parts.gst > 0 ? accountByRole(accounts, gstRole) : null;
  const missingGst = parts.gst > 0 && !gstAccount;
  const net = missingGst ? Math.abs(total || 0) : parts.ex;
  const gst = missingGst ? 0 : parts.gst;

  const lines = [];
  const push = (accountCode, debit, credit, label, taxCodeLabel) => {
    if (!debit && !credit) return;
    lines.push({ accountCode, debit, credit, label, taxCode: taxCodeLabel || null });
  };

  if (incoming) {
    push(bankCode, Math.abs(total || 0), 0, 'Bank');
    push(targetCode, 0, net, target?.name || targetCode, tc.code);
    if (gst) push(gstAccount.code, 0, gst, gstAccount.name, tc.code);
  } else {
    push(targetCode, net, 0, target?.name || targetCode, tc.code);
    if (gst) push(gstAccount.code, gst, 0, gstAccount.name, tc.code);
    push(bankCode, 0, Math.abs(total || 0), 'Bank');
  }

  return {
    lines,
    net,
    gst,
    debit: sum(lines.map((l) => l.debit)),
    credit: sum(lines.map((l) => l.credit)),
    missingGst,
    effectiveTaxCode: missingGst ? 'N-T' : tc.code,
  };
}

/** A Dr/Cr table for a previewed journal. */
function entryTable(ctx, lines) {
  const cur = currencyCode(ctx);
  return table({
    columns: [
      {
        key: 'accountCode',
        label: 'Account',
        render: (r) => h('span', null, h('span', { class: 'mono' }, r.accountCode || ''), ' ', h('span', { class: 'muted' }, r.label || '')),
      },
      { key: 'taxCode', label: 'Tax', render: (r) => (r.taxCode ? badge(r.taxCode, 'muted') : '') },
      { key: 'debit', label: 'Debit', align: 'right', render: (r) => (r.debit ? moneyCell(r.debit, { code: cur }) : '') },
      { key: 'credit', label: 'Credit', align: 'right', render: (r) => (r.credit ? moneyCell(r.credit, { code: cur }) : '') },
    ],
    rows: lines,
    compact: true,
    empty: 'Nothing to post yet.',
  });
}

/** Reconcile check indicator, shared by the cards and the reconciliation card. */
function reconcileIndicator(ctx, rec) {
  const ok = rec.difference === 0;
  // A gap with nothing left to review is a different animal from a gap with lines still to deal with, and
  // this chip is read first: "out by X" alone invites the reading that a line is not being counted.
  const detail = ok
    ? null
    : rec.unreconciledCount === 0
      ? 'Every line is reconciled, so the difference is between the books and the statement — check the opening balance, then the ledger.'
      : 'Categorise or match the lines below to close the gap.';
  return h('span', { class: `report-check${ok ? '' : ' bad'}`, title: detail },
    icon(ok ? ICONS.check : ICONS.warning, { size: 14 }),
    h('span', null, ok
      ? 'Reconciles'
      : `Does not reconcile — out by ${money(ctx, Math.abs(rec.difference))}`));
}

/* ------------------------------------------------------------------ contacts */

/** A small contact picker for turning a bank line into a payment. */
function pickContact(ctx, kind) {
  return new Promise((resolve) => {
    const contacts = ctx.data.contacts
      .filter((c) => (kind === 'customer' ? c.isCustomer !== false : c.isSupplier === true) && c.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name));
    const m = modal({
      title: kind === 'customer' ? 'Choose a customer' : 'Choose a supplier',
      subtitle: 'This line looks like money moving for this contact.',
      width: 'md',
      body: () => (contacts.length
        ? table({
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'email', label: 'Email', className: 'muted small' },
            { key: 'terms', label: 'Terms', className: 'muted small' },
          ],
          rows: contacts,
          onRowClick: (c) => { resolve(c.id); m.close(c); },
        })
        : emptyState({
          title: 'No contacts yet',
          message: `Add a ${kind} under Contacts, then come back and try again.`,
        })),
      actions: ({ close }) => [button({ label: 'Cancel', variant: 'ghost', onClick: () => { resolve(null); close(null); } })],
      onClose: () => resolve(null),
    });
  });
}

/* --------------------------------------------------------- categorise a line */

/**
 * The coding form for one bank line: an account and tax code, or a split across several, with the
 * contact and a live preview of the entry it will post.
 *
 * It returns the node rather than opening anything, because two places need it: the dialog, which is
 * what a row's Categorise action has always opened, and the panel on the transactions screen, which
 * embeds it so a line can be coded where it sits. One form, so the two cannot drift — and `post()`
 * throws with a reason instead of toasting, so each caller says it in its own voice.
 */
function categoriseForm(ctx, txn) {
  const accounts = ctx.data.accounts;
  const taxCodes = ctx.data.taxCodes;
  const cur = currencyCode(ctx);
  const incoming = txn.amount > 0;

  // What the last similar line was coded to, if anything was. It prefills a field and explains itself;
  // it posts nothing, and it is the weakest of the three things that can fill this in.
  const suggestion = txn.categoryAccount
    ? null
    : suggestAccount(ctx.data?.bankTxns || [], txn.description);

  const state = {
    // Three sources, each weaker than the last: what the line already says, what history suggests, and
    // failing both, the first account of the kind this line would go to.
    targetCode: txn.categoryAccount
      || (suggestion ? suggestion.accountCode : '')
      || (accounts.find((a) => a.type === (incoming ? 'income' : 'expense')) || {}).code
      || '',
    taxCode: txn.taxCode || '',
    contactId: txn.contactId || null,
    // Empty means the ordinary case — one account. It is filled in only when someone chooses to split,
    // and emptied again if they change their mind, so the single-account path is never on this code path.
    splits: [],
  };
  if (!state.taxCode) {
    state.taxCode = accounts.find((a) => a.code === state.targetCode)?.gstDefault || 'GST';
  }

  const options = accountOptions(accounts, { all: true }).filter((o) => o.value !== txn.accountCode);
  const previewHost = h('div');
  const bodyHost = h('div', { class: 'stack' });

  const targetSelect = accountPicker({
    options: options.filter((o) => o.value),
    value: state.targetCode,
    onChange: (v) => {
      state.targetCode = v;
      const acc = accounts.find((a) => a.code === v);
      if (acc?.gstDefault) { state.taxCode = acc.gstDefault; taxSelect.value = acc.gstDefault; }
      drawPreview();
    },
  });

  const taxSelect = select({
    options: taxCodes.map((t) => ({ value: t.code, label: `${t.code} — ${t.name}` })),
    value: state.taxCode,
    onChange: (v) => { state.taxCode = v; drawPreview(); },
  });
  taxSelect.title = taxCodes.map((t) => `${t.code}: ${t.description}`).join('\n');

  const contactSelect = select({
    options: [{ value: '', label: 'No contact' }, ...ctx.data.contacts.map((c) => ({ value: c.id, label: c.name }))],
    value: state.contactId || '',
    onChange: (v) => { state.contactId = v || null; },
  });

  /* ---------------------------------------------------------------- splitting */

  /*
   * One bank line across several accounts — a loan repayment is part principal, part interest.
   *
   * The single-account path is untouched: this is only reached when someone asks to split, and switching
   * to it starts from the account already chosen and the whole amount, so nothing has to be typed twice.
   * The amounts are what left the bank, GST included, and they have to add up to the whole line before
   * anything is posted — the running total below says by how much they do not.
   */
  const splitsHost = h('div', { class: 'stack' });
  let outOfBalance = 0;

  function addSplit() {
    const total = Math.abs(txn.amount || 0);
    const allocated = state.splits.reduce((a, s) => a + (s.amount || 0), 0);
    // A new split starts with what is still unallocated, which is almost always what the person means.
    state.splits.push({ accountCode: '', taxCode: state.taxCode, amount: Math.max(0, total - allocated), note: '', jobCode: state.splits[0]?.jobCode || '' });
    drawSplits();
  }

  function drawSplits() {
    clear(splitsHost);
    const total = Math.abs(txn.amount || 0);
    const allocated = state.splits.reduce((a, s) => a + (s.amount || 0), 0);
    outOfBalance = total - allocated;

    state.splits.forEach((split, index) => {
      // The job belongs to the leg, not the whole payment: one statement line can carry two jobs.
      const job = jobPicker(ctx, { value: split.jobCode, onChange: (v) => { split.jobCode = v; } });
      const cells = [
        field({
          label: `Split ${index + 1}`,
          input: accountPicker({
            options: options.filter((o) => o.value),
            value: split.accountCode,
            onChange: (v) => {
              split.accountCode = v;
              const acc = accounts.find((a) => a.code === v);
              if (acc?.gstDefault) split.taxCode = acc.gstDefault;
              drawSplits();
            },
          }),
        }),
        field({
          label: 'Tax code',
          input: select({
            options: taxCodes.map((t) => ({ value: t.code, label: t.code })),
            value: split.taxCode,
            onChange: (v) => { split.taxCode = v; drawSplits(); },
          }),
        }),
        field({
          label: 'Amount',
          // The kit's money input, so a split is typed in dollars and stored in cents like every other
          // amount in the app.
          input: moneyInput({
            value: split.amount || 0,
            code: cur,
            onChange: (v) => { split.amount = v; drawSplits(); },
          }),
        }),
        job ? field({ label: 'Job', input: job }) : null,
        field({
          label: 'Note',
          input: input({
            value: split.note || '',
            placeholder: 'e.g. Principal',
            onInput: (v) => { split.note = v; },
          }),
        }),
      ];
      if (state.splits.length > 1) {
        cells.push(button({
          label: 'Remove',
          size: 'sm',
          variant: 'ghost',
          onClick: () => { state.splits.splice(index, 1); drawSplits(); },
        }));
      }
      splitsHost.appendChild(h('div', { class: 'split-row' }, ...cells));
    });

    splitsHost.appendChild(h('div', { class: 'row-between' },
      button({ label: 'Add another split', size: 'sm', variant: 'subtle', onClick: addSplit }),
      h('span', { class: outOfBalance === 0 ? 'small muted' : 'small strong', id: 'split-balance' },
        outOfBalance === 0
          ? `The splits add up to ${money(ctx, total)} — ready to post.`
          : `${outOfBalance > 0 ? 'Still to allocate' : 'Over by'} ${money(ctx, Math.abs(outOfBalance))}: the splits must add up to ${money(ctx, total)}.`)));

    drawPreview();
  }

  /** The journal entry this dialog will post — one bank line, and a line per split. */
  function previewLines() {
    const total = Math.abs(txn.amount || 0);
    const direction = incoming ? 'receive' : 'spend';
    const shared = {
      direction, bankCode: txn.accountCode, accounts, taxCodes,
      gstRegistered: ctx.company?.gstRegistered !== false,
    };
    if (!state.splits.length) {
      return moneyLines({ ...shared, total, targetCode: state.targetCode, taxCode: state.taxCode });
    }

    const usable = state.splits.filter((s) => s.accountCode && s.amount);
    const lines = [];
    let bankLine = null;
    let missingGst = false;
    for (const split of usable) {
      const p = moneyLines({ ...shared, total: split.amount, targetCode: split.accountCode, taxCode: split.taxCode });
      missingGst = missingGst || p.missingGst;
      for (const l of p.lines) {
        if (l.accountCode === txn.accountCode) bankLine = bankLine || l;
        else lines.push(l);
      }
    }
    // The bank line is drawn once, at the whole amount, rather than one per split — that is the shape
    // the ledger gets, so the preview is the entry being posted rather than an approximation of it.
    if (bankLine) {
      lines.unshift({ ...bankLine, debit: incoming ? total : 0, credit: incoming ? 0 : total });
    }
    const debit = lines.reduce((a, l) => a + (l.debit || 0), 0);
    const credit = lines.reduce((a, l) => a + (l.credit || 0), 0);
    return {
      lines,
      debit,
      credit,
      effectiveTaxCode: state.splits[0]?.taxCode || state.taxCode,
      missingGst,
    };
  }

  function drawPreview() {
    clear(previewHost);
    if (state.splits.length) {
      if (!state.splits.some((s) => s.accountCode && s.amount)) {
        previewHost.appendChild(h('p', { class: 'field-hint' }, 'Give each split an account and an amount to see the journal entry this will post.'));
        return;
      }
      const p = previewLines();
      append(previewHost, [
        entryTable(ctx, p.lines),
        p.missingGst ? banner({
          kind: 'warning',
          title: 'No GST account in this file',
          message: `There is no "${incoming ? 'GST collected' : 'GST paid'}" account, so the whole amount will be posted as not reportable. Add the account under Accounts to record the GST separately.`,
        }) : h('span'),
        h('p', { class: 'report-note' },
          outOfBalance === 0
            ? `Debit ${money(ctx, p.debit)} · Credit ${money(ctx, p.credit)} — balanced, and the splits match the bank.`
            : `The splits are ${money(ctx, Math.abs(outOfBalance))} ${outOfBalance > 0 ? 'short of' : 'over'} the bank amount. Nothing is posted until they match.`),
      ]);
      return;
    }
    if (!state.targetCode) {
      previewHost.appendChild(h('p', { class: 'field-hint' }, 'Choose an account to see the journal entry this will post.'));
      return;
    }
    const p = previewLines();
    append(previewHost, [
      entryTable(ctx, p.lines),
      p.missingGst
        ? banner({
          kind: 'warning',
          title: 'No GST account in this file',
          message: `There is no "${incoming ? 'GST collected' : 'GST paid'}" account, so the whole amount will be posted as not reportable. Add the account under Accounts to record the GST separately.`,
        })
        : h('span'),
      h('p', { class: 'report-note' },
        `Debit ${money(ctx, p.debit)} · Credit ${money(ctx, p.credit)} — ${p.debit === p.credit ? 'balanced' : 'OUT OF BALANCE'}.`),
    ]);
  }

  const accountHint = suggestion && !txn.categoryAccount
    ? `Suggested from your own history: ${suggestion.count} similar line${suggestion.count === 1 ? '' : 's'}, most recently coded to ${accountName(accounts, suggestion.accountCode)} on ${fmt.date(suggestion.lastDate)}. Change it if that is not right.`
    : 'Type to search by name or code.';

  const singleFields = h('div', { class: 'form-grid' },
    field({ label: txn.amount > 0 ? 'Post the money to (income/asset/liability)' : 'Post the money to (expense/asset/liability)', required: true, input: targetSelect, hint: accountHint }),
    field({ label: 'Tax code', input: taxSelect }),
    field({ label: 'Contact', hint: 'Optional — links the entry to a customer or supplier.', input: contactSelect }));

  // Which view the dialog is showing. Splitting is one click from the ordinary case, and the ordinary
  // case is untouched — a person who never splits sees exactly the form that was always there.
  let splitMode = false;
  const bodyTop = h('div', { class: 'stack' });

  function switchToSplit() {
    splitMode = true;
    // Start from what is already chosen — the account, its tax code and the whole amount — because
    // switching should never lose work, and the first split is nearly always the account already picked.
    if (!state.splits.length) {
      state.splits = [{
        accountCode: state.targetCode,
        taxCode: state.taxCode,
        amount: Math.abs(txn.amount || 0),
        note: '',
      }];
    }
    drawBody();
  }

  function switchToOne() {
    splitMode = false;
    state.splits = [];
    drawBody();
  }

  function drawBody() {
    clear(bodyTop);
    if (splitMode) {
      bodyTop.appendChild(h('p', { class: 'field-hint' },
        'One bank line, several accounts — a loan repayment is part principal, part interest. Each amount is what left the bank, tax included, and together they must match the whole line.'));
      bodyTop.appendChild(splitsHost);
      bodyTop.appendChild(button({ label: 'Code it to one account instead', size: 'sm', variant: 'ghost', onClick: switchToOne }));
      drawSplits();
    } else {
      bodyTop.appendChild(singleFields);
      bodyTop.appendChild(button({ label: 'Split this across more than one account', size: 'sm', variant: 'subtle', onClick: switchToSplit }));
    }
    drawPreview();
  }

  append(bodyHost, [
    bodyTop,
    h('div', { class: 'divider' }),
    h('h3', { class: 'card-title', style: { fontSize: 'var(--fs-md)' } }, 'What this will post'),
    previewHost,
  ]);

  drawBody();

  /**
   * Post the line with what the form says. Throws with a reason if it cannot be posted, so the caller
   * decides how to say it; returns a line of detail for the toast when it works.
   */
  function post() {
    const usable = state.splits.filter((s) => s.accountCode && s.amount);
    if (splitMode) {
      if (!usable.length) throw new Error('Give at least one split an account and an amount.');
      if (outOfBalance !== 0) {
        throw new Error(`The splits do not add up to the bank amount: ${money(ctx, Math.abs(outOfBalance))} ${outOfBalance > 0 ? 'still to allocate' : 'over'}. Nothing is posted until they match.`);
      }
    } else if (!state.targetCode) {
      throw new Error('Choose the account this transaction belongs to.');
    }
    const p = previewLines();
    categoriseBankTxn(ctx.db, {
      ...txn,
      categoryAccount: splitMode ? usable[0].accountCode : state.targetCode,
      taxCode: splitMode ? usable[0].taxCode : p.effectiveTaxCode,
      contactId: state.contactId,
      splits: splitMode
        ? usable.map((s) => ({ accountCode: s.accountCode, taxCode: s.taxCode, amount: s.amount, note: s.note }))
        : [],
    });
    return splitMode
      ? `Posted to ${usable.map((s) => accountName(accounts, s.accountCode)).join(', ')}.`
      : `Posted to ${accountName(accounts, state.targetCode)}.`;
  }

  return { node: bodyHost, post, previewLines };
}

/** The categorise dialog: the same form, in a modal. */
function openCategoriseModal(ctx, txn) {
  const form = categoriseForm(ctx, txn);
  return modal({
    title: 'Categorise this transaction',
    subtitle: `${txn.date} · ${txn.description || txn.reference || 'bank line'} · ${money(ctx, txn.amount)}`,
    width: 'lg',
    body: form.node,
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({
        label: 'Post to the ledger',
        variant: 'primary',
        onClick: () => {
          try {
            const detail = form.post();
            toast('Transaction categorised', 'success', { detail });
            close(true);
            ctx.refresh();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }),
    ],
  });
}

/* ------------------------------------------------------------ match a line */

/**
 * The job picker for this company file.
 *
 * The control itself lives in the kit; this is the two lines that hand it the jobs. Duplicated on purpose
 * rather than imported across screens, so no screen depends on another screen's module.
 */
function jobPicker(ctx, { value, onChange } = {}) {
  return kitJobPicker(listJobs(ctx.db, ctx.companyId), { value, onChange });
}

/**
 * The records already in the books that a bank line could be matched to.
 *
 * One list, used by the match dialog *and* by the line's own panel: if the panel offered something the dialog
 * would not, or ranked it differently, the two would disagree about the same line. The window stays narrow —
 * the same amount, within a fortnight — because a match that is not the same money is not a match.
 */
function matchCandidates(ctx, txn) {
  return accountLedger(ctx.data.entries, txn.accountCode, { to: ctx.asOf })
    .filter((r) => Math.abs((r.amount || 0) - (txn.amount || 0)) <= MATCH_TOLERANCE_CENTS
      && Math.abs(daysBetween(r.date, txn.date)) <= MATCH_WINDOW_DAYS)
    .map((r) => ({ ...r, ...matchEvidence(txn, r) }))
    .sort((a, b) => (b.score - a.score) || a.date.localeCompare(b.date));
}

/**
 * Why a candidate looks like the one — in a sentence, with a score to rank on.
 *
 * The bank's own line is the best evidence there is: a reference printed on it, or the payer's name, is worth
 * far more than being a couple of days closer. The amount is the entry ticket, since every candidate already
 * matches it, so it tells them apart not at all. Digits are dropped when comparing descriptions (the same
 * rule the coding suggestion uses) which is why the printed reference is checked against the raw text
 * separately — "INV-0001" is the strongest signal on the line and the word comparison would throw it away.
 */
function matchEvidence(txn, row) {
  const rawLine = `${txn.reference || ''} ${txn.description || ''}`.toLowerCase();
  const printed = [row.number, row.ref].filter(Boolean).some((v) => rawLine.includes(String(v).toLowerCase()));
  const shared = similarity(normaliseDescription(`${txn.reference || ''} ${txn.description || ''}`),
    normaliseDescription(`${row.number || ''} ${row.ref || ''} ${row.memo || ''}`));
  const days = Math.abs(daysBetween(row.date, txn.date));
  const score = (printed ? 1000 : 0) + shared * 100 - days;
  const why = printed
    ? `${row.number || row.ref} is printed on the bank line, and the amount is the same`
    : shared > 0.25
      ? 'the description matches the bank line, and the amount is the same'
      : days === 0
        ? 'the amount is the same, on the same day'
        : `the amount is the same, ${days} day${days === 1 ? '' : 's'} apart`;
  return { score, why, printed };
}

/** Match a bank line to a transaction already in the books (nothing is posted). */
function openMatchModal(ctx, txn) {
  const cur = currencyCode(ctx);
  const candidates = matchCandidates(ctx, txn);

  const m = modal({
    title: 'Match to an existing transaction',
    subtitle: `${money(ctx, txn.amount)} on ${fmt.date(txn.date)} · ${txn.description || txn.reference || ''}`,
    width: 'lg',
    body: () => h('div', { class: 'stack' },
      h('p', { class: 'report-note' },
        'Matching marks this bank line reconciled against something already in your books — an invoice paid, a spend money entry, a transfer. Nothing new is posted; the line is simply ticked off.'),
      candidates.length
        ? table({
          columns: [
            { key: 'date', label: 'Date', render: (r) => h('span', { class: 'nowrap' }, fmt.date(r.date)) },
            { key: 'number', label: 'Number', className: 'mono small' },
            { key: 'memo', label: 'Description' },
            { key: 'source', label: 'Type', render: (r) => badge(SOURCE_LABELS[r.source] || r.source || 'Journal', 'muted') },
            { key: 'why', label: 'Why it fits', render: (r) => h('span', { class: 'small muted' }, r.why) },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => moneyCell(r.amount, { code: cur }) },
          ],
          rows: candidates,
          compact: true,
          onRowClick: (r) => {
            try {
              matchBankTxn(ctx.db, txn.id, r.entryId);
              toast('Line reconciled', 'success', { detail: `Matched to ${r.number || 'entry'} in the books.` });
              m.close(true);
              ctx.refresh();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        })
        : emptyState({
          title: 'No matching transactions',
          message: `Nothing in this account matches ${money(ctx, txn.amount)} within ${MATCH_WINDOW_DAYS} days. Categorise the line instead, or check the amount.`,
        })),
    actions: ({ close }) => [button({ label: 'Close', variant: 'ghost', onClick: () => close(null) })],
  });
  return m;
}

/* --------------------------------------------------------- create a payment */

/** Turn a line into a customer receipt or supplier payment, allocating it. */
async function createPaymentFromLine(ctx, txn) {
  let contactId = txn.contactId;
  if (!contactId) {
    contactId = await pickContact(ctx, txn.amount > 0 ? 'customer' : 'supplier');
    if (!contactId) return;
  }
  try {
    const payment = bankTxnToPayment(ctx.db, { ...txn, contactId });
    const contact = ctx.data.contacts.find((c) => c.id === contactId);
    toast(`Payment ${payment.number} recorded`, 'success', {
      detail: `${money(ctx, Math.abs(txn.amount))} ${txn.amount > 0 ? 'from' : 'to'} ${contact?.name || 'the contact'} — allocated to their oldest open documents.`,
    });
    ctx.refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------- exclude / reinstate */

async function excludeLine(ctx, txn) {
  const note = await promptDialog({
    title: 'Exclude this line?',
    label: 'Note (kept with the line)',
    message: 'Excluded lines are set aside when you reconcile. You can reinstate one at any time.',
    placeholder: 'e.g. personal expense, not mine',
    confirmLabel: 'Exclude',
  });
  if (note === null) return;
  try {
    excludeBankTxn(ctx.db, txn, note || '');
    toast('Line excluded', 'success');
    ctx.refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function reinstateLine(ctx, txn) {
  try {
    // Core decides where it goes back to: a categorised line returns to `posted`, not to review, because
    // returning it to review invites a second categorisation and a second entry for the same money.
    reinstateBankTxn(ctx.db, txn);
    toast('Line reinstated', 'success');
    ctx.refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/**
 * Put a reconciled line back in play.
 *
 * Reconciling is a tick against the statement, not a posting, so this is the whole undo: nothing in
 * the ledger is reversed, and a payment the line was matched to stays exactly where it is. What comes
 * back is the ability to change the line — and a line that posted its own entry returns to `posted`
 * with its coding, one step from review.
 */

async function unreconcileLine(ctx, txn) {
  const had = txn.journalId
    ? 'It is still categorised — reverse the categorisation if the account was wrong.'
    : 'It goes back to review, ready to be coded.';
  const ok = await confirmDialog({
    title: 'Un-reconcile this line?',
    message: `The tick against the statement is removed. Nothing in the ledger is reversed, and anything this line was matched to stays as it is. ${had}`,
    confirmLabel: 'Un-reconcile',
  });
  if (!ok) return;
  try {
    unreconcileBankTxn(ctx.db, txn);
    toast('Line un-reconciled', 'success', { detail: had });
    ctx.refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Tick a coded line off against the statement. Nothing is posted — the entry is already there. */
function reconcileLine(ctx, txn) {
  // Only the core call is guarded: it can refuse for real reasons worth showing. The plumbing below is not
  // wrapped, because a bug in it should break loudly rather than arrive disguised as a friendly error toast.
  try {
    reconcileBankTxn(ctx.db, txn);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  toast('Line reconciled', 'success', { detail: 'Ticked off against the statement. Nothing new was posted.' });
  // Clearing the remembered id is what closes the panel: the screen rebuilds itself from that value. This
  // function lives outside the render closure, so it deliberately does not touch the local mirror of it —
  // reaching for that threw, and the throw was invisible until the row failed to change on screen.
  ctx.ui.set('bankExpanded', null);
  ctx.refresh();
}

/**
 * Reverse a line's categorisation, so a different account or tax code can be chosen.
 *
 * The entry is voided rather than deleted, which is what makes coding it again safe: a voided entry
 * is kept for the record and left out of the reports, so the line cannot end up counted twice.
 */
async function undoLineCategorisation(ctx, txn) {
  const ok = await confirmDialog({
    title: 'Reverse this categorisation?',
    message: 'The entry this line posted is voided — kept in the ledger as a reversal, not deleted — and the line returns to review so you can code it again.',
    confirmLabel: 'Reverse it',
    danger: true,
  });
  if (!ok) return;
  try {
    undoBankTxnCategorisation(ctx.db, txn);
    toast('Categorisation reversed', 'success', { detail: 'The line is back in review.' });
    ctx.refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeLine(ctx, txn) {
  const posted = !!txn.journalId;
  const ok = await confirmDialog({
    title: 'Remove this bank line?',
    message: 'The bank line is deleted from this account. This cannot be undone.',
    detail: posted
      ? 'Its journal entry stays in the ledger — void it from the Journal screen if the entry was wrong too.'
      : `${txn.date} · ${txn.description || txn.reference || 'bank line'} · ${money(ctx, txn.amount)}`,
    confirmLabel: 'Remove line',
    danger: true,
  });
  if (!ok) return;
  ctx.db.remove('bankTxns', txn.id);
  toast('Bank line removed', 'success');
  ctx.refresh();
}

/* ------------------------------------------------------------------- import */

/** Import a bank statement (CSV or TXT): preview, duplicate check, then import. */
function openImportModal(ctx, defaultAccountCode) {
  const { db, companyId } = ctx;
  const banks = bankAccounts(ctx.data.accounts);
  const cur = currencyCode(ctx);

  const state = {
    accountCode: defaultAccountCode || banks[0]?.code || '',
    name: '',
    parsed: null,
    skipDuplicates: true,
  };

  const bodyHost = h('div', { class: 'stack' });
  let importBtn = null;

  function existingKeys(accountCode) {
    const set = new Set();
    for (const t of db.of('bankTxns', companyId).filter((x) => x.accountCode === accountCode)) {
      set.add(dupKey(t.date, t.amount, t.description));
    }
    return set;
  }

  /** Mark each parsed row as a duplicate of an existing line or an earlier row. */
  function markDuplicates() {
    if (!state.parsed) return { count: 0, marked: [] };
    const seen = existingKeys(state.accountCode);
    let count = 0;
    const marked = state.parsed.rows.map((r) => {
      const key = dupKey(r.date, r.amount, r.description);
      const dup = seen.has(key);
      if (dup) count++;
      seen.add(key);
      return dup;
    });
    return { count, marked };
  }

  function skipReasonCounts() {
    const out = new Map();
    for (const s of state.parsed?.skipped || []) out.set(s.reason, (out.get(s.reason) || 0) + 1);
    return [...out.entries()];
  }

  function doImport(close) {
    if (!state.parsed || !state.parsed.rows.length) { toast('Choose a file with at least one readable line first.', 'warn'); return; }
    const batch = uid('imp');
    const seen = existingKeys(state.accountCode);
    const rules = listBankRules(db, companyId);
    const records = [];
    let duplicatesSkipped = 0;
    let fromRules = 0;
    for (const r of state.parsed.rows) {
      const key = dupKey(r.date, r.amount, r.description);
      const dup = seen.has(key);
      seen.add(key);
      if (dup && state.skipDuplicates) { duplicatesSkipped++; continue; }
      // A rule pre-fills the account and tax code so a familiar line is easy to
      // spot and check. It is still only a suggestion: the line is posted later,
      // by Apply rules or by categorising it, so nothing reaches the ledger here.
      const suggestion = suggestFor(rules, { description: r.description, amount: r.amount });
      const record = blankBankTxn({
        companyId,
        accountCode: state.accountCode,
        date: r.date,
        description: r.description,
        reference: r.reference,
        amount: r.amount,
        balance: r.balance,
        status: 'unreconciled',
        type: r.amount > 0 ? 'receive' : 'spend',
        importedFrom: state.name,
        importedBatch: batch,
        categoryAccount: suggestion?.accountCode || '',
        taxCode: suggestion?.taxCode || 'GST',
        contactId: suggestion?.contactId || null,
      });
      if (suggestion?.accountCode) {
        record.ruleId = suggestion.ruleId;
        record.categorySource = 'rule';
        fromRules++;
      }
      records.push(record);
    }
    if (!records.length) { toast('Every line was a duplicate and was skipped.', 'info'); return; }
    db.putMany('bankTxns', records);
    close(true);
    toast(`Imported ${records.length} line(s)`, 'success', {
      detail: [
        duplicatesSkipped ? `${duplicatesSkipped} likely duplicate(s) skipped.` : `From ${state.name}.`,
        fromRules ? `${fromRules} line(s) pre-filled from a bank rule — check them.` : '',
      ].filter(Boolean).join(' '),
    });
    ctx.refresh();
  }

  async function onFile(fileInput) {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      state.name = file.name;
      state.text = text;
      // An explicit choice (the control below) wins over detection, so a file whose
      // dates were read the wrong way round can be corrected without re-exporting it.
      state.parsed = parseBankStatement(text, state.dateOrder ? { dateOrder: state.dateOrder } : {});
      redraw();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /**
   * The order is decided once for the whole file, so offer the decision rather than let
   * the app pick silently: a mis-read order moves every transaction by months.
   */
  function dateOrderControl() {
    const current = state.dateOrder || state.parsed?.dateOrder || 'dmy';
    return h('div', { style: { marginTop: '0.6rem', maxWidth: '280px' } },
      field({
        label: 'Date order in this file',
        input: select({
          options: [
            { value: 'dmy', label: 'Day first — 31/12/2026' },
            { value: 'mdy', label: 'Month first — 12/31/2026' },
          ],
          value: current,
          onChange: (v) => {
            state.dateOrder = v;
            if (state.text) state.parsed = parseBankStatement(state.text, { dateOrder: v });
            redraw();
          },
        }),
        hint: 'Rookeepa reads the whole file with one order, never row by row.',
      }));
  }

  function redraw() {
    clear(bodyHost);

    const accountSelect = select({
      options: banks.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` })),
      value: state.accountCode,
      onChange: (v) => { state.accountCode = v; redraw(); },
    });

    const fileInput = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', class: 'input' });
    fileInput.addEventListener('change', () => onFile(fileInput));

    append(bodyHost, [
      h('div', { class: 'form-grid' },
        field({ label: 'Bank account', required: true, input: accountSelect, hint: 'Every imported line is filed against this account.' }),
        field({
          label: 'Statement file (.csv, .txt)',
          required: true,
          input: fileInput,
          hint: state.name ? `Loaded ${state.name}. Choose another file to replace it.` : 'Any delimiter, quoted fields, or separate debit/credit columns.',
        })),
    ]);

    if (!state.parsed) {
      bodyHost.appendChild(h('p', { class: 'field-hint' }, 'Choose a file to see a preview. Nothing is imported until you press Import.'));
      if (importBtn) importBtn.disabled = true;
      return;
    }

    // A file whose dates contradict each other cannot be read at all. Refusing beats
    // importing half of it months out.
    if (state.parsed.dateOrderConflict) {
      bodyHost.appendChild(h('div', { class: 'divider' }));
      bodyHost.appendChild(banner({
        kind: 'warn',
        title: 'Set the date order for this file',
        message: state.parsed.problem,
      }));
      bodyHost.appendChild(dateOrderControl());
      if (importBtn) importBtn.disabled = true;
      return;
    }

    const { rows, skipped } = state.parsed;
    const dup = markDuplicates();
    const rules = listBankRules(db, companyId);

    const preview = rows.slice(0, 20).map((r, i) => {
      const suggestion = suggestFor(rules, { description: r.description, amount: r.amount });
      const matched = suggestion?.accountCode ? rules.find((x) => x.id === suggestion.ruleId) : null;
      return {
        ...r,
        duplicate: dup.marked[i],
        ruleName: suggestion?.accountCode ? (matched?.name || 'Bank rule') : '',
        ruleAccount: suggestion?.accountCode || '',
      };
    });
    const previewFromRules = preview.filter((r) => r.ruleAccount).length;
    bodyHost.appendChild(h('div', { class: 'divider' }));
    bodyHost.appendChild(h('h3', { class: 'card-title', style: { fontSize: 'var(--fs-md)' } }, 'Preview'));
    bodyHost.appendChild(h('p', { class: 'report-note' },
      `${rows.length} line(s) read · ${skipped.length} skipped${rows.length > 20 ? ` · showing the first 20` : ''}.`));
    if (previewFromRules) {
      bodyHost.appendChild(h('p', { class: 'field-hint' },
        `${previewFromRules} of these line(s) match a bank rule — their account and tax code are filled in below so you can check them before filing.`));
    }
    if (state.parsed.dateOrderAssumed) {
      bodyHost.appendChild(h('p', { class: 'field-hint' },
        'Every date in this file could be read either way, so Rookeepa assumed day/month — the Australian convention. Check the dates above, and change the order below if that is wrong.'));
    }
    bodyHost.appendChild(dateOrderControl());
    bodyHost.appendChild(table({
      columns: [
        { key: 'date', label: 'Date', render: (r) => h('span', { class: 'nowrap' }, fmt.date(r.date)) },
        { key: 'description', label: 'Description', render: (r) => h('div', null,
          h('span', null, r.description || '—'),
          r.duplicate ? h('div', { class: 'row-sub' }, 'Looks like a duplicate') : null) },
        { key: 'reference', label: 'Reference', className: 'muted small' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => moneyCell(r.amount, { code: cur }) },
        { key: 'balance', label: 'Balance', align: 'right', render: (r) => (r.balance === null || r.balance === undefined ? h('span', { class: 'muted' }, '—') : moneyCell(r.balance, { code: cur })) },
        {
          key: 'ruleName',
          label: 'Filed from',
          render: (r) => (r.ruleAccount
            ? h('div', null,
              badge(r.ruleName, 'info'),
              h('div', { class: 'row-sub' }, accountName(ctx.data.accounts, r.ruleAccount)))
            : h('span', { class: 'muted' }, '—')),
        },
      ],
      rows: preview,
      compact: true,
      empty: 'No readable lines were found in that file.',
    }));

    if (skipped.length) {
      bodyHost.appendChild(h('p', { class: 'field-hint' }, 'Lines that could not be read:'));
      bodyHost.appendChild(h('div', { class: 'stack' }, skipReasonCounts().map(([reason, n]) =>
        h('span', { class: 'row-sub' }, `${n} line(s) — ${reason}`))));
    }

    if (dup.count) {
      bodyHost.appendChild(banner({
        kind: 'warning',
        title: `${dup.count} line(s) look like duplicates`,
        message: 'Same date, amount and description already on this account (or repeated in this file).',
        actions: [checkbox({
          label: 'Skip duplicates on import',
          checked: state.skipDuplicates,
          onChange: (v) => { state.skipDuplicates = v; },
        })],
      }));
    }

    if (importBtn) importBtn.disabled = rows.length === 0;
  }

  const handle = modal({
    title: 'Import a bank statement',
    subtitle: 'Preview first — nothing is written to your books until you press Import.',
    width: 'lg',
    body: bodyHost,
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      (importBtn = button({ label: 'Import', variant: 'primary', onClick: () => doImport(close) })),
    ],
  });

  redraw();
  if (importBtn) importBtn.disabled = true;
  return handle;
}

/* -------------------------------------------------------- spend / receive money */

/** A manual entry that posts a journal and records a matching bank line. */
function openMoneyModal(ctx, direction, defaultAccountCode) {
  const { db, companyId, company, data } = ctx;
  const accounts = data.accounts;
  const taxCodes = data.taxCodes;
  const banks = bankAccounts(accounts);
  const incoming = direction === 'receive';
  const cur = currencyCode(ctx);

  const state = {
    date: ctx.asOf || todayISO(),
    accountCode: defaultAccountCode || company?.bankAccount || banks[0]?.code || '',
    description: '',
    reference: '',
    // One row per account the money is spread across. A single account is a list of one — the same shape the
    // ledger's split posting uses — so a note can sit on the line whether or not it is split, and there is no
    // separate "split" mode that can get out of step with the plain one.
    lines: [],
    amount: 0,
    contactId: null,
  };
  const fallbackTarget = accounts.find((a) => a.code === (incoming ? company?.defaultSalesAccount : company?.defaultPurchaseAccount))
    || accounts.find((a) => a.type === (incoming ? 'income' : 'expense') && a.active !== false);
  const opening = fallbackTarget?.code || '';
  state.lines = [{
    accountCode: opening,
    taxCode: accounts.find((a) => a.code === opening)?.gstDefault || 'GST',
    amount: 0,
    note: '',
  }];

  const previewHost = h('div');
  const targetHost = h('div');
  const bodyHost = h('div', { class: 'stack' });
  let handle = null;

  const dateField = dateInput({ value: state.date, onChange: (v) => { state.date = v; } });
  const bankSelect = select({
    options: banks.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` })),
    value: state.accountCode,
    onChange: (v) => { state.accountCode = v; buildTargets(); drawPreview(); },
  });
  const descField = input({
    value: '',
    placeholder: incoming ? 'Who paid you, and what for' : 'Who you paid, and what for',
    onInput: (v) => { state.description = v; },
  });
  const refField = input({ value: '', placeholder: 'Reference or cheque number', onInput: (v) => { state.reference = v; } });
  const amountField = moneyInput({
    value: 0,
    code: company?.currency,
    onChange: (v) => { state.amount = v; drawPreview(); },
    onEnter: () => save(),
  });
  const contactSelect = select({
    options: [{ value: '', label: 'No contact' }, ...data.contacts.map((c) => ({ value: c.id, label: c.name }))],
    value: '',
    onChange: (v) => { state.contactId = v || null; },
  });

  function buildTargets() {
    // Every row gets a live line of its own: a note belongs to the line it is typed on, not to the entry as
    // a whole, and the split has to add up to the bank before it can post.
    const rows = state.lines.map((row, index) => {
      const accountChoice = accountPicker({
        options: accountOptions(accounts, { all: true }).filter((o) => o.value !== state.accountCode),
        value: row.accountCode,
        onChange: (v) => {
          row.accountCode = v || '';
          row.taxCode = accounts.find((a) => a.code === v)?.gstDefault || row.taxCode;
          // Move the visible tax code with the account, without rebuilding the rows — rebuilding on a pick
          // would take the focus out of the field being typed in.
          if (row.taxSelect) row.taxSelect.value = row.taxCode;
          drawPreview();
        },
      });
      const amountBox = moneyInput({
        value: row.amount,
        code: company?.currency,
        onChange: (v) => { row.amount = v; drawPreview(); },
        onEnter: () => save(),
      });
      const tax = select({
        options: taxCodes.map((t) => ({ value: t.code, label: `${t.code} — ${t.name}` })),
        value: row.taxCode,
        onChange: (v) => { row.taxCode = v; drawPreview(); },
      });
      const note = input({
        value: row.note,
        placeholder: 'Note for this line (optional)',
        onInput: (v) => { row.note = v; },
      });
      const job = jobPicker(ctx, { value: row.jobCode, onChange: (v) => { row.jobCode = v; } });
      row.taxSelect = tax;
      return h('div', { class: 'split-row' }, [
        field({ label: index === 0 ? (incoming ? 'Income / asset account' : 'Expense / asset account') : 'Account', required: true, input: accountChoice }),
        field({ label: 'Amount', required: true, input: amountBox }),
        field({ label: 'Tax code', input: tax }),
        field({ label: 'Note', input: note }),
        job ? field({ label: 'Job', input: job }) : null,
        state.lines.length > 1
          ? button({
            label: 'Remove',
            variant: 'ghost',
            size: 'sm',
            onClick: () => { state.lines.splice(index, 1); buildTargets(); drawPreview(); },
          })
          : null,
      ]);
    });

    const shifted = state.lines.reduce((sum2, r) => sum2 + (Number(r.amount) || 0), 0);
    const difference = Math.abs(state.amount || 0) - shifted;

    clear(targetHost);
    append(targetHost, [
      ...rows,
      h('div', { class: 'split-actions' }, [
        button({
          label: state.lines.length > 1 ? 'Add another account' : 'Split across accounts',
          variant: 'ghost',
          size: 'sm',
          icon: ICONS.plus,
          onClick: () => {
            // A new row opens with whatever the total has left to place, so the common case — one line of a
            // receipt that is partly something else — starts out adding up.
            const left = Math.max(0, Math.abs(state.amount || 0) - shifted);
            state.lines.push({ accountCode: '', taxCode: 'GST', amount: left, note: '' });
            buildTargets(); drawPreview();
          },
        }),
        state.lines.length > 1
          ? h('span', { class: difference === 0 ? 'muted small' : 'small' },
            difference === 0
              ? 'The lines add up to the amount.'
              : `${money(ctx, Math.abs(difference))} ${difference > 0 ? 'left to place' : 'over the amount'} — the lines must add up to ${money(ctx, Math.abs(state.amount || 0))}.`)
          : null,
      ]),
      state.lines.length > 1
        ? h('p', { class: 'field-hint' },
          'Each line carries its own account, tax code and note. The bank sees one amount; the ledger sees the split.')
        : null,
    ]);
  }

  function preview() {
    // Each row previews exactly as a single-account entry of its own would, then the lines are gathered up —
    // so the GST, the tax summary and the balance read the way they always did, split or not.
    const parts = state.lines
      .filter((r) => r.accountCode && Number(r.amount))
      .map((r) => ({
        row: r,
        p: moneyLines({
          direction,
          total: Math.abs(Number(r.amount) || 0),
          bankCode: state.accountCode,
          targetCode: r.accountCode,
          taxCode: r.taxCode,
          accounts,
          taxCodes,
          gstRegistered: ctx.company?.gstRegistered !== false,
        }),
      }));
    return {
      lines: parts.flatMap((x) => x.p.lines),
      debit: parts.reduce((sum2, x) => sum2 + x.p.debit, 0),
      credit: parts.reduce((sum2, x) => sum2 + x.p.credit, 0),
      net: parts.reduce((sum2, x) => sum2 + x.p.net, 0),
      gst: parts.reduce((sum2, x) => sum2 + x.p.gst, 0),
      missingGst: parts.some((x) => x.p.missingGst),
      effectiveTaxCode: state.lines.length === 1 ? state.lines[0].taxCode : '',
      // The note a person typed is what the ledger line says, because "which of these was the flour?" is the
      // question a split is there to answer.
      noteFor: (row) => row.note || '',
      parts,
    };
  }

  function drawPreview() {
    clear(previewHost);
    const coded = state.lines.filter((r) => r.accountCode && Number(r.amount));
    if (!coded.length) { previewHost.appendChild(h('p', { class: 'field-hint' }, 'Choose an account to preview the entry.')); return; }
    if (!state.amount) { previewHost.appendChild(h('p', { class: 'field-hint' }, 'Enter the amount to see the entry.')); return; }
    const p = preview();
    append(previewHost, [
      entryTable(ctx, p.lines),
      p.missingGst
        ? banner({
          kind: 'warning',
          title: 'No GST account in this file',
          message: `There is no "${incoming ? 'GST collected' : 'GST paid'}" account, so the whole amount will be posted as not reportable. Add the account under Accounts to record the GST separately.`,
        })
        : h('span'),
      h('p', { class: 'report-note' },
        `Debit ${money(ctx, p.debit)} · Credit ${money(ctx, p.credit)} — ${p.debit === p.credit ? 'balanced' : 'OUT OF BALANCE'}.`),
    ]);
  }

  function save() {
    if (!state.date) { toast('Pick a date.', 'warn'); return; }
    const bank = accounts.find((a) => a.code === state.accountCode);
    if (!bank) { toast('Choose the bank account the money moved through.', 'warn'); return; }
    if (!(state.amount > 0)) { toast(`Enter the amount including ${company?.taxLabel || 'GST'}.`, 'warn'); return; }
    const unplaced = state.lines.filter((r) => !r.accountCode);
    if (unplaced.length) { toast('Choose an account for every line.', 'warn'); return; }
    const empty = state.lines.filter((r) => !(Number(r.amount) > 0));
    if (empty.length) { toast('Every line needs an amount.', 'warn'); return; }

    const total = Math.abs(state.amount);
    const placed = state.lines.reduce((sum2, r) => sum2 + (Number(r.amount) || 0), 0);
    if (placed !== total) {
      const out = total - placed;
      toast(`The lines add up to ${money(ctx, placed)}, which is ${money(ctx, Math.abs(out))} ${out > 0 ? 'short of' : 'over'} the ${money(ctx, total)} on this entry.`, 'warn');
      return;
    }

    // The first line's account is what the bank line shows as its category, which is what the statement view
    // and the bank rules read. The whole list travels with it either way.
    const first = state.lines[0];
    const txn = db.put('bankTxns', blankBankTxn({
      companyId,
      accountCode: state.accountCode,
      date: state.date,
      description: state.description,
      reference: state.reference,
      amount: incoming ? total : -total,
      status: 'unreconciled',
      type: incoming ? 'receive' : 'spend',
      categoryAccount: first.accountCode,
      taxCode: first.taxCode,
      splits: state.lines.map((r) => ({ accountCode: r.accountCode, taxCode: r.taxCode, amount: Number(r.amount) || 0, note: r.note || '', jobCode: r.jobCode || '' })),
      contactId: state.contactId,
    }));
    // Hand the line to the same engine that codes a line from a statement, rather than building ledger lines
    // here as well. The two were doing the same job from two places — the same GST per split, the same
    // balancing, the same source and id — so a fix to one could quietly miss the other. The engine also links
    // every line back to the bank line it came from (`sourceDocId`), which the hand-built lines never did.
    try {
      const saved = categoriseBankTxn(db, txn);
      const entry = saved.journalId ? db.get('entries', saved.journalId) : null;
      toast(incoming ? 'Money received' : 'Money spent', 'success', {
        detail: `${money(ctx, total)}${entry?.number ? ` — ${entry.number}` : ''}.`,
      });
      handle?.close(true);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  append(bodyHost, [
    h('div', { class: 'form-grid' },
      field({ label: 'Date', required: true, input: dateField }),
      field({ label: 'Bank account', required: true, input: bankSelect }),
      field({ label: `Amount (incl. ${company?.taxLabel || 'GST'})`, required: true, input: amountField }),
      field({ label: 'Contact', input: contactSelect }),
      field({ label: 'Reference', input: refField })),
    field({ label: incoming ? 'Description / payer' : 'Description / payee', required: true, input: descField }),
    targetHost,
    h('div', { class: 'divider' }),
    h('h3', { class: 'card-title', style: { fontSize: 'var(--fs-md)' } }, 'What this will post'),
    previewHost,
  ]);

  buildTargets();
  drawPreview();

  handle = modal({
    title: incoming ? 'Receive money' : 'Spend money',
    subtitle: 'Posts a journal and records the matching bank line, so the ledger and the bank agree.',
    width: 'lg',
    body: bodyHost,
    actions: () => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => handle.close(null) }),
      button({ label: incoming ? 'Receive money' : 'Spend money', variant: 'primary', onClick: save }),
    ],
  });
  return handle;
}

/* ----------------------------------------------------------------- transfer */

/** Move money between two bank accounts: one journal, a bank line on each side. */
function openTransferModal(ctx, defaultFromCode) {
  const { db, companyId, data } = ctx;
  const banks = bankAccounts(data.accounts);
  const cur = currencyCode(ctx);

  if (banks.length < 2) {
    toast('A transfer needs two bank accounts.', 'warn', {
      detail: 'Add a second bank account under Accounts first.',
    });
    return null;
  }

  const first = defaultFromCode || banks[0]?.code || '';
  const state = {
    fromCode: first,
    toCode: banks.find((a) => a.code !== first)?.code || '',
    date: ctx.asOf || todayISO(),
    amount: 0,
    memo: '',
  };

  const previewHost = h('div');
  const bodyHost = h('div', { class: 'stack' });
  let handle = null;

  const bankOption = (a) => ({ value: a.code, label: `${a.code} — ${a.name}` });

  const fromSelect = select({
    options: banks.map(bankOption),
    value: state.fromCode,
    onChange: (v) => {
      state.fromCode = v;
      if (state.toCode === v) {
        state.toCode = banks.find((a) => a.code !== v)?.code || '';
        toSelect.value = state.toCode;
      }
      drawPreview();
    },
  });
  const toSelect = select({
    options: banks.map(bankOption),
    value: state.toCode,
    onChange: (v) => { state.toCode = v; drawPreview(); },
  });
  const dateField = dateInput({ value: state.date, onChange: (v) => { state.date = v; } });
  const amountField = moneyInput({
    value: 0,
    code: ctx.company?.currency,
    onChange: (v) => { state.amount = v; drawPreview(); },
    onEnter: () => save(),
  });
  const memoField = input({ value: '', placeholder: 'e.g. Move to savings', onInput: (v) => { state.memo = v; } });

  function drawPreview() {
    clear(previewHost);
    if (!state.amount || state.fromCode === state.toCode) {
      previewHost.appendChild(h('p', { class: 'field-hint' }, state.fromCode === state.toCode
        ? 'Choose two different accounts.'
        : 'Enter the amount to see the entry.'));
      return;
    }
    const amount = Math.abs(state.amount);
    const memo = state.memo || 'Bank transfer';
    const lines = [
      { accountCode: state.toCode, debit: amount, credit: 0, label: accountName(data.accounts, state.toCode), taxCode: null },
      { accountCode: state.fromCode, debit: 0, credit: amount, label: accountName(data.accounts, state.fromCode), taxCode: null },
    ];
    append(previewHost, [
      entryTable(ctx, lines),
      h('p', { class: 'report-note' }, `Debit ${money(ctx, amount)} · Credit ${money(ctx, amount)} — balanced.${memo ? ` ${memo}.` : ''}`),
    ]);
  }

  function save() {
    if (!state.date) { toast('Pick a date.', 'warn'); return; }
    if (!state.fromCode || !state.toCode) { toast('Choose both accounts.', 'warn'); return; }
    if (state.fromCode === state.toCode) { toast('A transfer needs two different accounts.', 'warn'); return; }
    if (!(state.amount > 0)) { toast('Enter the amount to transfer.', 'warn'); return; }

    const amount = Math.abs(state.amount);
    const memo = state.memo || `Transfer ${state.fromCode} to ${state.toCode}`;
    const transferId = uid('trf');
    try {
      const entry = postEntry(db, {
        companyId,
        date: state.date,
        ref: '',
        memo,
        lines: [
          dr(state.toCode, amount, { description: memo }),
          cr(state.fromCode, amount, { description: memo }),
        ],
        source: { type: 'transfer', id: transferId },
      });
      db.put('bankTxns', blankBankTxn({
        companyId,
        accountCode: state.fromCode,
        date: state.date,
        description: memo,
        amount: -amount,
        status: 'posted',
        type: 'transfer',
        journalId: entry.id,
        importedBatch: transferId,
      }));
      db.put('bankTxns', blankBankTxn({
        companyId,
        accountCode: state.toCode,
        date: state.date,
        description: memo,
        amount,
        status: 'posted',
        type: 'transfer',
        journalId: entry.id,
        importedBatch: transferId,
      }));
      toast('Transfer recorded', 'success', { detail: `${money(ctx, amount)} — ${entry.number}.` });
      handle?.close(true);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  append(bodyHost, [
    h('div', { class: 'form-grid' },
      field({ label: 'From account', required: true, input: fromSelect }),
      field({ label: 'To account', required: true, input: toSelect }),
      field({ label: 'Date', required: true, input: dateField }),
      field({ label: 'Amount', required: true, input: amountField }),
      field({ label: 'Memo', input: memoField })),
    h('div', { class: 'divider' }),
    h('h3', { class: 'card-title', style: { fontSize: 'var(--fs-md)' } }, 'What this will post'),
    previewHost,
  ]);

  drawPreview();

  handle = modal({
    title: 'Transfer between accounts',
    subtitle: 'One journal, and a bank line on each side so both accounts stay in step.',
    width: 'md',
    body: bodyHost,
    actions: () => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => handle.close(null) }),
      button({ label: 'Record transfer', variant: 'primary', onClick: save }),
    ],
  });
  return handle;
}

/* ---------------------------------------------------------------- bank rules */

/** What a rule matches, in words, for the rules table. */
function ruleMatchLabel(rule) {
  const how = { contains: 'contains', 'starts-with': 'starts with', equals: 'is exactly' }[rule.match] || 'contains';
  const way = { in: 'money in', out: 'money out', any: 'either direction' }[rule.direction] || 'either direction';
  return `Description ${how} “${rule.text}” · ${way}`;
}

/**
 * Categorise a batch of lines at once.
 *
 * One dialog, one account, one tax code — applied line by line through the same categoriseBankTxn
 * that every single-line categorisation goes through, so a batch produces exactly the entries it
 * would have produced by hand. Each line is attempted on its own: one failure (an account removed
 * since, a line that moved underneath) must not abandon the rest silently, and the toast reports
 * what actually posted.
 */
function openBulkCategoriseModal(ctx, txns, done) {
  const accounts = (ctx.data.accounts || []).filter((a) => a.active !== false);
  const taxCodes = ctx.data.taxCodes || [];
  const cur = currencyCode(ctx);
  const first = txns[0] || {};
  const incoming = (first.amount || 0) > 0;
  const state = {
    targetCode: first.categoryAccount || (accounts.find((a) => a.type === (incoming ? 'income' : 'expense')) || {}).code || '',
    taxCode: '',
    // Prefilled only when every ticked line already agrees on one. A batch of the same supplier's lines
    // should not have to be told the supplier again, but taking the first line's contact would quietly
    // label the rest with the wrong one.
    contactId: (() => {
      const ids = new Set(txns.map((t) => t.contactId || null));
      return ids.size === 1 ? [...ids][0] : null;
    })(),
  };
  state.taxCode = first.taxCode || (accounts.find((a) => a.code === state.targetCode) || {}).gstDefault || 'GST';

  const total = sum(txns.map((t) => t.amount || 0));

  // Built here rather than inline in the body so that picking an account can move it: the account's own
  // default tax code has to be *shown*, not only recorded in state.
  const taxSelect = select({
    value: state.taxCode,
    options: taxCodes.map((t) => ({ value: t.code, label: `${t.code} — ${t.name}` })),
    onChange: (v) => { state.taxCode = v; },
  });

  const contactSelect = select({
    options: [{ value: '', label: 'No contact' }, ...(ctx.data.contacts || []).map((c) => ({ value: c.id, label: c.name }))],
    value: state.contactId || '',
    onChange: (v) => { state.contactId = v || null; },
  });
  // Order by what the money most likely went to, then by code — but the set is *every* account. Coding
  // a spend to drawings (equity) or to a loan (liability) is ordinary, and an earlier version of this
  // dialog filtered those out, which made them unreachable here while the single-line dialog offered
  // them. The bank account on the lines themselves is the one thing that can never be the answer.
  const typeOf = (code) => accounts.find((a) => a.code === code)?.type || '';
  const preference = incoming
    ? ['income', 'asset', 'liability', 'equity', 'expense', 'costOfSales', 'otherIncome', 'otherExpenses']
    : ['expense', 'costOfSales', 'otherExpenses', 'asset', 'liability', 'equity', 'income', 'otherIncome'];
  const bankCodes = new Set(txns.map((t) => t.accountCode));
  const accountChoices = accountOptions(accounts, { all: true })
    .filter((o) => !bankCodes.has(o.value))
    .sort((a, b) => preference.indexOf(typeOf(a.value)) - preference.indexOf(typeOf(b.value))
      || a.value.localeCompare(b.value));

  const body = h('div', { class: 'stack' },
    h('p', { class: 'field-hint' },
      `${txns.length} line${txns.length === 1 ? '' : 's'}, ${fmt.money(total, { code: cur })} in total. Each one posts as its own entry, the same as doing it one at a time.`),
    field({
      label: 'Account',
      hint: 'Anything but the bank account — an expense, an asset, a liability, or equity such as drawings. Type to search.',
      input: accountPicker({
        options: accountChoices,
        value: state.targetCode,
        onChange: (v) => {
          state.targetCode = v;
          const acc = accounts.find((a) => a.code === v);
          // Follow the account's own default tax code *and show it*: setting only the state left the
          // select displaying GST while the batch posted as N-T.
          if (acc && acc.gstDefault) { state.taxCode = acc.gstDefault; taxSelect.value = acc.gstDefault; }
        },
      }),
    }),
    field({
      label: 'Tax code',
      hint: 'Applied to every line in the batch',
      input: taxSelect,
    }),
    field({
      label: 'Contact',
      hint: 'Optional — links every entry in the batch to one customer or supplier.',
      input: contactSelect,
    }));

  modal({
    title: `Categorise ${txns.length} line${txns.length === 1 ? '' : 's'}`,
    subtitle: 'They are posted to the ledger as you apply, and each can be voided afterwards if it was wrong.',
    body,
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({
        label: 'Categorise all',
        variant: 'primary',
        disabled: !state.targetCode,
        onClick: () => {
          let posted = 0;
          const failed = [];
          for (const t of txns) {
            try {
              categoriseBankTxn(ctx.db, {
                ...t, categoryAccount: state.targetCode, taxCode: state.taxCode, contactId: state.contactId,
              });
              posted++;
            } catch (err) {
              failed.push(`${t.description || t.id}: ${err?.message || 'could not be posted'}`);
            }
          }
          if (posted) {
            toast(`${posted} line${posted === 1 ? '' : 's'} categorised`, 'success', {
              detail: failed.length ? `${failed.length} could not be: ${failed[0]}` : 'Posted to the ledger.',
            });
          } else {
            toast('Nothing was categorised', 'error', { detail: failed[0] || 'No line could be posted.' });
          }
          close(null);
          done();
        },
      }),
    ],
  });
}

/**
 * Turn a selection into a rule.
 *
 * The rule is only ever *proposed*: the match text comes from the lines themsely — exactly, when
 * every selected line shares one description, otherwise the first word long enough to be a merchant
 * name — the direction from the money, and the account from a line that is already coded. The
 * dialog opens for editing, because a rule built silently out of a guess is a rule nobody can trust.
 */
function openRuleFromSelection(ctx, txns) {
  const first = txns[0] || {};
  const descriptions = txns.map((t) => String(t.description || '').trim());
  const same = descriptions.length > 0 && descriptions.every((d) => d === descriptions[0]);
  const candidate = same
    ? descriptions[0]
    : (descriptions[0].split(/\s+/).find((w) => w.length >= 4) || descriptions[0] || '');
  openRuleModal(ctx, blankBankRule({
    companyId: ctx.companyId,
    name: candidate ? `Rule for ${candidate}` : 'New rule',
    match: same ? 'equals' : 'contains',
    text: candidate.slice(0, 60),
    direction: (first.amount || 0) > 0 ? 'in' : 'out',
    accountCode: first.categoryAccount || '',
    taxCode: first.taxCode || 'GST',
  }), { proposed: true });
}

/** Add or edit a bank rule. */
function openRuleModal(ctx, existing = null, opts = {}) {
  const accounts = ctx.data.accounts;
  const taxCodes = ctx.data.taxCodes;
  const base = existing || blankBankRule({ companyId: ctx.companyId });

  const state = {
    name: base.name || '',
    match: base.match || 'contains',
    text: base.text || '',
    direction: base.direction || 'any',
    // Always at least one condition on screen, including for a brand-new rule. ruleConditions reads a
    // rule written before conditions existed as a single description condition, so opening an old
    // rule shows what it actually matches rather than an empty form.
    conditions: (() => {
      const read = ruleConditions(base);
      return read.length ? read.map((c) => ({ ...c })) : [{ field: 'description', match: 'contains', text: '' }];
    })(),
    combine: base.combine === 'any' ? 'any' : 'all',
    accountCode: base.accountCode || '',
    taxCode: base.taxCode || 'GST',
    contactId: base.contactId || null,
    active: base.active !== false,
  };

  const accountOpts = accountOptions(accounts, { all: true });

  /**
   * The conditions editor.
   *
   * Rebuilt rather than patched up whenever a condition is added, removed or re-pointed, because a
   * condition's match modes depend on its field — a description can "contain" text, an amount cannot
   * — so when the field changes to or from Amount the match is corrected here. The form can never be
   * left holding a comparison that cannot apply to the thing it reads.
   */
  const conditionsHost = h('div', { class: 'stack' });

  const TEXT_MATCHES = [
    { value: 'contains', label: 'Contains' },
    { value: 'starts-with', label: 'Starts with' },
    { value: 'equals', label: 'Is exactly' },
  ];
  const AMOUNT_MATCHES = [
    { value: 'more-than', label: 'Is more than' },
    { value: 'less-than', label: 'Is less than' },
    { value: 'between', label: 'Is between' },
  ];

  /** What a person types into an amount box, turned into the integer cents the ledger uses. */
  function centsFromInput(value) {
    const n = Number(String(value ?? '').replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? Math.abs(Math.round(n * 100)) : NaN;
  }

  function drawConditions() {
    clear(conditionsHost);
    if (state.conditions.length > 1) {
      conditionsHost.appendChild(field({
        label: 'A line is filed when it meets',
        input: select({
          options: [
            { value: 'all', label: `All ${state.conditions.length} conditions` },
            { value: 'any', label: 'Any one condition' },
          ],
          value: state.combine,
          onChange: (v) => { state.combine = v; },
        }),
      }));
    }
    state.conditions.forEach((cond, index) => {
      const isAmount = cond.field === 'amount';
      const cells = [
        field({
          label: state.conditions.length > 1 ? `Condition ${index + 1}` : 'Look at',
          input: select({
            options: [
              { value: 'description', label: 'Description' },
              { value: 'reference', label: 'Reference' },
              { value: 'amount', label: 'Amount' },
            ],
            value: cond.field || 'description',
            onChange: (v) => {
              cond.field = v;
              const allowed = v === 'amount' ? AMOUNT_MATCHES : TEXT_MATCHES;
              if (!allowed.some((m) => m.value === cond.match)) cond.match = allowed[0].value;
              drawConditions();
            },
          }),
        }),
        field({
          label: isAmount ? 'Compare' : 'Match',
          input: select({
            options: isAmount ? AMOUNT_MATCHES : TEXT_MATCHES,
            value: cond.match,
            onChange: (v) => { cond.match = v; drawConditions(); },
          }),
        }),
        isAmount
          ? field({
              label: cond.match === 'between' ? 'From' : 'Amount',
              input: input({
                value: Number.isFinite(cond.cents) ? String(Math.abs(cond.cents) / 100) : '',
                placeholder: '0.00',
                onInput: (v) => { cond.cents = centsFromInput(v); },
              }),
            })
          : field({
              label: 'Text',
              input: input({
                value: cond.text || '',
                placeholder: cond.field === 'reference' ? 'e.g. INV-' : 'e.g. WOOLWORTHS',
                onInput: (v) => { cond.text = v; },
              }),
            }),
      ];
      if (isAmount && cond.match === 'between') {
        cells.push(field({
          label: 'To',
          input: input({
            value: Number.isFinite(cond.centsTo) ? String(Math.abs(cond.centsTo) / 100) : '',
            placeholder: '0.00',
            onInput: (v) => { cond.centsTo = centsFromInput(v); },
          }),
        }));
      }
      if (state.conditions.length > 1) {
        cells.push(button({
          label: 'Remove',
          size: 'sm',
          variant: 'ghost',
          onClick: () => { state.conditions.splice(index, 1); drawConditions(); },
        }));
      }
      conditionsHost.appendChild(h('div', { class: 'condition-row' }, ...cells));
    });
    conditionsHost.appendChild(button({
      label: 'Add another condition',
      size: 'sm',
      variant: 'ghost',
      onClick: () => {
        state.conditions.push({ field: 'description', match: 'contains', text: '' });
        drawConditions();
      },
    }));
  }
  drawConditions();

  const body = h('div', { class: 'stack' },
    field({
      label: 'Rule name',
      required: true,
      input: input({ value: state.name, placeholder: 'e.g. Groceries — supermarket', onInput: (v) => { state.name = v; } }),
    }),
    h('div', { class: 'form-grid' },
      field({
        label: 'Applies to',
        input: select({
          options: [
            { value: 'any', label: 'Any line' },
            { value: 'in', label: 'Money in (received)' },
            { value: 'out', label: 'Money out (paid)' },
          ],
          value: state.direction,
          onChange: (v) => { state.direction = v; },
        }),
      }),
      field({
        label: 'File it against',
        required: true,
        input: select({
          options: [{ value: '', label: 'Choose an account…' }, ...accountOpts],
          value: state.accountCode,
          onChange: (v) => { state.accountCode = v; },
        }),
      }),
      field({
        label: 'Tax code',
        input: select({
          options: taxCodes.map((t) => ({ value: t.code, label: `${t.code} — ${t.name}` })),
          value: state.taxCode,
          onChange: (v) => { state.taxCode = v; },
        }),
      }),
      field({
        label: 'Contact',
        hint: 'Optional — links the entry to a customer or supplier.',
        input: select({
          options: [{ value: '', label: 'No contact' }, ...ctx.data.contacts.map((c) => ({ value: c.id, label: c.name }))],
          value: state.contactId || '',
          onChange: (v) => { state.contactId = v || null; },
        }),
      })),
    conditionsHost,
    checkbox({
      label: 'Active — apply this rule when filing lines',
      checked: state.active,
      onChange: (v) => { state.active = v; },
    }),
    h('p', { class: 'report-note' },
      'A matched line is still posted as an ordinary Spend money / Receive money entry, so it always balances — the rule only chooses the account and tax code.'));

  return modal({
    // A rule proposed from a selected line is new, not an edit of something — it arrives with fields
    // filled in, and calling that "Edit bank rule" made a person think they were changing an existing one.
    title: existing && !opts.proposed ? 'Edit bank rule' : 'New bank rule',
    subtitle: 'File a statement line automatically when its description matches.',
    width: 'lg',
    body,
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({
        label: existing && !opts.proposed ? 'Save rule' : 'Add rule',
        variant: 'primary',
        onClick: () => {
          if (!state.name.trim()) { toast('Give the rule a name.', 'warn'); return; }
          if (!state.accountCode) { toast('Choose the account these lines belong to.', 'warn'); return; }
          // A half-filled condition is dropped rather than saved: a condition with nothing to compare
          // against matches nothing, and a rule that quietly never fires is worse than a complaint now.
          const conditions = [];
          for (const cond of state.conditions) {
            if (cond.field === 'amount') {
              if (!Number.isFinite(cond.cents)) continue;
              const from = Math.abs(cond.cents);
              if (cond.match === 'between') {
                if (!Number.isFinite(cond.centsTo)) continue;
                conditions.push({ field: 'amount', match: 'between', cents: from, centsTo: Math.abs(cond.centsTo) });
              } else {
                conditions.push({ field: 'amount', match: cond.match, cents: from });
              }
              continue;
            }
            const text = String(cond.text || '').trim();
            if (!text) continue;
            conditions.push({
              field: cond.field === 'reference' ? 'reference' : 'description',
              match: cond.match === 'equals' || cond.match === 'starts-with' ? cond.match : 'contains',
              text,
            });
          }
          if (!conditions.length) {
            toast('This rule needs at least one condition with something to match.', 'warn');
            return;
          }
          // The first text condition is also mirrored into match/text, so a rule written here still
          // reads correctly to anything expecting the older single-condition shape.
          const firstText = conditions.find((c) => c.field !== 'amount');
          try {
            saveBankRule(ctx.db, blankBankRule({
              ...base,
              ...state,
              name: state.name.trim(),
              conditions,
              combine: state.combine,
              match: firstText ? firstText.match : 'contains',
              text: firstText ? firstText.text : '',
              companyId: ctx.companyId,
            }));
            toast(existing ? 'Rule saved' : 'Rule added', 'success');
            close(true);
            ctx.refresh();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }),
    ],
  });
}

async function deleteRule(ctx, rule) {
  const ok = await confirmDialog({
    title: 'Delete this rule?',
    message: `“${rule.name || 'This rule'}” will stop filing matching lines. Lines it has already filed are left as they are.`,
    confirmLabel: 'Delete rule',
    danger: true,
  });
  if (!ok) return;
  deleteBankRule(ctx.db, ctx.companyId, rule.id);
  toast('Rule deleted', 'success');
  ctx.refresh();
}

/** Run every rule over the account's lines and report what was filed. */
function applyRulesAction(ctx) {
  try {
    const result = applyRules(ctx.db, ctx.companyId);
    if (result.applied) {
      toast(`Filed ${result.applied} line(s) from your rules`, 'success', {
        detail: 'Each one is posted as a balanced Spend money or Receive money entry.',
      });
      ctx.refresh();
    } else {
      toast('Nothing to file — no uncategorised line matched a rule', 'info', {
        detail: 'Add a rule, or import a statement whose descriptions match one you already have.',
      });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** The Bank rules card: the list of rules, and the actions to manage them. */
function bankRulesCard(ctx) {
  const rules = listBankRules(ctx.db, ctx.companyId);
  const accounts = ctx.data.accounts;
  const contacts = ctx.data.contacts;

  const body = h('div', { class: 'stack' });

  if (!rules.length) {
    body.appendChild(emptyState({
      title: 'No bank rules yet',
      message: 'A bank rule files a statement line against the right account automatically. Add one for a supplier or a payment you see every month.',
      action: button({ label: 'Add rule', variant: 'primary', icon: ICONS.plus, onClick: () => openRuleModal(ctx) }),
    }));
  } else {
    body.appendChild(table({
      columns: [
        {
          key: 'name',
          label: 'Rule',
          render: (r) => h('div', null,
            h('span', { class: 'strong' }, r.name || '(unnamed rule)'),
            h('div', { class: 'row-sub' }, ruleMatchLabel(r))),
        },
        { key: 'accountCode', label: 'Account', render: (r) => accountName(accounts, r.accountCode) },
        { key: 'taxCode', label: 'Tax', render: (r) => (r.taxCode ? badge(r.taxCode, 'muted') : '') },
        { key: 'contactId', label: 'Contact', render: (r) => (r.contactId ? (contacts.find((c) => c.id === r.contactId)?.name || '—') : h('span', { class: 'muted' }, '—')) },
        { key: 'active', label: 'Status', render: (r) => badge(r.active === false ? 'Paused' : 'Active', r.active === false ? 'muted' : 'positive') },
        {
          key: 'actions',
          label: '',
          className: 'col-right',
          render: (r) => h('div', { class: 'table-actions' },
            iconButton({ label: 'Edit rule', icon: ICONS.edit, onClick: () => openRuleModal(ctx, r) }),
            iconButton({ label: 'Delete rule', icon: ICONS.trash, onClick: () => deleteRule(ctx, r) })),
        },
      ],
      rows: rules,
      compact: true,
    }));
  }

  body.appendChild(h('p', { class: 'report-note' },
    'A rule points at an account by code, so renaming an account does not break it. '
    + 'Nothing is posted until a line is filed — until then a rule is only a suggestion you can see and check.'));

  return card({
    title: 'Bank rules',
    subtitle: 'File a statement line automatically when its description matches.',
    actions: [
      button({ label: 'Apply rules', icon: ICONS.refresh, variant: 'subtle', size: 'sm', onClick: () => applyRulesAction(ctx) }),
      button({ label: 'Add rule', icon: ICONS.plus, variant: 'primary', size: 'sm', onClick: () => openRuleModal(ctx) }),
    ],
    body,
  });
}

/* ------------------------------------------------------------------- screen */

export async function render(ctx) {
  const { db, companyId, data } = ctx;
  const entries = data.entries || [];
  const accounts = data.accounts || [];
  const cur = currencyCode(ctx);
  const root = h('div', { class: 'stack' });

  const banks = bankAccounts(accounts);

  root.appendChild(pageHeader({
    title: meta.title,
    subtitle: meta.subtitle,
    actions: banks.length ? [
      button({
        label: 'Import statement',
        icon: ICONS.upload,
        variant: 'primary',
        onClick: () => openImportModal(ctx, selectedCode()),
      }),
      button({ label: 'Spend money', icon: ICONS.plus, onClick: () => openMoneyModal(ctx, 'spend', selectedCode()) }),
      button({ label: 'Receive money', icon: ICONS.plus, onClick: () => openMoneyModal(ctx, 'receive', selectedCode()) }),
      button({ label: 'Transfer', icon: ICONS.arrowRight, onClick: () => openTransferModal(ctx, selectedCode()) }),
    ] : [],
  }));

  if (!banks.length) {
    root.appendChild(card({
      title: 'No bank accounts yet',
      body: emptyState({
        title: 'This file has no bank accounts',
        message: 'Rookeepa files bank activity under accounts flagged as a bank or credit card. Add one to start importing statements.',
        action: button({ label: 'Go to Accounts', variant: 'primary', onClick: () => ctx.go('accounts') }),
        icon: ICONS.bank,
      }),
    }));
    return root;
  }

  function selectedCode() {
    const wanted = ctx.ui.get('bankAccount');
    return banks.find((a) => a.code === wanted)?.code || banks[0].code;
  }

  function selectAccount(code) {
    ctx.ui.set('bankAccount', code);
    ctx.refresh();
  }

  const selected = banks.find((a) => a.code === selectedCode()) || banks[0];

  /* ---- account cards ---- */

  const cardsGrid = h('div', { class: 'grid grid-3' });
  for (const acc of banks) {
    const rec = reconciliation(db, companyId, acc.code, ctx.asOf);
    const bal = accountBalance(entries, acc.code, { to: ctx.asOf });
    const isSelected = acc.code === selected.code;
    cardsGrid.appendChild(card({
      title: `${acc.code} — ${acc.name}`,
      subtitle: isSelected ? 'Selected for review' : null,
      actions: [
        button({
          label: isSelected ? 'Reviewing' : 'Review',
          variant: isSelected ? 'subtle' : 'primary',
          size: 'sm',
          disabled: isSelected,
          onClick: () => selectAccount(acc.code),
        }),
      ],
      body: h('div', { class: 'stack' },
        h('div', { class: 'stat-grid' },
          kpi({ label: 'Ledger balance', value: money(ctx, bal), tone: bal < 0 ? 'negative' : 'default' }),
          kpi({ label: 'Cleared / statement', value: money(ctx, rec.statementBalance) }),
          kpi({
            label: 'To review',
            value: String(rec.unreconciledCount),
            tone: rec.unreconciledCount ? 'warn' : 'default',
            sub: rec.unreconciledCount ? money(ctx, rec.unreconciledTotal) : 'Nothing outstanding',
          })),
        reconcileIndicator(ctx, rec)),
    }));
  }
  root.appendChild(cardsGrid);

  /* ---- reconciliation card ---- */

  const rec = reconciliation(db, companyId, selected.code, ctx.asOf);
  const ledgerBalance = accountBalance(entries, selected.code, { to: ctx.asOf });
  const gapDir = rec.difference > 0 ? 'ahead of' : 'behind';
  const reconcileNote = rec.difference === 0
    ? 'The bank balance and the ledger agree. Nothing to chase.'
    : !rec.hasStatementData
      ? 'Nothing has been reconciled against a statement yet. Import a statement, or set the statement opening balance, and this difference becomes the real gap between the bank and the books.'
      // With every line ticked off, "categorise or match the lines below" sends somebody to an empty list, and
      // the gap they can see is the one thing the lines cannot explain. Say where it actually is.
      : rec.unreconciledCount === 0
        ? `Every line on this account is reconciled, so the ${money(ctx, Math.abs(rec.difference))} gap is not in the lines below — it is between the books and the bank's paperwork. Check the statement opening balance first, then look for an entry on this account the bank never saw: the same money recorded twice, or dated outside the statement.`
        : `The ledger is ${money(ctx, Math.abs(rec.difference))} ${gapDir} the cleared statement balance. Categorise or match the lines below to close the gap.`;
  root.appendChild(card({
    title: 'Reconciliation',
    subtitle: `${selected.code} — ${selected.name} · as at ${fmt.date(ctx.asOf)}`,
    actions: [
      button({
        label: 'Statement opening',
        variant: 'ghost',
        size: 'sm',
        icon: ICONS.bank,
        title: 'Set the balance the statement showed before your first recorded line',
        onClick: () => setOpeningBalanceModal(ctx, selected, rec),
      }),
      reconcileIndicator(ctx, rec),
    ],
    body: h('div', { class: 'stack' },
      h('div', { class: 'stat-grid' },
        kpi({ label: 'Ledger balance', value: money(ctx, ledgerBalance), tone: ledgerBalance < 0 ? 'negative' : 'default' }),
        kpi({ label: 'Statement opening', value: money(ctx, rec.openingBalance) }),
        kpi({ label: 'Cleared (statement)', value: money(ctx, rec.statementBalance) }),
        kpi({
          label: 'Difference',
          value: money(ctx, rec.difference),
          tone: rec.difference === 0 ? 'positive' : 'negative',
        }),
        kpi({
          label: 'Lines to review',
          value: String(rec.unreconciledCount),
          tone: rec.unreconciledCount ? 'warn' : 'default',
          sub: money(ctx, rec.unreconciledTotal),
        })),
      h('p', { class: 'report-note' }, reconcileNote)),
  }));

  /* ---- review table ---- */

  const allTxns = data.bankTxns
    .filter((t) => t.accountCode === selected.code)
    .slice()
    // String() on both: an imported row can arrive with no date at all, and undefined.localeCompare is a
    // crash in the middle of drawing the table rather than a row that sorts first.
    .sort((a, b) => (a.date === b.date
      ? String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      : String(a.date || '').localeCompare(String(b.date || ''))));

  // Which tab, and what you searched for, are the state the screen is *about* — they belong to the
  // screen, not to one render of it. They were local variables initialised here on every render,
  // which is why removing an imported line or allocating one cleared the search and put the rows
  // back to "All": the screen was rebuilt from its defaults while the person's work stayed in front
  // of them. The chosen bank account has been remembered this way for a while; these are now too.
  let filter = ctx.ui.get('bankFilter') || 'all';
  let queryText = String(ctx.ui.get('bankQuery') || '');
  let query = queryText.trim().toLowerCase();

  // An amount filter is a range in dollars, kept as typed so that an empty box means "no bound" rather
  // than zero. Amounts are compared by size: "$50 to $100" means the money moved by that much, in
  // whichever direction — in or out is what the tabs above are for.
  let amountFromText = String(ctx.ui.get('bankAmountFrom') || '');
  let amountToText = String(ctx.ui.get('bankAmountTo') || '');

  // A date range, for the same reason the journal has one: a statement that arrived in pieces, or a
  // reconciliation worked through a month at a time. Kept as typed, so an empty box means "no bound".
  let dateFrom = String(ctx.ui.get('bankDateFrom') || '');
  let dateTo = String(ctx.ui.get('bankDateTo') || '');

  // A word that must NOT be in the description or reference. The `-word` shorthand in the search box does the
  // same thing, but nobody discovers a shorthand: this is the control the filter deserves.
  let excludeText = String(ctx.ui.get('bankExclude') || '');
  let exclude = excludeText.trim().toLowerCase();

  // Lines ticked for a bulk action. Deliberately not remembered between sessions: a selection is
  // about the work in front of you, and finding eleven lines still ticked tomorrow, from an
  // afternoon you have forgotten, is worse than losing the ticks.
  const ticked = new Set();

  // The line whose panel is open, if any. Kept with the screen's other state so it survives the re-read
  // that follows an action — the whole point is to work down a list without losing your place.
  let expandedId = ctx.ui.get('bankExpanded') || null;

  const passesFilter = (t) => {
    if (filter === 'all') return true;
    // "To review" is everything not yet ticked off against the bank and not excluded:
    // uncategorised lines, and lines that were categorised but not reconciled.
    if (filter === 'review') return t.status === 'unreconciled' || t.status === 'posted';
    if (filter === 'reconciled') return t.status === 'reconciled';
    if (filter === 'excluded') return t.status === 'excluded';
    return true;
  };
  // Terms are ANDed, and a term beginning with a minus must NOT appear: "rent -september" asks for the rent
  // without September's, which is the usual reason to want the other way round and needs no second box.
  const passesQuery = (t) => {
    const hay = `${t.description || ''} ${t.reference || ''}`.toLowerCase();
    if (exclude && hay.includes(exclude)) return false;
    for (const term of query.split(/\s+/).filter(Boolean)) {
      if (term.startsWith('-')) {
        if (term.length > 1 && hay.includes(term.slice(1))) return false;
      } else if (!hay.includes(term)) return false;
    }
    return true;
  };

  /** What was typed into an amount box, as cents — null when it is empty or not a number. */
  const amountBound = (text) => {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const n = Number(raw.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? Math.abs(Math.round(n * 100)) : null;
  };
  const passesAmount = (t) => {
    const from = amountBound(amountFromText);
    const to = amountBound(amountToText);
    if (from === null && to === null) return true;
    const size = Math.abs(t.amount || 0);
    if (from !== null && size < from) return false;
    if (to !== null && size > to) return false;
    return true;
  };
  // ISO dates compare as text, which is the whole reason the app stores them that way. A line with no date
  // is not inside any range: it cannot claim a place it does not have.
  const passesDate = (t) => {
    if (!dateFrom && !dateTo) return true;
    const d = String(t.date || '');
    if (!d) return false;
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  };

  const segHost = h('div');
  const rowsHost = h('div');
  // The open line's panel lives in its own host beside the table so that filling it needs no knowledge
  // of the table at all — the table stays a table.
  const searchField = input({
    placeholder: 'Search description or reference (-word excludes)',
    value: queryText,
    onInput: (v) => { queryText = v; query = v.trim().toLowerCase(); ctx.ui.set('bankQuery', v); drawRows(); },
  });

  /**
   * A small × that empties one field.
   *
   * It sits *after* the field in normal flow rather than positioned over it: positioned inside, it collided
   * with the field's border and stole room from the placeholder, which is how "Amount from" came to read
   * "Amount ×".
   */
  const clearField = (field, clear, onClear) => {
    const b = h('button', {
      class: 'field-clear', type: 'button', title: 'Clear this filter', 'aria-label': 'Clear this filter',
      onClick: () => { clear(); field.value = ''; if (onClear) onClear(); drawRows(); },
    }, '×');
    return b;
  };

  const excludeField = input({
    placeholder: 'a word',
    'aria-label': 'Exclude a word',
    value: excludeText,
    onInput: (v) => { excludeText = v; exclude = v.trim().toLowerCase(); ctx.ui.set('bankExclude', v); drawRows(); },
  });
  const amountFromField = input({
    placeholder: 'Amount from',
    'aria-label': 'Amount from',
    value: amountFromText,
    onInput: (v) => { amountFromText = v; ctx.ui.set('bankAmountFrom', v); drawRows(); },
  });
  const amountToField = input({
    placeholder: 'Amount to',
    'aria-label': 'Amount to',
    value: amountToText,
    onInput: (v) => { amountToText = v; ctx.ui.set('bankAmountTo', v); drawRows(); },
  });
  const dateFromField = dateInput({
    value: dateFrom,
    id: 'bank-date-from',
    onChange: (v) => { dateFrom = v || ''; ctx.ui.set('bankDateFrom', dateFrom); drawRows(); },
  });
  const dateToField = dateInput({
    value: dateTo,
    id: 'bank-date-to',
    onChange: (v) => { dateTo = v || ''; ctx.ui.set('bankDateTo', dateTo); drawRows(); },
  });
  dateFromField.style.width = '10.5rem';
  dateToField.style.width = '10.5rem';
  // The kit's date input takes value, onChange and id, not arbitrary attributes — so the labels that make
  // these two boxes tellable apart to a screen reader are set on the nodes themselves.
  dateFromField.setAttribute('aria-label', 'From date');
  dateToField.setAttribute('aria-label', 'To date');

  function rowActions(t) {
    const actions = [];
    actions.push(iconButton({
      label: 'Open',
      title: 'Open this line in place — match, code, transfer or make a rule',
      icon: ICONS.chevronDown,
      onClick: () => { ctx.ui.set('bankExpanded', t.id); expandedId = t.id; drawRows(); },
    }));
    if (t.status === 'unreconciled') {
      actions.push(iconButton({
        label: 'Categorise',
        title: 'Categorise — post this to an account',
        icon: ICONS.edit,
        onClick: () => openCategoriseModal(ctx, t),
      }));
      actions.push(iconButton({
        label: 'Match to an existing transaction',
        title: 'Match to an existing transaction',
        icon: ICONS.search,
        onClick: () => openMatchModal(ctx, t),
      }));
      actions.push(iconButton({
        label: 'Create a payment',
        title: 'Create a customer receipt or supplier payment',
        icon: ICONS.coins,
        onClick: () => createPaymentFromLine(ctx, t),
      }));
      actions.push(iconButton({
        label: 'Exclude',
        title: 'Exclude this line from reconciliation',
        icon: ICONS.close,
        onClick: () => excludeLine(ctx, t),
      }));
    }
    if (t.status === 'posted') {
      actions.push(iconButton({
        label: 'Reconcile',
        title: 'Tick it off against the statement — its entry is already posted',
        icon: ICONS.check,
        onClick: () => reconcileLine(ctx, t),
      }));
      actions.push(iconButton({
        label: 'Reverse the categorisation',
        title: 'Reverse the categorisation so the account or tax code can be changed',
        icon: ICONS.refresh,
        onClick: () => undoLineCategorisation(ctx, t),
      }));
    }
    if (t.status === 'reconciled') {
      actions.push(iconButton({
        label: 'Un-reconcile',
        title: 'Un-reconcile this line so its coding can be changed',
        icon: ICONS.refresh,
        onClick: () => unreconcileLine(ctx, t),
      }));
    }
    if (t.status === 'excluded') {
      actions.push(iconButton({ label: 'Reinstate', title: 'Reinstate this line', icon: ICONS.refresh, onClick: () => reinstateLine(ctx, t) }));
    }
    actions.push(iconButton({
      label: 'Remove this line',
      icon: ICONS.trash,
      onClick: () => removeLine(ctx, t),
    }));
    return h('div', { class: 'table-actions' }, actions);
  }

  /**
   * The bar that appears once lines are ticked: what is ticked, and what can be done with it.
   *
   * Only unreconciled lines can be categorised — a reconciled line already agrees with the bank,
   * and a bulk action must not quietly rewrite one — so the bar says how many of the ticked lines
   * are ready rather than letting the user find out afterwards. It is drawn above the table, not
   * inside it: a toolbar row inside a table breaks sorting and scanning for everything below it.
   */
  /**
   * Run one action over the ticked lines, one line at a time.
   *
   * Each line is attempted on its own terms and the refusals are counted rather than swallowed: a batch
   * that reversed six lines and refused one must not report "done". The lines that could not be acted on
   * are left exactly as they were.
   */
  function bulkAct(verb, list, act) {
    let done = 0;
    const refused = [];
    for (const t of list) {
      try { act(t); done += 1; } catch (err) { refused.push(`${t.description || t.id}: ${err.message}`); }
    }
    ticked.clear();
    if (done) {
      toast(`${done} line${done === 1 ? '' : 's'} ${verb}`, 'success', {
        detail: refused.length ? `${refused.length} could not be, and were left alone: ${refused[0]}` : '',
      });
    } else {
      toast(`Nothing was ${verb}`, 'error', { detail: refused[0] || '' });
    }
    ctx.refresh();
  }

  async function bulkUnreconcile(list) {
    const ok = await confirmDialog({
      title: `Un-reconcile ${list.length} line${list.length === 1 ? '' : 's'}?`,
      message: 'The tick against the statement comes off each one. Nothing in the ledger is reversed, and anything these lines were matched to stays as it is — including payments, which were real money.',
      confirmLabel: 'Un-reconcile',
    });
    if (!ok) return;
    bulkAct('un-reconciled', list, (t) => unreconcileBankTxn(ctx.db, t));
  }

  async function bulkReverse(list) {
    const ok = await confirmDialog({
      title: `Reverse ${list.length} categorisation${list.length === 1 ? '' : 's'}?`,
      message: 'Each entry these lines posted is voided — kept in the ledger as a reversal, not deleted — and the lines go back to review so they can be coded again.',
      confirmLabel: 'Reverse them',
      danger: true,
    });
    if (!ok) return;
    bulkAct('reversed', list, (t) => undoBankTxnCategorisation(ctx.db, t));
  }

  async function bulkExclude(list) {
    const note = await promptDialog({
      title: `Exclude ${list.length} line${list.length === 1 ? '' : 's'}?`,
      label: 'Reason (kept with each line)',
      message: 'Excluded lines are set aside when you reconcile. Nothing is posted or reversed, and you can reinstate them at any time.',
      placeholder: 'e.g. personal expenses, not the business',
      confirmLabel: 'Exclude',
    });
    if (note === null) return;
    bulkAct('excluded', list, (t) => excludeBankTxn(ctx.db, t, note || ''));
  }

  function bulkReinstate(list) {
    // The harmless direction, so no confirmation: putting a line back cannot lose anything.
    bulkAct('reinstated', list, (t) => reinstateBankTxn(ctx.db, t));
  }

  /**
   * What can be done to the ticked lines, and how many of them each action can actually act on.
   *
   * The counts sit on the buttons rather than in a sentence, because the answer differs per action: of
   * four ticked lines, two may be categorisable and one un-reconcilable at the same time. An action with
   * nothing to act on is disabled showing a zero, so "why did nothing happen" never comes up.
   */
  function bulkBar(visible) {
    const chosen = allTxns.filter((t) => ticked.has(t.id));
    const has = (predicate) => chosen.filter(predicate);
    const canCategorise = has((t) => t.status === 'unreconciled');
    const canReverse = has((t) => t.status === 'posted' && t.journalId);
    const canUnreconcile = has((t) => t.status === 'reconciled');
    const canExclude = has((t) => t.status === 'unreconciled' || t.status === 'posted');
    const canReinstate = has((t) => t.status === 'excluded');

    const act = (label, list, run, variant = 'subtle') => button({
      label: `${label} (${list.length})`,
      size: 'sm',
      variant,
      disabled: !list.length,
      onClick: () => run(list),
    });

    return toolbar({
      left: [h('span', { class: 'muted small' }, `${chosen.length} selected`)],
      right: [
        button({ label: 'Select all shown', size: 'sm', variant: 'ghost', onClick: () => { for (const r of visible) ticked.add(r.id); drawRows(); } }),
        button({ label: 'Clear', size: 'sm', variant: 'ghost', onClick: () => { ticked.clear(); drawRows(); } }),
        act('Categorise', canCategorise, (list) => openBulkCategoriseModal(ctx, list, () => { ticked.clear(); ctx.refresh(); }), 'primary'),
        act('Un-reconcile', canUnreconcile, bulkUnreconcile),
        act('Reverse the categorisation', canReverse, bulkReverse),
        act('Exclude', canExclude, bulkExclude),
        act('Reinstate', canReinstate, bulkReinstate),
        button({ label: 'Create rule', size: 'sm', variant: 'ghost', onClick: () => openRuleFromSelection(ctx, chosen) }),
      ],
    });
  }

  /**
   * The panel that opens beneath the table for one line.
   *
   * This is the interaction the MYOB screenshot is really about: rather than having to know which of
   * three dialogs you want before you can touch a line, the line opens and offers them in words, each
   * saying what it does. The table is not replaced — every other row stays on screen — which is what
   * makes working down a statement bearable instead of a dialog and a scroll for each line.
   *
   * Each choice opens the flow that already exists for it, tested and unchanged, rather than a second
   * copy living in the row. The coding form itself is still a dialog: embedding it here is the next
   * step, and it is what this panel was deliberately shaped to have room for.
   */
  function linePanel(t) {
    const coded = accounts.find((a) => a.code === t.categoryAccount);
    const choice = (label, note, onClick) => h('button',
      { class: 'line-choice', onClick },
      h('span', { class: 'line-choice-label' }, label),
      h('span', { class: 'line-choice-note muted small' }, note));
    const choices = [];

    if (t.status === 'unreconciled') {
      choices.push(
        choice('Match to an existing record', 'It is already in your books — an invoice paid, a spend money entry, a transfer.', () => openMatchModal(ctx, t)),
        choice('Create a payment', 'A customer receipt or supplier payment from this line.', () => createPaymentFromLine(ctx, t)),
        choice('Transfer money', 'Move it to another of your accounts.', () => openTransferModal(ctx, t.accountCode)),
      );
    }
    if (t.status === 'posted' && t.journalId) {
      // Its entry is posted and the bank shows the line: the one thing that could not be done from here until
      // now was say so, and it needs no confirmation because nothing is recorded by doing it.
      choices.push(choice('Tick it off against the statement', 'The bank shows this line and its entry is already posted. Nothing new is recorded.', () => reconcileLine(ctx, t)));
      choices.push(choice('Reverse the categorisation', 'Voids the entry it posted and puts the line back in review.', () => undoLineCategorisation(ctx, t)));
    }
    if (t.status === 'reconciled') {
      choices.push(choice('Un-reconcile', 'Removes the tick against the statement. Nothing in the ledger is reversed.', () => unreconcileLine(ctx, t)));
    }
    if (t.status === 'excluded') {
      choices.push(choice('Reinstate', 'Puts it back to review, or to posted if it was already coded.', () => reinstateLine(ctx, t)));
    }
    choices.push(choice('Create a rule from this line', 'File future lines like this one automatically.', () => openRuleFromSelection(ctx, [t])));

    /**
     * How this line stands against the books, and — if it is back in review — what it could stand against.
     *
     * Asked for from use: a line read "Reconciled" with nothing saying against what, and a line put back to
     * review read "To review" with no hint of what it had been ticked off against a minute earlier. The panel
     * is where the question gets asked, so the panel is where the answer belongs.
     */
    function reconciliationBlock(t) {
      const rows = [];
      const codedName = () => {
        const a = accounts.find((x) => x.code === t.categoryAccount);
        return a ? `${a.name} (${a.code})` : 'no account';
      };
      const entryOf = (id) => (id ? ctx.db.get('entries', id) : null);

      if (t.status === 'reconciled') {
        const matched = entryOf(t.matchedEntryId);
        const own = matched ? null : entryOf(t.journalId);
        rows.push(h('p', { class: 'report-note' },
          matched
            ? `Reconciled against ${SOURCE_LABELS[matched.source?.type] || 'a record'} ${matched.number || ''} · ${fmt.date(matched.date)} · ${matched.memo || ''} · ${money(ctx, Math.abs(t.amount))} — nothing was posted for this line, matching ticks it off against something already in your books.`
            : own
              ? `Reconciled against the statement. It was coded to ${codedName()} and posted as ${own.number || 'an entry'}.`
              : 'Reconciled against the statement.'));
      } else if (t.status === 'posted' && t.journalId) {
        const own = entryOf(t.journalId);
        rows.push(h('p', { class: 'report-note' },
          `Coded to ${codedName()} and posted as ${own?.number || 'an entry'} — not ticked off against a statement yet.`));
      } else if (t.status === 'unreconciled') {
        const cands = matchCandidates(ctx, t).slice(0, 3);
        if (!cands.length) {
          rows.push(h('div', { class: 'strong' }, 'Nothing to match this to'));
          rows.push(h('p', { class: 'report-note' },
            `Nothing in this account matches ${money(ctx, t.amount)} within ${MATCH_WINDOW_DAYS} days. Categorise it instead — the form below posts it.`));
        } else {
          rows.push(h('div', { class: 'strong' }, 'What this could be'));
          rows.push(h('p', { class: 'report-note' },
            'These are already in your books and match the amount. Matching ticks the line off against one of them and posts nothing.'));
          rows.push(h('div', { class: 'line-choices' }, ...cands.map((c) => h('button', {
            class: 'line-choice',
            onClick: () => {
              try {
                matchBankTxn(ctx.db, t.id, c.entryId);
                toast('Line reconciled', 'success', { detail: `Matched to ${c.number || 'an entry'} in the books.` });
                ctx.ui.set('bankExpanded', null);
                expandedId = null;
                ctx.refresh();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          h('span', { class: 'line-choice-label' }, `${c.number || SOURCE_LABELS[c.source] || 'Entry'} · ${c.memo || '(no description)'}`),
          h('span', { class: 'line-choice-note muted small' }, `${fmt.date(c.date)} · ${money(ctx, c.amount)} — ${c.why}`)))));
          rows.push(button({ label: 'See every candidate', size: 'sm', variant: 'ghost', onClick: () => openMatchModal(ctx, t) }));
        }
      }
      return rows.length ? h('div', { class: 'line-recon' }, ...rows) : null;
    }

    /**
     * Files attached to this line — the supplier's PDF, the photo of the receipt.
     *
     * The contents stay on this device: the books backup describes each file and does not carry it, so the
     * panel says where they live rather than letting a person discover it after a restore.
     */
    function attachmentsBlock(t) {
      // Turned off means the control goes. What is already attached still shows, so nothing looks lost.
      if (ctx.company?.attachmentsEnabled === false) {
        const existing = filesFor(ctx.db, t.companyId, 'bankTxn', t.id);
        return h('div', { class: 'line-recon' },
          h('div', { class: 'strong' }, 'Attachments'),
          h('p', { class: 'report-note' },
            existing.length
              ? `Attachments are turned off for this company file. The ${existing.length} already on this line are kept and still export from Settings → Attachments.`
              : 'Attachments are turned off for this company file. Turn them back on under Settings → Attachments to attach a file here.'));
      }
      const list = filesFor(ctx.db, t.companyId, 'bankTxn', t.id);
      const picker = h('input', {
        type: 'file',
        class: 'input input-file',
        'aria-label': 'Attach a file to this line',
        onChange: async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          try {
            const data = await readFileAsDataUrl(file);
            const saved = attachFile(ctx.db, {
              companyId: t.companyId, entityType: 'bankTxn', entityId: t.id,
              name: file.name, mime: file.type, data,
            });
            toast(`Attached ${saved.name}`, 'success', {
              detail: `${formatBytes(saved.size)}. The contents stay on this device — see Settings → Attachments.`,
            });
            expandedId = t.id;
            ctx.refresh();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      });
      const rows = list.map((f) => h('div', { class: 'row-between' },
        h('div', { class: 'small' },
          h('span', { class: 'strong' }, f.name),
          h('span', { class: 'muted' }, ` · ${formatBytes(f.size)}`),
          f.data
            ? h('a', { class: 'small', href: f.data, download: f.name, style: { marginLeft: '8px' } }, 'Download')
            : h('span', { class: 'muted small' }, ' · contents are not on this device — import the attachments file to bring them back'),
        ),
        button({
          label: 'Remove', size: 'sm', variant: 'ghost',
          onClick: () => {
            try {
              const out = removeFile(ctx.db, f);
              toast(`Removed ${out.removed.name}`, 'success', { detail: out.remaining ? `${out.remaining} file(s) still attached.` : 'Nothing else is attached to this line.' });
              expandedId = t.id;
              ctx.refresh();
            } catch (err) { toast(err.message, 'error'); }
          },
        })));
      return h('div', { class: 'line-recon' },
        h('div', { class: 'strong' }, list.length ? `Attachments (${list.length})` : 'Attachments'),
        rows,
        h('div', { class: 'row-between' },
          picker,
          h('span', { class: 'muted small' }, 'Kept on this device, not in the books backup.')),
        h('p', { class: 'field-hint' },
          'A supplier invoice, a receipt, a photo. The books backup records that a file belongs here and leaves the file itself where it is — export the files from Settings → Attachments to keep them beside your backup.'));
    }

    const parts = [
      h('div', { class: 'row-between' },
        h('div', null,
          h('div', { class: 'strong' }, t.description || t.reference || 'Bank line'),
          h('div', { class: 'muted small' },
            `${fmt.date(t.date)} · ${money(ctx, t.amount)} · ${coded ? `${coded.name} · ${coded.code}` : 'not coded'}${t.note ? ` · ${t.note}` : ''}`)),
        button({
          label: 'Close',
          size: 'sm',
          variant: 'ghost',
          onClick: () => { ctx.ui.set('bankExpanded', null); expandedId = null; drawRows(); },
        })),
      reconciliationBlock(t),
      attachmentsBlock(t),
      h('div', { class: 'line-choices' }, ...choices),
    ].filter(Boolean);

    // The coding form itself, embedded rather than dialled up: a line is coded where it sits, with the
    // rows above and below still on screen. Same form the dialog uses, so the two cannot drift.
    if (t.status === 'unreconciled') {
      const form = categoriseForm(ctx, t);
      parts.push(h('div', { class: 'divider' }));
      parts.push(h('div', { class: 'row-between' },
        h('span', { class: 'strong' }, 'Select categories'),
        button({
          label: 'Post to the ledger',
          variant: 'primary',
          size: 'sm',
          onClick: () => {
            try {
              const detail = form.post();
              toast('Transaction categorised', 'success', { detail });
              ctx.ui.set('bankExpanded', null);
              expandedId = null;
              ctx.refresh();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        })));
      parts.push(form.node);
    }

    return h('div', { class: 'line-panel' }, ...parts);
  }

  function drawRows() {
    clear(rowsHost);
    const rows = allTxns.filter(passesFilter).filter(passesQuery).filter(passesAmount).filter(passesDate);
    const open = expandedId ? rows.find((r) => r.id === expandedId) : null;
    const total = sum(rows.map((r) => r.amount || 0));
    // The bar sits above the table rather than inside it: a table with a toolbar row in it is a
    // table nobody can sort or scan.
    if (ticked.size) {
      const bar = bulkBar(rows);
      // What the ticked lines add up to: ticking a batch is usually a question about the money, and the bar
      // was answering only how many there were. In, out and net, because a statement's lines run both ways.
      const chosen = rows.filter((r) => ticked.has(r.id));
      const cameIn = chosen.filter((r) => (r.amount || 0) > 0).reduce((n, r) => n + r.amount, 0);
      const wentOut = chosen.filter((r) => (r.amount || 0) < 0).reduce((n, r) => n + Math.abs(r.amount), 0);
      bar.insertBefore(h('div', { class: 'bulk-sum' },
        h('strong', null, `${chosen.length} ticked`),
        h('span', { class: 'muted' }, ` · in ${ctx.fmt.money(cameIn)}`),
        h('span', { class: 'muted' }, ` · out ${ctx.fmt.money(wentOut)}`),
        h('span', { class: 'muted' }, ` · net ${ctx.fmt.money(cameIn - wentOut)}`)), bar.firstChild);
      rowsHost.appendChild(bar);
    }
    rowsHost.appendChild(table({
      columns: [
        {
          key: 'select',
          label: '',
          className: 'col-tick',
          // A tick box per line, so a batch of imports can be dealt with in one action rather than
          // eight dialogs. State lives in `selected`, so it survives the redraw that follows.
          render: (r) => h('input', {
            type: 'checkbox',
            class: 'checkbox',
            checked: ticked.has(r.id) || null,
            'aria-label': `Select ${r.description || 'this line'}`,
            onChange: (e) => {
              if (e.target.checked) ticked.add(r.id);
              else ticked.delete(r.id);
              drawRows();
            },
          }),
        },
        { key: 'date', label: 'Date', sortable: true, render: (r) => h('span', { class: 'nowrap' }, fmt.date(r.date)) },
        {
          key: 'description',
          label: 'Description',
          render: (r) => h('div', null,
            h('span', null, r.description || '—'),
            r.categoryAccount ? h('div', { class: 'row-sub' }, accountName(accounts, r.categoryAccount)) : null,
            r.categorySource === 'rule'
              ? h('div', { class: 'row-sub' }, r.journalId
                ? 'Filed from a bank rule — check it'
                : 'Account suggested by a bank rule — file it with Apply rules or Categorise')
              : null,
            r.matchedEntryId ? h('div', { class: 'row-sub' }, 'Matched to an entry in the books') : null,
            r.status === 'excluded' && r.note ? h('div', { class: 'row-sub' }, r.note) : null),
        },
        { key: 'reference', label: 'Reference', className: 'muted small' },
        {
          key: 'withdrawal',
          label: 'Withdrawal',
          align: 'right',
          sortable: true,
          // Both columns sort on the signed amount, so ascending in Withdrawal puts the biggest payment
          // out first. The amount is shown as the app formats money everywhere — the direction is
          // carried by which column it is in *and* by the sign, because one signed column is exactly
          // how a card payment imported as income went unnoticed.
          sortValue: (r) => r.amount,
          render: (r) => (r.amount < 0 ? moneyCell(r.amount, { code: cur }) : h('span', { class: 'faint' }, '—')),
        },
        {
          key: 'deposit',
          label: 'Deposit',
          align: 'right',
          sortable: true,
          sortValue: (r) => r.amount,
          render: (r) => (r.amount > 0 ? moneyCell(r.amount, { code: cur }) : h('span', { class: 'faint' }, '—')),
        },
        {
          key: 'balance',
          label: 'Balance',
          align: 'right',
          render: (r) => (r.balance === null || r.balance === undefined ? h('span', { class: 'muted' }, '—') : moneyCell(r.balance, { code: cur })),
        },
        {
          key: 'match',
          label: 'Coded to',
          // What the line is coded to, readable without opening anything: the account's name, its type
          // and its code. An uncategorised line shows a dash rather than an empty cell that could be
          // mistaken for a coding.
          render: (r) => {
            const acc = accounts.find((a) => a.code === r.categoryAccount);
            if (!acc) return h('span', { class: 'faint' }, '—');
            return h('span', { class: 'muted small nowrap' }, `${acc.name} · ${acc.type} · ${acc.code}`);
          },
        },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
        { key: 'actions', label: '', title: 'Actions', className: 'col-right', render: (r) => rowActions(r) },
      ],
      rows,
      compact: true,
      // The sort is part of what the screen is showing, so it is remembered like the tab and the
      // search are. A table is rebuilt from scratch on every refresh, and its sort lives inside it,
      // so without this a column someone had sorted reverted the moment they allocated a line.
      // The line's own panel opens in the row it belongs to, as a detail row of the table.
      rowDetail: (r) => (r.id === expandedId ? linePanel(r) : null),
      sortKey: ctx.ui.get('bankSortKey') || null,
      sortDir: ctx.ui.get('bankSortDir') || 'asc',
      onSort: (key, dir) => {
        ctx.ui.set('bankSortKey', key);
        ctx.ui.set('bankSortDir', dir);
      },
      empty: allTxns.length
        ? 'No lines match this filter or search.'
        : 'No bank lines on this account yet. Import a statement to get started.',
      footer: [[
        h('span', { class: 'small muted' }, `${rows.length} line(s)`),
        '', '', moneyCell(total, { code: cur }), '', '', '',
      ]],
    }));
  }

  function drawSeg() {
    clear(segHost);
    segHost.appendChild(segmented({
      options: [
        { value: 'all', label: 'All' },
        { value: 'review', label: 'To review' },
        { value: 'reconciled', label: 'Reconciled' },
        { value: 'excluded', label: 'Excluded' },
      ],
      value: filter,
      onChange: (v) => { filter = v; ctx.ui.set('bankFilter', v); drawSeg(); drawRows(); },
    }));
  }

  const reviewBody = h('div', { class: 'stack' },
    toolbar({
      left: [segHost],
      right: [
        h('span', { class: 'with-clear' },
          h('div', { class: 'search-box' }, icon(ICONS.search, { size: 15 }), searchField),
          clearField(searchField, () => { queryText = ''; query = ''; ctx.ui.set('bankQuery', ''); })),
        h('span', { class: 'muted small' }, 'Exclude'),
        h('span', { class: 'with-clear' },
          excludeField,
          clearField(excludeField, () => { excludeText = ''; exclude = ''; ctx.ui.set('bankExclude', ''); })),
        h('div', { class: 'amount-range' },
          h('span', { class: 'with-clear' }, dateFromField,
            clearField(dateFromField, () => { dateFrom = ''; ctx.ui.set('bankDateFrom', ''); })),
          h('span', { class: 'muted small' }, 'to'),
          h('span', { class: 'with-clear' }, dateToField,
            clearField(dateToField, () => { dateTo = ''; ctx.ui.set('bankDateTo', ''); }))),
        h('div', { class: 'amount-range' },
          h('span', { class: 'with-clear' }, amountFromField,
            clearField(amountFromField, () => { amountFromText = ''; ctx.ui.set('bankAmountFrom', ''); })),
          h('span', { class: 'muted small' }, 'to'),
          h('span', { class: 'with-clear' }, amountToField,
            clearField(amountToField, () => { amountToText = ''; ctx.ui.set('bankAmountTo', ''); }))),
        button({
          label: 'Clear filters', variant: 'ghost', size: 'sm',
          onClick: () => {
            queryText = ''; query = ''; excludeText = ''; exclude = '';
            amountFromText = ''; amountToText = ''; dateFrom = ''; dateTo = '';
            for (const k of ['bankQuery', 'bankExclude', 'bankAmountFrom', 'bankAmountTo', 'bankDateFrom', 'bankDateTo']) ctx.ui.set(k, '');
            searchField.value = ''; excludeField.value = ''; amountFromField.value = ''; amountToField.value = '';
            dateFromField.value = ''; dateToField.value = '';
            drawRows();
          },
        }),
      ],
    }),
    rowsHost);

  root.appendChild(card({
    title: `Transactions — ${selected.code} ${selected.name}`,
    subtitle: 'Every line from this account, categorised, matched or excluded.',
    actions: [
      button({
        label: 'Import statement',
        icon: ICONS.upload,
        variant: 'subtle',
        size: 'sm',
        onClick: () => openImportModal(ctx, selected.code),
      }),
      button({
        label: 'Export CSV',
        icon: ICONS.download,
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          const headers = ['Date', 'Description', 'Reference', 'Amount', 'Balance', 'Status', 'Category'];
          const rows = allTxns.map((t) => [
            t.date,
            t.description || '',
            t.reference || '',
            fmt.raw(t.amount || 0),
            t.balance === null || t.balance === undefined ? '' : fmt.raw(t.balance),
            t.status || '',
            t.categoryAccount || '',
          ]);
          if (!rows.length) { toast('There are no bank lines to export yet.', 'info'); return; }
          downloadBlob(`bank-${selected.code}-${todayISO()}.csv`, rowsToCsvBlob(rows, headers));
          toast('Exported bank lines', 'success', { detail: `${rows.length} line(s).` });
        },
      }),
    ],
    body: reviewBody,
  }));

  /* ---- bank rules ---- */

  root.appendChild(bankRulesCard(ctx));

  /* ---- cash summary ---- */

  const fyStart = fyStartFor(ctx.asOf, ctx.company?.fyStartMonth || 7);
  const fyCash = cashFlow({ accounts, entries, from: fyStart, to: ctx.asOf });
  const totalCash = sum(banks.map((a) => accountBalance(entries, a.code, { to: ctx.asOf })));

  const chartTo = endOfMonth(ctx.asOf);
  const chartFrom = addMonths(startOfMonth(ctx.asOf), -11);
  const chartCash = cashFlow({ accounts, entries, from: chartFrom, to: chartTo });
  const netByMonth = new Map(chartCash.months.map((m) => [m.month, m.net]));
  const points = monthsBetween(chartFrom, chartTo).map((key) => ({ label: key, value: netByMonth.get(key) || 0 }));

  root.appendChild(card({
    title: 'Cash summary',
    subtitle: `All bank accounts · financial year to ${fmt.date(ctx.asOf)}`,
    body: h('div', { class: 'stack' },
      h('div', { class: 'stat-grid' },
        kpi({ label: 'Total cash', value: money(ctx, totalCash), tone: totalCash < 0 ? 'negative' : 'default' }),
        kpi({ label: 'Money in (this FY)', value: money(ctx, fyCash.inflows), tone: 'positive' }),
        kpi({ label: 'Money out (this FY)', value: money(ctx, fyCash.outflows), tone: fyCash.outflows ? 'negative' : 'default' }),
        kpi({ label: 'Net movement (this FY)', value: money(ctx, fyCash.net), tone: fyCash.net < 0 ? 'negative' : 'positive' })),
      sectionTitle('Net cash movement, last 12 months', 'Net movement through every bank account each month.'),
      barChart({
        points,
        height: 150,
        format: (v) => money(ctx, v),
      })),
  }));

  drawSeg();
  drawRows();

  return root;
}

/**
 * Set the balance the bank statement showed before the first line recorded
 * here. It is a fact about the bank's paperwork rather than about the ledger,
 * so it is stored against the company file and never posted.
 */
function setOpeningBalanceModal(ctx, account, rec) {
  let cents = rec.openingBalance || 0;
  return modal({
    title: `Statement opening balance — ${account.code}`,
    subtitle: 'The balance the bank statement showed before the first line you recorded.',
    width: 'sm',
    body: () => h('div', null,
      field({
        label: 'Opening balance',
        input: moneyInput({
          value: cents,
          code: ctx.company?.currency || 'AUD',
          onChange: (v) => { cents = v; },
          autofocus: true,
        }),
        hint: 'Negative for an overdrawn account or a credit card.',
      }),
      h('p', { class: 'field-hint' },
        `The ledger says this account holds ${ctx.fmt.money(accountBalance(ctx.data.entries, account.code, { to: ctx.asOf }))} as at ${ctx.fmt.date(ctx.asOf)}. Setting the statement opening balance makes the difference above compare like with like.`)),
    actions: ({ close }) => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => close(null) }),
      button({
        label: 'Save',
        variant: 'primary',
        onClick: () => {
          setStatementOpening(ctx.db, ctx.companyId, account.code, cents);
          ctx.toast('Statement opening balance saved', 'success', {
            detail: 'Reconciliation now compares the bank against the books from the same starting point.',
          });
          close(true);
          ctx.refresh();
        },
      }),
    ],
  });
}
