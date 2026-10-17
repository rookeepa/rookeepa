/**
 * Rookeepa — chart of accounts and tax codes.
 *
 * A new company file is seeded from the Australian default chart below. The
 * numbering uses the six-series convention common in Australian small-business
 * accounting (1-xxxx assets, 2-xxxx liabilities, 3-xxxx equity, 4-xxxx income,
 * 5-xxxx cost of sales, 6-xxxx expenses) so figures map onto what an accountant
 * already expects. Nothing here is copied from another product: account codes,
 * names and groupings are ordinary industry conventions, and every account is
 * editable.
 */

export const ACCOUNT_TYPES = {
  asset: { label: 'Asset', normal: 'debit', statement: 'balanceSheet', order: 1 },
  liability: { label: 'Liability', normal: 'credit', statement: 'balanceSheet', order: 2 },
  equity: { label: 'Equity', normal: 'credit', statement: 'balanceSheet', order: 3 },
  income: { label: 'Income', normal: 'credit', statement: 'profitAndLoss', order: 4 },
  costOfSales: { label: 'Cost of Sales', normal: 'debit', statement: 'profitAndLoss', order: 5 },
  expense: { label: 'Expense', normal: 'debit', statement: 'profitAndLoss', order: 6 },
  // Trading is not the whole story: interest received and interest paid sit outside it, and a gross margin
  // that includes a one-off interest receipt is not the business's margin. Separating them is what MYOB's
  // "Other income" and "Other expenses" are for.
  otherIncome: { label: 'Other income', normal: 'credit', statement: 'profitAndLoss', order: 7 },
  otherExpenses: { label: 'Other expenses', normal: 'debit', statement: 'profitAndLoss', order: 8 },
};

export function isDebitType(type) {
  return ACCOUNT_TYPES[type]?.normal === 'debit';
}

export function accountTypeLabel(type) {
  return ACCOUNT_TYPES[type]?.label || type;
}

/**
 * The standard Australian GST tax codes.
 * gstBps is the GST rate in basis points (1000 = 10%).
 * bas.* flags drive the Activity Statement summary, whose boxes (G1, 1A, 1B,
 * G10, G11) are published by the ATO.
 */
export const DEFAULT_TAX_CODES = [
  {
    code: 'GST', name: 'GST', gstBps: 1000, reportable: true,
    bas: { salesG1: true, salesG2: false, salesG3: false, inputTaxed: false, purchasesG10: false, purchasesG11: true, gstOnSales: true, gstOnPurchases: true },
    description: 'Standard 10% GST on sales and purchases',
  },
  {
    code: 'FRE', name: 'GST Free', gstBps: 0, reportable: true,
    bas: { salesG1: true, salesG2: false, salesG3: true, inputTaxed: false, purchasesG10: false, purchasesG11: true, gstOnSales: false, gstOnPurchases: false },
    description: 'GST-free supplies (fresh food, health, education, some exports)',
  },
  {
    code: 'EXP', name: 'GST Free Exports', gstBps: 0, reportable: true,
    bas: { salesG1: true, salesG2: true, salesG3: false, inputTaxed: false, purchasesG10: false, purchasesG11: true, gstOnSales: false, gstOnPurchases: false },
    description: 'Goods and services exported for use outside Australia',
  },
  {
    code: 'ITS', name: 'Input Taxed', gstBps: 0, reportable: true,
    // Input-taxed sales belong in G1: the ATO requires input-taxed sales to be
    // reported at G1 total sales (they carry no GST, but they are still sales).
    // Excluding them understated total sales and made G1 differ from the ATO's figure.
    bas: { salesG1: true, salesG2: false, salesG3: false, inputTaxed: true, purchasesG10: false, purchasesG11: false, gstOnSales: false, gstOnPurchases: false },
    description: 'Input-taxed sales (residential rent, financial supplies) — no GST, no GST credits',
  },
  {
    code: 'CAP', name: 'Capital Purchases', gstBps: 1000, reportable: true,
    bas: { salesG1: false, salesG2: false, salesG3: false, inputTaxed: false, purchasesG10: true, purchasesG11: false, gstOnSales: false, gstOnPurchases: true },
    description: 'Capital acquisitions (equipment, vehicles, fit-out) with 10% GST',
  },
  {
    code: 'N-T', name: 'Not Reportable', gstBps: 0, reportable: false,
    bas: { salesG1: false, salesG2: false, salesG3: false, inputTaxed: false, purchasesG10: false, purchasesG11: false, gstOnSales: false, gstOnPurchases: false },
    description: 'Wages, bank transfers, drawings, super and anything outside the BAS',
  },
];

