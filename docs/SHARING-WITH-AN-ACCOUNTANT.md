# Sharing your books with an accountant

Rookeepa has no accounts and no server, and that changes what "giving someone access" can mean. This
page says what actually works, what doesn't, and why — because the natural request ("send them the link
and the file") only half works, and the half that doesn't fails in a way that looks fine.

---

## The bit that doesn't work: a link

**There is nothing to log into.** The app is a static site; your books live in *your* browser's storage
on *your* computer. If you send someone the address, they get the app — with none of your data. There is
no account, no sharing, no permissions and no server that could hold a copy.

So:

- **A link alone gives your accountant an empty app.** Not your books.
- **There is no read-only view, no inviting a collaborator, no multi-user.** One browser, one copy of the
  books, one writer at a time. That is a deliberate design choice, not a missing feature to wait for.
- **Two people cannot work in the same books at once** through any mechanism Rookeepa has.

If an accountant asks for a "login", the honest answer is that this software doesn't have one — and that
the file below is better for them anyway, because they can work on it in their own copy without touching
yours.

## The bit that works: a file, and three ways to send it

### 1. The reports — for a review, a BAS, or a set of accounts

**Settings → Backup and restore** has CSV exports: accounts, contacts, documents, transactions. The
reports (profit and loss, balance sheet, trial balance, aged debtors and creditors, the activity statement
summary) print from the browser to PDF.

This is what most accountants actually want for a routine job: the numbers, in a form they already know.
It is also the safest — a trial balance contains no contact details, no bank numbers and no receipts.

**Use this when:** they are checking a BAS, reviewing a year, or preparing a return.

### 2. The backup file — for a full set of books

**Settings → Download backup** gives one JSON file holding everything: accounts, contacts, documents,
journal, bank lines, jobs, attachments *metadata*. It is the same file you would use to move to a new
computer.

They open Rookeepa — their own copy, or `rookeepa.com.au` in their browser — and choose
**Settings → Backup and restore → Restore**, then either:

- **Merge new records only** — adds anything whose id isn't already in their copy and leaves their
  existing files alone. **Use this.** It never deletes anything, so it is safe alongside their own work.
- **Replace everything** — wipes the company files in *that browser* and loads yours exactly. Only for a
  machine that holds nothing else.

**Use this when:** they need to look at the books themselves — drill into a transaction, check a
reconciliation, see how something was posted.

### 3. The attachments file — only if they need the receipts

**Settings → Attachments → Export** produces a second file with the actual files (the PDFs and photos). It
travels separately from the books on purpose: the backup describes each attachment and leaves the bytes on
your device, so the books backup stays small.

Most accountants don't want it. Send it only when they ask for substantiation.

---

## What to be careful about

1. **The backup file is not encrypted.** It is readable JSON. Send it the way you would send a bank
   statement: a password-protected zip, a shared drive with access control, or your accountant's own
   secure portal. Not a plain email attachment if it is someone's real books.
2. **It is a snapshot, not a live view.** Note the date in the file name and in your message. If they need
   the position at 30 June, export on 1 July and say so.
3. **It holds everything in that company file** — every contact's name, address and email, every document
   and every bank transaction. Send the *reports* if that is all they need.
4. **It is the company's records.** Once you send it, keep it. Treat the copy you sent as part of the
   audit trail, not as a working file.
5. **Restoring on their machine replaces or merges into *their* copy.** If they already hold other clients'
   files, tell them to use **Merge**, never **Replace**.

## A message you can send with it

> Hi — attached is my bookkeeping file for [Company] to [date].
>
> It's from Rookeepa, the free bookkeeping app (rookeepa.com.au). There's no login for it — the books are a
> single file, which is what I've sent.
>
> To look at it: open rookeepa.com.au, then Settings → Backup and restore → Restore, and choose **Merge new
> records only** (that's the safe option — it won't touch anything else you have). The reports and CSV
> exports are on the same screen if that's easier.
>
> The file contains the full company file, including contacts and bank transactions. It's a snapshot to
> [date], not a live connection. Anything you need re-exported, just ask.
>
> No payroll and no ATO connection — nothing is lodged from my side.

## If they insist on seeing it "live"

The only honest answer is that there is no live view, because there is no server. The practical
alternative is a rhythm: a fresh export on the first of the month, or at the end of each BAS period. It
takes one click, and it means the accountant always has a dated copy — which is what they need for their
own file anyway.
