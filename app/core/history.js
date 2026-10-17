/*
 * Suggestions from the user's own history.
 *
 * Written rules only cover what somebody thought to write down. A fresh statement from a supplier you
 * have paid for a year needs nothing written down — the description looks like the ones already in the
 * books, and they are already coded. This is that: for a line, the account the last similar line was
 * coded to, with the evidence so it can be judged rather than trusted.
 *
 * Deliberately pure. It takes lines and a description and returns a suggestion; it touches no database
 * and posts nothing. The caller decides whether to prefill a field with it — and prefill is the whole
 * of its power. A suggestion can never move money on its own.
 */

/** A description reduced to the words that identify the merchant. */
export function normaliseDescription(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !/^\d+$/.test(word))
    .join(' ');
}

const tokensOf = (normalised) => normalised.split(' ').filter(Boolean);

/**
 * How alike two descriptions are: the share of the shorter one's words that appear in the other.
 *
 * Digits are already gone, which is what makes "WOOLWORTHS 1234 SYDNEY" and "WOOLWORTHS 5678 SYDNEY"
 * the same shop — a matcher that kept the digits would see two merchants and suggest nothing.
 *
 * A shared word only counts if it is at least four characters long. "LTD", "PTY", a suburb and a card
 * scheme appear on half a statement, and matching on them would suggest an account for every line in
 * the file. The score is taken over the *shorter* description, so a long description sharing one word
 * with a short one does not score well by accident.
 */
export function similarity(a, b) {
  const left = tokensOf(normaliseDescription(a));
  const right = tokensOf(normaliseDescription(b));
  if (!left.length || !right.length) return 0;
  const pool = new Set(right);
  const shared = left.filter((word) => word.length >= 4 && pool.has(word)).length;
  return shared / Math.min(left.length, right.length);
}

/**
 * The account to suggest for a description, from the lines already coded.
 *
 * Most recent similar line wins, not the best-scoring one: the question is "what did I do with this
 * last time", and a slightly better match from three years ago is a worse answer than an exact one from
 * last month. Lines with no account are ignored — they carry no answer.
 *
 * Returns null when nothing is similar enough, which is the common case for a genuinely new supplier and
 * should leave the caller's own default alone rather than forcing a guess.
 */
export function suggestAccount(txns, description, opts = {}) {
  const needle = normaliseDescription(description);
  if (!needle) return null;
  const minScore = opts.minScore ?? 0.5;

  const matches = (Array.isArray(txns) ? txns : [])
    .filter((t) => t && t.categoryAccount && normaliseDescription(t.description))
    .map((t) => ({ txn: t, score: similarity(needle, t.description) }))
    .filter((hit) => hit.score >= minScore)
    .sort((a, b) => String(b.txn.date || '').localeCompare(String(a.txn.date || '')));
  if (!matches.length) return null;

  const accountCode = matches[0].txn.categoryAccount;
  const same = matches.filter((hit) => hit.txn.categoryAccount === accountCode);
  const dates = same.map((hit) => String(hit.txn.date || '')).filter(Boolean).sort();
  return {
    accountCode,
    count: same.length,
    lastDate: dates[dates.length - 1] || '',
    examples: same.slice(0, 3).map((hit) => hit.txn.description),
    // The score of the line the answer came from, for a caller that wants to be careful with a weak one.
    score: matches[0].score,
  };
}
