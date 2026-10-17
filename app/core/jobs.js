/**
 * Jobs — what a cost or a sale belongs to, when it is not the whole business.
 *
 * Per **line**, not per document, which is the choice this was built on: one supplier invoice can carry
 * materials for two jobs, and the books have to be able to say which is which. The ledger line has carried a
 * `jobCode` field since the beginning and nothing ever set it; this is what fills it in.
 *
 * A job is deliberately a thin thing: a code, a name, and whether it is still running. It is not a project
 * plan and holds no tasks — the moment it does, it stops being part of the accounts.
 */

/** Codes are made, not typed, so two jobs cannot end up with the same one by accident. */
export function nextJobCode(db, companyId) {
  const used = new Set(db.of('jobs', companyId).map((j) => String(j.code || '').toUpperCase()));
  for (let n = 1; n < 10000; n += 1) {
    const code = `JOB-${String(n).padStart(3, '0')}`;
    if (!used.has(code)) return code;
  }
  throw new Error('There are too many jobs to make another code.');
}

export function blankJob({ companyId, code = '', name = '', description = '' } = {}) {
  return { companyId, code, name, description, active: true };
}

export function listJobs(db, companyId, { includeInactive = false } = {}) {
  return db.of('jobs', companyId)
    .filter((j) => includeInactive || j.active !== false)
    .sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
}

export function jobByCode(db, companyId, code) {
  if (!code) return null;
  return db.of('jobs', companyId).find((j) => j.code === code) || null;
}

export function jobLabel(job) {
  return job ? `${job.code} ${job.name}`.trim() : '';
}

/**
 * Add or change a job.
 *
 * The code is made here when one is not given, and checked for uniqueness either way: a job code is quoted on
 * reports and in conversation, so two jobs sharing one would be a slow, quiet mess.
 */
export function saveJob(db, job) {
  if (!job || !String(job.name || '').trim()) throw new Error('Give the job a name.');
  if (!job.companyId) throw new Error('A job belongs to a company file.');
  const code = String(job.code || '').trim().toUpperCase() || nextJobCode(db, job.companyId);
  const clash = db.of('jobs', job.companyId)
    .find((j) => j.code && j.code.toUpperCase() === code && j.id !== job.id);
  if (clash) throw new Error(`Job code ${code} is already used by ${clash.name}.`);
  return db.put('jobs', { ...job, code, name: String(job.name).trim() });
}

/** Retire a job without deleting it: its history stays, and it stops being offered on new lines. */
export function setJobActive(db, job, active) {
  const row = typeof job === 'string' ? db.get('jobs', job) : job;
  if (!row) throw new Error('Job not found.');
  const want = Boolean(active);
  if ((row.active !== false) === want) return row;
  return db.put('jobs', { ...row, active: want });
}

/* ------------------------------------------------------------------- the report */

const INCOME_TYPES = ['income', 'otherIncome'];
const EXPENSE_TYPES = ['costOfSales', 'expense', 'otherExpenses'];

/**
 * What each job earned and cost over a period, read from the ledger.
 *
 * Every posted line that carries a job code is counted, classified by the account it sits on rather than by
 * the document it came from — which is what makes a mixed invoice split correctly. Lines with no job are
 * gathered under "no job" rather than dropped, so the totals reconcile against the profit and loss instead of
 * quietly disagreeing with it.
 */
export function jobsSummary(db, companyId, { from = null, to = null } = {}) {
  const accounts = db.of('accounts', companyId);
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const jobs = new Map(db.of('jobs', companyId).map((j) => [j.code, j]));
  const buckets = new Map();

  const bucket = (code) => {
    if (!buckets.has(code)) {
      const job = jobs.get(code);
      buckets.set(code, {
        code: code || null,
        name: job ? job.name : (code ? code : 'No job'),
        known: Boolean(job),
        income: 0,
        expenses: 0,
        lines: 0,
      });
    }
    return buckets.get(code);
  };

  for (const e of db.of('entries', companyId)) {
    if (e.status !== 'posted') continue;
    if (from && e.date < from) continue;
    if (to && e.date > to) continue;
    for (const l of e.lines || []) {
      const account = byCode.get(l.accountCode);
      if (!account) continue;
      const signed = (l.debit || 0) - (l.credit || 0);
      const natural = account.type && INCOME_TYPES.includes(account.type) ? -signed
        : EXPENSE_TYPES.includes(account.type) ? signed
          : null;
      if (natural === null) continue; // a balance-sheet line: not profit, so not in this report
      const row = bucket(l.jobCode || null);
      if (INCOME_TYPES.includes(account.type)) row.income += natural;
      else row.expenses += natural;
      row.lines += 1;
    }
  }

  const rows = [...buckets.values()]
    .map((r) => ({ ...r, net: r.income - r.expenses }))
    .sort((a, b) => (a.code === null ? 1 : b.code === null ? -1 : String(a.code).localeCompare(String(b.code))));
  return {
    from,
    to,
    rows,
    totals: {
      income: rows.reduce((n, r) => n + r.income, 0),
      expenses: rows.reduce((n, r) => n + r.expenses, 0),
      net: rows.reduce((n, r) => n + r.net, 0),
    },
  };
}
