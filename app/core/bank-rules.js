/**
 * Rookeepa — bank rules.
 *
 * A bank rule is a small, user-defined instruction: when an imported statement
 * line looks like this, file it against that account and tax code. Rules stay
 * deliberately simple — a text match on the description, a direction, and the
 * account and tax code to use — because a rule the owner cannot read back to
 * themselves is a rule they cannot trust.
 *
 * Two things keep the result honest rather than magical:
 *   - a rule only ever *suggests* an account until the line is posted, and the
 *     banking screen shows where the suggestion came from so it can be checked;
 *   - applying rules goes through categoriseBankTxn (./docs.js), so every line
 *     it files becomes an ordinary, balanced Spend money / Receive money journal
 *     exactly as if it had been categorised by hand. Nothing here inventents a
 *     posting of its own.
 *
 * Storage: a rule is a setting about the business, not a transaction, so rules
 * live in db.meta alongside the statement opening balances — db.meta.bankRules,
 * a map of company id to that company's rules. That keeps them out of the
 * ledger (they never post anything by themselves) and keeps one company file's
 * rules separate from another's.
 */

import { uid as newId } from './db.js';
import { categoriseBankTxn } from './docs.js';

/** The db.meta key holding { [companyId]: BankRule[] }. */
export const BANK_RULES_META = 'bankRules';

/** How a rule decides a description is a match, most specific first. */
export const MATCH_MODES = ['equals', 'starts-with', 'contains'];
export const DIRECTIONS = ['any', 'in', 'out'];

/**
 * A bank rule. Validation is not done here — this only gives the shape every
 * other part of the app expects, with the same defaults as a blank bank line.
 */
