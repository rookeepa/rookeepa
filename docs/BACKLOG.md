# What is left from the trial run

From a hands-on trial on 2026-10-15, kept in the repository so it does not live inside one chat
window. Each item should land as its own commit, and be verified by driving the actual flow in a
browser before it is called done — three of the four real defects found that day came from someone
using the app, not from the checks.

## Done

- [x] Sundry and company-registration accounts in the default chart (`6-2200`, `6-2300`), with
      ASIC fees defaulting to GST-free. **New company files only** — an existing file needs the
      accounts added by hand in Accounts.
- [x] A backup reminder on the dashboard: never backed up, or no backup in the last seven days.
- [x] The page no longer jumps to the top when a screen re-renders itself (filters, sorting,
      categorising). **Verified both halves:** scroll to 700 on the transactions screen, type in the
      search box, and the filtered list returns with the page still at 700; navigating to another
      screen lands at 0.

## Next, in the order they were agreed

1. ~~**Screen state on the transactions screen.**~~ **Done.** The tab, the search box, the sort and
   the scroll position all survive a re-render of the screen, and a genuine navigation starts at the
   top. Verified in a browser: type "commbank" → one row; switch to "To review" → the search stays;
   sort by Amount → the list leads with the wages line; re-render and reload → all still true.
   Covered four reported symptoms: removing a line clearing the filter, an allocation clearing the
   search, the sort resetting after an allocation, and rows landing in *All* after *To review*.
   Follow-up closed: the table now marks the column it was built with, so a sort the screen
   remembered is shown on the header too — an arrow sits on the label, so the label and the list
   always agree. Verified through the case that exposed it: sort by Withdrawal, reload, and the
   column is still marked with the rows still in that order.
2. ~~**Bulk select.**~~ **Done.** A tick box per line, a bar above the table, and two actions: bulk
   categorise (one account and tax code, applied line by line through the same posting path as
   single-line categorisation, with the bar naming how many ticked lines are actually ready) and
   create-a-rule-from-the-selection (proposed and editable, never saved silently).
   Verified: ticked two of three seeded lines → "2 lines categorised", both posted with journal
   entries, the unticked third untouched; ticking one and pressing Create rule pre-fills the rule
   from that line.
   Follow-up closed: a rule proposed from a line is titled "New bank rule" with an "Add rule" button, so
   creating one does not read as editing an existing rule.
3. ~~**Rule conditions.**~~ **Done.**
   Done: a rule carries a list of conditions plus all-of/any-of, reading the description, the
   reference or the amount (more than / less than / between, compared by size with the rule's
   direction deciding in or out). Rules saved in the old single-condition shape are *read* as one
   description condition rather than migrated, so every rule a user already has keeps matching
   exactly as it did — the twelve existing rule tests pass untouched, and the legacy shape is
   asserted directly. An amount condition ranks as specific as an exact text match. Nine new tests.
   The editor: the rule dialog now takes a list of conditions — each one picking what to look at
   (description, reference or amount), how to compare it and the value, with a second value for a
   bracket, an all-of/any-of choice once there is more than one, and add/remove. The match modes
   follow the field, so a description that "contains" can never be left holding an amount
   comparison. Opening a rule written before conditions existed fills in its one condition rather
   than an empty form, so an old rule shows what it actually matches.
   Verified through the interface: a rule "amount over $50 AND description contains woolworths",
   authored in the dialog, saved as two conditions with all-of, then filed a $60 Woolworths line
   through Apply rules and left an identically-described $40 line alone. Reopening it showed both
   conditions filled in.
4. ~~**Unreconcile, edit, re-reconcile.**~~ **Done.** A reconciled line's only action used to be
   "Remove this line", and a categorised-but-unreconciled (`posted`) line had none at all — so a
   wrong coding on a reconciled line was a dead end.
   A reconciled line now offers **Un-reconcile**, which clears the tick and nothing else: matching
   never posted anything, so the ledger is left exactly as it was, including a payment the line was
   matched to. A line that posted its own entry returns to `posted` with its coding intact; one that
   only matched returns to review.
   A `posted` line now offers **Reverse the categorisation**, which voids its entry — kept as a
   reversal, never deleted — and puts the line back in review to be coded again. Voiding is what makes
   coding it again safe: a voided entry is left out of the reports, so the line cannot be counted
   twice. That is asserted directly — categorise, reverse, re-categorise, and the ledger holds the
   $110 exactly once, still balanced.
   Both actions are in the audit log. Six unit tests cover the accounting (including that
   un-reconciling a payment match leaves the payment alone) and a browser check covers the wiring: the
   right button on the right status, a dialog saying what is and is not reversed, the tick coming off
   with the entry kept, and the row then offering the next step.
