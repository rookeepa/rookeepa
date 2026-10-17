/**
 * Rookeepa — company files.
 *
 * One company = one set of books. Creating one seeds the chart of accounts,
 * the tax codes and the control accounts every posting looks for, so a new
 * file is immediately usable.
 */

import { COLLECTIONS, uid } from './db.js';
import {
  DEFAULT_ACCOUNTS, DEFAULT_TAX_CODES, blankCompany, blankAccount, sortAccounts, ACCOUNT_TYPES,
} from './coa.js';
import { dr, cr, postEntry, audit, validateEntry, nextNumber } from './ledger.js';
import { isDebitType } from './coa.js';
import { todayISO } from './dates.js';

export function createCompany(db, input = {}) {
  const company = db.put('companies', { ...blankCompany(input), id: null });
  seedAccounts(db, company.id);
  seedTaxCodes(db, company.id);
  audit(db, { companyId: company.id, action: 'create', entity: 'company', entityId: company.id, detail: `Created company file "${company.name}"` });
  return company;
}

export function seedAccounts(db, companyId) {
  const rows = DEFAULT_ACCOUNTS.map((a) => db.put('accounts', { ...blankAccount(a), companyId }, { silent: true }));
  db.notify({ collection: 'accounts', action: 'seed' });
  return rows;
}

export function seedTaxCodes(db, companyId) {
  const rows = DEFAULT_TAX_CODES.map((t) => db.put('taxCodes', { ...t, companyId }, { silent: true }));
  db.notify({ collection: 'taxCodes', action: 'seed' });
  return rows;
}

export function listCompanies(db) {
  return [...db.all('companies')].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function renameCompany(db, companyId, patch) {
  const company = db.get('companies', companyId);
  if (!company) throw new Error('Company file not found.');
  const saved = db.put('companies', { ...company, ...patch });
  audit(db, { companyId, action: 'update', entity: 'company', entityId: companyId, detail: 'Updated company details' });
  return saved;
}

/** Delete a company file and every record that belongs to it. Permanent. */
export function deleteCompany(db, companyId) {
  const company = db.get('companies', companyId);
  if (!company) return false;
  // Every collection except the companies themselves, rather than a list written out by hand: a hand-written
  // list goes stale the moment a collection is added, and then deleting a company quietly leaves that
  // collection's records behind while the audit entry claims everything went.
  for (const coll of COLLECTIONS) {
    if (coll === 'companies') continue;
    db.removeWhere(coll, (r) => r.companyId === companyId, { silent: true });
  }
  db.remove('companies', companyId, { silent: true });
  audit(db, { companyId: null, action: 'delete', entity: 'company', entityId: companyId, detail: `Deleted company file "${company.name}" and all of its data` });
  db.notify({ action: 'companyDeleted', companyId });
  return true;
}

export function usage(db, companyId) {
  const counts = {};
  for (const coll of ['accounts', 'contacts', 'items', 'documents', 'payments', 'entries', 'bankTxns']) {
    counts[coll] = db.of(coll, companyId).length;
  }
  return counts;
}

/**
 * Enter opening balances.
 *
 * Input is a list of { accountCode, amount } where the amount is entered as a
 * positive number in the account's own natural direction (a bank balance of
 * $5,000 is 500000 cents debit; a $20,000 loan is 2000000 cents credit).
 * The difference lands in the Historical Balancing Account, exactly as it does
 * in a desktop accounting package when your opening trial balance does not
 * close by itself.
 */
export function setOpeningBalances(db, companyId, rows, asOf = todayISO()) {
  const accounts = db.of('accounts', companyId);
  const openingAccount = accounts.find((a) => a.control === 'opening');
  if (!openingAccount) throw new Error('This company file has no Historical Balancing Account. Add a 3-8000 equity account to use opening balances.');

  const lines = [];
  let net = 0;
  for (const row of rows) {
    const amount = Math.round(row.amount || 0);
    if (!amount) continue;
    const account = accounts.find((a) => a.code === row.accountCode);
    if (!account) throw new Error(`Account ${row.accountCode} does not exist.`);
    const debit = isDebitType(account.type);
    const [d, c] = debit
      ? [row.amount < 0 ? 0 : amount, row.amount < 0 ? -amount : 0]
      : [row.amount < 0 ? -amount : 0, row.amount < 0 ? 0 : amount];
    if (d) lines.push(dr(account.code, d, { description: 'Opening balance', taxCode: 'N-T' }));
    else lines.push(cr(account.code, c, { description: 'Opening balance', taxCode: 'N-T' }));
    net += d - c;
  }
  if (!lines.length) throw new Error('Nothing to post — enter at least one opening balance.');
  if (net !== 0) {
    if (net > 0) lines.push(cr(openingAccount.code, net, { description: 'Opening balance offset' }));
    else lines.push(dr(openingAccount.code, -net, { description: 'Opening balance offset' }));
  }

  const entry = postEntry(db, {
    companyId,
    date: asOf,
    ref: 'OB',
    memo: 'Opening balances',
    lines,
    source: { type: 'opening-balances', id: `ob_${companyId}` },
  });
  audit(db, { companyId, action: 'openingBalances', entity: 'entry', entityId: entry.id, detail: `Posted opening balances as at ${asOf}` });
  return entry;
}

export function openingBalanceRows(db, companyId) {
  const accounts = db.of('accounts', companyId);
  const entries = db.of('entries', companyId).filter((e) => e.status === 'posted' && e.source?.type === 'opening-balances');
  const map = new Map();
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.accountCode === accounts.find((a) => a.control === 'opening')?.code) continue;
      map.set(l.accountCode, (map.get(l.accountCode) || 0) + (l.debit || 0) - (l.credit || 0));
    }
  }
  return sortAccounts(accounts).map((a) => {
    const signed = map.get(a.code) || 0;
    const natural = isDebitType(a.type) ? signed : -signed;
    return { accountCode: a.code, name: a.name, type: a.type, amount: natural, hasEntry: map.has(a.code) };
  });
}

export function groupAccountsByType(accounts) {
  const out = {};
  for (const type of Object.keys(ACCOUNT_TYPES)) {
    out[type] = sortAccounts(accounts.filter((a) => a.type === type && a.active !== false));
  }
  return out;
}
