# Rookeepa

**Free, open-source, local-first bookkeeping for small business — the everyday accounting that subscription software charges you for every month.**

**Live: [rookeepa.com.au](https://rookeepa.com.au)** · [the app](https://rookeepa.com.au/app/) · source below

[What it does and does not do](./faq.html) · [Sharing your books with an accountant](./docs/SHARING-WITH-AN-ACCOUNTANT.md)

Rookeepa does invoices, bills, contacts, bank reconciliation, GST and financial
reports, and it runs entirely in your browser. There is no server, no account, no
subscription, and no data leaving your computer. Open the page, keep your books,
back them up to a file you own.

It exists for the business that needs **real double-entry books and a GST
summary** — not another monthly fee. Invoices, bills, bank reconciliation, jobs,
attachments, recurring entries and ten reports, on one page, with no server behind
it.

```
No build step. No npm dependencies. No telemetry. No account. MIT licensed.
```

---

## Three ways to use it

**1. Just use it.** Open <https://rookeepa.com.au/>. That address is
the front page; its **Open Rookeepa** button leads to the app itself, which lives
at <https://rookeepa.com.au/app/>. There is nothing to install, and
the app keeps working offline once loaded.

**2. Get your own copy on your own GitHub account.** Click **Use this template**
on the repository page (or fork it), then in your new repository go to
**Settings → Pages** and set *Source* to **GitHub Actions**. That is the whole
setup — the included workflow publishes the app for you on every push. Your books
are still yours; this only decides where the app is served from.

**3. Run it locally.**

```bash
git clone https://github.com/rookeepa/rookeepa.git
cd rookeepa
python3 -m http.server 5173      # or: npx serve -l 5173 .
# front page: http://127.0.0.1:5173/     app: http://127.0.0.1:5173/app/
```

Then click **Explore with demo data** to see a full year of books, or **Create my
company file** to start your own. [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)
takes you from an empty company file to your first reports in about half an hour,
including the part most software makes hard: opening balances.

> ES modules have to be served over HTTP, so opening `app/index.html` from the
> file system will not work. Any static server will do, and GitHub Pages needs no
> configuration beyond the workflow already in this repository.

Publishing your own copy from the command line is one command:

```bash
brew install gh && gh auth login   # once
npm run publish:github             # or: ./scripts/publish.sh your-org/your-repo
```

---

## What it does

**Sales**
- Tax invoices with line items, quantities, per-line discounts, GST-inclusive or
  GST-exclusive pricing and per-line tax codes
- GST, GST-free, export, input-taxed, capital-purchase and not-reportable tax
  codes, mapped to the Activity Statement boxes
- Quotes, credit notes, payment terms (net 7/14/30/45/60, end of month)
- Customer receipts with allocations across invoices, part payments, and money
  left on account
- Printable tax invoices, or copy the whole invoice as plain text for an email
- Statements of account: a printable statement for any customer over a date
  range, showing the opening balance, every invoice and receipt, and what is
  still owed
- Recurring transactions: a schedule of invoices or bills you raise again
  (weekly through yearly), which creates drafts for you to check and authorise

**Purchases**
- Supplier bills and supplier credits, authorised into the ledger the same way
- Payments to suppliers, including prepayments sitting on the supplier's account

**Money and bank**
- Bank statement import from CSV exports — any delimiter, DD/MM/YYYY or ISO
  dates, signed amounts or separate debit/credit columns, and a preview with the
  rows it could not read before anything is imported
- Categorise a bank line to an account and tax code, or match it to a
  transaction already in the books
- Bank rules: your own "if the description contains this, use this account and
  tax code" rules, applied to imported lines and to everything unreconciled
- Transfers between accounts, spend money / receive money
- Per-account reconciliation: what the books say against what the bank says, with
  the difference spelled out and a statement opening balance you control

**Books**
- Full chart of accounts seeded with an Australian default, using the
  six-series `1-xxxx`…`6-xxxx` numbering convention, and fully editable
- A real double-entry journal. Invoices, bills, payments and bank lines all
  resolve to journal entries you can read, and every report is computed from
  those lines — there are no shadow balances anywhere
- Opening balances with a historical balancing account, exactly as a desktop
  package handles a trial balance that does not close by itself
- Void rather than delete: nothing that touched the ledger ever disappears
- An audit log of what changed and when

**Reports**
- Profit & loss (with a comparison period, a by-month view, and a cash-basis
  switch that recognises income and expenses when money moved)
- Balance sheet, with an unclosed-profit line so assets always equal
  liabilities plus equity
- Trial balance (opening / debit / credit / closing)
- General ledger per account with a running balance, and the full journal
- Aged receivables and aged payables (current, 1–30, 31–60, 61–90, 90+)
- GST / Activity Statement summary (G1, G2, G3, G10, G11, 1A, 1B) with a
  per-tax-code breakdown
- Cash flow, with an operating/investing/financing split
- CSV export and print on every report

---

## Your data

- **Local-first.** Books live in this browser's IndexedDB. Nothing is uploaded,
  and there is no server to upload to. No analytics, no cookies, and no network
  calls at runtime at all.
- **Yours to hold.** *Settings → Backup* exports the whole company file as one
  JSON file. Restore it on another machine, keep it in Dropbox, on a USB stick,
  or in a private git repository.
- **It asks the browser to keep the data.** On every start Rookeepa calls
  `navigator.storage.persist()` — a request that the browser not treat the file
  as disposable. If the browser agrees, the sidebar says *Saved in this browser ·
  storage kept*. It is a request, not a setting: browsers decide using their own
  criteria, and they are likelier to agree once the site is bookmarked or
  installed. If it is refused, the backup is not a nicety — it is the only copy
  that survives.
- **The dashboard tells you when a backup is overdue.** No backup ever, or none
  in the last seven days, puts a line on the dashboard with a button to download
  one. It disappears once you have taken one.
- **Beware the browser.** Clearing site data, a private window with storage
  disabled, or a browser profile reset will take your books with it. Safari in
  particular deletes a site's storage after seven days without a visit, which is
  why the persistent-storage request and the backup reminder both matter.
  Rookeepa tells you in the sidebar when it cannot save. That is the price of
  having no vendor holding your data — and the backup is the same file you would
  hand your accountant.
- **Nothing writes to your disk unless you ask it to.** Every copy outside the browser
  is a deliberate click — the books backup, the attachments export, the CSVs — *except*
  when you turn on Automatic backup (Settings), which saves your books and your
  attachments into a folder you choose, on a timer you choose. That one has two limits
  worth knowing before you rely on it. **It works in Chrome and Edge on a desktop
  only**: Safari and Firefox have no API for writing to a folder, so there the card says
  so and the exports are the answer. And **it only runs while Rookeepa is open** — a
  browser page cannot write to your disk in the background, and this app has no server
  to do it for you, so a save that came due while the browser was shut happens next
  time. Wherever you are, treat a backup as a chore with a rhythm.
- **CSV out, always.** Accounts, contacts, documents and every journal line
  export to CSV.
- **One browser at a time.** There is no sync. If you work on two machines,
  export and restore, or keep the books on one machine. Putting the backup file
  in a folder that Dropbox, OneDrive or Google Drive already syncs is the
  closest thing to sync today — it is still a manual export on each machine, and
  two devices editing the same company file will simply overwrite each other.

### Working with an accountant

There is no shared login and no guest access, because there are no accounts and
no server. In practice it works like this:

1. *Settings → Backup*, and send the JSON file. It is the whole company file:
   every invoice, every journal line, every setting. Email or a shared folder is
   fine.
2. Send them the app, too — a link to the site, or the repository if they would
   rather run their own copy. They open it, choose *Restore from a backup*,
   and can read every report, the general ledger and the BAS summary.
3. Anything they change is in *their* copy. If they hand it back, you restore it
   as a replacement, or use *merge new records only* to bring their entries in
   alongside yours — read that option's note, because merging assumes the two
   files were not edited independently.

For a bookkeeper running several sets of books, each company file is separate,
and one backup file per client is the unit of exchange.

### How big can it get?

Reports derive everything from the journal, so they stay flat: the profit and
loss, balance sheet, trial balance, BAS summary and general ledger take a few
milliseconds even at 20,000 transactions. The dashboard and the aged reports are
the ones that have to ask "is this invoice paid?" of every invoice, and they
used to compare every invoice with every receipt — 2.2 seconds on a 10,000
document file. Receipts are now indexed once per report instead, which took that
to about 35 ms, growing with the number of documents rather than the square of
it. `npm run bench` measures a file of any size on your own machine if you want
to see where your books sit.

Two limits are real and worth knowing: saving after an edit rewrites whole
collections, so a very large file pauses briefly on each save; and if the
browser's storage for this site fills up completely, the app has been seen to
open a blank page rather than explain itself. Neither is a design decision — both
are on the list to fix.

## What it deliberately does not do

| Not included | Why |
| --- | --- |
| ATO / SBR lodgement, BAS submission | Lodgement is regulated and needs credentials and accreditation. Rookeepa does the arithmetic; you or your accountant lodge. |
| Single Touch Payroll, payroll reporting | STP is a lodgement obligation. Rookeepa can record wages and PAYG liabilities, but it does not file them. |
| Multi-user, cloud sync | Adding sync means adding a server, accounts and trust. Out of scope for the free local-first version. |
| Bank feeds over an API | Those need a commercial data-aggregator agreement. CSV import works with every bank and costs nothing. |
| Being tax advice | It cannot be. Have your books reviewed by an accountant. |

---

## Independence and licensing

Rookeepa is an independent, original work, and it is deliberately boring about
intellectual property:

- **No third-party code, fonts or artwork.** There are no dependencies at all.
  Every line of JavaScript, CSS and SVG here is part of this repository. The app
  uses the system font stack, so no font licence is involved, and the icons are
  hand-written SVG paths.
- **Not affiliated with anyone.** Rookeepa is not connected to, endorsed by,
  sponsored by, or derived from any other accounting or bookkeeping product, and
  this repository contains no code, text, artwork or data taken from one.
- **Conventions are not property.** Account codes and groupings, the shape of a
  profit & loss statement or a balance sheet, double-entry bookkeeping itself,
  and the Activity Statement box labels (G1, 1A, 1B, G10, G11 — published by the
  Australian Taxation Office) are standard practice and public facts rather than
  any vendor's intellectual property.
- **Nothing here claims anyone's trademark.** If you plan to build a commercial
  product on this code, have a lawyer check your own branding and any comparative
  advertising before you launch.
- **MIT licensed** — use it, change it, build a business on it. See
  [LICENSE](LICENSE), which also records the no-third-party-code and
  non-affiliation position.

## Testing

```bash
npm test                      # 81 unit tests: money, GST, ledger, posting, reports, company files
node scripts/smoke.mjs        # 52 end-to-end checks in headless Chrome (needs the app served)
```

The unit suite proves the accounting rather than the pixels: every posted entry
balances, the trial balance closes to zero, the balance sheet balances at any
date, profit and loss equals the movement in the profit and loss accounts, aged
receivables and payables reconcile to their control accounts, the Activity
Statement ties to the GST control accounts, and cash flow closes at the sum of
the bank accounts.

`scripts/smoke.mjs` drives the real UI in a real browser: it creates a company,
walks every screen looking for console errors, raises an invoice through the
form, and then checks the books with the app's own reporting engine. It needs
Chrome and a static server, and it writes screenshots to `.smoke/`. It works at
any base path — including the `/rookeepa/app/` path GitHub Pages serves the app
from:

```bash
python3 -m http.server 5173 &
node scripts/smoke.mjs --shots /tmp/rookeepa-shots     # defaults to /app/
```

## Architecture

```
index.html          the front page — static, no JavaScript, no dependencies
app/index.html      the app shell; with app/styles.css and app/main.js
app/main.js         shell, hash router, context object
app/core/           the engine — no DOM, unit-tested
  money.js          integer-cent arithmetic, GST rounding, formatting
  dates.js          ISO dates, Australian financial years
  coa.js            default chart of accounts, tax codes, control roles
  db.js             IndexedDB (with localStorage/memory fallbacks) + change events
  ledger.js         double-entry posting, validation, balances, voiding
  docs.js           invoices/bills/credit notes/payments/bank → journal entries
  reports.js        P&L, balance sheet, trial balance, GL, aging, BAS, cash flow
  csv.js            forgiving CSV parsing and bank statement detection
  backup.js         export, restore, CSV exports
  sample.js         demo company with a year of books
app/ui/             one module per screen, built from kit.js
```

Two documents matter if you want to work on this:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the data model, why every
  report is derived from journal lines, and the invariants the engine keeps.
- **[docs/UI-CONTRACT.md](docs/UI-CONTRACT.md)** — the context object, the kit
  components, and the rules a new screen must follow.

Key design decisions:

1. **Money is never a float.** Every amount is an integer number of cents;
   quantities are thousandths of a unit. GST uses integer basis points with
   half-up rounding in integer space, so a document's parts always add back to
   its total.
2. **The journal is the only source of truth.** An invoice is a friendly way of
   writing a journal entry. Reports read journal lines and nothing else, so a
   display bug can never corrupt a balance.
3. **The engine is pure.** `app/core/*` takes arrays and returns objects; no DOM,
   no globals, no I/O. That is why the accounting is testable.
4. **Persistence is a whole-collection blob per table**, written through to
   IndexedDB on a debounce. Small-business volumes are tiny, so queries stay
   synchronous and the UI stays instant.

## Contributing

Issues and pull requests are welcome. Read
[docs/UI-CONTRACT.md](docs/UI-CONTRACT.md) before adding a screen, keep the core
free of DOM code, and make sure `npm test` passes. See
[CONTRIBUTING.md](CONTRIBUTING.md).

Useful things to pick up:

- Attaching files to a **document** (an invoice or a bill), not only to a bank line — the
  store and the backup handling already take documents
- Multi-currency invoices and realised/unrealised FX
- Recurring invoices and bills
- Quote → invoice conversion
- Budgets and a budget-vs-actual report
- New Zealand GST and other jurisdictions' tax codes
- Inventory: average cost, stock adjustments, a stock movement report
- Optional self-hosted sync (a folder of JSON files, no accounts)
- Importers for common contact/item exports (CSV from wherever you are coming
  from) to shorten the move

## License

[MIT](LICENSE). Do what you like with it — including running your business on it.

Rookeepa is bookkeeping software, not accounting or tax advice, and it is not
connected to the ATO or any other revenue authority. Check your figures with a
registered accountant or tax agent before you rely on them.
