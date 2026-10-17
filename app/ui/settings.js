import { listBackups, folderSupported, pickFolder, recallFolder, forgetFolder, folderPermission, saveToFolder } from '../core/autosave.js';
import { listJobs, blankJob, saveJob, setJobActive, jobsSummary } from '../core/jobs.js';
import { exportAttachments, importAttachments, attachmentTotals, formatBytes } from '../core/attachments.js';
/**
 * Rookeepa — Settings.
 *
 * One place for the things that are about the business rather than about a
 * single transaction: who you are, how tax works, where the data lives, and how
 * to get it out again. Deleting a company file lives here too, behind a typed
 * confirmation, because it is the only action in the app that cannot be undone.
 */

import {
  h, card, append, pageHeader, field, input, textarea, select, checkbox, radioGroup,
  button, table, kv, toast, promptDialog, emptyState, csvButton, ICONS, clear,
} from './kit.js';
import { renameCompany, deleteCompany, usage, listCompanies } from '../core/company.js';
import {
  exportCompany, importSnapshot, downloadJson, backupFilename, readFileAsJson,
  accountsCsv, contactsCsv, documentsCsv, transactionsCsv, slugify,
} from '../core/backup.js';
import { seedDemoCompany } from '../core/sample.js';
import { CURRENCIES, formatCents } from '../core/money.js';
import { PAYMENT_TERMS } from '../core/coa.js';
import { autosaveState, onAutosaveChange, saveNow, setHandle, setMinutes } from './autosave-runner.js';

// Kept in step with package.json by hand — there is no build step to inject it.
const VERSION = '0.1.0';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const meta = {
  title: 'Settings',
  subtitle: 'Business details, tax codes, storage and backups',
};

export async function render(ctx) {
  const root = h('div');
  root.appendChild(pageHeader({
    title: 'Settings',
    subtitle: 'The business, this company file, and your data',
  }));
  root.appendChild(businessCard(ctx));
  root.appendChild(taxCodesCard(ctx));
  root.appendChild(storageCard(ctx));
  root.appendChild(backupCard(ctx));
  root.appendChild(attachmentsCard(ctx));
  root.appendChild(jobsCard(ctx));
  root.appendChild(automaticBackupCard(ctx));
  root.appendChild(demoCard(ctx));
  root.appendChild(dangerCard(ctx));
  root.appendChild(aboutCard(ctx));
  return root;
}

/* ------------------------------------------------------------ business details */

