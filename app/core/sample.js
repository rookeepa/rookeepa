/**
 * Rookeepa — demo data.
 *
 * `seedDemoCompany` builds a small but complete set of books: opening balances,
 * customers, suppliers, invoices, bills, payments and a bank statement with a
 * few categorised lines. It is what the "Load demo company" button uses and
 * what the test suite posts against, so the numbers you see in the app are the
 * same numbers the tests check.
 */

import { createCompany, setOpeningBalances } from './company.js';
import { toCents } from './money.js';
import { addDays, todayISO, fyStartFor } from './dates.js';
import {
  blankDocument, blankLine, blankPayment, blankBankTxn, authoriseDocument, savePayment,
  categoriseBankTxn, computeDocument, setStatementOpening,
} from './docs.js';

const TERMS = ['net7', 'net14', 'net30'];

function makeContact(db, companyId, data) {
  return db.put('contacts', {
    companyId,
    name: data.name,
    isCustomer: data.customer !== false,
    isSupplier: data.supplier === true,
    email: data.email || '',
    phone: data.phone || '',
    abn: data.abn || '',
    addressLine1: data.address || '',
    city: data.city || '',
    state: data.state || 'NSW',
    postcode: data.postcode || '',
    terms: data.terms || 'net14',
    notes: data.notes || '',
    active: true,
  });
}

function makeItem(db, companyId, data) {
  return db.put('items', {
    companyId,
    code: data.code,
    name: data.name,
    description: data.description || '',
    priceCents: toCents(data.price),
    costCents: toCents(data.cost || 0),
    taxCode: data.taxCode || 'GST',
    accountCode: data.accountCode || '4-0100',
    assetAccountCode: '1-1100',
    trackInventory: data.trackInventory === true,
    qtyOnHand: data.trackInventory ? 40 : null,
    active: true,
  });
}