/**
 * control marks an account the software posts to automatically.
 * Roles: bank | ar | ap | gstCollected | gstPaid | inventory | retained |
 *        opening | suspense | paygPayable | superPayable
 */
export const DEFAULT_ACCOUNTS = [
  // ---- 1-xxxx Assets ----
  { code: '1-0000', name: 'Business Bank Account', type: 'asset', control: 'bank', gstDefault: 'N-T' },
  { code: '1-0100', name: 'Savings / Reserve Account', type: 'asset', control: 'bank2', gstDefault: 'N-T' },
  { code: '1-0200', name: 'Undeposited Funds', type: 'asset', gstDefault: 'N-T' },
  { code: '1-1000', name: 'Accounts Receivable (Debtors)', type: 'asset', control: 'ar', gstDefault: 'N-T' },
  { code: '1-1100', name: 'Inventory on Hand', type: 'asset', control: 'inventory', gstDefault: 'N-T' },
  { code: '1-1200', name: 'Prepaid Expenses', type: 'asset', gstDefault: 'N-T' },
  { code: '1-1300', name: 'GST Paid (Receivable)', type: 'asset', control: 'gstPaid', gstDefault: 'N-T' },
  { code: '1-1400', name: 'PAYG Withholding Receivable', type: 'asset', gstDefault: 'N-T' },
  { code: '1-2000', name: 'Office Equipment at Cost', type: 'asset', gstDefault: 'CAP' },
  { code: '1-2100', name: 'Computer Equipment at Cost', type: 'asset', gstDefault: 'CAP' },
  { code: '1-2200', name: 'Furniture & Fittings at Cost', type: 'asset', gstDefault: 'CAP' },
  { code: '1-2500', name: 'Less: Accumulated Depreciation', type: 'asset', gstDefault: 'N-T' },
  { code: '1-3000', name: 'Motor Vehicles at Cost', type: 'asset', gstDefault: 'CAP' },
  { code: '1-3500', name: 'Less: Accum Depn Motor Vehicles', type: 'asset', gstDefault: 'N-T' },

  // ---- 2-xxxx Liabilities ----
  { code: '2-1000', name: 'Accounts Payable (Creditors)', type: 'liability', control: 'ap', gstDefault: 'N-T' },
  { code: '2-1100', name: 'Credit Card', type: 'liability', control: 'bank3', gstDefault: 'N-T' },
  { code: '2-1200', name: 'GST Collected (Payable)', type: 'liability', control: 'gstCollected', gstDefault: 'N-T' },
  { code: '2-1300', name: 'PAYG Withholding Payable', type: 'liability', control: 'paygPayable', gstDefault: 'N-T' },
  { code: '2-1400', name: 'Superannuation Payable', type: 'liability', control: 'superPayable', gstDefault: 'N-T' },
  { code: '2-1500', name: 'Wages Payable', type: 'liability', gstDefault: 'N-T' },
  { code: '2-2000', name: 'Bank Loan', type: 'liability', gstDefault: 'N-T' },
  { code: '2-2100', name: 'Hire Purchase / Lease Liability', type: 'liability', gstDefault: 'N-T' },
  { code: '2-2500', name: 'Provision for Annual Leave', type: 'liability', gstDefault: 'N-T' },

  // ---- 3-xxxx Equity ----
  { code: '3-0100', name: "Owner's / Shareholder Capital", type: 'equity', gstDefault: 'N-T' },
  { code: '3-0200', name: 'Owner Drawings / Dividends', type: 'equity', gstDefault: 'N-T' },
  { code: '3-8000', name: 'Historical Balancing Account', type: 'equity', control: 'opening', gstDefault: 'N-T' },
  { code: '3-9000', name: 'Retained Earnings', type: 'equity', control: 'retained', gstDefault: 'N-T' },

  // ---- 4-xxxx Income ----
  { code: '4-0000', name: 'Sales — Services', type: 'income', gstDefault: 'GST' },
  { code: '4-0100', name: 'Sales — Products', type: 'income', gstDefault: 'GST' },
  { code: '4-0200', name: 'Freight & Delivery Income', type: 'income', gstDefault: 'GST' },
  // Interest and the like, outside trading. These two accounts are re-typed for new companies only:
  // a company file already in use keeps the types it was created with, because silently re-typing an
  // account in somebody's books is not something an upgrade should do. They can be changed under Accounts,
  // and until they are, the reports treat them exactly as before.
  { code: '4-0300', name: 'Interest Income', type: 'otherIncome', gstDefault: 'FRE' },
  { code: '4-0400', name: 'Discounts Received', type: 'income', gstDefault: 'GST' },
  { code: '4-0500', name: 'Other Income', type: 'income', gstDefault: 'GST' },

  // ---- 5-xxxx Cost of Sales ----
  { code: '5-0000', name: 'Cost of Goods Sold', type: 'costOfSales', gstDefault: 'GST' },
  { code: '5-0100', name: 'Freight & Cartage (Purchases)', type: 'costOfSales', gstDefault: 'GST' },
  { code: '5-0200', name: 'Subcontractor Cost of Sales', type: 'costOfSales', gstDefault: 'GST' },
  { code: '5-0300', name: 'Purchases — Materials', type: 'costOfSales', gstDefault: 'GST' },

  // ---- 6-xxxx Expenses ----
  { code: '6-0000', name: 'Advertising & Marketing', type: 'expense', gstDefault: 'GST' },
  { code: '6-0100', name: 'Bank Fees & Charges', type: 'expense', gstDefault: 'FRE' },
  { code: '6-0200', name: 'Depreciation', type: 'expense', gstDefault: 'N-T' },
  { code: '6-0300', name: 'Electricity & Gas', type: 'expense', gstDefault: 'GST' },
  { code: '6-0400', name: 'Insurance', type: 'expense', gstDefault: 'GST' },
  { code: '6-0500', name: 'Interest Expense', type: 'otherExpenses', gstDefault: 'FRE' },
  { code: '6-0600', name: 'Motor Vehicle Expenses', type: 'expense', gstDefault: 'GST' },
  { code: '6-0700', name: 'Office Supplies & Stationery', type: 'expense', gstDefault: 'GST' },
  { code: '6-0800', name: 'Rent', type: 'expense', gstDefault: 'GST' },
  { code: '6-0900', name: 'Repairs & Maintenance', type: 'expense', gstDefault: 'GST' },
  { code: '6-1000', name: 'Subcontractors & Consultants', type: 'expense', gstDefault: 'GST' },
  { code: '6-1100', name: 'Superannuation Expense', type: 'expense', gstDefault: 'N-T' },
  { code: '6-1200', name: 'Telephone & Internet', type: 'expense', gstDefault: 'GST' },
  { code: '6-1300', name: 'Travel & Accommodation', type: 'expense', gstDefault: 'GST' },
  { code: '6-1400', name: 'Wages & Salaries', type: 'expense', gstDefault: 'N-T' },
  { code: '6-1500', name: 'Accounting & Bookkeeping Fees', type: 'expense', gstDefault: 'GST' },
  { code: '6-1600', name: 'Software & Subscriptions', type: 'expense', gstDefault: 'GST' },
  { code: '6-1700', name: 'Professional Memberships', type: 'expense', gstDefault: 'GST' },
  { code: '6-1800', name: 'Training & Education', type: 'expense', gstDefault: 'GST' },
  { code: '6-1900', name: 'Cleaning & Waste', type: 'expense', gstDefault: 'GST' },
  { code: '6-2000', name: 'Printing & Postage', type: 'expense', gstDefault: 'GST' },
  { code: '6-2100', name: 'Tools & Equipment (small)', type: 'expense', gstDefault: 'GST' },
  { code: '6-2200', name: 'Sundry / Miscellaneous Expenses', type: 'expense', gstDefault: 'GST' },
  // ASIC and company registration charges are government fees: no GST, so the default tax code
  // is GST-free rather than GST, which would otherwise build a BAS position out of nothing.
  { code: '6-2300', name: 'Company Registration & ASIC Fees', type: 'expense', gstDefault: 'FRE' },
  { code: '6-9900', name: 'Suspense / Ask My Accountant', type: 'expense', control: 'suspense', gstDefault: 'GST' },
];