function businessCard(ctx) {
  const company = ctx.company || {};
  const accounts = ctx.data.accounts || [];
  const draft = { ...company };
  const set = (key) => (value) => { draft[key] = value; };

  const bankAccounts = accounts.filter((a) => a.control && a.control.startsWith('bank') && a.active !== false);
  const salesAccounts = accounts.filter((a) => a.type === 'income' && a.active !== false);
  const purchaseAccounts = accounts.filter((a) => ['expense', 'costOfSales', 'otherExpenses', 'asset'].includes(a.type) && a.active !== false);

  // The logo is kept inside the company file as the image itself, so a printed invoice never
  // depends on a file that has since been moved, renamed or lost.
  const logoSlot = h('div', { class: 'logo-slot' });
  const drawLogo = () => {
    clear(logoSlot);
    if (draft.logoDataUrl) {
      logoSlot.appendChild(h('img', { class: 'logo-preview', src: draft.logoDataUrl, alt: 'Your business logo' }));
      logoSlot.appendChild(button({
        label: 'Remove', variant: 'ghost', size: 'sm',
        onClick: () => { draft.logoDataUrl = ''; drawLogo(); },
      }));
    } else {
      logoSlot.appendChild(h('span', { class: 'muted small' }, 'No logo yet.'));
    }
  };
  const logoInput = h('input', {
    type: 'file',
    class: 'input',
    accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
    'aria-label': 'Choose a business logo',
  });
  logoInput.addEventListener('change', () => {
    const file = logoInput.files && logoInput.files[0];
    logoInput.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type || '')) {
      toast('Choose an image file — PNG, JPEG, WebP or SVG.', 'warn');
      return;
    }
    // Generous for a logo, and small enough that the company file and its backups stay
    // reasonable: the image travels inside them.
    if (file.size > 256 * 1024) {
      toast('That image is larger than 256 KB. A smaller file will print just as well.', 'warn');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { draft.logoDataUrl = String(reader.result || ''); drawLogo(); };
    reader.onerror = () => toast('That image could not be read.', 'error');
    reader.readAsDataURL(file);
  });
  drawLogo();

  const logoField = field({
    label: 'Business logo',
    hint: 'Printed at the top of your invoices and quotes. Stored inside your company file, not uploaded anywhere.',
    input: h('div', { class: 'stack', style: { gap: '0.4rem' } }, logoSlot, logoInput),
  });

  const identity = h('div', { class: 'form-grid' },
    logoField,
    field({ label: 'Business name', required: true, input: input({ value: draft.name || '', onInput: set('name') }) }),
    field({ label: 'Legal name', hint: 'Printed on documents when it differs from the trading name.', input: input({ value: draft.legalName || '', onInput: set('legalName') }) }),
    field({ label: 'ABN', input: input({ value: draft.abn || '', onInput: set('abn') }) }),
    field({ label: 'Email', input: input({ type: 'email', value: draft.email || '', onInput: set('email') }) }),
    field({ label: 'Phone', input: input({ value: draft.phone || '', onInput: set('phone') }) }),
    field({ label: 'Website', input: input({ value: draft.website || '', onInput: set('website') }) }),
    field({ label: 'Address', input: input({ value: draft.addressLine1 || '', onInput: set('addressLine1') }) }),
    field({ label: 'Address line 2', input: input({ value: draft.addressLine2 || '', onInput: set('addressLine2') }) }),
    field({ label: 'City / suburb', input: input({ value: draft.city || '', onInput: set('city') }) }),
    field({ label: 'State', input: input({ value: draft.state || '', onInput: set('state') }) }),
    field({ label: 'Postcode', input: input({ value: draft.postcode || '', onInput: set('postcode') }) }),
    field({ label: 'Currency', input: select({ options: currencyOptions(), value: draft.currency || 'AUD', onChange: set('currency') }) }),
  );

  const taxAndDefaults = h('div', { class: 'form-grid' },
    field({ label: 'Financial year starts', input: select({ options: fyStartOptions(), value: String(draft.fyStartMonth || 7), onChange: (v) => set('fyStartMonth')(Number(v)) }) }),
    field({ label: 'Tax label', hint: 'What tax is called on your documents — GST, VAT or similar.', input: input({ value: draft.taxLabel || 'GST', onInput: set('taxLabel') }) }),
    field({ label: 'Default payment terms', input: select({ options: PAYMENT_TERMS.map((t) => ({ value: t.id, label: t.label })), value: draft.defaultTerms || 'net14', onChange: set('defaultTerms') }) }),
    field({ label: 'Default sales account', input: select({ options: accountOptionsFor(salesAccounts), value: draft.defaultSalesAccount || '', onChange: set('defaultSalesAccount') }) }),
    field({ label: 'Default purchase account', input: select({ options: accountOptionsFor(purchaseAccounts), value: draft.defaultPurchaseAccount || '', onChange: set('defaultPurchaseAccount') }) }),
    field({ label: 'Default bank account', input: select({ options: accountOptionsFor(bankAccounts), value: draft.bankAccount || '', onChange: set('bankAccount') }) }),
  );

  const numbering = h('div', { class: 'form-grid' },
    field({ label: 'Invoice prefix', input: input({ value: draft.invoicePrefix || '', onInput: set('invoicePrefix') }) }),
    field({ label: 'Bill prefix', input: input({ value: draft.billPrefix || '', onInput: set('billPrefix') }) }),
    field({ label: 'Credit note prefix', input: input({ value: draft.creditNotePrefix || '', onInput: set('creditNotePrefix') }) }),
    field({ label: 'Quote prefix', input: input({ value: draft.quotePrefix || '', onInput: set('quotePrefix') }) }),
    field({ label: 'Payment prefix', input: input({ value: draft.paymentPrefix || '', onInput: set('paymentPrefix') }) }),
  );

  const toggles = h('div', { class: 'row', style: { gap: '1.4rem', marginTop: '0.3rem', marginBottom: '0.4rem' } },
    checkbox({
      id: 'settings-gst',
      label: `Registered for ${draft.taxLabel || 'GST'}`,
      checked: draft.gstRegistered !== false,
      onChange: (checked) => { draft.gstRegistered = checked; },
    }),
    checkbox({
      id: 'settings-inventory',
      label: 'Track inventory (perpetual)',
      checked: draft.perpetualInventory === true,
      onChange: (checked) => { draft.perpetualInventory = checked; },
    }),
  );

  const save = () => {
    const name = String(draft.name || '').trim();
    if (!name) { toast('Give the business a name before saving.', 'warn'); return; }
    try {
      renameCompany(ctx.db, ctx.companyId, {
        name,
        legalName: draft.legalName || '',
        abn: draft.abn || '',
        logoDataUrl: draft.logoDataUrl || '',
        email: draft.email || '',
        phone: draft.phone || '',
        website: draft.website || '',
        addressLine1: draft.addressLine1 || '',
        addressLine2: draft.addressLine2 || '',
        city: draft.city || '',
        state: draft.state || '',
        postcode: draft.postcode || '',
        currency: draft.currency || 'AUD',
        gstRegistered: draft.gstRegistered !== false,
        fyStartMonth: Number(draft.fyStartMonth || 7),
        taxLabel: draft.taxLabel || 'GST',
        defaultTerms: draft.defaultTerms || 'net14',
        defaultSalesAccount: draft.defaultSalesAccount || '',
        defaultPurchaseAccount: draft.defaultPurchaseAccount || '',
        bankAccount: draft.bankAccount || '',
        invoicePrefix: draft.invoicePrefix || '',
        billPrefix: draft.billPrefix || '',
        creditNotePrefix: draft.creditNotePrefix || '',
        quotePrefix: draft.quotePrefix || '',
        paymentPrefix: draft.paymentPrefix || '',
        invoiceFooter: draft.invoiceFooter || '',
        perpetualInventory: draft.perpetualInventory === true,
      });
      toast('Company details saved', 'success');
      ctx.refresh();
    } catch (err) {
      // The draft is still on screen, so nothing the user typed is lost.
      toast(err?.message || 'Could not save the company details.', 'error');
    }
  };

  return card({
    title: 'Business details',
    subtitle: 'Shown on documents and used as the defaults for everything you enter.',
    actions: button({ label: 'Save changes', variant: 'primary', icon: ICONS.check, onClick: save }),
    body: h('div', null,
      identity,
      h('div', { class: 'divider' }),
      subHeading('Tax and defaults'),
      taxAndDefaults,
      h('div', { class: 'divider' }),
      subHeading('Document numbering'),
      numbering,
      toggles,
      field({ label: 'Invoice footer', hint: 'Printed at the foot of every invoice and bill.', input: textarea({ value: draft.invoiceFooter || '', rows: 2, onInput: set('invoiceFooter') }) }),
    ),
  });
}

