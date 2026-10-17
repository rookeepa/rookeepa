/**
 * Rookeepa — the chart of accounts.
 *
 * One screen for the whole chart: what each account is, what it balances to
 * right now, and which control roles make the software post to the right place
 * on its own. Balances are shown in each account's natural direction, so a
 * bank overdraft reads negative and a loan reads positive.
 */

import {
  h, clear, append, card, pageHeader, button, iconButton, icon, ICONS, table, moneyCell, badge,
  field, input, select, moneyInput, dateInput, checkbox, toolbar, emptyState, banner, modal,
  confirmDialog, toast, fmt, kpi,
} from './kit.js';
import { balancesByAccount, naturalBalance, entryTotals } from '../core/ledger.js';
import { renameAccountCode, setAccountActive } from '../core/coa.js';
import { setOpeningBalances, openingBalanceRows, usage } from '../core/company.js';
import { ACCOUNT_TYPES, blankAccount, isDebitType, sortAccounts, accountTypeLabel } from '../core/coa.js';
import { trialBalance, balanceSheet, incomeStatement } from '../core/reports.js';
import { todayISO, fyStartFor } from '../core/dates.js';

export const meta = {
  title: 'Accounts',
  subtitle: 'The chart of accounts: what each account is, what it balances to, and what posts to it automatically',
};

/* --------------------------------------------------------------- view state */

const viewState = {
  search: '',
  showInactive: false,
};

const SERIES = { asset: '1-', liability: '2-', equity: '3-', income: '4-', costOfSales: '5-', expense: '6-' };

const ROLE_LABEL = {
  bank: 'Bank',
  bank2: 'Bank (savings)',
  bank3: 'Credit card',
  ar: 'Debtors control',
  ap: 'Creditors control',
  gstCollected: 'GST collected',
  gstPaid: 'GST paid',
  inventory: 'Inventory',
  retained: 'Retained earnings',
  opening: 'Historical balancing',
  suspense: 'Suspense',
  paygPayable: 'PAYG payable',
  superPayable: 'Super payable',
};

// Which control roles make sense for each account type. A control role is what
// lets Rookeepa post to an account without being told, so only accounts of the
// right type may hold one.
const ROLES_BY_TYPE = {
  asset: ['bank', 'bank2', 'ar', 'inventory', 'gstPaid'],
  liability: ['ap', 'bank3', 'gstCollected', 'paygPayable', 'superPayable'],
  equity: ['retained', 'opening'],
  expense: ['suspense'],
  income: [],
  costOfSales: [],
};

/* ------------------------------------------------------------------ helpers */