5. ~~**Filter by amount on the transactions screen.**~~ **Done.** Two small boxes beside the search,
   an amount from and an amount to. Compared by size, not sign — "$50 to $100" means the money moved
   by that much in either direction, since in or out is what the tabs are for. An empty box means no
   bound rather than zero, so one end alone works, and a box holding something that is not a number is
   ignored rather than read as zero. Remembered like the search and the tab, so it survives the screen
   re-rendering and a reload.
   Verified in a browser against four seeded lines ($20, $60 out, $150 out, $60 in): from $50 leaves
   both $60s and the $150; adding to $100 drops the $150 and keeps both $60s; both boxes and the rows
   are unchanged after a full reload; clearing the boxes shows all four again.
6. ~~**Date presets.**~~ **Done.**
   What was there was three copies of the same idea (journals, reports, sales) and they had drifted:
   the same periods under three sets of names, no week anywhere, and no previous financial year or
   previous quarter in the journals screen — which is where it was noticed.
   The ranges now live once in `app/core/periods.js`, built on the app's own date helpers, honouring
   the business's `fyStartMonth`, with Monday weeks and the old key names still understood so a
   remembered choice is not reset by a rename. The journals screen uses it and gains this week, last
   week, last quarter and last financial year.
   The other two screens now use it as well, so the three copies are gone and cannot drift again: the
   functions keep their names and signatures and are delegations, and neither screen lost a period it
   had. Reports offered six ranges and now offers the shared list, gaining this week, last week, last
   quarter; sales offered four and gains those plus year to date and the previous financial year.
   Verified in a browser: reports offers a week and the previous quarter alongside everything it had,
   and choosing "This week" moves the dates to a real seven-day span rather than only relabelling.
   Ten tests pin the boundaries: the day a financial year turns over, the last day of a year (still in
   it), January and April year starts, quarter edges, a week across a month end, February in a leap
   year, and that every preset offered to a person computes a range at all.
7. ~~**A note on an allocation**, not just on the document.~~ **Done.** The payment already had a
   memo; this is a note against one allocation, which is where the question comes up when a payment
   settles several documents for different reasons.
   A note is never money — it is only written onto an allocation that exists, and the tests assert the
   ledger is identical with and without one, and that a part payment moves the balance by the
   allocation amount and not a cent more. Notes are held beside the allocations as well as on them,
   because a note can be typed before the amount that gives it an allocation to belong to and
   auto-allocating rebuilds the list; the browser check drives exactly that order.
   Verified: a note typed against a document before anything was applied was carried onto the
   allocation auto-allocate created and saved with the receipt.
   The notes now show where someone would look for them: under the applied amount in the sales and
   purchases payment lists, beside the figure they explain, with a payment that has no notes rendering
   exactly as before and no empty line where one would be.
   Verified in both lists. Sales was confirmed first; purchases looked unconfirmed for a while because
   the check was reading the wrong thing — it matched the payments tab by prefix on its whole text, which
   includes the count ("Payments made5"), and then by the wrong label, so the view never switched and the
   table it read was still bills. The tabs are `role="tab"` buttons whose label and count are separate
   elements; matching the label element alone reaches them. With that fixed, the purchases list shows the
   note beside the applied amount too. One sliver left: there is no printed receipt for a payment at
   all (print.js has document and statement nodes only), so the eventual home for a printed note is the
   statement.
8. ~~**Split a bank line across accounts** — a loan repayment split into principal and interest.~~
   **Done.** The posting shape first: a bank line can be coded to several accounts at once — one line on
   the bank side for the whole amount, one line per split on the other, in a single entry. A single
   account is a list of one, so the two cases cannot drift and a business that never splits gets the
   entry it always got (asserted by comparison). Splits must add up to the bank amount exactly, or
   nothing is posted and the difference is named. GST is worked out per split; the first split is
   recorded as the line's `categoryAccount` so the register, the rules and the tax summary keep working;
   each split's note becomes its ledger line's description; and the tax summary carries a row per
   taxable split. Eight unit tests.
   Then the editor: the categorise dialog offers **Split this across more than one account**, starting
   from the account already chosen and the whole amount, with a row per split (account, tax code,
   amount, note) and a running total — "Still to allocate $100.00: the splits must add up to
   $1,000.00" — that refuses to post until they match. A split added later starts at what is left. The
   preview shows the entry that will be posted, one bank line at the whole amount. The ordinary
   one-account form is untouched for anyone who never splits.
   Verified in a browser on a $1,000 repayment: $800 principal, a second split starting at the
   remaining $200, a deliberate $700 that was refused and wrote nothing, then $800 that posted one
   balanced $1,000 entry with both splits recorded. Eleven checks.

