# Architecture

Rookeepa is deliberately small and deliberately old-fashioned in one respect: it
is a double-entry ledger, and everything else is a view onto it.

## The shape of the thing

```
        document / payment / bank line        (what a human deals with)
                     |
                     v
        buildDocumentEntry / buildPaymentEntry  (app/core/docs.js)
                     |
                     v
        postEntry -> db 'entries'             (the ledger: Dr/Cr lines)
                     |
                     v
   incomeStatement balanceSheet trialBalance generalLedger agedReport
        basSummary cashFlow                       (app/core/reports.js)
                     |
                     v
              app/ui/*.js                     (tables and forms)
```

Nothing stores a balance. Not an invoice, not an account, not a contact. A
balance is always a fold over journal lines, computed on demand. That single
rule is why a display bug cannot corrupt your books, and why "the report is
wrong" always has exactly one place to look.

## Records

| Collection | Holds | Notes |
| --- | --- | --- |
| `companies` | one record per company file | identity, tax label, financial-year start, number prefixes, default accounts |
| `accounts` | chart of accounts | `code`, `name`, `type`, and an optional `control` role |
| `taxCodes` | GST codes | rate in basis points plus which BAS boxes it feeds |
| `contacts` | customers and suppliers | one record can be both |
| `items` | products and services | optional; prices, cost, tax code, income account |
| `documents` | invoices, quotes, credit notes, bills | header + lines + `status`, links to its journal entry |
| `payments` | customer receipts and supplier payments | amount plus allocations to documents |
| `bankTxns` | imported statement lines | signed amounts, reconciliation status, how it was dealt with |
| `entries` | **the ledger** | date, memo, source document, and lines of `{ accountCode, debit, credit, taxCode }` |
| `auditLog` | who did what | append-only |

`control` roles on accounts are what make posting automatic. Instead of
hard-coding `2-1200` as "the GST account", `docs.js` asks the chart for the
account flagged `gstCollected`. Rename or renumber anything you like; the
software finds it by role.

## Money

- Every amount is an **integer number of cents**. No floats, anywhere, in any
  record. Parsing and formatting convert at the edges (`app/core/money.js`).
- **Quantities are integers in thousandths** (`1.5 units` is `1500`), so a
  quantity can be fractional without floating-point drift.
- GST is applied with **integer basis points** and half-up rounding away from
  zero: `mulRate(cents, 1000)` is 10%. The rounding is not the same as
  `Math.round`, which is half-up towards positive infinity and would bias a
  credit note.
- Splitting a GST-inclusive amount (`splitInclusive`) computes the ex-GST part
  and then **derives the tax as the remainder**, so `ex + gst` is always exactly
  the number you started with. A cent can never appear or vanish.

## The posting rules

| Transaction | Debits | Credits |
| --- | --- | --- |
| Sales invoice | Accounts receivable (total incl. GST) | income accounts (ex GST) per line; GST collected per tax code |
| Sales credit note | income accounts; GST collected | Accounts receivable |
| Supplier bill | expense/asset accounts; GST paid | Accounts payable (total incl. GST) |
| Supplier credit | Accounts payable | expense accounts; GST paid |
| Customer receipt | bank | accounts receivable (applied), then accounts receivable again for anything unapplied |
| Supplier payment | accounts payable | bank |
| Spend money | expense net + GST paid | bank |
| Receive money | bank | income net + GST collected |
| Transfer | destination account | source account |
| Opening balances | per your entry | per your entry, difference to the historical balancing account |

Every entry is validated before it is stored: at least two lines, exactly one of
debit/credit non-zero per line, no negative amounts, no fractional cents, and
debits equal to credits. `postEntry` throws with a readable message rather than
saving something that does not balance.

Posting is **idempotent per source document**. Each entry carries
`source: { type, id }`; posting the same invoice again replaces its entry instead
of doubling the books, which is what makes "edit a posted invoice" safe.

## Tax detail travels with the entry

Deriving BAS boxes by guessing which lines look like sales is fragile, so each
entry also carries a `taxSummary` — `[{ taxCode, side: 'sales'|'purchases',
net, gst }]`, negative for credit notes. `basSummary` reads that when it is
present and only falls back to reading tax codes off the lines for hand-written
journals. This is what lets G10 (capital purchases) be reported separately from
G11, and 1A/1B to tie exactly to the GST control accounts.

## Why the balance sheet balances

Rookeepa never posts a year-end closing entry behind your back. So accumulated
profit that has not been closed to retained earnings would otherwise be missing
from equity, and the balance sheet would not balance. It is therefore shown as
its own equity line, "Current year earnings (not yet closed)", computed as the
negation of the signed balance of every profit-and-loss account. Assets equal
liabilities plus equity at every date, and the test suite asserts it at four
different dates.

## Reconciliation as a check, not a claim

The aged receivables report does not just total what it found: it also computes
the debtors control account balance and reports `reconciles` and `difference`. If
the two ever disagree, the screen says so instead of quietly presenting a
plausible number. Opening balances that were entered straight against debtors or
creditors have no document to age, so they are excluded from that comparison and
reported separately, by name, rather than being allowed to create a phantom gap.

## Storage

One blob per collection in IndexedDB, written through on a debounce, with the
whole data set held in memory. Small-business volumes (thousands of documents)
make that a non-issue, and it keeps every query synchronous, which is why the
UI has no loading spinners. Backends fall back to `localStorage` and then memory
so the app still works in a private window — and it tells you when it is not
really saving.

There is no server, no account, no telemetry and no network call at all: the app
runs from static files and never phones home.

## Testing philosophy

`app/core` is pure functions over arrays, so the tests assert accounting rather
than markup:

- every posted entry balances (property-checked across the demo books)
- the trial balance closes to zero
- the balance sheet balances at any date
- P&L equals the movement in the profit-and-loss accounts
- aged receivables and payables reconcile to their control accounts
- BAS 1A and 1B equal the movement on the GST control accounts
- cash flow closes at the sum of the bank accounts
- the general ledger for every account ties to that account's balance

`scripts/smoke.mjs` then drives the real UI in a real browser and re-checks those
invariants against the live database after a human-style workflow.