function nextCodeFor(accounts, type) {
  const prefix = SERIES[type] || '9-';
  let max = -1;
  for (const a of accounts) {
    const code = String(a.code || '');
    if (!code.startsWith(prefix)) continue;
    const tail = code.slice(prefix.length).replace(/[^0-9]/g, '');
    if (!tail) continue;
    const value = parseInt(tail, 10);
    if (Number.isFinite(value) && value > max) max = value;
  }
  const next = max < 0 ? 0 : (Math.floor(max / 100) + 1) * 100;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

function accountActions(ctx, account) {
  return h('div', { class: 'table-actions' },
    iconButton({
      label: `View the general ledger for ${account.code}`,
      icon: ICONS.arrowRight,
      onClick: () => ctx.go('reports', ['gl'], { code: account.code }),
    }),
    iconButton({
      label: `Edit ${account.code}`,
      icon: ICONS.edit,
      onClick: () => openAccountModal(ctx, account),
    }),
    iconButton({
      label: account.active === false ? `Reactivate ${account.code}` : `Deactivate ${account.code}`,
      icon: ICONS.lock,
      onClick: () => toggleActive(ctx, account),
    }),
    iconButton({
      label: `Delete ${account.code}`,
      icon: ICONS.trash,
      onClick: () => deleteAccount(ctx, account),
    }));
}

function accountGroupCard(ctx, type, list, helpers) {
  const { cur, bal, ticked, onTick } = helpers;
  return card({
    title: ACCOUNT_TYPES[type].label,
    subtitle: `${list.length} account${list.length === 1 ? '' : 's'}`,
    flush: true,
    body: () => table({
      columns: [
        {
          key: 'select',
          label: '',
          className: 'col-tick',
          // A tick per account, so a batch can be activated or deactivated in one action rather than a
          // dialog per account. State lives in the screen's Set, so it survives the redraw.
          render: (r) => h('input', {
            type: 'checkbox',
            class: 'checkbox',
            checked: ticked.has(r.id) || null,
            'aria-label': `Select ${r.code}`,
            onChange: (e) => onTick(r.id, e.target.checked),
          }),
        },
        { key: 'code', label: 'Code', render: (r) => h('span', { class: 'mono' }, r.code) },
        { key: 'name', label: 'Name', render: (r) => h('div', null,
          h('span', { class: 'row-title' }, r.name),
          r.description ? h('div', { class: 'row-sub' }, r.description) : null) },
        { key: 'type', label: 'Type', render: (r) => h('span', { class: 'muted small' }, accountTypeLabel(r.type)) },
        { key: 'gstDefault', label: 'Tax', render: (r) => (r.gstDefault ? badge(r.gstDefault, 'muted') : '') },
        { key: 'control', label: 'Control role', render: (r) => (r.control
          ? badge(ROLE_LABEL[r.control] || r.control, 'accent', { title: 'Rookeepa posts to this account automatically' })
          : h('span', { class: 'faint' }, '—')) },
        { key: 'balance', label: 'Balance', align: 'right', render: (r) => moneyCell(naturalBalance(bal.get(r.code) || 0, r.type), cur) },
        { key: 'active', label: 'Active', render: (r) => (r.active === false ? badge('Inactive', 'muted') : badge('Active', 'positive')) },
        { key: 'actions', label: '', align: 'right', render: (r) => accountActions(ctx, r) },
      ],
      rows: list,
      compact: true,
    }),
  });
}

/* ---------------------------------------------------------------- mutations */

async function toggleActive(ctx, account) {
  const reactivating = account.active === false;
  if (!reactivating && account.control) {
    const ok = await confirmDialog({
      title: `Deactivate ${account.code}?`,
      message: `${account.name} carries the "${ROLE_LABEL[account.control] || account.control}" control role. While it is inactive, Rookeepa cannot find it to post automatically.`,
      detail: 'Reactivate it any time. Existing entries keep their history either way.',
      confirmLabel: 'Deactivate anyway',
      danger: true,
    });
    if (!ok) return;
  }
  setAccountActive(ctx.db, account, reactivating);
  toast(`${account.code} ${reactivating ? 'reactivated' : 'deactivated'}`, 'success', {
    detail: reactivating ? 'It is offered in account pickers again.' : 'Existing entries keep their history; the account just stops being offered.',
  });
  ctx.refresh();
}

async function deleteAccount(ctx, account) {
  const used = ctx.data.entries.some((e) => e.lines.some((l) => l.accountCode === account.code));
  if (used) {
    toast('Cannot delete an account that has transactions', 'warn', {
      detail: 'Deactivate it instead — the history stays and it stops being offered in pickers.',
    });
    return;
  }
  const ok = await confirmDialog({
    title: `Delete ${account.code} ${account.name}?`,
    message: 'This account has no journal lines, so deleting it changes no balances. This cannot be undone.',
    confirmLabel: 'Delete account',
    danger: true,
  });
  if (!ok) return;
  ctx.db.remove('accounts', account.id);
  toast(`${account.code} deleted`, 'success');
  ctx.refresh();
}

/* ---------------------------------------------------------- account editor */

function openAccountModal(ctx, account) {
  const editing = !!account;
  const accounts = ctx.data.accounts;
  const taxCodes = ctx.data.taxCodes;

  let type = account?.type || 'expense';
  let code = account?.code || nextCodeFor(accounts, type);
  let name = account?.name || '';
  let description = account?.description || '';
  let gstDefault = account?.gstDefault || 'GST';
  let active = account?.active !== false;
  let control = account?.control || null;
  const hasTxns = account
    ? ctx.data.entries.some((e) => e.lines.some((l) => l.accountCode === account.code))
    : false;

  const codeInput = input({ value: code, placeholder: nextCodeFor(accounts, type), onInput: (v) => { code = v; } });
  const nameInput = input({ value: name, autofocus: true, onInput: (v) => { name = v; } });
  const typeSelect = select({
    options: Object.entries(ACCOUNT_TYPES)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([key, value]) => ({ value: key, label: value.label })),
    value: type,
    onChange: (v) => {
      type = v;
      if (!editing) { code = nextCodeFor(accounts, v); codeInput.value = code; }
      redrawControl();
    },
  });
  const gstSelect = select({
    options: taxCodes.map((t) => ({ value: t.code, label: t.code })),
    value: gstDefault,
    onChange: (v) => { gstDefault = v; },
  });
  const descInput = input({ value: description, placeholder: 'What this account is for', onInput: (v) => { description = v; } });

  const controlHost = h('div');
  function redrawControl() {
    clear(controlHost);
    const roles = ROLES_BY_TYPE[type] || [];
    if (hasTxns) {
      controlHost.appendChild(field({
        label: 'Control role',
        input: control ? badge(ROLE_LABEL[control] || control, 'accent') : h('span', { class: 'muted' }, 'Not a control account'),
        hint: 'Locked, because this account already has transactions. Rookeepa posts here automatically.',
      }));
      return;
    }
    if (!roles.length) {
      controlHost.appendChild(field({
        label: 'Control role',
        input: h('span', { class: 'muted' }, 'No automatic role for this account type'),
        hint: 'Income, cost of sales and most expense accounts are ordinary accounts — you choose them by hand.',
      }));
      return;
    }
    controlHost.appendChild(field({
      label: 'Control role',
      input: select({
        options: [
          { value: '', label: 'Not a control account' },
          ...roles.map((r) => ({ value: r, label: ROLE_LABEL[r] || r })),
        ],
        value: control || '',
        onChange: (v) => { control = v || null; },
      }),
      hint: 'A control role tells Rookeepa to post here automatically. Only one account can hold a role.',
    }));
  }

  const body = h('div', null,
    h('div', { class: 'form-grid' },
      field({
        label: 'Code',
        required: true,
        input: codeInput,
        hint: 'Number the account in its series — 1- assets, 2- liabilities, 3- equity, 4- income, 5- cost of sales, 6- expenses.',
      }),
      field({ label: 'Name', required: true, input: nameInput }),
      field({ label: 'Type', input: typeSelect }),
      field({ label: 'Default tax code', input: gstSelect })),
    field({ label: 'Description', input: descInput }),
    checkbox({ label: 'Active', checked: active, onChange: (c) => { active = c; } }),
    h('div', { class: 'divider' }),
    h('p', { class: 'field-hint' },
      'Control roles are what let the software post to the right account without asking: an invoice debits the Debtors control account, GST lands in the GST collected and GST paid accounts, inventory movements use the Inventory account, and any opening-balance difference goes to the Historical Balancing Account. Each role can belong to only one account.'),
    controlHost);

  function save() {
    const nextCode = code.trim();
    const nextName = name.trim();
    if (!nextCode) { toast('Give the account a code.', 'warn'); return; }
    if (!nextName) { toast('Give the account a name.', 'warn'); return; }

    const clash = accounts.find((a) => a.code === nextCode && a.id !== account?.id);
    if (clash) { toast(`Code ${nextCode} is already used by ${clash.name}.`, 'error'); return; }

    const role = control;
    if (role) {
      const holder = accounts.find((a) => a.control === role && a.id !== account?.id);
      if (holder) {
        toast(`"${ROLE_LABEL[role] || role}" is already held by ${holder.code} ${holder.name}. Only one account can carry a control role.`, 'error');
        return;
      }
    }

    const base = account ? { ...account } : blankAccount({});
    // A rename has to travel: the ledger refers to accounts by code, so writing the new code on the account
    // alone strands every posting that still names the old one.
    if (account && nextCode !== account.code) {
      try {
        renameAccountCode(ctx.db, ctx.companyId, account.code, nextCode);
      } catch (err) {
        toast(err.message || 'That code could not be changed.', 'error');
        return;
      }
    }
    ctx.db.put('accounts', {
      ...base,
      code: nextCode,
      name: nextName,
      type,
      description: description.trim(),
      gstDefault,
      control: role || null,
      active,
      companyId: ctx.companyId,
    });
    toast(editing ? `${nextCode} updated` : `Account ${nextCode} created`, 'success');
    handle.close(true);
    ctx.refresh();
  }

  const handle = modal({
    title: editing ? `Edit ${account.code}` : 'New account',
    subtitle: editing ? 'Changes apply everywhere this account is used.' : 'New accounts are offered in pickers straight away.',
    width: 'lg',
    body,
    actions: () => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => handle.close(null) }),
      button({ label: editing ? 'Save account' : 'Create account', variant: 'primary', onClick: save }),
    ],
  });

  redrawControl();
  return handle;
}