/** Deterministic-ish demo books. `asOf` defaults to today. */
export function seedDemoCompany(db, opts = {}) {
  const asOf = opts.asOf || todayISO();
  const company = createCompany(db, {
    name: opts.name || 'Harbour & Co (Demo)',
    legalName: opts.name || 'Harbour & Co Pty Ltd',
    abn: '51 824 753 556',
    email: 'hello@harbourco.example',
    phone: '02 5550 1234',
    addressLine1: '12 Wharf Road',
    city: 'Balmain',
    state: 'NSW',
    postcode: '2041',
    gstRegistered: true,
    fyStartMonth: 7,
    defaultTerms: 'net14',
  });
  const companyId = company.id;
  const accounts = db.of('accounts', companyId);

  // A business that started the year with money in the bank and a small loan.
  const fyStart = fyStartFor(asOf, company.fyStartMonth);
  setOpeningBalances(db, companyId, [
    { accountCode: '1-0000', amount: toCents(18450.00) },
    { accountCode: '1-1000', amount: toCents(2310.00) },
    { accountCode: '1-1100', amount: toCents(4120.00) },
    { accountCode: '1-2000', amount: toCents(6800.00) },
    { accountCode: '2-1000', amount: toCents(1980.00) },
    { accountCode: '2-2000', amount: toCents(12000.00) },
    { accountCode: '3-0100', amount: toCents(17700.50) },
    { accountCode: '3-9000', amount: toCents(0) },
  ], addDays(fyStart, 0));

  const customers = [
    { name: 'Balmain Bistro', email: 'accounts@balmainbistro.example', terms: 'net14', abn: '33 004 226 918', address: '88 Darling Street', city: 'Balmain', postcode: '2041' },
    { name: 'Northside Physio', email: 'admin@northsidephysio.example', terms: 'net30', abn: '62 128 747 001', address: '5 Falcon Street', city: 'Crows Nest', postcode: '2065' },
    { name: 'Riverbend Legal', email: 'finance@riverbendlegal.example', terms: 'net14', abn: '18 774 512 638', address: 'Level 3, 240 Pitt Street', city: 'Sydney', postcode: '2000' },
    { name: 'Coastal Yoga Studio', email: 'hello@coastalyoga.example', terms: 'net7', abn: '45 991 220 771', address: '2 Marine Parade', city: 'Manly', postcode: '2095' },
    { name: 'Hillside Cafe', email: 'orders@hillsidecafe.example', terms: 'net30', abn: '77 220 553 118', address: '19 Old Northern Road', city: 'Baulkham Hills', postcode: '2153' },
  ].map((c) => makeContact(db, companyId, c));

  const suppliers = [
    { name: 'Glebe Printing', supplier: true, customer: false, email: 'jobs@glebeprinting.example', terms: 'net14', abn: '29 004 551 220', address: '41 Glebe Point Road', city: 'Glebe', postcode: '2037' },
    { name: 'Metro Office Supplies', supplier: true, customer: false, email: 'sales@metrooffice.example', terms: 'net30', abn: '55 003 998 771', address: '7 Botany Road', city: 'Alexandria', postcode: '2015' },
    { name: 'Southern Cross Freight', supplier: true, customer: false, email: 'invoices@scfreight.example', terms: 'net14', abn: '81 119 004 663', address: '3 Port Drive', city: 'Port Botany', postcode: '2036' },
    { name: 'Ausgrid Business', supplier: true, customer: false, email: 'business@ausgrid.example', terms: 'net14', abn: '78 508 211 731', address: 'GPO Box 4009', city: 'Sydney', postcode: '2001' },
    { name: 'Lane Cove Accountants', supplier: true, customer: false, email: 'office@lcaccountants.example', terms: 'net30', abn: '12 334 887 002', address: 'Suite 4, 61 Longueville Road', city: 'Lane Cove', postcode: '2066' },
  ].map((c) => makeContact(db, companyId, c));

  const items = [
    { code: 'SV-STRAT', name: 'Strategy session', price: '450.00', accountCode: '4-0000', description: 'Half-day consulting session' },
    { code: 'SV-DESIGN', name: 'Design package', price: '1850.00', accountCode: '4-0000', description: 'Brand and collateral design package' },
    { code: 'PR-HANDBOOK', name: 'Printed handbook', price: '39.95', cost: '14.20', accountCode: '4-0100', trackInventory: true, description: 'A5 printed staff handbook' },
    { code: 'PR-SIGNAGE', name: 'Shopfront signage', price: '640.00', cost: '310.00', accountCode: '4-0100', trackInventory: true, description: 'Printed and fitted signage' },
    { code: 'FR-DELIVERY', name: 'Delivery', price: '55.00', accountCode: '4-0200', description: 'Metro delivery' },
  ].map((i) => makeItem(db, companyId, i));

  /* ---- sales invoices across the year so reports have something to show ---- */

  const invoiceSpecs = [
    { contact: 0, days: -96, terms: 'net14', lines: [[0, 2, '450.00', 'GST'], [4, 1, '55.00', 'GST']] },
    { contact: 1, days: -84, terms: 'net30', lines: [[1, 1, '1850.00', 'GST']] },
    { contact: 2, days: -70, terms: 'net14', lines: [[0, 4, '450.00', 'GST'], [2, 10, '39.95', 'GST']] },
    { contact: 3, days: -52, terms: 'net7', lines: [[1, 1, '1850.00', 'GST'], [4, 1, '55.00', 'GST']] },
    { contact: 4, days: -40, terms: 'net30', lines: [[2, 25, '39.95', 'GST']] },
    { contact: 0, days: -27, terms: 'net14', lines: [[3, 1, '640.00', 'GST']] },
    { contact: 1, days: -19, terms: 'net30', lines: [[0, 3, '450.00', 'GST']] },
    { contact: 2, days: -9, terms: 'net14', lines: [[2, 12, '39.95', 'FRE']] },
    { contact: 3, days: -4, terms: 'net7', lines: [[1, 1, '1850.00', 'GST'], [2, 5, '39.95', 'GST']] },
    { contact: 4, days: 0, terms: 'net30', lines: [[0, 1, '450.00', 'GST']] },
  ];

  const invoices = [];
  for (const spec of invoiceSpecs) {
    const date = addDays(asOf, spec.days);
    const doc = blankDocument({
      companyId,
      type: 'invoice',
      contactId: customers[spec.contact].id,
      date,
      dueDate: addDays(date, spec.terms === 'net7' ? 7 : spec.terms === 'net30' ? 30 : 14),
      terms: spec.terms,
      reference: '',
      memo: '',
      lines: spec.lines.map(([itemIdx, qty, price, taxCode]) => blankLine({
        itemId: items[itemIdx].id,
        description: items[itemIdx].name,
        accountCode: items[itemIdx].accountCode,
        qty: Math.round(qty * 1000),
        unitPrice: toCents(price),
        taxCode,
      })),
    });
    invoices.push(authoriseDocument(db, db.put('documents', doc).id));
  }

  /* ---- supplier bills ---- */

  const billSpecs = [
    { contact: 0, days: -92, lines: [[800.00, '6-0000', 'GST']] },
    { contact: 1, days: -76, lines: [[310.00, '6-0700', 'GST']] },
    { contact: 3, days: -64, lines: [[486.20, '6-0300', 'GST']] },
    { contact: 2, days: -47, lines: [[220.00, '5-0100', 'GST']] },
    { contact: 4, days: -33, lines: [[1450.00, '6-1500', 'GST']] },
    { contact: 1, days: -21, lines: [[210.00, '6-0700', 'GST']] },
    { contact: 3, days: -12, lines: [[512.90, '6-0300', 'GST']] },
    { contact: 2, days: -6, lines: [[275.00, '5-0100', 'GST']] },
    { contact: 4, days: -2, lines: [[880.00, '6-1500', 'GST']] },
  ];
  const bills = [];
  for (const spec of billSpecs) {
    const date = addDays(asOf, spec.days);
    const doc = blankDocument({
      companyId,
      type: 'bill',
      contactId: suppliers[spec.contact].id,
      date,
      dueDate: addDays(date, 14),
      terms: 'net14',
      lines: spec.lines.map(([amount, accountCode, taxCode]) => blankLine({
        description: 'Supplier invoice',
        accountCode,
        qty: 1000,
        unitPrice: toCents(amount),
        taxCode,
        priceIncludesTax: false,
      })),
      memo: 'Supplier invoice',
    });
    bills.push(authoriseDocument(db, db.put('documents', doc).id));
  }

  /* ---- rent, wages and a couple of bank items ---- */

  const miscBank = [
    { days: -60, amount: toCents(-2200.00), description: 'Rent — August', category: '6-0800', tax: 'GST' },
    { days: -30, amount: toCents(-2200.00), description: 'Rent — September', category: '6-0800', tax: 'GST' },
    { days: -26, amount: toCents(-3850.00), description: 'Wages run', category: '6-1400', tax: 'N-T' },
    { days: -23, amount: toCents(-124.35), description: 'Bank fees', category: '6-0100', tax: 'FRE' },
    { days: -17, amount: toCents(-342.00), description: 'Cloud subscriptions', category: '6-1600', tax: 'GST' },
    { days: -11, amount: toCents(-689.00), description: 'Fuel and tolls', category: '6-0600', tax: 'GST' },
    { days: -8, amount: toCents(240.00), description: 'Interest received', category: '4-0300', tax: 'FRE' },
    { days: -3, amount: toCents(-180.00), description: 'Cleaning services', category: '6-1900', tax: 'GST' },
  ];
  const bankTxns = [];
  let running = 18450.00;
  for (const spec of miscBank) {
    running += spec.amount / 100;
    const txn = db.put('bankTxns', blankBankTxn({
      companyId,
      accountCode: '1-0000',
      date: addDays(asOf, spec.days),
      description: spec.description,
      amount: spec.amount,
      balance: toCents(running),
      categoryAccount: spec.category,
      taxCode: spec.tax,
      importedFrom: 'demo-data.csv',
    }));
    bankTxns.push(categoriseBankTxn(db, txn));
  }

  /* ---- customer receipts, including one left unapplied on purpose ---- */

  // Everything that moved through the bank gets a statement line, so the demo
  // books can actually be reconciled rather than merely being in balance.
  const statementLine = (fields) => db.put('bankTxns', blankBankTxn({
    companyId,
    accountCode: '1-0000',
    status: 'reconciled',
    importedFrom: 'demo-data.csv',
    ...fields,
  }));

  const receiptSpecs = [
    { doc: 0, days: -88 },
    { doc: 1, days: -74 },
    { doc: 3, days: -45 },
    { doc: 5, days: -20 },
  ];
  for (const spec of receiptSpecs) {
    const doc = invoices[spec.doc];
    const taxCodes = db.of('taxCodes', companyId);
    const total = computeDocument(doc, taxCodes).total;
    const contactName = db.get('contacts', doc.contactId)?.name || '';
    const payment = savePayment(db, blankPayment({
      companyId,
      type: 'customer',
      contactId: doc.contactId,
      date: addDays(asOf, spec.days),
      amount: total,
      accountCode: '1-0000',
      method: 'Bank transfer',
      allocations: [{ docId: doc.id, amount: total, docNumber: doc.number }],
      memo: `Receipt for ${doc.number}`,
    }));
    statementLine({
      date: payment.date,
      description: `DEPOSIT ${contactName}`.toUpperCase(),
      reference: doc.number,
      amount: total,
      type: 'payment',
      contactId: doc.contactId,
      matchedEntryId: payment.journalId,
    });
  }

  // A part payment, to leave a nice "partly paid" row on the aged report.
  {
    const doc = invoices[2];
    const partPayment = savePayment(db, blankPayment({
      companyId,
      type: 'customer',
      contactId: doc.contactId,
      date: addDays(asOf, -14),
      amount: toCents(500.00),
      accountCode: '1-0000',
      method: 'Card',
      allocations: [{ docId: doc.id, amount: toCents(500.00) }],
      memo: 'Part payment',
    }));
    statementLine({
      date: partPayment.date,
      description: 'CARD SETTLEMENT',
      reference: doc.number,
      amount: toCents(500.00),
      type: 'payment',
      contactId: doc.contactId,
      matchedEntryId: partPayment.journalId,
    });
  }

  // Some supplier bills paid, and one prepayment sitting on account.
  for (const idx of [0, 1, 3]) {
    const doc = bills[idx];
    const taxCodes = db.of('taxCodes', companyId);
    const total = computeDocument(doc, taxCodes).total;
    const contactName = db.get('contacts', doc.contactId)?.name || '';
    const payment = savePayment(db, blankPayment({
      companyId,
      type: 'supplier',
      contactId: doc.contactId,
      date: addDays(asOf, -10 + idx * 3),
      amount: total,
      accountCode: '1-0000',
      method: 'Bank transfer',
      allocations: [{ docId: doc.id, amount: total, docNumber: doc.number }],
      memo: `Payment for ${doc.number}`,
    }));
    statementLine({
      date: payment.date,
      description: `BPAY ${contactName}`.toUpperCase(),
      reference: doc.number,
      amount: -total,
      type: 'spend',
      contactId: doc.contactId,
      matchedEntryId: payment.journalId,
    });
  }
  {
    const prepayment = savePayment(db, blankPayment({
      companyId,
      type: 'supplier',
      contactId: suppliers[4].id,
      date: addDays(asOf, -5),
      amount: toCents(300.00),
      accountCode: '1-0000',
      method: 'Bank transfer',
      allocations: [],
      memo: 'Prepayment on account',
    }));
    statementLine({
      date: prepayment.date,
      description: `BPAY ${suppliers[4].name}`.toUpperCase(),
      reference: prepayment.number,
      amount: toCents(-300.00),
      type: 'spend',
      contactId: suppliers[4].id,
      matchedEntryId: prepayment.journalId,
    });
  }

  // The balance the bank statement showed when this company file was started.
  setStatementOpening(db, companyId, '1-0000', toCents(18450.00));

  // A quote the customer has not accepted yet, so drafts are visible too.
  db.put('documents', blankDocument({
    companyId,
    type: 'quote',
    contactId: customers[3].id,
    date: addDays(asOf, -1),
    dueDate: addDays(asOf, 29),
    terms: 'net30',
    lines: [blankLine({ itemId: items[1].id, description: 'Design package — stage 2', accountCode: '4-0000', qty: 1000, unitPrice: toCents(1850.00), taxCode: 'GST' })],
    memo: 'Proposed stage 2 design work',
    status: 'draft',
  }));

  db.notify({ action: 'seedDemo' });
  return company;
}