/** Payment terms presets, in days. */
export const PAYMENT_TERMS = [
  { id: 'due_on_receipt', label: 'Due on receipt', days: 0 },
  { id: 'net7', label: 'Net 7 days', days: 7 },
  { id: 'net14', label: 'Net 14 days', days: 14 },
  { id: 'net21', label: 'Net 21 days', days: 21 },
  { id: 'net30', label: 'Net 30 days', days: 30 },
  { id: 'net45', label: 'Net 45 days', days: 45 },
  { id: 'net60', label: 'Net 60 days', days: 60 },
  { id: 'eom', label: 'End of month', days: null },
];

export function termsDays(termId) {
  const t = PAYMENT_TERMS.find((x) => x.id === termId);
  return t ? t.days : 14;
}

/** Find the single account carrying a control role. */
export function accountByRole(accounts, role) {
  return accounts.find((a) => a.control === role && a.active !== false) || null;
}

export function requireRole(accounts, role) {
  const acct = accountByRole(accounts, role);
  if (!acct) {
    const err = new Error(`This company file has no account flagged as "${role}". Add one in Accounts before posting this transaction.`);
    err.code = 'MISSING_ROLE';
    err.role = role;
    throw err;
  }
  return acct;
}

export function bankAccounts(accounts) {
  return accounts.filter((a) => a.control && a.control.startsWith('bank') && a.active !== false);
}