/* -------------------------------------------------------- opening balances */

function viewExistingOpening(ctx) {
  const entry = ctx.db.find('entries', (e) => e.companyId === ctx.companyId
    && e.source?.type === 'opening-balances' && e.status === 'posted');
  if (!entry) { toast('No opening-balances entry found.', 'info'); return; }
  const accounts = ctx.data.accounts;
  const cur = { code: ctx.company?.currency || 'AUD' };
  const totals = entryTotals(entry);
  modal({
    title: 'Opening balances entry',
    subtitle: `${entry.number || 'OB'} · ${ctx.fmt.date(entry.date)}`,
    width: 'lg',
    body: () => h('div', null,
      table({
        columns: [
          { key: 'accountCode', label: 'Account', render: (r) => h('div', null,
            h('span', { class: 'mono' }, r.accountCode),
            h('div', { class: 'row-sub' }, (accounts.find((a) => a.code === r.accountCode) || {}).name || '(deleted account)')) },
          { key: 'description', label: 'Description', render: (r) => r.description || '' },
          { key: 'debit', label: 'Debit', align: 'right', render: (r) => (r.debit ? moneyCell(r.debit, cur) : '') },
          { key: 'credit', label: 'Credit', align: 'right', render: (r) => (r.credit ? moneyCell(r.credit, cur) : '') },
        ],
        rows: entry.lines,
        footer: [[
          'Totals', '',
          h('span', { class: 'num' }, fmt.money(totals.debit, cur)),
          h('span', { class: 'num' }, fmt.money(totals.credit, cur)),
        ]],
        compact: true,
      }),
      h('p', { class: 'report-note' }, 'To change opening balances, void this entry first, then post new figures from here.')),
  });
}

