# Contributing to Rookeepa

Thanks for wanting to help. Rookeepa exists so that a small business can keep
proper books without a subscription, and it stays useful only if the numbers stay
trustworthy. Everything below is in service of that.

## Getting set up

```bash
git clone https://github.com/<you>/rookeepa.git
cd rookeepa
python3 -m http.server 5173        # ES modules must be served over HTTP
npm test                           # 73 unit tests, no dependencies needed
```

Open <http://127.0.0.1:5173/app/>, click **Explore with demo data**, and you have a
year of books to work against.

There is no build step, no bundler and **no runtime dependencies**. Keep it that
way: a bookkeeping tool people trust with their records should be something you
can read end to end, and a `git clone` should run the same as the deployed copy.

## The three rules

1. **Money is never a float.** Amounts are integer cents; quantities are
   thousandths; GST uses integer basis points. If you find yourself writing
   `Number(x.toFixed(2))`, something has gone wrong.
2. **The journal is the only source of truth.** Never store a balance on an
   invoice, account or contact. Derive it. Write ledger changes through
   `postEntry` (or the helpers in `app/core/docs.js`) so debits always equal
   credits, and never `db.put('entries', …)` directly.
3. **The engine has no DOM.** `app/core/*` takes arrays and returns objects.
   That is what makes the accounting testable. Any change that needs a browser
   API belongs in `app/ui/`.

## Before you open a pull request

```bash
npm test                     # must pass
node scripts/smoke.mjs       # drives the real UI; needs the server running
```

- Run the smoke test with `--shots /tmp/shots` and look at the screenshots if
  you changed anything visual.
- If you fix a bug, add a test that fails without your fix — especially if it is
  an accounting bug.
- If you change a posting rule, say so in the pull request and update
  `docs/ARCHITECTURE.md`, because those rules are the contract.
- Keep the diff focused. Reformatting unrelated files makes a change impossible
  to review.

## Adding a screen

Read [docs/UI-CONTRACT.md](docs/UI-CONTRACT.md) first — it covers the context
object, the kit components and the rules. The short version:

1. Create `app/ui/yourscreen.js` exporting `meta` and `render(ctx)`.
2. Register it in the `VIEWS` map and `NAV` list in `app/main.js`.
3. Build the screen from `card`, `table`, `toolbar`, `kpi`, `emptyState` and the
   form controls in `app/ui/kit.js`. Do not add CSS files and do not hard-code
   colours — the design tokens handle light and dark.
4. Call `ctx.refresh()` after every write; confirm before anything destructive;
   void rather than delete once something has touched the ledger.
5. Make sure `node --input-type=module -e "import('./app/ui/yourscreen.js')"`
   works — no DOM access at import time.

## Testing the accounting

Tests live in `tests/` and run on Node's built-in runner. They assert behaviour
of the books, not the layout:

```js
const db = await DB.open({ forceMemory: true, debounceMs: 0 });
const company = createCompany(db, { name: 'Test Co' });
// …post something, then assert on balances and reports
```

Prefer assertions that would catch a real bookkeeping error — "aged receivables
reconcile to the debtors control account" is worth more than ten DOM snapshot
tests. The demo company in `app/core/sample.js` exists so tests and the app
exercise the same data.

## Reporting bugs

Include the company file if you can: **Settings → Backup** produces one JSON file
with everything needed to reproduce, and you can trim it if it contains anything
private. Say what you expected, what happened, and which report shows it.

## What is out of scope

- ATO/SBR lodgement, BAS submission, Single Touch Payroll filing — regulated, and
  deliberately excluded.
- A hosted service with accounts and sync. Keep the free local-first version
  honest; an optional self-hosted sync folder is a fair future idea.
- Anything that requires a proprietary service to work.

## License

Contributions are accepted under the [MIT license](LICENSE).