/**
 * Make an account active or inactive.
 *
 * Inactive is not deleted: existing entries keep their history, and the account stops being offered when
 * new work is coded. It is a setup change rather than a bookkeeping one — the same kind of event as
 * renaming an account — so it is not written to the audit log, unlike everything that touches the ledger.
 *
 * Idempotent, because a batch will contain accounts already in the state being asked for.
 */
export function setAccountActive(db, account, active) {
  const row = typeof account === 'string' ? db.get('accounts', account) : account;
  if (!row) throw new Error('Account not found.');
  const want = Boolean(active);
  if ((row.active !== false) === want) return row;
  return db.put('accounts', { ...row, active: want });
}

export function sortAccounts(accounts) {
  return [...accounts].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

export function accountsByType(accounts, type) {
  return sortAccounts(accounts.filter((a) => a.type === type && a.active !== false));
}

/** A brand-new company file: identity, settings and the seeded chart. */
export function blankCompany(overrides = {}) {
  return {
    id: overrides.id || null,
    name: overrides.name || 'My Business',
    legalName: overrides.legalName || '',
    abn: overrides.abn || '',
    // A business logo for its invoices and quotes, kept as the image itself (a data URL) so
    // a printed document never depends on a file that has since moved.
    logoDataUrl: overrides.logoDataUrl || '',
    email: overrides.email || '',
    phone: overrides.phone || '',
    website: overrides.website || '',
    addressLine1: overrides.addressLine1 || '',
    addressLine2: overrides.addressLine2 || '',
    city: overrides.city || '',
    state: overrides.state || '',
    postcode: overrides.postcode || '',
    country: 'Australia',
    currency: overrides.currency || 'AUD',
    gstRegistered: overrides.gstRegistered !== false,
    fyStartMonth: overrides.fyStartMonth || 7,
    invoicePrefix: overrides.invoicePrefix || 'INV-',
    billPrefix: overrides.billPrefix || 'BILL-',
    creditNotePrefix: overrides.creditNotePrefix || 'CN-',
    quotePrefix: overrides.quotePrefix || 'QUO-',
    paymentPrefix: overrides.paymentPrefix || 'PMT-',
    defaultTerms: overrides.defaultTerms || 'net14',
    defaultSalesAccount: overrides.defaultSalesAccount || '4-0000',
    defaultPurchaseAccount: overrides.defaultPurchaseAccount || '6-0700',
    bankAccount: overrides.bankAccount || '1-0000',
    invoiceFooter: overrides.invoiceFooter || 'Thank you for your business. Payment is due by the date shown above.',
    taxLabel: overrides.taxLabel || 'GST',
    perpetualInventory: overrides.perpetualInventory === true,
    createdAt: overrides.createdAt || null,
  };
}

// An account carries no balance of its own: the journal is the only source of truth, and opening balances
// are posted entries (see setOpeningBalances in company.js) rather than a figure sitting on the account.
export function blankAccount(overrides = {}) {
  return {
    id: overrides.id || null,
    code: overrides.code || '',
    name: overrides.name || '',
    type: overrides.type || 'expense',
    description: overrides.description || '',
    gstDefault: overrides.gstDefault || 'GST',
    control: overrides.control || null,
    active: overrides.active !== false,
  };
}


/** Rewrite every `accountCode` field in a value, however deeply it is buried. */
function remapCodes(value, from, to) {
  if (Array.isArray(value)) return value.map((v) => remapCodes(v, from, to));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'accountCode' && v === from ? to : remapCodes(v, from, to);
    }
    return out;
  }
  return value;
}