## Known defects, not from the trial

- When the browser's storage for the origin is full, the app has been seen to open a blank page
  instead of explaining itself.
- Saving after an edit rewrites whole collections, so a very large file pauses on each save.

## Tooling

**Solved, and worth remembering.** A browser check began failing with `ERR_CONNECTION_RESET` against
a local URL that `curl` reached fine, which made every result of that run meaningless — empty where
it should have been full, and easy to mistake for passing.

The cause was **eight Chrome processes left running on the harness profile** from earlier runs.
`ensureChrome()` reuses whatever is already listening on the debug port, so once that instance went
bad — and it had been alive for the whole session — every subsequent run inherited it. A single
stale browser looks exactly like a working one from the outside: the port answers, the tab opens,
and the page simply never loads.

The cure is to kill the profile's browsers outright and delete the profile:
`pkill -9 -f rookeepa-smoke-chrome`, then remove the `rookeepa-smoke-chrome` directory under the
system temp dir. Do that before concluding anything about the app when a screen will not load.

Worth building into the harness: a `CHROME_FORCE_RESTART=1` option, and reusing `usable()` from
`smoke.mjs` in `ensureChrome()` so a browser that cannot load a page is replaced rather than
reused.

---

# Second batch — from MYOB, 2026-10-15

A chart-of-accounts export and a screenshot of an expanded bank transaction. Recorded with what
Rookeepa does today, so a fresh session does not have to rediscover it.

## Bank transactions: the expanded row

The screenshot shows one line expanded in place, and it is the best idea in the batch: instead of a
dialog per transaction, you work down the list with everything you need in the row.

**It needs a decision before it needs code**, because the kit's `table()` has no notion of a row that
opens — it renders a flat list of rows from columns, and nothing in it can spill. Two ways, and they are
not equal:

1. **Teach the table about an expanded row** (a `rowDetail(row)` renderer, or a `render` that may return
   more than one row). General, but it changes a component every screen uses to serve one screen.
2. **Draw the panel outside the table** — the table keeps rendering rows, and the selected line's panel is
   rendered beneath it, above or below the page footer, scrolling into view when a row is clicked. The
   table stays dumb, the panel can be as rich as it likes (the three choices, the coding fields, create a
   rule, the split editor), and the risk is bounded to one screen.

Recommended: (2) first. It delivers the interaction the screenshot is showing, it can reuse the panels
that already exist (the categorise form, the split rows, the rule editor), and if it turns out the panel
really wants to sit between rows, moving it into the table afterwards is a smaller change than undoing a
table-shaped one. The test of whether it worked is not where the markup lives but whether a person can
code a list of lines without the surrounding rows ever leaving the screen.

The three actions to put at the top of it are already-built functions looking for a home: categorise
(`openCategoriseModal`), match (`openMatchModal`) and transfer. Today they live in three places, so the
user has to know which one they want before they start.

- [x] **Expand a transaction in place** — done. A line opens beside the table: it names itself, offers
      its choices, and embeds the coding form itself, so a line is coded where it sits rather than in a
      dialog over the top of the rows. Every other row stays on screen throughout, which is the property
      the screenshot is really about.
      The form is one function with two callers (`categoriseForm`), returning its node and a `post()`
      that throws a reason rather than toasting one — the dialog says it in a modal, the panel says it in
      place, and there is no second copy of the split logic or the balance check to drift.
      Verified: the form embedded with no modal open, an account typed into the picker and posted to that
      account as one balanced entry, the rows still on screen, the panel closing itself, and the row's
      Categorise action still opening the same form in a dialog. rather than opening a modal to categorise it. The row opens
      to reveal the coding panel; the rows above and below stay visible. This is the interaction
      that makes bulk work bearable, and it is the natural home for the items below.
