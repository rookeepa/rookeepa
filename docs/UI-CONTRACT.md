# Rookeepa UI contract

Everything a view module needs to know. Read this before adding a screen.

## File layout

```
app/index.html           loads app/main.js as a module
app/styles.css           the whole design system (tokens + components)
app/main.js              shell: sidebar, router, context object
app/core/*.js            engine — no DOM, unit-tested (money, db, ledger, docs, reports, csv, backup, sample, company, coa, dates)
app/ui/kit.js            DOM components and form controls
app/ui/print.js          printable documents, plain-text documents, account option lists
app/ui/document-editor.js  invoice / quote / bill / credit note editor
app/ui/payment-modal.js    receive a payment / pay a supplier
app/ui/ui-state.js       preferences and route parsing
app/ui/<view>.js         one module per screen
```

There is **no build step**. Plain ES modules, loaded by the browser, deployed as
static files. Do not add a bundler, npm dependency or framework.

## The view module contract

```js
export const meta = { title: 'Sales', subtitle: 'Invoices, quotes and credit notes' };

/** @param {object} ctx  @returns {Node|Promise<Node>} the screen content */
export async function render(ctx) {
  const el = document.createElement('div');
  // ... build screens with kit helpers, read from ctx.data, write through ctx.db
  return el;
}
```

- `render` may be called again at any time for the same route. It must be
  **idempotent** and must read fresh data from `ctx.data` on every call (never
  cache an array across renders).
- The returned node is appended into `<div class="content">` inside `<main>`.
- Never touch the sidebar, `#overlays`, `#toasts` or `document.body` directly.
- Never write to `ctx.db` and then hand-patch the DOM: write, then call
  `ctx.refresh()` (optionally through a callback after a modal closes).
- Do not import another view module. Shared behaviour goes into kit or core.

## The context object (`ctx`)

| member | what it is |
| --- | --- |
| `ctx.db` | the `DB` (`get`, `all`, `of`, `put`, `putMany`, `remove`, `removeWhere`, `find`, `filter`, `snapshot`, `flush`) |
| `ctx.companyId` | the open company file's id |
| `ctx.company` | the company record (name, abn, currency, taxLabel, fyStartMonth, prefixes, `defaultTerms`, `bankAccount`, `defaultSalesAccount`, `defaultPurchaseAccount`, `perpetualInventory`) |
| `ctx.data.accounts` | `[{ code, name, type, control, gstDefault, active }]` |
| `ctx.data.taxCodes` | `[{ code, name, gstBps, reportable, bas, description }]` |
| `ctx.data.contacts` | `[{ id, name, isCustomer, isSupplier, email, phone, abn, addressLine1, city, state, postcode, terms, notes, active }]` |
| `ctx.data.items` | `[{ id, code, name, description, priceCents, costCents, taxCode, accountCode, trackInventory, qtyOnHand, active }]` |
| `ctx.data.documents` | invoices, bills, quotes, credit notes (see below) |
| `ctx.data.payments` | `[{ id, type: 'customer'\|'supplier', contactId, date, amount, accountCode, method, reference, number, allocations: [{ docId, amount }], journalId, status }]` |
| `ctx.data.entries` | posted journal entries (read-only in views; write through core helpers) |
| `ctx.data.bankTxns` | imported/categorised bank lines |
| `ctx.data.recurring` | recurring transaction schedules (see `core/recurring.js`) |
| `ctx.data.auditLog` | who did what, when |
| `ctx.db.meta` | per-company settings that are not transactions: `statementOpening`, `bankRules`. Included in a backup; scoped per company |
| `ctx.asOf` / `ctx.setAsOf(iso)` | the working date used for "as at" figures |
| `ctx.navigate(hash)` | go to an exact hash |
| `ctx.go(view, segments?, query?)` | build and go to a hash |
| `ctx.refresh()` | re-render the current route (call after a write) |
| `ctx.toast(message, kind, { detail, actionLabel, onAction, duration })` | kinds: `success`, `error`, `warn`, `info` |
| `ctx.modal({ title, subtitle, body, actions, width })` | see kit |
| `ctx.confirm({ title, message, confirmLabel, danger, detail })` | resolves `true`/`false` |
| `ctx.field`, `ctx.input`, `ctx.card`, `ctx.emptyState`, `ctx.kit` | shortcuts into kit |
| `ctx.fmt` | `money(cents, {code,parens,symbol:false})`, `plain`, `raw`, `qty(milli)`, `date(iso, style)`, `percent` |

## Money and quantities

