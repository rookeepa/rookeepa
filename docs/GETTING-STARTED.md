# Getting started with Rookeepa

From an empty company file to your first reports, in about half an hour. Written
for someone who is comfortable with their business but not necessarily with
accounting software.

Rookeepa has no sign-up, no email confirmation and no onboarding survey. You
create a company file, and it is yours immediately.

---

## Before you start: five things to have handy

1. **Your business name and ABN** (they print on your invoices).
2. **The date your financial year starts.** In Australia and New Zealand that is
   1 July. For a new business it is the day you started trading.
3. **Whether you are registered for GST.** If you are not, Rookeepa still works;
   documents simply carry no GST.
4. **Your bank balance and your loan balances** as at the start date above. This
   is your opening position.
5. **A CSV export of a recent bank statement** (most banks call it "export" or
   "download transactions"). Keep it for step 9.

Then open the app — <https://rookeepa.com.au/app/> or your own copy — and
click **Explore with demo data** if you want to poke at a full set of books first.
The demo is a separate company file and you can delete it whenever you like.

---

## Step 1 — Create your company file

Click **Create my company file** and enter the business name and, if you like,
your ABN and financial year start.

Rookeepa immediately seeds a full chart of accounts (assets, liabilities, equity,
income, cost of sales, expenses) with the six-series `1-xxxx` … `6-xxxx`
numbering convention, plus the standard Australian GST tax codes. Nothing is
locked: rename, renumber, add and deactivate accounts as you please. The one
thing that matters is that some account keeps each *control role* — the flags that
make posting automatic:

| Control role | What it does |
| --- | --- |
| Bank | The account money moves through. You can have several. |
| Debtors control | Where unpaid invoices sit until they are paid. |
| Creditors control | Where unpaid bills sit until they are paid. |
| GST collected / GST paid | Where GST lands; the GST summary reads these. |
| Inventory | Where stock value sits, if you track inventory. |
| Historical balancing | Absorbs the imbalance in your opening balances. |
| Retained earnings | Prior years' profit, once you close a year. |

## Step 2 — Fill in your business details

**Settings → Business details**: legal name, ABN, address, email, phone, currency,
GST registration, financial year start, the prefixes for your document numbers
(`INV-`, `BILL-`), your default payment terms, your default sales and purchase
accounts, and the footer you want on every invoice.

## Step 3 — Check the tax codes

**Settings → Tax codes** lists them. The two you will use constantly are:

- **GST** — standard 10% GST on sales and purchases.
- **N-T** ("not reportable") — wages, bank transfers, drawings, anything that
  never appears on a BAS.

The others (**FRE**, **EXP**, **ITS**, **CAP**) exist because the Activity
Statement reports GST-free sales, export sales, input-taxed sales and capital
purchases in different boxes. If you are unsure which to use on a line, ask your
accountant — using N-T where GST belongs is the most common way a GST summary
ends up wrong.

## Step 4 — Enter your opening balances

**Accounts → Opening balances.** This is the step most software makes painful, so
here is what it means and the easy way through it.

You tell Rookeepa what you owned and owed on day one:

- Bank and cash accounts: the balance in each.
- Accounts receivable: the total your customers owed you (or skip it and raise
  the invoices properly — see the note below).
- Inventory: the value of stock on hand at cost.
- Equipment, vehicles, furniture: what you paid for them.
- Accounts payable: the total you owed suppliers.
- Loans and credit cards: what you owed.
- Owner's equity / capital: your stake in the business.

Rookeepa does not make you balance it. Whatever the difference is goes to the
**Historical Balancing Account**, which is exactly what a desktop accounting
package does with a trial balance that does not close by itself. Enter what you
know, save, then look at the balance sheet: if the balancing account holds a
figure you do not like, adjust the equity figure until it reaches zero.

**A practical shortcut.** If you are moving mid-year from another system, enter
the *smallest* set of balances that tells the truth: your bank, your debts, your
loans, and equity to absorb the rest. Then raise the unpaid invoices and bills as
real documents (backdated to their true dates) so they can be aged and paid
properly. Estimates in opening balances are fine; the number that matters is the
one that will eventually reconcile to your bank.