- [x] **Match to existing record / Select categories / Transfer money** as three explicit choices at
      the top of the expanded panel. Rookeepa has all three actions but they live in different
      places (categorise, match, transfer), so the user has to know which one they want first.
- [x] **Unmatch.** Covered by **Un-reconcile**, which clears the match and the document link while
      leaving the other side alone — a payment stays, because it was real money. `tests/bulk-actions.test.mjs`
      asserts it rather than leaving it as a claim.
- [x] **Create rule from this line**, in the expanded panel. Today a rule is written by hand on a
      different screen. Creating it from the line you are looking at is how the rule actually gets
      written.

## Splitting a bank line across categories

- [x] Multiple category lines per bank line, each with an **Amount ($)**, a per-line description and
      a tax code per line.
- [x] **Spend money / Receive money: split the amount and note each line.** Reported from use: the buttons
      in Banking had one account, one tax code and one description for the whole entry, so a receipt that was
      partly stock and partly something else could not be recorded as one bank line. The single-account
      dialog now carries a **list** of lines — `Split across accounts` adds one, each with its own account,
      amount, tax code and note — because a single account is a list of one, the same shape the ledger's
      split posting uses, so there is no separate "split mode" that can drift from the plain one. The list
      must add up to the bank before anything posts, and the refusal names the shortfall rather than posting
      a partial entry. The note on a line becomes that line's description in the ledger, which is the
      question a split is there to answer ("which of these was the flour?"). The bank line keeps the whole
      amount and records the split underneath it.
      Verified in a browser: a 60/40 purchase across two accounts posts one balanced entry with the GST
      apportioned per line, each line carrying its own note; 60/30 is refused with the shortfall named and
      **nothing posted**.
- [x] **Calendar picker on the custom date range.** Reported as missing; it is there. The From/To fields are
      native `type="date"` inputs on the journal, the reports, the purchases screen and the statement
      dialog, and the picker indicator is not hidden by styling, so the browser supplies a calendar. Checked
      in the browser rather than assumed. **If a different screen was meant, that one needs naming** —
      everything reachable from a date range already uses the native control.