export function blankBankRule(overrides = {}) {
  return {
    id: overrides.id || newId('br'),
    companyId: overrides.companyId || null,
    name: overrides.name || '',
    match: overrides.match || 'contains', // contains | starts-with | equals
    text: overrides.text || '',
    direction: overrides.direction || 'any', // any | in | out
    // A rule may carry several conditions and a choice of how they combine. `match`/`text` above are
    // the original single-condition shape and are still written for the first condition, so a rule
    // saved by an older version of the app — or by a version of the user with no need for more than
    // one — keeps working without being rewritten.
    conditions: Array.isArray(overrides.conditions) ? overrides.conditions.map((c) => ({ ...c })) : [],
    combine: overrides.combine === 'any' ? 'any' : 'all',
    accountCode: overrides.accountCode || '',
    taxCode: overrides.taxCode || 'GST',
    contactId: overrides.contactId || null,
    active: overrides.active !== false,
    createdAt: overrides.createdAt || new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ matching */

/** Rank of each match mode, so the most specific rule can win. */
const MATCH_RANK = { equals: 3, 'starts-with': 2, contains: 1, between: 3, 'more-than': 3, 'less-than': 3 };

/** The fields a condition can look at. */
export const CONDITION_FIELDS = ['description', 'reference', 'amount'];
/** How a condition compares. The first three read text; the last three read a size, in cents. */
export const CONDITION_MATCHES = ['contains', 'starts-with', 'equals', 'more-than', 'less-than', 'between'];

export function isAmountCondition(condition) {
  return ['more-than', 'less-than', 'between'].includes(condition?.match);
}

/** The description both the rule and the line are compared on: trimmed, lower-cased. */
function normalise(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * A rule's conditions, whenever it was written.
 *
 * A rule saved before conditions existed has one `match`/`text` pair and no list. It is read as a
 * single description condition rather than being migrated or rewritten on disk: a user's rules are
 * their own, and an upgrade that silently edits them is one nobody can check.
 */
export function ruleConditions(rule) {
  if (!rule) return [];
  if (Array.isArray(rule.conditions) && rule.conditions.length) {
    return rule.conditions.filter((c) => c && c.match);
  }
  if (rule.text) return [{ field: 'description', match: rule.match || 'contains', text: rule.text }];
  return [];
}

/**
 * Does one condition match one transaction?
 *
 * Amount conditions compare the *size* of the amount, not its sign: "over $50" means the money moved
 * by more than fifty dollars, and whether that was in or out is what the rule's direction is for.
 * Comparing signed amounts would make "over 50" mean "spent more than $50" for an outgoing rule and
 * "received more than $50" for an incoming one, which is not what the words say.
 */
export function conditionMatches(condition, txn = {}) {
  if (!condition || !condition.match) return false;
  const amount = Math.abs(txn.amount || 0);

  if (condition.match === 'more-than') return amount > Math.abs(condition.cents || 0);
  if (condition.match === 'less-than') return amount < Math.abs(condition.cents || 0);
  if (condition.match === 'between') {
    const low = Math.min(Math.abs(condition.cents || 0), Math.abs(condition.centsTo || 0));
    const high = Math.max(Math.abs(condition.cents || 0), Math.abs(condition.centsTo || 0));
    return amount >= low && amount <= high;
  }

  // The amount field has its own three comparisons. A text match aimed at it is a mis-built
  // condition, and falling through would quietly compare the description instead — matching lines
  // the rule never meant, which is worse than matching none.
  if (condition.field === 'amount') return false;

  const needle = normalise(condition.text);
  if (!needle) return false;
  const haystack = normalise(condition.field === 'reference' ? txn.reference : txn.description);
  if (condition.match === 'equals') return haystack === needle;
  if (condition.match === 'starts-with') return haystack.startsWith(needle);
  return haystack.includes(needle);
}

/**
 * Does one rule match one transaction?
 *
 * Split out so both matchRule and a caller checking a single rule agree on exactly the same answer.
 * A rule with no usable condition matches nothing — an empty rule must never become a catch-all that
 * quietly files every line in the account. With several conditions, `combine` decides: every one of
 * them, or any one of them.
 */
export function ruleMatches(rule, txn = {}) {
  if (!rule || rule.active === false) return false;
  const conditions = ruleConditions(rule);
  if (!conditions.length) return false;

  const amount = txn.amount || 0;
  if (rule.direction === 'in' && !(amount > 0)) return false;
  if (rule.direction === 'out' && !(amount < 0)) return false;

  if (rule.combine === 'any' && conditions.length > 1) {
    return conditions.some((c) => conditionMatches(c, txn));
  }
  return conditions.every((c) => conditionMatches(c, txn));
}

/** How specific a rule is — the most specific condition in it decides. */
function ruleSpecificity(rule) {
  const conditions = ruleConditions(rule);
  if (!conditions.length) return 0;
  return Math.max(...conditions.map((c) => MATCH_RANK[c.match] || MATCH_RANK.contains));
}

/**
 * The best matching rule for a transaction, or null.
 *
 * Most specific wins: a condition that names one merchant or one amount beats a broad "anything with
 * 'fee' in it". Between two equally specific rules the earlier one in the list wins, which is the
 * order the user can see on screen.
 */
export function matchRule(rules = [], txn = {}) {
  let best = null;
  let bestRank = 0;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!ruleMatches(rule, txn)) continue;
    const rank = ruleSpecificity(rule);
    if (rank > bestRank) { best = rule; bestRank = rank; }
  }
  return best;
}

/** What a rule would file a line as, or null when nothing matches. */
export function suggestFor(rules = [], txn = {}) {
  const rule = matchRule(rules, txn);
  if (!rule) return null;
  return {
    accountCode: rule.accountCode || '',
    taxCode: rule.taxCode || '',
    contactId: rule.contactId || null,
    ruleId: rule.id || null,
  };
}

/* ------------------------------------------------------------------- storage */

/** This company file's rules, oldest first. */
export function listBankRules(db, companyId) {
  const rows = db?.meta?.[BANK_RULES_META]?.[companyId];
  return Array.isArray(rows) ? rows : [];
}

/** Add or replace a rule. Returns the saved record. */
export function saveBankRule(db, rule) {
  const saved = blankBankRule(rule);
  if (!saved.companyId) throw new Error('A bank rule needs a company file.');
  const all = { ...(db.meta[BANK_RULES_META] || {}) };
  const rows = Array.isArray(all[saved.companyId]) ? all[saved.companyId].slice() : [];
  const idx = rows.findIndex((r) => r.id === saved.id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...saved };
  else rows.push(saved);
  all[saved.companyId] = rows;
  db.meta[BANK_RULES_META] = all;
  db.markDirty('meta');
  db.notify({ collection: BANK_RULES_META, action: idx >= 0 ? 'update' : 'insert', id: saved.id });
  return idx >= 0 ? rows[idx] : saved;
}

/** Remove a rule. Returns false when there was nothing to remove. */
export function deleteBankRule(db, companyId, ruleId) {
  const all = { ...(db.meta[BANK_RULES_META] || {}) };
  const rows = Array.isArray(all[companyId]) ? all[companyId].slice() : [];
  const next = rows.filter((r) => r.id !== ruleId);
  if (next.length === rows.length) return false;
  all[companyId] = next;
  db.meta[BANK_RULES_META] = all;
  db.markDirty('meta');
  db.notify({ collection: BANK_RULES_META, action: 'delete', id: ruleId });
  return true;
}

/* ------------------------------------------------------------------- applying */

/**
 * File every matching line in the account through categoriseBankTxn.
 *
 * Returns { applied, matched, skipped }: `matched` is the ids of the lines that
 * were filed, `skipped` the ids of the lines it left alone (already reconciled,
 * already posted, set aside, or not matched by any rule).
 *
 * A line is only "already categorised" when it has been posted to the ledger —
 * picked up from `journalId`, not from carrying a suggested account. A line the
 * import merely pre-filled still needs its Spend/Receive money entry, so it is
 * filed here. That is also what makes a second run a no-op: once filed, a line
 * is reconciled and carries a journal, so nothing matches again.
 *
 * Reconciled lines are never rewritten: they agree with the bank and rewriting
 * one would move money that the statement already confirmed. Excluded lines are
 * set aside on purpose. Both are reported as skipped.
 */
export function applyRules(db, companyId, { onlyUncategorised = true } = {}) {
  const rules = listBankRules(db, companyId);
  const matched = [];
  const skipped = [];

  for (const txn of db.of('bankTxns', companyId)) {
    if (txn.status === 'reconciled' || txn.status === 'excluded') { skipped.push(txn.id); continue; }
    if (onlyUncategorised && txn.journalId) { skipped.push(txn.id); continue; }

    const suggestion = suggestFor(rules, txn);
    if (!suggestion || !suggestion.accountCode) { skipped.push(txn.id); continue; }

    try {
      categoriseBankTxn(db, {
        ...txn,
        categoryAccount: suggestion.accountCode,
        taxCode: suggestion.taxCode || txn.taxCode,
        // A rule without a contact leaves whatever the line already had.
        contactId: suggestion.contactId || txn.contactId,
      });
      matched.push(txn.id);
    } catch {
      // A rule that points at an account which has since been removed must not
      // abort the whole run: leave the line for review and carry on with the rest.
      skipped.push(txn.id);
    }
  }

  return { applied: matched.length, matched, skipped };
}