Opening balances can be edited: saving again **replaces** your opening entry
rather than adding to it, so you can iterate without corrupting anything.

## Step 5 — Set your bank statement opening balance

**Banking → Statement opening.** Enter the balance the bank statement showed
before the first transaction you are going to record. This number only makes the
reconciliation comparison meaningful; it is never posted to the ledger.

If you enter opening balances and skip this, your bank card will say the account
does not reconcile — because the books have a starting balance the statement does
not, yet.

## Step 6 — Add your customers and suppliers

**Contacts → New customer / New supplier.** Name, email, ABN, address, and default
payment terms (a name can be both a customer and a supplier).

You do not need to add everyone on day one. You can also create a contact from
inside an invoice when you realise they are missing.

## Step 7 — Add items (optional)

**Items** is for things you sell or buy repeatedly: a service, a product, a
delivery charge. Each one carries its own price, tax code and income account, so
raising an invoice becomes picking items and quantities.

Skip it if you mostly invoice bespoke amounts. Typing a description and a price
straight onto the invoice works perfectly well.

## Step 8 — Raise your first invoice

**Sales → New invoice.** Choose the customer, set the date and terms, then add
lines:

1. Pick an item or type a description.
2. Choose the **account** the income belongs to.
3. Quantity, unit price, discount if any, and the **tax code**.
4. Press **Show the journal entry** to see exactly what will be posted — debits,
   credits and all. Nothing has been saved at this point.

Then **Authorise invoice**. At that moment Rookeepa assigns the number, posts the
journal entry and the invoice becomes part of your books. Print it, or **Copy as
text** to paste into an email.

When the money arrives: **Receive payment**. Pick the customer, check the amount,
press **Auto-allocate oldest first**, and the invoice is marked paid while
anything left over sits as a credit on their account.

*Draft vs authorised:* a draft is not in the books and changes no balances. An
authorised invoice is in the books and is voided (never deleted) if it was wrong.

## Step 9 — Enter your bills

**Purchases → Enter bill.** Same idea, opposite direction: choose the supplier,
the expense or asset account, the amount and the tax code. When you pay it:
**Pay a supplier**.

## Step 10 — Import a bank statement and reconcile

**Banking → Import statement.** Choose your CSV. Rookeepa shows a preview: the
rows it read, the column meanings it detected, and a count of rows it could not
read with the reason, plus any probable duplicates. Nothing is imported until you
say so.

Then work down the **review** list. Each line gets one of four treatments:

- **Categorise** — it belongs to an expense or income account. Pick the account,
  the tax code, and a contact. Rookeepa posts a Spend money or Receive money
  entry and shows you the journal it will write.
- **Match** — it is a transaction already in the books (a customer paid an
  invoice, say). Rookeepa suggests candidates with the same amount and a close
  date; matching ties the bank line to that entry.
- **Create payment** — it is a receipt or a payment that needs allocating across
  invoices or bills.
- **Exclude** — it is not yours to book (a transfer between your own accounts,
  say). It stays visible, marked as excluded.

The reconciliation card tells you the two numbers that matter: the **ledger
balance** (what the books say) and the **cleared statement balance** (statement
opening plus every line you have ticked off). When they agree, the account
reconciles. If they do not, the difference is the work left to do.

## Step 11 — Read your reports

**Reports** has ten of them. Start with three:

- **Profit & loss** for the period — did you make money?
- **Balance sheet** as at today — what you own and owe. Assets always equal
  liabilities plus equity; if that ever fails, something is badly wrong, and the
  screen will tell you loudly.
- **GST / activity statement** — the arithmetic for your BAS: total sales, GST on
  sales (1A), GST on purchases (1B) and the net figure.

Also worth knowing:

- **Aged receivables / payables** — who owes you, who you owe, and how late. Each
  one shows whether its total reconciles to the control account, so a mismatch
  cannot hide.
- **Trial balance** — every account's opening, movement and closing. It must
  close to zero. This is your accountant's favourite screen.
- **General ledger** — the story of one account, movement by movement.
- **Journal** — every posted line, if you want to see everything at once.

