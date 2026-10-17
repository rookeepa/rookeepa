import test from 'node:test';
import assert from 'node:assert/strict';
import { DB } from '../app/core/db.js';
import { createCompany } from '../app/core/company.js';
import { blankLine, computeDocument, authoriseDocument } from '../app/core/docs.js';
import {
  blankRecurring, advance, isDue, dueTemplates, upcomingTemplates, createNext, skipNext, overdueCount, frequencyLabel,
} from '../app/core/recurring.js';

/*
 * Recurring transactions.
 *
 * The schedule is the part that is easy to get subtly wrong — month lengths, a leap day, a
 * template that was posted late or skipped — so most of these tests are about dates and about
 * the template not drifting. The rest pin the two rules that matter: a template creates a
 * draft, and it is dated when it was scheduled, not when someone got to it.
 */

async function setup() {
  const db = await DB.open({ forceMemory: true, debounceMs: 0 });
  const company = createCompany(db, { name: 'Recurring Co' });
  const customer = db.put('contacts', { companyId: company.id, name: 'Tenant Pty Ltd', isCustomer: true });
  return { db, company, customer };
}

const template = (company, customer, overrides = {}) => blankRecurring({
  companyId: company.id,
  name: 'Monthly service fee',
  type: 'invoice',
  contactId: customer.id,
  frequency: 'monthly',
  startDate: '2026-07-01',
  nextDate: '2026-07-01',
  lines: [blankLine({ description: 'Service fee', accountCode: '4-0000', taxCode: 'GST', qty: 1000, unitPrice: 50000 })],
  ...overrides,
});

test('a period forward is a period forward, whatever the month length', () => {
  assert.equal(advance('2026-07-01', 'weekly'), '2026-07-08');
  assert.equal(advance('2026-07-01', 'fortnightly'), '2026-07-15');
  assert.equal(advance('2026-07-15', 'monthly'), '2026-08-15');
  assert.equal(advance('2026-07-15', 'quarterly'), '2026-10-15');
  assert.equal(advance('2026-07-15', 'yearly'), '2027-07-15');
});

test('a month step from the end of a month clamps instead of sliding into the next one', () => {
  // 31 January plus a month is the end of February, not 2 or 3 March.
  assert.equal(advance('2027-01-31', 'monthly'), '2027-02-28');
  assert.equal(advance('2028-01-31', 'monthly'), '2028-02-29', 'a leap year gets the 29th');
  assert.equal(advance('2026-08-31', 'monthly'), '2026-09-30');
});

test('a yearly schedule on 29 February lands on the 28th in a common year', () => {
  assert.equal(advance('2028-02-29', 'yearly'), '2029-02-28');
});

test('a period beyond the end date is not due', () => {
  const t = blankRecurring({ name: 'Finishing', nextDate: '2026-09-01', endDate: '2026-08-31' });
  assert.equal(isDue(t, '2026-09-01'), false, 'the schedule has finished');
  assert.equal(isDue({ ...t, nextDate: '2026-08-01' }, '2026-09-01'), true, 'the last one is still due');
});

test('an inactive template is never due', () => {
  const t = blankRecurring({ name: 'Paused', nextDate: '2026-07-01', active: false });
  assert.equal(isDue(t, '2026-08-01'), false);
});

test('due templates come back oldest first, and only when they are due', () => {
  const later = blankRecurring({ name: 'Zeta', nextDate: '2026-08-20' });
  const earlier = blankRecurring({ name: 'Alpha', nextDate: '2026-08-01' });
  const future = blankRecurring({ name: 'Later', nextDate: '2026-09-01' });
  const due = dueTemplates([later, future, earlier], '2026-08-31');
  assert.deepEqual(due.map((t) => t.name), ['Alpha', 'Zeta']);
  assert.equal(upcomingTemplates([later, future, earlier], 5, '2026-08-31').length, 1);
});

test('creating from a template produces a draft, and the schedule moves on by one period', async () => {
  const { db, company, customer } = await setup();
  const t = db.put('recurring', template(company, customer));

  const { document, template: after, scheduled } = createNext(db, t.id);
  assert.equal(scheduled, '2026-07-01');
  assert.equal(document.status, 'draft', 'nothing goes into the books until someone authorises it');
  assert.equal(document.date, '2026-07-01', 'dated when it was scheduled');
  assert.equal(document.contactId, customer.id);
  assert.equal(document.recurringId, t.id, 'the draft says where it came from');
  assert.equal(document.lines.length, 1);
  assert.equal(after.nextDate, '2026-08-01');
  assert.equal(after.postedCount, 1);

  const computed = computeDocument(document, db.of('taxCodes', company.id));
  assert.equal(computed.total, 55000, '$500 plus GST');

  // A draft has no journal behind it: the ledger is untouched until it is authorised.
  assert.equal(db.of('entries', company.id).length, 0);

  // And it becomes a real document the normal way.
  const authorised = authoriseDocument(db, document.id);
  assert.equal(authorised.status, 'open');
  assert.equal(db.of('entries', company.id).length, 1);
});

test('catching up two missed periods does not skip either of them or drift the schedule', async () => {
  const { db, company, customer } = await setup();
  const t = db.put('recurring', template(company, customer));

  const first = createNext(db, t.id).document;
  const second = createNext(db, t.id).document;
  assert.equal(first.date, '2026-07-01');
  assert.equal(second.date, '2026-08-01', 'the second one belongs to August, not to today');

  const third = createNext(db, t.id);
  assert.equal(third.template.nextDate, '2026-10-01', 'still one period at a time');
});

test('skipping moves the schedule on without creating anything', async () => {
  const { db, company, customer } = await setup();
  const t = db.put('recurring', template(company, customer));

  const after = skipNext(db, t.id);
  assert.equal(after.nextDate, '2026-08-01');
  assert.equal(after.skippedCount, 1);
  assert.equal(after.postedCount, 0);
  assert.equal(db.of('documents', company.id).length, 0);
});

test('a template posted late keeps its own schedule rather than restarting from today', async () => {
  const { db, company, customer } = await setup();
  const t = db.put('recurring', template(company, customer, { nextDate: '2026-05-01' }));

  // Three months behind: each one is created on its own scheduled date.
  createNext(db, t.id);
  createNext(db, t.id);
  const third = createNext(db, t.id);
  assert.deepEqual(db.of('documents', company.id).map((d) => d.date), ['2026-05-01', '2026-06-01', '2026-07-01']);
  assert.equal(third.template.nextDate, '2026-08-01');
});

test('you are told how many occurrences are behind', async () => {
  const { db, company, customer } = await setup();
  const t = template(company, customer, { nextDate: '2026-05-01' });
  assert.equal(overdueCount(t, '2026-07-01'), 3, 'May, June and July are all due');
  assert.equal(overdueCount({ ...t, nextDate: '2026-07-02' }, '2026-07-01'), 0);
});

test('a bill template creates a purchase draft, not a sale', async () => {
  const { db, company, customer } = await setup();
  const t = db.put('recurring', template(company, customer, { type: 'bill', name: 'Rent' }));
  const { document } = createNext(db, t.id);
  assert.equal(document.type, 'bill');
  assert.equal(document.ledger, 'purchases');
});

test('frequencies have plain-English labels', () => {
  assert.equal(frequencyLabel('fortnightly'), 'Every 2 weeks');
  assert.equal(frequencyLabel('monthly'), 'Every month');
});