- [x] **Post Spend/Receive money through the same engine as a coded bank line.** Done: the dialog builds the
      bank line and hands it to `categoriseBankTxn`, so the ledger lines are no longer built twice. Nothing
      about the entry changed in the direction a person would notice — same source (`spend-money` /
      `receive-money` with the line's id), same GST per split, same balancing — but two things improved: every
      line now carries `sourceDocId`, so the ledger can say which bank line it came from, and a split's note is
      added to the description ("SUPPLIES PLUS — paper") instead of replacing it. One behaviour is deliberately
      stricter: a file with GST but no GST account is now refused with an explanation rather than posted with
      the whole amount as not reportable — the old warning banner is gone because refusing is the better answer.
      Verified with six unit tests pinning the contract the dialog now depends on, and end to end in a browser:
      a two-way split posts one balanced entry (5,455 + 545 GST, 4,000) with the second line's note beside its
      description and every line linked back to the bank line.
- [x] **Re-allocate a payment from the bank line** — **dropped at the maintainer\'s request**, not built, and
      not going to be. Recorded here only so it is not re-proposed: a payment cannot be edited anywhere in the
      app, so offering it would mean building an edit path for an existing payment\'s allocations.
- [x] **Amount (%)** — decided against, and the reason is in the entry\'s own condition. A percentage split
      earns its place when the amount it is a share of can move — an allocation following a running total.
      Nothing here has that shape: a bank line\'s amount is fixed by the statement, and a document\'s lines add
      up to a total the person typing is building. A percentage box would be a second way to say the same
      thing, and the split editor already refuses lines that do not add up, which was the job the percentage
      was there for. It gets built the moment something with a moving total arrives — a budget, or an
      allocation across a variable pool.
- [x] A running **Subtotal and Out of balance** while coding. Rookeepa already does exactly this in
      the journal preview on a document; the bank screen needs the same reassurance, and the
      screenshot shows how little space it takes.
- [x] This supersedes item 8 in the list above (principal/interest split): a split allocation is the
      general case, and the loan repayment is one use of it.

## Columns on the bank screen

- [x] **Separate Withdrawal and Deposit columns** — done and verified: money out shows under
      Withdrawal with a dash under Deposit and a receipt the other way round, and both sort on the
      signed amount. rather than one signed Amount. Worth doing for a
      reason beyond matching MYOB: a single signed column is exactly how a £42.10 card payment
      imported as *income* last week. Two columns make the direction of money impossible to
      misread, on the screen where it is read most.
- [x] **A shown Match column** — done as **Coded to**: the account's name, type and code against each
      line, with a dash where a line is not coded. Verified. ("✓ Service Income · Income · 4-1450") against each line, so what the
      line is coded to is visible without opening anything.
- [x] **A lightning-bolt suggestion from the user's own history** — done, and verified. For an uncoded
      line, the account the most recent similar line was coded to, prefilled into the account field with
      the evidence in the hint: *"Suggested from your own history: 3 similar lines, most recently coded
      to Bank Fees & Charges on 1 Oct. Change it if that is not right."*
      `app/core/history.js` is pure — lines and a description in, a suggestion out, no database and no
      posting. Two guards make it useful rather than noisy: digits are dropped before comparing (so the
      same shop with a different card number matches), and a shared word only counts at four characters
      or more (so "PTY", "LTD" and a suburb do not suggest an account for every line in the file). Most
      recent wins, not best-scoring oldest, because the question is "what did I do last time" — and when
      nothing is similar enough it returns null and the caller keeps its own default.

## Chart of accounts

From the MYOB export: an account list with a hierarchy (type → level 2 → level 3 → level 4), a
**Linked** column, a tax code per account, search, a show-inactive toggle, bulk select, and a
**current balance for every account**.

Rookeepa's accounts screen has a balance column, the control role, search and a show-inactive toggle.
What it does not have is bulk select (now built) and grouping or levels. Several entries below were
written from the screenshot before any of that was checked against the code, and are ticked as found
rather than built.

- [x] **Current balance per account.** — already built; the entry was stale. Verified: the accounts
      screen has a Balance column. The most useful column in that screenshot and the cheapest to
      add: the ledger already knows every balance.
- [x] **Search and show-inactive**, and **bulk select** for editing several accounts at once. Search
      and the show-inactive toggle were built already — the paragraph above claimed otherwise and this
      was never checked against the code. The missing third, bulk select, is now built: a tick per
      account and a bar with a count per action (Reactivate (2) · Deactivate (1)), through a new core
      `setAccountActive` that the single-row toggle also uses. Verified, including that a batch confirm
      **names** any control account it would deactivate rather than burying it.
- [x] **Expose `control` as "Linked"** — also already there, as a Control role column. Verified. in the accounts list. Rookeepa already marks accounts the
      software posts to (bank, ar, ap, gstCollected, …); the UI just never says so, which is why
      deleting or repurposing one looks safe when it is not.
- [x] **Grouping and levels** — deliberately **not** built, and the decision recorded rather than left as
      an omission. A flat chart grouped by type is right for the businesses this is for: MYOB's four levels
      exist largely because desktop software needed a filing cabinet, and "Current Assets → Bank Accounts →
      Business Bank Account" is one account with two folders around it. Reports group by type already, which
      is where grouping earns its keep — the hierarchy mostly adds a choice nobody wants to make, about
      whether each report rolls sub-accounts up.
      What would change the answer: a need showing up rather than a screenshot suggesting one — several bank
      accounts of the same kind, a dividend stream to separate, or a business wanting cost of sales broken
      down further. Deciding then, under a real requirement, is cheaper than building it now and finding
      every report has to take a position on rolling up.
- [x] **An "Other income" / "Other expenses" split.** MYOB separates interest received and interest
      expense from trading income and expenses, which matters for margin reporting. Rookeepa puts
      them all under income/expense.

## Open, from the independent reviews

Two independent reviews of the whole application were run on 2026-10-17: Codex (gpt-6-astra, high effort) and
Claude Code (sonnet, high effort), both against the same brief, both read-only. Everything they reported is
either fixed or recorded here. This list is the record; the commit messages explain the reasoning.

### Fixed

Restore deleting receipts it did not know about; the single-writer lease listening on the wrong object and
takeover writing stale books; the autosave timer saving the previous company and not starting without Settings;
other income counted as a purchase on the BAS; GST-free splits missing from the BAS; cash-basis profit ignoring
refunds; renaming a used account code stranding its postings (including the references held in `db.meta`); a
journal line taking the wrong tax code when two jobs share an account; un-categorising a bank line leaving its
payment live; the Journal screen voiding an entry a document owns; the sidebar backup carrying attachment bytes;
deleting a company leaving attachments, jobs and audit records behind; attachment import bypassing the size
caps; the folder listing cutting before it sorted by date; an imported bank row with no date crashing the sort;
and the dead `openingBalance` field on accounts.

### Open

- **Two company files with the same name produce the same backup filenames.** The name carries no company id, so
  on one computer they collide. Rare (two files, one name, one folder) but silent.
- **Attachment restore and import can cross company boundaries with crafted ids.** Matching is by global file id
  without checking ownership, so a hand-edited file could bring one company's bytes into another's record.
- **The restore validator checks totals, not lines.** A snapshot with fractional cents, or a duplicate posted
  journal for one document, is accepted. Normal posting is idempotent and integer; restore does not preserve it.
- **Bank categorisation may drop a selected job.** Reported with a reproduction, but it contradicts
  `tests/jobs.test.mjs`, which asserts the opposite — so this needs investigating before it is "fixed", not a
  patch applied to whichever is wrong.
- **An authorised quote cannot be edited and saved.** `saveDocument` tries to post every open document, so
  saving a quote after authorising it throws "Quotes are not posted to the ledger".
- **The document editor's line cell ignores `gstRegistered`.** For a company not registered for GST the line
  shows the GST-inclusive figure while the document totals show the right one — display only.
- **`money(ctx, cents)` is local to `app/ui/banking.js`.** It belongs in the kit with the other shared helpers.
  Worth doing together with closing the template-interpolation gap in `scripts/lint-imports.mjs`, which cannot
  see calls inside `${...}` and so let an unimported `money()` reach the Settings screen once.

## Bigger, and deliberately deferred

      Built: two new account types render under the profit and loss, below the trading result —
      "Operating profit", then other income and other expenses, then net profit. The point is margin
      reporting: interest received is not turnover, and a gross margin that includes a one-off receipt is
      not the business's margin, so the trading figures ignore both groups entirely. Interest Income and
      Interest Expense in the default chart are typed to them for **new** companies only; a company file
      already in use keeps the types it was created with, because re-typing an account in somebody's books
      is not something an upgrade should do, and until it is re-typed the reports treat it exactly as
      before. Re-typing is under Accounts and never touches the entries.
      Verified: the trading figures are unmoved by interest (gross profit 6,000,000 not 6,500,000; gross
      margin 0.60), net profit is operating profit plus the interest, a company that separates nothing gets
      the profit and loss it always got, an account re-types between the two without its entries changing,
      "Total other income" appears on the screen, the summary card and the print totals so the parts add up
      to the bottom line, and the CSV carries the new rows (it maps the same rows as the table). The
      existing invariant test — "the profit and loss equals the movement in the profit and loss accounts" —
      caught its own type list being incomplete by exactly the $240 of interest in the demo data, which is
      the test doing its job. The new types are also offered wherever the old ones were: the bank-coding
      picker's order, recurring templates (a monthly interest receipt or payment), bill lines, and the
      default purchase accounts.
      Not changed: the cash-flow style report that classifies income, expenses and cost of sales as
      operating leaves the two new groups out of that classification deliberately — where interest sits in
      a cash flow is a judgement, and changing it silently would be worse than leaving it alone.
- [x] **Job / tracking categories.** Built **per line**, which was the open question: one supplier invoice can
      carry materials for two jobs, so the job belongs on the line rather than the document. The ledger line has
      carried a `jobCode` field since the beginning and nothing ever set it — that field is now filled in and
      read back. A job is a code, a name and whether it is still running: no tasks, no plan, because the moment
      it becomes a project tool it stops being part of the accounts.
      Choose a job on a bank split or on a coded statement line; the engine carries it to the ledger line the
      split creates. Settings → Jobs lists them, adds one (the code is made, so two jobs cannot collide),
      renames, and retires one without deleting it — a retired job keeps its history and leaves the pickers.
      Each is shown with what it has earned and cost, read from the ledger and classified **by the account each
      line sits on**, which is what makes a mixed invoice come out right. Lines with no job are gathered as
      "no job" rather than dropped, so the totals still agree with the profit and loss; balance-sheet lines are
      left out, since capital spending is not profit until it is depreciated.
      Verified with six unit tests — including that a job on a split reaches the ledger line, that the summary
      splits one invoice across two jobs, that a retired job keeps its history, and that the period bounds it —
      and in a browser end to end: the job is created in Settings with its own code, a coded line carries it to
      the ledger, the summary puts the cost on it, and the card shows it.
      **Still open: a job picker on a document line.** The store, the engine and the report are general and
      already take it; the document editor's line rows need the same picker the bank splits have.
- [x] **Attachments on a transaction** — built for **bank lines**, with the files kept **separately from the
      books backup** (the maintainer's decision). A file attaches from the line's own panel; the books backup
      describes it (name, type, size, when, and what it is attached to) and carries none of its contents, and
      says so in the file itself. Because a restore replaces every collection, restoring books now carries the
      files across by id — a backup that never held them must not delete them — and a file the backup
      describes but the device does not have stays described, marked, and file-less rather than vanishing.
      Settings → Attachments exports the files into one JSON to keep beside the backup and reads them back,
      matched by id. Caps: 2 MB per file, 25 MB per company file, measured from the data rather than trusted.
      Verified by ten unit tests (including that the backup contains no base64 at all, and that a restore keeps
      the files already on the device) and end to end in a browser, attaching a real file through the real
      input control.
      **Still open: attaching to a document** (an invoice or bill) rather than only a bank line. The store, the
      backup handling and the panel are all general — `entityType` takes `document`, `payment` and `entry`
      already — so this is a UI job on the document editor, not a change to any of the above.
## Bulk actions on a ticked selection — audited 2026-10-17

The question was whether anything else of this kind is missing. A selection could only *Categorise* or
*Create rule*; everything else that can be done to a reconciled, coded or excluded line had to be done
one line at a time.

**Now on the bar, each with the number of ticked lines it can act on**, because the answer differs per
action (of four ticked lines, two may be categorisable and one un-reconcilable at once), and a
zero-count action is disabled rather than hidden:

- **Categorise** — uncategorised lines
- **Un-reconcile** — reconciled lines (clears the tick, the match and the document link; reverses nothing)
- **Reverse the categorisation** — lines with their own entry; the entry is voided, never deleted
- **Exclude** — lines not already excluded, with one reason kept on each
- **Reinstate** — excluded lines, each returning to the status it came from
- **Create rule** — any line

**Deliberately not bulk**, because each names a specific counterparty or a removal that a batch should
not decide for you: matching a line to a ledger entry, creating a payment, and deleting a line.

**Still missing, and the one genuine gap in this class: a batch contact.** The single-line dialog takes a
contact and the batch dialog does not, so coding a month of the same supplier's lines cannot set the
contact in one go. Small, and the same shape as the bulk account field.

**Verification, honestly.** The core is unit-tested — eight tests in `tests/bulk-actions.test.mjs`,
including that reinstating a categorised line returns it to `posted` rather than to review (returning it
to review invites a second categorisation, which posts a second entry for the same money), and that
un-reconciling a matched line unmatches it while leaving the payment alone. The bar's own counts were
confirmed in a browser — `Categorise (1) · Un-reconcile (1) · Reverse the categorisation (1) ·
Exclude (2) · Reinstate (1)` for four seeded lines in four different states — and a batch reverse was
driven end to end. The batch un-reconcile, exclude-with-a-reason and reinstate steps did not complete
their browser pass: the check kept reading the bar a moment before the redraw that creates it, and
once typed a prompt value in script where the prompt needs real keystrokes. Both are check bugs and
both are repeat offenders in this session's own checks. Re-running one clean pass over those three is
the next step; the underlying core behaviour is tested and nothing is known to be broken.


### Bulk exclude with a reason — verified

The last step of the bulk actions now has its browser pass. The failure it kept hitting was in the check,
not the app: `promptDialog` leaves the previous dialog in the DOM while it closes, so
`querySelector('.modal')` can hand back a dialog that is on its way out — one with no field in it. Every
check that opens a dialog after another one should take the **newest visible** modal, not the first.

With that fixed, driven through the interface: two ticked lines, Exclude, the prompt's field already
focused, a reason typed, and both lines excluded carrying that reason with the toast reporting two lines.
So the whole bulk bar is now verified end to end — counts, un-reconcile, reverse, exclude and reinstate.


### Batch contact — done

The batch categorise dialog now takes a contact, the last gap in the bulk class: the single-line dialog
had one and the batch dialog did not, so a month of one supplier's lines could not be linked in one go.
It is prefilled only when every ticked line already agrees, and left blank when they disagree — taking the
first line's contact would quietly label the rest.

Verified with three lines that disagreed (two naming one contact, one naming another): the dialog opened
blank rather than guessing, choosing one applied it to all three lines *and* to the entries they posted,
and the toast reported three.