function openOpeningBalances(ctx) {
  const company = ctx.company || {};
  const cur = { code: company.currency || 'AUD' };
  const fyStartMonth = company.fyStartMonth || 7;
  let asOf = fyStartFor(ctx.asOf || todayISO(), fyStartMonth);

  const rows = openingBalanceRows(ctx.db, ctx.companyId)
    .filter((r) => ['asset', 'liability', 'equity'].includes(r.type));
  const hasExisting = rows.some((r) => r.hasEntry);
  const openingAccount = ctx.data.accounts.find((a) => a.control === 'opening');

  // Entered in each account's own natural direction. Prefilled with whatever is
  // already posted, because a saved set replaces the existing entry rather than
  // adding a second one — so this edits the opening balances in place.
  const amounts = new Map();
  for (const r of rows) amounts.set(r.accountCode, r.amount || 0);

  const dateField = dateInput({ value: asOf, onChange: (v) => { asOf = v; } });
  const diffHost = h('div');
  const saveButton = button({ label: 'Post opening balances', variant: 'primary', onClick: save });

  function updateDifference() {
    let net = 0;
    for (const r of rows) net += (isDebitType(r.type) ? 1 : -1) * (amounts.get(r.accountCode) || 0);
    const balanced = net === 0;
    clear(diffHost);
    append(diffHost, [
      h('div', { class: 'totals-table' },
        h('span', null, 'Difference'), h('span', { class: `num${net ? ' neg' : ''}` }, fmt.money(net, cur))),
      h('div', { class: `report-check${balanced ? '' : ' bad'}`, style: { marginTop: '0.4rem' } },
        icon(balanced ? ICONS.check : ICONS.info, { size: 15 }),
        h('span', null, balanced
          ? 'Balances exactly — no balancing entry needed'
          : `${fmt.money(Math.abs(net), cur)} will be posted to ${openingAccount ? openingAccount.name : 'the Historical Balancing Account'}`)),
    ]);
    saveButton.disabled = !openingAccount || !rows.some((r) => amounts.get(r.accountCode));
  }

  async function save() {
    const list = rows
      .map((r) => ({ accountCode: r.accountCode, amount: amounts.get(r.accountCode) || 0 }))
      .filter((r) => r.amount);
    if (!list.length) { toast('Enter at least one opening balance.', 'warn'); return; }
    if (hasExisting) {
      const ok = await confirmDialog({
        title: 'Replace the existing opening balances?',
        message: 'Opening balances are already on the ledger. Saving replaces that entry with the figures above — the previous amounts are overwritten, and it does not add a second entry.',
        detail: 'View the existing entry first if you want to compare before replacing it.',
        confirmLabel: 'Replace opening balances',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      setOpeningBalances(ctx.db, ctx.companyId, list, asOf);
      toast('Opening balances posted', 'success', { detail: `As at ${ctx.fmt.date(asOf)}.` });
      handle.close(true);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const warning = hasExisting
    ? banner({
      kind: 'warning',
      title: 'Opening balances have already been posted',
      message: 'The figures below are what is currently on the ledger. Saving replaces that existing opening-balances entry — it does not add a second one, and any account you clear is left out. View the entry first if you want to compare.',
      actions: [button({ label: 'View the existing entry', variant: 'subtle', size: 'sm', onClick: () => viewExistingOpening(ctx) })],
    })
    : null;

  const handle = modal({
    title: 'Opening balances',
    subtitle: 'Enter each amount in the account\'s own direction — type a bank balance as a positive number.',
    width: 'lg',
    body: () => h('div', null,
      warning,
      field({ label: 'As at', input: dateField, hint: 'Defaults to the start of the current financial year.' }),
      table({
        columns: [
          { key: 'accountCode', label: 'Account', render: (r) => h('div', null,
            h('span', { class: 'mono' }, r.accountCode),
            h('div', { class: 'row-sub' }, r.name)) },
          { key: 'type', label: 'Type', render: (r) => h('span', { class: 'muted small' }, accountTypeLabel(r.type)) },
          { key: 'existing', label: 'Already posted', align: 'right', render: (r) => (r.hasEntry ? moneyCell(r.amount, cur) : h('span', { class: 'faint' }, '—')) },
          { key: 'amount', label: 'Opening balance', align: 'right', width: '150px', render: (r) => moneyInput({
            value: amounts.get(r.accountCode) || 0,
            code: cur.code,
            onChange: (v) => { amounts.set(r.accountCode, v); updateDifference(); },
          }) },
        ],
        rows,
        compact: true,
      }),
      h('div', { class: 'divider' }),
      diffHost,
      h('p', { class: 'report-note' }, 'Nothing is posted until you choose Post opening balances. If the figures do not balance on their own, the remainder lands in the Historical Balancing Account — exactly as a desktop package does.')),
    actions: () => [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => handle.close(null) }),
      saveButton,
    ],
  });

  updateDifference();
  return handle;
}

/* -------------------------------------------------------------------- screen */

export async function render(ctx) {
  const wrap = h('div');
  const company = ctx.company || {};
  const asOf = ctx.asOf || todayISO();
  const cur = { code: company.currency || 'AUD' };
  const fyStartMonth = company.fyStartMonth || 7;
  const accounts = ctx.data.accounts;
  const entries = ctx.data.entries;
  const counts = usage(ctx.db, ctx.companyId);

  const tb = trialBalance({ accounts, entries, to: asOf });
  const bs = balanceSheet({ accounts, entries, asOf, fyStartMonth });
  const fyFrom = fyStartFor(asOf, fyStartMonth);
  const is = incomeStatement({ accounts, entries, from: fyFrom, to: asOf });

  const summary = card({
    title: 'Trial balance and position',
    subtitle: `As at ${ctx.fmt.date(asOf)} · ${counts.entries || 0} journal entries`,
    body: () => h('div', null,
      h('div', { class: 'stat-grid' },
        kpi({ label: 'Total debits', value: fmt.money(tb.totals.debit, cur) }),
        kpi({ label: 'Total credits', value: fmt.money(tb.totals.credit, cur) }),
        kpi({
          label: 'Balances',
          value: tb.balanced ? 'Yes' : 'No',
          sub: tb.balanced ? 'Debits equal credits' : `Out by ${fmt.money(Math.abs(tb.totals.debit - tb.totals.credit), cur)}`,
          tone: tb.balanced ? 'positive' : 'negative',
        })),
      h('div', { class: 'divider' }),
      h('div', { class: 'stat-grid' },
        kpi({ label: 'Total assets', value: fmt.money(bs.assets.total, cur) }),
        kpi({ label: 'Total liabilities', value: fmt.money(bs.liabilities.total, cur) }),
        kpi({ label: 'Total equity', value: fmt.money(bs.equity.total, cur) }),
        kpi({
          label: 'Net profit this year',
          value: fmt.money(is.totals.netProfit, cur),
          sub: `${ctx.fmt.date(fyFrom, 'MMM yyyy')} to ${ctx.fmt.date(asOf, 'MMM yyyy')}`,
          tone: is.totals.netProfit < 0 ? 'negative' : 'positive',
        }))),
  });

  const searchInput = input({
    value: viewState.search,
    placeholder: 'Search code or name',
    onInput: (v) => { viewState.search = v; drawAccounts(); },
  });
  const searchBox = h('div', { class: 'search-box' }, icon(ICONS.search, { size: 15 }), searchInput);

  const inactiveToggle = checkbox({
    label: 'Show inactive accounts',
    checked: viewState.showInactive,
    onChange: (c) => { viewState.showInactive = c; drawAccounts(); },
  });

  const bar = toolbar({ left: [searchBox], right: [inactiveToggle] });

  const header = pageHeader({
    title: meta.title,
    subtitle: meta.subtitle,
    actions: [
      button({ label: 'New account', icon: ICONS.plus, variant: 'primary', onClick: () => openAccountModal(ctx, null) }),
      button({ label: 'Opening balances', icon: ICONS.coins, variant: 'default', onClick: () => openOpeningBalances(ctx) }),
    ],
  });

  const listHost = h('div');
  // Accounts ticked for a bulk action. Transient, like the bank screen's: a selection is about the work in
  // front of you, and finding eleven accounts still ticked tomorrow would be worse than losing them.
  const tickedAccounts = new Set();

  /**
   * Activate or deactivate a batch.
   *
   * Deactivating is not deleting — entries keep their history — but a control account is the exception
   * worth asking about: Rookeepa posts to it automatically, so deactivating one breaks posting quietly. The
   * confirm says how many of the batch those are and names them, because a batch confirm that hides the
   * one that matters is worse than no confirm at all.
   */
  async function bulkSetActive(active, list) {
    const controls = list.filter((a) => a.control);
    if (!active && controls.length) {
      const ok = await confirmDialog({
        title: `Deactivate ${list.length} account${list.length === 1 ? '' : 's'}?`,
        message: `${controls.length} of them carr${controls.length === 1 ? 'ies' : 'y'} a control role — ${controls.map((a) => a.code).join(', ')}. While one of those is inactive, Rookeepa cannot find it to post automatically.`,
        detail: 'Existing entries keep their history either way, and you can reactivate at any time.',
        confirmLabel: 'Deactivate anyway',
        danger: true,
      });
      if (!ok) return;
    }
    let done = 0;
    try {
      for (const account of list) { setAccountActive(ctx.db, account, active); done += 1; }
    } catch (err) {
      toast(err.message, 'error');
    }
    tickedAccounts.clear();
    if (done) {
      toast(`${done} account${done === 1 ? '' : 's'} ${active ? 'reactivated' : 'deactivated'}`, 'success', {
        detail: active ? 'Offered in account pickers again.' : 'Existing entries keep their history.',
      });
    }
    ctx.refresh();
  }

  function accountsBulkBar(shown) {
    const chosen = accounts.filter((a) => tickedAccounts.has(a.id));
    const toDeactivate = chosen.filter((a) => a.active !== false);
    const toReactivate = chosen.filter((a) => a.active === false);
    const act = (label, list, run) => button({
      label: `${label} (${list.length})`,
      size: 'sm',
      variant: 'subtle',
      disabled: !list.length,
      onClick: () => run(list),
    });
    return toolbar({
      left: [h('span', { class: 'muted small' }, `${chosen.length} selected`)],
      right: [
        button({ label: 'Select all shown', size: 'sm', variant: 'ghost', onClick: () => { for (const a of shown) tickedAccounts.add(a.id); drawAccounts(); } }),
        button({ label: 'Clear', size: 'sm', variant: 'ghost', onClick: () => { tickedAccounts.clear(); drawAccounts(); } }),
        act('Reactivate', toReactivate, (list) => bulkSetActive(true, list)),
        act('Deactivate', toDeactivate, (list) => bulkSetActive(false, list)),
      ],
    });
  }

  function drawAccounts() {
    const q = viewState.search.trim().toLowerCase();
    const bal = balancesByAccount(entries, { to: asOf });
    clear(listHost);
    let shown = 0;
    const shownAccounts = [];
    for (const type of Object.keys(ACCOUNT_TYPES)) {
      const list = sortAccounts(accounts.filter((a) => a.type === type
        && (viewState.showInactive || a.active !== false)
        && (!q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))));
      if (!list.length) continue;
      shown += list.length;
      shownAccounts.push(...list);
      listHost.appendChild(accountGroupCard(ctx, type, list, {
        cur,
        bal,
        ticked: tickedAccounts,
        onTick: (id, checked) => { if (checked) tickedAccounts.add(id); else tickedAccounts.delete(id); drawAccounts(); },
      }));
    }
    if (tickedAccounts.size) listHost.insertBefore(accountsBulkBar(shownAccounts), listHost.firstChild);
    if (!shown) {
      listHost.appendChild(emptyState({
        title: 'No accounts match',
        message: viewState.search
          ? `Nothing matches "${viewState.search}". Clear the search, or add a new account.`
          : 'This company file has no accounts yet. Add one before posting anything.',
        action: button({ label: 'New account', variant: 'primary', icon: ICONS.plus, onClick: () => openAccountModal(ctx, null) }),
      }));
    }
  }

  wrap.appendChild(header);
  wrap.appendChild(summary);
  wrap.appendChild(bar);
  wrap.appendChild(listHost);
  drawAccounts();
  return wrap;
}