Every report prints and exports to CSV.

---

## The ongoing routine

**Weekly (10 minutes):** import the bank statement, categorise the lines, send any
overdue invoices a nudge (Sales shows them at the top).

**Monthly (20 minutes):** reconcile every bank account to zero difference, check
aged receivables and aged payables look sane, glance at the P&L against last
month, and — most importantly — **export a backup**.

**Quarterly:** BAS from the GST report; check the GST control accounts agree with
the statement of what you have collected and paid.

**Year end:** give your accountant the backup file, or the trial balance and the reports they ask for. Rookeepa does not close your year for you; if you want to
tidy up, post a journal moving the profit and loss accounts to Retained Earnings.

## Backups, seriously

There is no server, so there is nobody else holding a copy. **Settings → Backup**
produces one JSON file containing everything. Put it somewhere that is not the
same laptop: a synced folder, an external drive, a private git repository, your
accountant's inbox.

Do it after any session where you did real work. The sidebar tells you what
Rookeepa is saving to: if it ever says it is *not* saving (a private window with
storage disabled, or another tab holding the database), export immediately.

**Or let Rookeepa do it for you.** Settings → Automatic backup takes a folder you choose — Documents, a Dropbox
or OneDrive folder, a USB stick — and writes your books, and your attachments, into it every fifteen minutes.
Two limits are worth knowing before you rely on it. It works in **Chrome and Edge on a desktop**: Safari and
Firefox have no way for a page to write to a folder, so there the exports are the answer. And it only runs
**while Rookeepa is open**, because a browser cannot write to your disk in the background — a save that came
due while the browser was shut happens next time. The sidebar says where it is saving to once a folder is set.

If you keep attachments, note that they are **not** inside the books backup: it records that a file belongs to
a transaction and leaves the file itself on your device. Export them from **Settings → Attachments** and keep
the two files together.

**On a second computer.** Install nothing — open Rookeepa on the new machine, choose the same folder, and use
**Find a backup in this folder** on the same Settings card. The newest backup is listed with its date and its
size, and opening it brings the books (and the files) across. From then on both computers save into that folder
without getting in each other's way: each one writes its own file, named for the company and for that computer,
so neither can overwrite the other. To move from one to the other, save on the first, then open the newest
backup on the second. Opening a backup replaces what is in that browser, so it asks first — and if you have
unsaved work on the second computer, export it before you open anything.

## Coming from another system

1. Finish the previous period in your old system, so its reports are final.
2. Start Rookeepa with a **start date** — the first day of a month or a quarter
   reads best.
3. Enter opening balances as at that date (step 4) and the bank statement opening
   balance (step 5).
4. Re-raise unpaid invoices and unpaid bills as real documents, using their
   original dates and numbers, so aging and GST land in the right periods.
5. Keep the old system's final reports and your Rookeepa backup together for your
   accountant. Tell them the switch-over date, in writing.

Rookeepa cannot import another product's company file — formats differ and most
are proprietary. What it can do is export everything to CSV, always, so you are
never trapped here either.

## When something looks wrong

| Symptom | Likely cause |
| --- | --- |
| GST total is too high or too low | A line's tax code. Check for N-T where GST was meant, or a GST-free sale coded as GST. |
| The bank will not reconcile | The statement opening balance is not set, or a line is still unreviewed. The card tells you the difference. |
| An invoice says "overdue" but I know it is paid | The payment was not allocated to it. Check the receipt's allocations. |
| The trial balance does not close to zero | It cannot, by construction. If it does, report it — that is a bug worth knowing about. |
| Nothing is saving | A private window, or site data is blocked. The sidebar says so. Export a backup. |
| I voided something by mistake | Nothing is deleted. Voided entries and documents stay visible with their reason, and the audit log records it. |

## Getting help

- The demo company file exercises every feature; compare what it does against
  what yours is doing.
- [ARCHITECTURE.md](ARCHITECTURE.md) explains why the numbers do what they do.
- Bugs and questions: open an issue on the repository. If you can attach a backup
  file (Settings → Backup), a problem can usually be reproduced exactly.
- Tax questions are for your accountant, not for this README.