/* ------------------------------------------------------------------ tax codes */

function taxCodesCard(ctx) {
  const taxCodes = ctx.data.taxCodes || [];
  const body = h('div');

  if (!taxCodes.length) {
    body.appendChild(emptyState({
      title: 'No tax codes',
      message: 'This company file has no tax codes. A new file is seeded with the Australian defaults.',
    }));
  } else {
    body.appendChild(table({
      columns: [
        { key: 'code', label: 'Code', render: (r) => h('span', { class: 'mono strong' }, r.code) },
        { key: 'name', label: 'Name', render: (r) => r.name },
        { key: 'rate', label: 'Rate', align: 'right', render: (r) => formatRate(r.gstBps) },
        { key: 'bas', label: 'Activity Statement boxes', render: (r) => basBoxes(r) },
        { key: 'desc', label: 'Used for', render: (r) => h('span', { class: 'muted' }, r.description || '') },
      ],
      rows: taxCodes,
      compact: true,
    }));
  }

  body.appendChild(h('p', { class: 'report-note' },
    'GST-free sales (FRE, EXP) still count in the total-sales box G1 but carry no GST. Input-taxed sales (ITS) are left out of G1 altogether and never earn GST credits — which is why two codes that both read "no GST" land in different places on the Activity Statement.'));

  return card({
    title: 'Tax codes',
    subtitle: 'What each code does and where it lands on the Activity Statement',
    body,
  });
}