- **Every amount in a record is an integer number of cents.** Never store a float.
- Quantities are integers in **thousandths** (`1.5` → `1500`).
- Use `moneyInput({ value: cents, onChange: (cents) => … })` and
  `qtyInput({ value: milli, onChange: (milli) => … })` for anything the user types.
- Render money with `moneyCell(cents)` / `ctx.fmt.money(cents)`, never with
  `.toFixed()`.

## Document records

```js
{
  id, companyId, type: 'invoice'|'quote'|'credit-note-sale'|'bill'|'credit-note-purchase',
  ledger: 'sales'|'purchases', contactId, number: 'INV-0001', date: 'YYYY-MM-DD',
  dueDate, terms, reference, poNumber, memo, notes, priceIncludesTax,
  lines: [{ id, itemId, description, accountCode, qty, unitPrice, discountPct, taxCode }],
  status: 'draft'|'open'|'void', journalId, journalNumber, sentAt
}
```

Derived values come from core, never from a stored field:

```js
import { computeDocument, documentSummary, authorisedOnly } from '../core/docs.js';
const summary = documentSummary(doc, ctx.data.taxCodes, ctx.data.payments, ctx.asOf);
// { rows, subtotal, tax, total, freight, taxBreakdown, paid, balance, status, overdueDays }
```

`status` values to display: `draft`, `open`, `paid`, `partly-paid`, `overdue`, `void`.
Use `statusBadge(status)` from kit.

## Writing to the books

Views must go through these core functions so the ledger stays consistent:

| task | call |
| --- | --- |
| create/edit/authorise a document | `openDocumentEditor(ctx, { type, docId, onSaved })` |
| receive money / pay a supplier | `openPaymentModal(ctx, { type, contactId, docId, amount, onSaved })` |
| generic journal | `postEntry(ctx.db, { date, memo, lines: [dr(code, cents), cr(code, cents)], source })` |
| void an entry | `voidEntry(ctx.db, id, reason)` |
| check the books | `trialBalance`, `balanceSheet`, `incomeStatement`, `agedReport`, `basSummary`, `cashFlow` from `../core/reports.js` |

Never `ctx.db.put('entries', …)` directly — always `postEntry`, which validates
that debits equal credits before anything is saved.

## Kit components (import from `./kit.js`)

`h`, `clear`, `append`, `frag`, `icon`, `ICONS`, `card`, `pageHeader`, `button`,
`iconButton`, `buttonGroup`, `table`, `moneyCell`, `badge`, `statusBadge`,
`field`, `input`, `textarea`, `select`, `moneyInput`, `qtyInput`, `dateInput`,
`checkbox`, `radioGroup`, `segmented`, `tabs`, `toolbar`, `emptyState`, `banner`,
`kpi`, `kv`, `sectionTitle`, `modal`, `closeAllModals`, `confirmDialog`,
`promptDialog`, `toast`, `csvButton`, `paginate`, `pager`, `printNode`, `fmt`,
`fiscalYearOptions`, `monthOptions`, `avatar`, `initials`, `link`, `progressBar`,
`barChart`, `sortBy`, `sumField`, `grid helpers via CSS classes`.

## Style rules

- Compose screens from `card`, `table`, `kpi`, `toolbar`, `pageHeader`, `tabs` —
  do not hand-roll new visual patterns, and do not add CSS files.
- Use the CSS variables (`var(--text-muted)`, `var(--negative)`, …) if you must
  inline a style. Never hard-code a colour.
- Numbers right-aligned with `align: 'right'` and `moneyCell`.
- Dates display through `ctx.fmt.date(iso)` (`d MMM yyyy`); storage is ISO.
- Empty states: `emptyState({ title, message, action })` — never a bare table
  with no rows and no explanation.
- Every destructive action confirms first (`ctx.confirm`), and voids rather than
  deletes once something is posted.
- Keyboard: Escape closes modals (kit does this); Enter in the last field of a
  form should submit where it obviously should.
- Plain, specific copy. No exclamation marks, no marketing voice, no emoji.

## Accessibility

- Interactive `div`s are not allowed: use `button`/`a` (kit already does).
- Every input has a label (use `field({ label, input })`).
- Tables get column labels; icon-only buttons get an `aria-label` (kit does this
  through the `label` option).
- Keep contrast: use the tokens, not invented colours.

## Testing a view module

```bash
node --input-type=module -e "import('./app/ui/sales.js').then(m => console.log(Object.keys(m)))"
```

Modules must have **no top-level side effects** (no DOM access at import time),
so that this smoke test passes and so views can be loaded lazily.