/**
 * Change an account's code, and move every reference to it.
 *
 * The ledger refers to accounts by code, so changing the code alone leaves every posting pointing at one that
 * no longer exists: income drops out of the reports while the journal still balances, and the trial balance
 * splits. Nothing about the amounts changes here — only the label, everywhere it was written.
 *
 * Every collection is walked rather than a list of the places a code can appear, because such a list goes
 * stale the moment something new starts carrying an account code. Like renaming a file, this is a setup
 * change and is not written to the audit trail (the same decision as setAccountActive).
 */
export function renameAccountCode(db, company, from, to) {
  const companyId = typeof company === 'string' ? company : company?.id;
  const want = String(to || '').trim();
  if (!want) throw new Error('An account needs a code.');
  if (want === from) return 0;
  const accounts = db.of('accounts', companyId);
  if (accounts.some((a) => a.code === want)) throw new Error(`Code ${want} is already used by another account.`);
  const source = accounts.find((a) => a.code === from);
  if (!source) throw new Error(`There is no account with code ${from}.`);

  let changed = 0;
  for (const coll of Object.keys(db.data || {})) {
    if (coll === 'companies') continue;
    for (const row of db.of(coll, companyId)) {
      const next = remapCodes(row, from, want);
      if (JSON.stringify(next) !== JSON.stringify(row)) { db.put(coll, next, { silent: true }); changed += 1; }
    }
  }
  // db.meta names accounts in two places the collections do not cover: the per-account statement opening
  // balance, where the code is the key, and each bank rule's accountCode. Left behind, a renamed bank account
  // loses its opening balance and every rule that pointed at it stops matching — quietly, with no error
  // anywhere. markDirty('meta') is enough to persist it: every write already queues meta alongside.
  const meta = db.meta || {};
  let metaChanged = false;
  const openings = meta.statementOpening && meta.statementOpening[companyId];
  if (openings && Object.prototype.hasOwnProperty.call(openings, from)) {
    const next = { ...openings };
    next[want] = (next[want] || 0) + (next[from] || 0);
    delete next[from];
    db.meta = { ...meta, statementOpening: { ...meta.statementOpening, [companyId]: next } };
    metaChanged = true;
  }
  const rules = meta.bankRules && meta.bankRules[companyId];
  if (Array.isArray(rules)) {
    const nextRules = rules.map((r) => remapCodes(r, from, want));
    if (JSON.stringify(nextRules) !== JSON.stringify(rules)) {
      db.meta = { ...db.meta, bankRules: { ...meta.bankRules, [companyId]: nextRules } };
      metaChanged = true;
    }
  }
  if (metaChanged) db.markDirty('meta');

  db.put('accounts', { ...source, code: want }, { silent: true });
  db.notify({ collection: 'accounts', action: 'rename', from, to: want });
  return changed;
}