/** Basis points -> a percentage: 1000 bps is 10%. */
function formatRate(gstBps) {
  const pct = Number(gstBps || 0) / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

/** Read the Activity Statement flags off a tax code into the boxes it feeds. */
function basBoxes(tc) {
  const bas = tc.bas || {};
  const boxes = [];
  if (bas.salesG1) boxes.push('G1');
  if (bas.salesG2) boxes.push('G2');
  if (bas.salesG3) boxes.push('G3');
  if (bas.purchasesG10) boxes.push('G10');
  if (bas.purchasesG11) boxes.push('G11');
  if (bas.gstOnSales) boxes.push('1A');
  if (bas.gstOnPurchases) boxes.push('1B');
  if (boxes.length) return h('span', { class: 'mono' }, boxes.join(' · '));
  if (bas.inputTaxed) return h('span', { class: 'muted' }, 'Input-taxed — excluded from G1, no GST credits');
  return h('span', { class: 'muted' }, tc.reportable === false ? 'Not reported on the BAS' : 'No BAS boxes');
}

/* -------------------------------------------------------------------- storage */

function storageCard(ctx) {
  const backend = ctx.db?.backend?.kind || 'memory';
  const backendLabel = {
    indexedDB: 'IndexedDB — saved in this browser',
    localStorage: 'localStorage — saved in this browser (limited space)',
    memory: 'Memory only — nothing is being saved (private window, or storage turned off)',
  }[backend] || backend;

  const stats = ctx.db.stats();
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  const statPairs = Object.keys(stats).sort().map((coll) => [collectionLabel(coll), String(stats[coll])]);

  const body = h('div', null,
    kv([
      ['Storage backend', backendLabel],
      ['Records in this browser', String(total)],
    ]),
    h('div', { class: 'divider' }),
    subHeading('Records by type'),
    statPairs.length
      ? kv(statPairs)
      : h('p', { class: 'muted small' }, 'No records stored yet.'),
    h('div', { class: 'divider' }),
    h('p', { class: 'report-note' },
      'Your books live only in this browser. There is no server and no account, so nothing is uploaded and no one else can read them. ',
      'If the browser storage is cleared — clearing site data, a private window, a profile reset, or the browser reclaiming space — the books are gone; there is no copy anywhere else. ',
      'So export a JSON backup regularly and keep the file somewhere safe: a USB stick, a synced folder, or a private repository.'),
    button({
      label: 'Force save now',
      variant: 'subtle',
      icon: ICONS.check,
      // Only claim success if the write actually committed: this used to toast
      // "Saved to this browser" even when the save had thrown.
      onClick: async () => {
        try {
          await ctx.save();
          toast('Saved to this browser', 'success');
        } catch {
          // ctx.save reports the failure itself (footer + toast); claiming success
          // here is exactly the bug this guards against.
        }
      },
    }),
  );

  return card({
    title: 'Storage',
    subtitle: 'Where your data lives and what happens if it is cleared',
    body,
  });
}

/* ------------------------------------------------------------ backup & restore */

/* ------------------------------------------------- attachments, kept out of the books backup */

/**
 * The files attached to transactions — the other half of keeping them separate.
 *
 * The books backup records that a file belongs to a transaction and does not carry the file itself, which is
 * what the maintainer asked for. That only works if the files have somewhere to live and a way to move: this
 * card exports them into one file to keep beside your books backup, and reads that file back. Without it,
 * "kept separately" would quietly mean "lost when the machine changes".
 */
function attachmentsCard(ctx) {
  const totals = attachmentTotals(ctx.db, ctx.companyId);
  const input = h('input', { type: 'file', accept: '.json,application/json', class: 'input', 'aria-label': 'Attachments file to import' });

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let bag;
    try {
      bag = await readFileAsJson(file);
      const result = importAttachments(ctx.db, bag);
      // "Skipped" covers two different things: a file already here, and one refused because the file or the
      // company file would be over its limit. Saying "already here" for both would be a lie about the second.
      const refused = result.refused || [];
      toast(refused.length ? 'Attachments imported, some left out' : 'Attachments imported', refused.length ? 'warn' : 'success', {
        detail: `${result.added} added, ${result.updated} filled in, ${result.skipped} already here.`
          + (refused.length ? ` Not imported: ${refused.map((r) => `${r.name} (${r.reason})`).join('; ')}.` : ''),
      });
      ctx.refresh();
    } catch (err) {
      toast(err?.message || 'Could not read that file.', 'error');
    }
  });

  return card({
    title: 'Attachments',
    subtitle: 'The files attached to transactions — supplier invoices, receipts, photos',
    body: h('div', { class: 'stack' },
      h('p', { class: 'report-note' },
        totals.count
          ? `This company file holds ${totals.count} attachment${totals.count === 1 ? '' : 's'}, ${formatBytes(totals.bytes)} in all.`
          : 'Nothing is attached to a transaction yet. Attach a file from a bank line — open it in place and use Attachments.'),
      totals.withoutData
        ? h('p', { class: 'report-note' },
          `${totals.withoutData} of them are described but have no contents on this device — restore came from a backup that does not carry them. Import the attachments file to bring them back.`)
        : null,
      h('p', { class: 'report-note' },
        'These files are kept separately from your books backup: the backup says a file belongs to a transaction, and does not carry the file. So export them here and keep the two files together — a books backup on its own can tell you a receipt existed, but not show it to you.'),
      // Off means off, and off is not delete: the picker goes, new files are refused, and what is already
      // here stays and still travels in the attachments export.
      h('div', { class: 'row-between' },
        h('div', null,
          h('div', { class: 'strong' }, 'Allow attachments'),
          h('div', { class: 'muted small' }, 'Turn this off and the attach control disappears from every bank line. Files already attached are kept, and still export.')),
        checkbox({
          checked: ctx.company?.attachmentsEnabled !== false,
          label: ctx.company?.attachmentsEnabled === false ? 'Off' : 'On',
          onChange: (on) => {
            try {
              renameCompany(ctx.db, ctx.companyId, { attachmentsEnabled: on });
              toast(on ? 'Attachments allowed' : 'Attachments turned off', 'success', {
                detail: on ? 'A file can be attached to a transaction again.' : 'Nothing was deleted — existing files are kept and still export.',
              });
              ctx.refresh();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        })),
      h('div', { class: 'form-row' },
        button({
          label: 'Export attachments',
          icon: ICONS.download,
          variant: 'subtle',
          onClick: () => {
            if (!totals.count) { toast('There is nothing attached in this company file yet.', 'info'); return; }
            downloadJson(`rookeepa-attachments-${slugify(ctx.company?.name || 'company')}.json`, exportAttachments(ctx.db, ctx.companyId));
            toast('Attachments exported', 'success', {
              detail: `${totals.count} file(s), ${formatBytes(totals.bytes)}. Keep this beside your books backup.`,
            });
          },
        }),
        button({
          label: 'Import attachments',
          icon: ICONS.upload,
          variant: 'ghost',
          onClick: () => input.click(),
        })),
      input,
      h('p', { class: 'field-hint' },
        'Importing fills in the contents the books backup left out, matching files by id — so importing the same file twice changes nothing, and a file that is already here is left alone.')),
  });
}

/* ---------------------------------------------------------------------- jobs */

/**
 * Jobs — what a cost or a sale belongs to.
 *
 * Per line, which is the choice this was built on: one supplier invoice can carry materials for two jobs. The
 * card is deliberately plain — a list, a way to add one, and what each earned and cost — because a job is a
 * label the books carry, not a project plan.
 */
function jobsCard(ctx) {
  const all = listJobs(ctx.db, ctx.companyId, { includeInactive: true });
  const summary = jobsSummary(ctx.db, ctx.companyId, {});
  const byCode = new Map(summary.rows.map((r) => [r.code, r]));
  const nameInput = input({ value: '', placeholder: 'Job name — e.g. Kitchen renovation', onEnter: () => addJob() });

  function addJob() {
    const name = (nameInput.value || '').trim();
    if (!name) { toast('Give the job a name.', 'warn'); return; }
    try {
      const job = saveJob(ctx.db, blankJob({ companyId: ctx.companyId, name }));
      toast('Job added', 'success', { detail: `${job.code} · ${job.name}` });
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const rowFor = (job) => {
    const figures = byCode.get(job.code);
    return h('div', { class: 'row-between' },
      h('div', { class: 'small' },
        h('span', { class: 'mono' }, job.code),
        h('span', { class: 'strong', style: { marginLeft: '8px' } }, job.name),
        job.active === false ? h('span', { class: 'muted' }, ' · retired') : null,
        h('span', { class: 'muted' }, figures
          ? ` · income ${formatCents(figures.income, { code: ctx.company?.currency || 'AUD' })} · expenses ${formatCents(figures.expenses, { code: ctx.company?.currency || 'AUD' })} · net ${formatCents(figures.net, { code: ctx.company?.currency || 'AUD' })}`
          : ' · nothing posted to it yet')),
      h('div', { class: 'row' },
        button({
          label: 'Rename', size: 'sm', variant: 'ghost',
          onClick: () => {
            const next = window.prompt(`Rename ${job.code}`, job.name);
            if (next === null) return;
            try {
              saveJob(ctx.db, { ...job, name: next });
              ctx.refresh();
            } catch (err) { toast(err.message, 'error'); }
          },
        }),
        button({
          label: job.active === false ? 'Reactivate' : 'Retire',
          size: 'sm', variant: 'ghost',
          onClick: () => {
            setJobActive(ctx.db, job, job.active === false);
            ctx.refresh();
          },
        })));
  };

  return card({
    title: 'Jobs',
    subtitle: 'What a cost or a sale belongs to, when it is not the whole business',
    body: h('div', { class: 'stack' },
      all.length
        ? h('div', { class: 'stack' }, ...all.map(rowFor))
        : h('p', { class: 'report-note' }, 'No jobs yet. A job is a code and a name — a renovation, a contract, a property — and each line of a document or a bank split can be given one.'),
      summary.rows.some((r) => r.code === null)
        ? h('p', { class: 'report-note' },
          `${formatCents(byCode.get(null).net, { code: ctx.company?.currency || 'AUD' })} of profit so far is not on any job — it is gathered here rather than dropped, so the figures add up against the profit and loss.`)
        : null,
      h('p', { class: 'report-note' },
        'Retiring a job keeps its history and takes it off the pickers. Nothing here is deleted, so a job you stop using still explains the old entries.'),
      h('div', { class: 'form-row' }, nameInput, button({ label: 'Add job', variant: 'subtle', icon: ICONS.plus, onClick: addJob })),
      h('p', { class: 'field-hint' },
        'A job is chosen per line — on a document line, or on each split of a bank line — so one invoice can carry two jobs, and the report splits them by the account each line sits on.')),
  });
}

/* ------------------------------------------ saving into a folder you choose, on a timer */

/* The timer and the chosen folder live in ./autosave-runner.js — outside this screen, because it has to keep
 * running when the screen is closed and has to save whichever company is open when it fires. */

function automaticBackupCard(ctx) {
  if (!folderSupported()) {
    return card({
      title: 'Automatic backup',
      subtitle: 'Save your books and your files into a folder, on a timer',
      body: h('div', { class: 'stack' },
        h('p', { class: 'report-note' },
          'This browser cannot write to a folder you choose. Chrome and Edge on a desktop can; Safari and Firefox have no such feature. Your books backup and your attachments export work everywhere — export them on a rhythm you will keep.')),
    });
  }

  const statusHost = h('div', { class: 'stack' });
  const folderName = () => (autosaveState().handle?.name ? autosaveState().handle.name : 'No folder chosen');

  const runSave = async ({ quiet = false } = {}) => {
    try {
      const out = await saveNow({ quiet });
      if (!quiet) {
        if (out) toast('Saved into your folder', 'success', { detail: out.written.map((w) => w.name).join(' · ') });
        else toast('Nothing to save yet', 'warn', { detail: 'Open a company file first.' });
      }
    } catch (err) {
      toast(err?.message || 'That save did not work.', 'error');
    }
    drawStatus();
  };

  // The runner owns the interval; this only asks it to change.
  const setTimer = (minutes) => { setMinutes(minutes); drawStatus(); };

  function drawStatus() {
    clear(statusHost);
    const saved = autosaveState();
    const when = saved.last ? `Last saved ${new Date(saved.last).toLocaleTimeString()}` : 'Not saved into a folder yet';
    append(statusHost, [
      kv([
        ['Folder', folderName()],
        ['Saving', saved.minutes > 0 && saved.handle ? `Every ${saved.minutes} minutes, while Rookeepa is open` : 'Only when you press Save now'],
        ['Last save', when],
      ]),
      h('div', { class: 'form-row' },
        button({
          label: autosaveState().handle ? 'Change folder' : 'Choose folder',
          variant: 'subtle',
          icon: ICONS.folder || ICONS.bank,
          onClick: async () => {
            try {
              setHandle(await pickFolder());
              await runSave();
            } catch (err) {
              if (err && err.name === 'AbortError') return; // the person closed the dialog
              toast(err.message || 'That folder could not be used.', 'error');
            }
          },
        }),
        button({ label: 'Save now', variant: 'ghost', onClick: () => runSave() }),
        autosaveState().handle
          ? button({
            label: 'Stop',
            variant: 'ghost',
            onClick: async () => {
              await forgetFolder();
              setHandle(null);
              drawStatus();
              toast('Automatic saving stopped', 'success', { detail: 'Your folder and its files are untouched.' });
            },
          })
          : null),
      h('p', { class: 'report-note' },
        'Two files are written: your books, and your attachments. They are the same two exports the buttons above produce, so either can be restored.'),
      h('p', { class: 'field-hint' },
        'Saving happens while Rookeepa is open — a browser cannot write to your disk in the background, and there is no server in this app to do it. Choose a rhythm short enough that you will not mind losing the last few minutes.'),
      // The limitation belongs on the screen even for people it does not affect: whoever shares these books
      // may well be on a browser where this card is the apology instead of the feature.
      h('p', { class: 'field-hint' },
        'This needs Chrome or Edge on a desktop. Safari and Firefox have no way to write to a folder at all — on those, and on a phone or tablet, the export buttons are the answer, so export on a rhythm you will keep.'),
    ]);
  }

  // The shell starts the runner at boot and recalls the folder; this card is told when that lands, and when a
  // save happens, so its status is the runner's state rather than a copy of it.
  onAutosaveChange(drawStatus);
  drawStatus();

  // Reading the folder back is what makes one folder usable from two computers. The files are already there —
  // named by company, and by which computer wrote them — so opening the newest one is the whole of "carry on
  // where I left off". Nothing here writes to the folder or deletes from it.
  const foundHost = h('div', { class: 'stack' });

  const restoreFrom = async (item) => {
    if (!item.snapshot) { toast('That file could not be read.', 'error'); return; }
    const when = item.savedAt ? `, saved ${new Date(item.savedAt).toLocaleString()}` : '';
    const ok = await ctx.confirm({
      title: 'Open this backup?',
      message: `This replaces every company file in this browser with the one in “${item.name}”${when}. Anything not in that backup will be gone from this computer.`,
      confirmLabel: 'Replace and open',
      danger: true,
    });
    if (!ok) return;
    try {
      await importSnapshot(ctx.db, item.snapshot, { mode: 'replace' });
      const companies = listCompanies(ctx.db);
      if (companies.length) ctx.ui.set('companyId', companies[0].id);
      toast('Backup opened', 'success', { detail: 'The books on this computer are now the ones from the folder.' });
      ctx.go('dashboard');
    } catch (err) {
      toast(err?.message || 'Could not open that backup.', 'error');
    }
  };

  const findBackups = async () => {
    foundHost.textContent = '';
    const handle = autosaveState().handle;
    if (!handle) { toast('Choose a folder first.', 'warn'); return; }
    foundHost.appendChild(h('p', { class: 'muted small' }, `Reading “${handle.name}”…`));
    let found = [];
    try {
      found = await listBackups(handle);
    } catch (err) {
      foundHost.textContent = '';
      foundHost.appendChild(h('p', { class: 'report-note' }, err?.message || 'Could not read that folder.'));
      return;
    }
    foundHost.textContent = '';
    if (!found.length) {
      foundHost.appendChild(h('p', { class: 'muted small' },
        `No backups in “${handle.name}” yet. The first one is written when the timer next runs.`));
      return;
    }
    foundHost.appendChild(h('p', { class: 'muted small' },
      `${found.length} backup${found.length === 1 ? '' : 's'} in “${handle.name}”, newest name first. Opening one replaces the books in this browser; the folder itself is only read.`));
    for (const item of found) {
      const bits = [];
      if (item.bytes) bits.push(`${Math.max(1, Math.round(item.bytes / 1024))} KB`);
      if (item.savedAt) bits.push(`saved ${new Date(item.savedAt).toLocaleString()}`);
      if (item.entries !== null && item.entries !== undefined) bits.push(`${item.entries} ledger ${item.entries === 1 ? 'entry' : 'entries'}`);
      foundHost.appendChild(h('div', { class: 'stack' },
        h('strong', null, item.unreadable ? `${item.name} — could not be read` : (item.company || item.name)),
        h('span', { class: 'muted small' }, item.unreadable ? item.name : `${item.name}${bits.length ? ' · ' + bits.join(' · ') : ''}`),
        item.unreadable ? null : button({
          label: 'Open this backup',
          variant: 'subtle',
          onClick: () => restoreFrom(item),
        })));
    }
  };

  return card({
    title: 'Automatic backup',
    subtitle: 'Save your books and your files into a folder, on a timer',
    body: h('div', { class: 'stack' },
      h('p', { class: 'report-note' },
        'Pick a folder once — your Documents, a Dropbox or OneDrive folder, a USB stick — and Rookeepa writes your books and your attachments into it on a timer. Nothing leaves your computer: the folder is on your disk, and the browser only writes where you point it.'),
      statusHost,
      h('div', { class: 'divider' }),
      subHeading('Open a backup from this folder'),
      h('p', { class: 'muted small' },
        'On a second computer, point it at the same folder and open the newest backup from here — the books come across without hunting for a file. This only reads the folder; it changes nothing in it, and opening a backup asks before it replaces anything.'),
      button({ label: 'Find a backup in this folder', variant: 'subtle', onClick: findBackups }),
      foundHost),
  });
}

function backupCard(ctx) {
  const company = ctx.company || {};
  const slug = slugify(company.name || 'company');

  const csvDefs = [
    { label: 'Accounts', filename: `${slug}-accounts.csv`, note: 'every account: code, name, type and default tax code.', ...accountsCsv(ctx.db, ctx.companyId) },
    { label: 'Contacts', filename: `${slug}-contacts.csv`, note: 'customers and suppliers with their contact details.', ...contactsCsv(ctx.db, ctx.companyId) },
    { label: 'Documents', filename: `${slug}-documents.csv`, note: 'invoices, bills, quotes and credit notes with totals and balances.', ...documentsCsv(ctx.db, ctx.companyId) },
    { label: 'Transactions', filename: `${slug}-transactions.csv`, note: 'every posted ledger line: date, account, debit, credit and tax code.', ...transactionsCsv(ctx.db, ctx.companyId) },
  ];

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'input' });
  let mode = 'replace';

  const doRestore = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { toast('Choose a backup file first.', 'warn'); return; }
    let snapshot;
    try {
      snapshot = await readFileAsJson(file);
    } catch (err) {
      toast(err?.message || 'Could not read that file.', 'error');
      return;
    }
    if (mode === 'replace') {
      const ok = await ctx.confirm({
        title: 'Replace everything?',
        message: 'This deletes every company file in this browser and replaces them with the contents of the backup.',
        confirmLabel: 'Replace and restore',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await importSnapshot(ctx.db, snapshot, { mode });
      const companies = listCompanies(ctx.db);
      if (companies.length) ctx.ui.set('companyId', companies[0].id);
      toast(mode === 'replace' ? 'Backup restored' : 'Backup merged', 'success');
      ctx.go('dashboard');
    } catch (err) {
      toast(err?.message || 'Could not restore that file.', 'error');
    }
  };

  return card({
    title: 'Backup and restore',
    subtitle: 'Get your books out as a file you own, and put them back again',
    body: h('div', null,
      subHeading('Download a backup'),
      h('p', { class: 'muted small' }, 'One JSON file holding every part of this company file. This is the file that would bring your books back — keep it somewhere safe.'),
      button({
        label: 'Download backup',
        variant: 'primary',
        icon: ICONS.download,
        onClick: () => {
          const snapshot = exportCompany(ctx.db, ctx.companyId);
          downloadJson(backupFilename(company), snapshot);
          ctx.ui.set('lastBackupAt', new Date().toISOString());
          toast('Backup downloaded', 'success', { detail: 'Keep it somewhere safe — it is your whole company file.' });
        },
      }),
      h('div', { class: 'divider' }),
      subHeading('Restore from a backup file'),
      h('p', { class: 'muted small' },
        'Replace everything wipes the company files in this browser and loads the backup exactly as it was — use it to move to a new computer. ',
        'Merge new records only adds any records whose ids are not already here and leaves your existing files alone — use it to bring one company file in alongside others. ',
        'Replacing asks you to confirm first; merging never deletes anything.'),
      field({ label: 'Backup file', input: fileInput }),
      field({
        label: 'How to apply it',
        input: radioGroup({
          name: 'restore-mode',
          options: [
            { value: 'replace', label: 'Replace everything' },
            { value: 'merge', label: 'Merge new records only' },
          ],
          value: mode,
          onChange: (value) => { mode = value; },
        }),
      }),
      button({ label: 'Restore', variant: 'subtle', icon: ICONS.upload, onClick: doRestore }),
      h('div', { class: 'divider' }),
      subHeading('Export to CSV'),
      h('p', { class: 'muted small' }, 'Spreadsheet-friendly extracts. They are one-way: to bring books back, restore from the JSON backup, not from a CSV.'),
      h('div', { class: 'row' },
        csvDefs.map((d) => csvButton({ label: `${d.label} CSV`, filename: d.filename, headers: d.headers, rows: d.rows, variant: 'subtle' }))),
      h('ul', { class: 'stack', style: { margin: '0.6rem 0 0', paddingLeft: '1.1rem' } },
        csvDefs.map((d) => h('li', { class: 'muted small' }, `${d.label}: ${d.note}`))),
    ),
  });
}

/* ----------------------------------------------------------------- demo data */

function demoCard(ctx) {
  return card({
    title: 'Demo data',
    subtitle: 'A second company file to explore, kept apart from your books',
    body: h('div', null,
      h('p', { class: 'muted small' },
        'Creates a separate demo company file with a year of invoices, bills, payments and a categorised bank statement. It is a second set of books — it does not add anything to this company file, and you can delete it whenever you like.'),
      button({ label: 'Add a demo company file', variant: 'subtle', icon: ICONS.dashboard, onClick: () => loadDemo(ctx) })),
  });
}

/** Seeds a brand-new, separate demo company file; leaves the open one alone. */
async function loadDemo(ctx) {
  try {
    const company = seedDemoCompany(ctx.db);
    await ctx.db.flush();
    if (company && ctx.setCompany) {
      toast('Demo company file added', 'success', {
        detail: 'Switched to it. Your own file is untouched — switch back from the company switcher.',
      });
      ctx.setCompany(company.id);
      return;
    }
    toast('Demo company file added', 'success', {
      detail: 'Open it from the company switcher, top left. Your own file is untouched.',
    });
    ctx.refresh();
  } catch (err) {
    toast(err?.message || 'Could not load the demo data.', 'error');
  }
}

/* ---------------------------------------------------------------- danger zone */

function dangerCard(ctx) {
  const counts = usage(ctx.db, ctx.companyId);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pairs = Object.keys(counts).map((coll) => [collectionLabel(coll), String(counts[coll])]);

  return card({
    className: 'danger-zone',
    title: 'Danger zone',
    subtitle: 'Actions that cannot be undone',
    body: h('div', null,
      h('p', { class: 'muted small' },
        `Deleting this company file removes all ${total} of its records — ${summaryLine(counts)} — and cannot be undone. There is no copy on a server. Download a backup first if you might ever want it back.`),
      kv(pairs),
      h('div', { style: { marginTop: '0.75rem' } },
        button({ label: 'Delete this company file', variant: 'danger', icon: ICONS.trash, onClick: () => deleteFlow(ctx) })),
    ),
  });
}

async function deleteFlow(ctx) {
  const company = ctx.company;
  if (!company) return;
  const counts = usage(ctx.db, ctx.companyId);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const typed = await promptDialog({
    title: `Delete "${company.name}"?`,
    label: 'Type the company name to confirm',
    message: `This permanently deletes the company file and its ${total} records — its invoices, bills, payments and ledger. Type the name exactly to continue.`,
    placeholder: company.name,
    confirmLabel: 'Delete company file',
  });
  if (typed === null) return;
  if (String(typed).trim() !== String(company.name)) {
    toast('That name did not match — nothing was deleted.', 'warn');
    return;
  }

  try {
    deleteCompany(ctx.db, ctx.companyId);
    const remaining = listCompanies(ctx.db);
    if (remaining.length) ctx.ui.set('companyId', remaining[0].id);
    toast(`Deleted "${company.name}"`, 'success');
    // With no company files left the shell shows its own first-run screen.
    ctx.go('dashboard');
  } catch (err) {
    toast(err?.message || 'Could not delete the company file.', 'error');
  }
}

/* -------------------------------------------------------------------- about */

function aboutCard(ctx) {
  const limitations = [
    'No ATO connection and no lodgement: Rookeepa works out your GST and Activity Statement figures, but does not submit anything.',
    'No STP or payroll reporting: it records wages and PAYG liabilities, but does not file employee payroll.',
    'Single user: one set of books in one browser, not a multi-user or cloud system.',
    'One browser only: data does not sync between browsers or devices.',
    'Back up yourself: with no server there is no automatic copy, so a regular export is your only safety net.',
  ];

  return card({
    title: 'About Rookeepa',
    subtitle: `Version ${VERSION}`,
    body: h('div', null,
      h('ul', { class: 'stack', style: { margin: '0 0 0.75rem', paddingLeft: '1.1rem' } },
        limitations.map((text) => h('li', { class: 'muted small' }, text))),
      h('p', { class: 'muted small' },
        'Rookeepa is free, MIT-licensed open-source software. It is bookkeeping software, not tax advice — have your figures checked by a registered accountant before you rely on them.'),
      h('p', { class: 'small' },
        // These resolve from the app directory, which sits under the site root, so they reach
        // up one level. The pages workflow publishes the docs with the app; without that they
        // pointed at files that were never deployed (and 404'd on the live site).
        h('a', { href: '../docs/ARCHITECTURE.md', target: '_blank', rel: 'noopener noreferrer' }, 'Architecture notes'),
        ' · ',
        h('a', { href: '../docs/UI-CONTRACT.md', target: '_blank', rel: 'noopener noreferrer' }, 'UI contract'),
        ' · ',
        h('a', { href: '../README.md', target: '_blank', rel: 'noopener noreferrer' }, 'README'))),
  });
}

/* -------------------------------------------------------------------- bits */

function currencyOptions() {
  return Object.values(CURRENCIES).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }));
}

function fyStartOptions() {
  return MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name }));
}

function accountOptionsFor(accounts) {
  return accounts
    .map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function collectionLabel(coll) {
  return String(coll || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function summaryLine(counts) {
  const order = ['documents', 'payments', 'entries', 'contacts', 'items', 'bankTxns', 'accounts'];
  const parts = order.filter((k) => counts[k]).map((k) => `${counts[k]} ${collectionLabel(k).toLowerCase()}`);
  return parts.length ? parts.join(', ') : 'nothing entered yet';
}

function subHeading(text) {
  return h('h3', { class: 'card-title', style: { fontSize: 'var(--fs-md)', margin: '0.9rem 0 0.5rem' } }, text);
}
