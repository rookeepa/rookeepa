/**
 * Rookeepa — Recurring transactions.
 *
 * A recurring transaction is a template: the same invoice or bill, raised again on a schedule.
 * Rent, a subscription, a regular service fee. It is not a post-dated document, and it is not a
 * standing order — it never writes to the books by itself.
 *
 * Two deliberate decisions:
 *
 *   1. A template produces a *draft*. Authorising a document is what moves money in the books,
 *      and nothing should do that without a person looking at it at least once. The template's
 *      job is to save you typing the same lines again, not to decide what your books say.
 *   2. A document is dated the day it was *scheduled*, not the day you got around to it. If two
 *      months of rent are created on the same afternoon, each lands in the month it belongs to,
 *      and the schedule itself keeps moving from the scheduled date so it cannot drift.
 */

import { uid as newId } from './db.js';
import { todayISO, compareISO, addDays, addMonths, addYears } from './dates.js';
import { blankDocument, blankLine } from './docs.js';

export const FREQUENCIES = [
  { value: 'weekly', label: 'Every week' },
  { value: 'fortnightly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Every month' },
  { value: 'quarterly', label: 'Every 3 months' },
  { value: 'yearly', label: 'Every year' },
];

const DOCUMENT_TYPES = [
  { value: 'invoice', label: 'Invoice (money in)' },
  { value: 'bill', label: 'Bill (money out)' },
];

export function documentTypes() { return DOCUMENT_TYPES.map((t) => ({ ...t })); }

export function frequencyLabel(value) {
  return (FREQUENCIES.find((f) => f.value === value) || { label: value }).label;
}

export function blankRecurring(overrides = {}) {
  const startDate = overrides.startDate || todayISO();
  return {
    id: overrides.id || newId('rec'),
    companyId: overrides.companyId || null,
    name: overrides.name || '',
    type: overrides.type || 'invoice',
    contactId: overrides.contactId || null,
    frequency: overrides.frequency || 'monthly',
    startDate,
    nextDate: overrides.nextDate || startDate,
    endDate: overrides.endDate || null,
    note: overrides.note || '',
    priceIncludesTax: overrides.priceIncludesTax === true,
    gstRegistered: overrides.gstRegistered !== false,
    lines: (overrides.lines || []).map((l) => blankLine(l)),
    active: overrides.active !== false,
    postedCount: overrides.postedCount || 0,
    lastPostedAt: overrides.lastPostedAt || null,
    lastDocumentId: overrides.lastDocumentId || null,
    skippedCount: overrides.skippedCount || 0,
  };
}

/** One period forward. Month and year steps clamp (31 January plus a month is 28 February). */
export function advance(iso, frequency, steps = 1) {
  switch (frequency) {
    case 'weekly': return addDays(iso, 7 * steps);
    case 'fortnightly': return addDays(iso, 14 * steps);
    case 'monthly': return addMonths(iso, steps);
    case 'quarterly': return addMonths(iso, 3 * steps);
    case 'yearly': return addYears(iso, steps);
    default: throw new Error(`Unknown frequency: ${frequency}`);
  }
}

/** Whether a template should produce something on or before `asOf`. */
export function isDue(template, asOf = todayISO()) {
  if (template.active === false) return false;
  if (!template.nextDate) return false;
  if (template.endDate && compareISO(template.nextDate, template.endDate) > 0) return false;
  return compareISO(template.nextDate, asOf) <= 0;
}

/** Everything due, oldest first, so the most overdue is dealt with first. */
export function dueTemplates(templates, asOf = todayISO()) {
  return templates
    .filter((t) => isDue(t, asOf))
    .sort((a, b) => compareISO(a.nextDate, b.nextDate) || String(a.name).localeCompare(String(b.name)));
}

export function upcomingTemplates(templates, limit = 5, asOf = todayISO()) {
  return templates
    .filter((t) => t.active !== false && t.nextDate && compareISO(t.nextDate, asOf) >= 0)
    .sort((a, b) => compareISO(a.nextDate, b.nextDate))
    .slice(0, limit);
}

/** The draft document a template describes, on the date it was scheduled for. */
export function draftFromTemplate(template, { date = null } = {}) {
  const on = date || template.nextDate || todayISO();
  const doc = blankDocument({
    companyId: template.companyId,
    type: template.type,
    contactId: template.contactId,
    date: on,
    dueDate: on,
    lines: (template.lines || []).map((l) => blankLine(l)),
    priceIncludesTax: template.priceIncludesTax === true,
    gstRegistered: template.gstRegistered !== false,
    notes: template.note,
    status: 'draft',
  });
  // blankDocument builds its record from a fixed list of fields, so provenance is attached
  // afterwards rather than being silently dropped. This is what lets a draft say where it came
  // from when you open it.
  doc.recurringId = template.id;
  doc.recurringName = template.name;
  return doc;
}

/**
 * Create the next draft for a template and move its schedule on by one period.
 * The template keeps its own `nextDate`, so a template that was posted late does not shift.
 */
export function createNext(db, templateId, { date = null } = {}) {
  const template = db.get('recurring', templateId);
  if (!template) throw new Error('That recurring transaction no longer exists.');
  const scheduled = date || template.nextDate;
  const document = draftFromTemplate(template, { date: scheduled });
  db.put('documents', document);
  const updated = db.put('recurring', {
    ...template,
    nextDate: advance(template.nextDate, template.frequency, 1),
    lastPostedAt: todayISO(),
    lastDocumentId: document.id,
    postedCount: (template.postedCount || 0) + 1,
  });
  return { document, template: updated, scheduled };
}

/** Skip one occurrence: move the schedule on without creating anything. */
export function skipNext(db, templateId) {
  const template = db.get('recurring', templateId);
  if (!template) throw new Error('That recurring transaction no longer exists.');
  return db.put('recurring', {
    ...template,
    nextDate: advance(template.nextDate, template.frequency, 1),
    skippedCount: (template.skippedCount || 0) + 1,
  });
}

/** How many periods a template is behind, for a plain-English "you are N behind" line. */
export function overdueCount(template, asOf = todayISO()) {
  if (!isDue(template, asOf)) return 0;
  let count = 0;
  let cursor = template.nextDate;
  // A year is a generous ceiling; a template that far behind is a mistake to fix by hand.
  while (compareISO(cursor, asOf) <= 0 && count < 60) {
    count++;
    cursor = advance(cursor, template.frequency, 1);
  }
  return count;
}
