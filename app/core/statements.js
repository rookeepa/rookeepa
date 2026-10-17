/**
 * Rookeepa — statements of account.
 *
 * A statement of account is one contact's account told as a story: every invoice
 * raised, every credit note and every receipt, in date order, with the balance
 * carried forward line by line. It is the document you send a customer who asks
 * "what do we owe you, and why?".
 *
 * What a statement shows — and what it deliberately does not:
 *   - It is a record of the account, not a demand for payment. It shows the
 *     movement between two dates plus the balance that was already there before
 *     them, so "as at 30 June" and "for July" tell a customer different, useful
 *     things.
 *   - Every amount is taken from the same sources the ledger is. A document's
 *     amount is its tax-inclusive total (computeDocument); a receipt moves the
 *     account only by what it actually allocates to this contact's documents
 *     (allocatedTo). Nothing is re-derived here, so a statement can never
 *     disagree with the receivables report.
 *   - It is the sales side of a contact's account only: the invoices you raised
 *     and the money they paid. A bill they sent you is not part of their
 *     statement, so only sales-ledger documents are read.
 */

import { computeDocument, allocatedTo, isSales } from './docs.js';
import { sum } from './money.js';

/** A signed movement: positive grows what the customer owes, negative shrinks it. */
function movementOf(entry) {
  return (entry.debit || 0) - (entry.credit || 0);
}

function documentDescription(doc) {
  return doc.memo || doc.reference || '';
}

function receiptDescription(payment) {
  return payment.memo || payment.reference || payment.method || '';
}

/**
 * Build a statement of account for one contact.
 *
 * @returns {{
 *   contactId: string, from: string|null, to: string|null,
 *   opening: number,
 *   lines: Array<{ date, kind, number, description, debit, credit, balance }>,
 *   totals: { debit: number, credit: number },
 *   closing: number,
 *   totalDue: number,
 * }}
 */
export function statementFor({
  documents = [], payments = [], contactId, from = null, to = null, taxCodes = [], contact = null,
}) {
  // Only this contact's own sales documents, and never a voided one: voiding a
  // document reverses its effect on the ledger, so it must not reappear here.
  const salesDocs = documents.filter((d) => d.contactId === contactId && d.status !== 'void' && isSales(d.type));

  // Only money received from this contact, and never a reversed receipt. A
  // refund is a "customer" payment with a negative amount and negative
  // allocations, so it is still read — at its signed amount, below.
  const receipts = payments.filter((p) => p.contactId === contactId && p.type === 'customer' && p.status !== 'void');

  const ledger = [];

  for (const doc of salesDocs) {
    // A document's effect on the account is its tax-inclusive total — the same
    // figure the customer was invoiced and the ledger holds.
    const total = computeDocument(doc, taxCodes).total;
    const isCreditNote = doc.type.startsWith('credit-note');
    ledger.push({
      date: doc.date,
      // A credit note is the mirror of an invoice, so it credits the account.
      kind: isCreditNote ? 'credit-note' : 'invoice',
      number: doc.number || '',
      description: documentDescription(doc),
      debit: isCreditNote ? 0 : total,
      credit: isCreditNote ? total : 0,
    });
  }

  for (const payment of receipts) {
    // A receipt moves the balance by what it actually allocates to this
    // contact's documents — never its face value. Reading it through
    // allocatedTo() keeps the void and "as at" rules in one place, so a reversed
    // or later-dated receipt can never be counted here on one rule and there on
    // another.
    //
    // A receipt that is applied to no document is money on account: the customer
    // has paid, but no invoice has been settled. It is deliberately NOT applied
    // to a document — which debt a payment settles is the user's decision, and
    // this app refuses to guess — so it moves nothing on the statement. It shows
    // as a credit on the account only once someone allocates it.
    let applied = 0;
    for (const doc of salesDocs) applied += allocatedTo([payment], doc.id);
    if (applied === 0) continue;

    // An ordinary receipt credits the account. A refund is a negative allocation
    // on a negative receipt, so its "applied" comes back negative and it is a
    // debit — the exact mirror of the payment it reverses.
    ledger.push({
      date: payment.date,
      kind: 'receipt',
      number: payment.number || '',
      description: receiptDescription(payment),
      debit: applied < 0 ? -applied : 0,
      credit: applied > 0 ? applied : 0,
    });
  }

  // Date order, and within a date by document/receipt number, so the same
  // movement always reads the same way on every statement.
  ledger.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.number.localeCompare(b.number));

  // The balance already on the account before the range opens...
  const opening = sum(ledger.filter((e) => from && e.date < from).map(movementOf));

  // ...then every movement inside the range, running the balance forward.
  let balance = opening;
  const inRange = ledger.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
  const lines = inRange.map((e) => {
    balance += movementOf(e);
    return { ...e, balance };
  });

  const totals = {
    debit: sum(inRange.map((e) => e.debit || 0)),
    credit: sum(inRange.map((e) => e.credit || 0)),
  };

  // Closing is built by running the balance forward from the opening, so it is
  // always exactly opening plus the movement — the two cannot disagree.
  const closing = balance;

  // What is still owed does not depend on the range: it is the whole account, so
  // a statement of the last month still tells the customer their true balance.
  const totalDue = sum(ledger.map(movementOf));

  return { contactId, from, to, opening, lines, totals, closing, totalDue };
}
