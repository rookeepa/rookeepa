/**
 * Files attached to a transaction — a supplier's PDF, a photo of a receipt.
 *
 * The bytes are kept **separately from the books backup**, by the maintainer's decision, and that single
 * choice is what most of this module exists to make safe:
 *
 *  - the books backup carries each attachment's *description* (its name, type, size, when it was added and
 *    what it is attached to) but not its data, so a backup stays the size of the books;
 *  - restoring a books backup must therefore never delete the files that are already on the device. The
 *    restore replaces collections wholesale, so files are carried across by id — that is `preserveFiles`;
 *  - and because "kept separately" would otherwise mean "lost when the laptop dies", the files travel in
 *    their own file: `exportAttachments` / `importAttachments`.
 *
 * The caps are not decoration. Everything lives in the browser's storage, and a file too large for the quota
 * is how a browser-only app turns into a blank page.
 */

/** Per file. Large enough for a scanned invoice, small enough that a few hundred stay comfortable. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Across one company file, so a pile of photos cannot fill the browser's storage. */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

import { audit } from './ledger.js';

const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s;

/** What a file is attached to. Kept as a plain pair so a new kind of record needs no schema change. */
export const ATTACHABLE = ['bankTxn', 'document', 'payment', 'entry'];

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The decoded size of a base64 data URL, without decoding it. */
export function dataUrlBytes(dataUrl) {
  const m = DATA_URL.exec(String(dataUrl || ''));
  if (!m) return 0;
  const b64 = m[3] || '';
  const padding = (b64.match(/=+$/) || [''])[0].length;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export function dataUrlMime(dataUrl) {
  const m = DATA_URL.exec(String(dataUrl || ''));
  return (m && m[1]) || 'application/octet-stream';
}

/** Everything attached to one record, oldest first. */
export function filesFor(db, companyId, entityType, entityId) {
  return db.of('files', companyId)
    .filter((f) => f.entityType === entityType && f.entityId === entityId)
    .sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')));
}

export function filesForCompany(db, companyId) {
  return db.of('files', companyId);
}

export function attachmentTotals(db, companyId) {
  const files = filesForCompany(db, companyId);
  return {
    count: files.length,
    bytes: files.reduce((n, f) => n + (Number(f.size) || 0), 0),
    withoutData: files.filter((f) => !f.data).length,
  };
}

/**
 * Attach a file to a record.
 *
 * The size is measured from the data itself rather than trusted from the caller, because the cap is the
 * thing standing between a user and a full browser profile.
 */
export function attachFile(db, { companyId, entityType, entityId, name, data, mime }) {
  if (!companyId) throw new Error('An attachment needs a company file.');
  // Turning attachments off means off: the picker is hidden, and this refuses as well, because a hidden
  // control is not a rule. Existing files are left alone — off is not delete.
  const company = db.get('companies', companyId);
  if (company && company.attachmentsEnabled === false) {
    throw new Error('Attachments are turned off for this company file. Turn them back on under Settings → Attachments.');
  }
  if (!ATTACHABLE.includes(entityType)) throw new Error(`Cannot attach files to a ${entityType || 'record'}.`);
  if (!entityId) throw new Error('An attachment needs something to attach to.');
  if (!data) throw new Error('That file had no contents to read.');
  const size = dataUrlBytes(data);
  if (!size) throw new Error('That file had no contents to read.');
  if (size > MAX_FILE_BYTES) {
    throw new Error(`That file is ${formatBytes(size)}. The limit is ${formatBytes(MAX_FILE_BYTES)} — attach a smaller version, or a photo taken at a lower setting.`);
  }
  const total = attachmentTotals(db, companyId).bytes;
  if (total + size > MAX_TOTAL_BYTES) {
    throw new Error(`This company file already holds ${formatBytes(total)} of attachments, and the limit is ${formatBytes(MAX_TOTAL_BYTES)}. Remove something first, or export the attachments and start again.`);
  }
  const saved = db.put('files', {
    companyId,
    entityType,
    entityId,
    name: String(name || 'file').slice(0, 120),
    mime: mime || dataUrlMime(data),
    size,
    addedAt: new Date().toISOString(),
    data,
  });
  audit(db, {
    companyId,
    action: 'attach',
    entity: entityType,
    entityId,
    detail: `Attached ${saved.name} (${formatBytes(size)})`,
  });
  return saved;
}

export function removeFile(db, file) {
  const row = typeof file === 'string' ? db.get('files', file) : file;
  if (!row) throw new Error('That attachment is not here any more.');
  db.remove('files', row.id);
  const rest = filesFor(db, row.companyId, row.entityType, row.entityId);
  return { removed: row, remaining: rest.length };
}

/* ------------------------------------------------- the books backup, and the files themselves */

/**
 * Take the file contents out of a books backup, leaving the description behind.
 *
 * The row stays, without its `data`, so the restore knows a file belongs to that transaction and can say so
 * rather than pretending the transaction never had one.
 */
export function stripFileData(snapshot) {
  const files = snapshot && snapshot.data && snapshot.data.files;
  if (!Array.isArray(files)) return snapshot;
  return {
    ...snapshot,
    data: {
      ...snapshot.data,
      files: files.map(({ data, ...rest }) => ({ ...rest, data: null, metadataOnly: true })),
    },
    attachmentsKeptSeparately: true,
  };
}

/**
 * Put back, after a restore, the file contents the restore could not carry.
 *
 * A restore replaces every collection, so without this the files that were on the device would be deleted by
 * restoring a backup that never contained them — the worst possible outcome of keeping them separate. What
 * exists locally and matches by id is kept; anything the backup describes but the device does not have stays
 * described and file-less, with `metadataOnly` saying why.
 */
export function preserveFiles(db, incoming) {
  if (!Array.isArray(incoming)) return [];
  const kept = incoming.map((row) => {
    if (row && row.data) return row;
    const local = row && row.id ? db.get('files', row.id) : null;
    if (local && local.data) return { ...row, data: local.data, metadataOnly: undefined };
    return { ...row, metadataOnly: true };
  });
  // A backup never carries the contents, and a restore replaces the whole collection — so every file on this
  // device that the backup does not mention would be deleted by restoring one taken earlier. Those are the
  // receipts attached after that backup: carried across by id and left alone, because restoring your books
  // must not destroy the receipts it never knew about. Files are read company by company: a collection is
  // company-scoped, and an unscoped read finds nothing at all.
  const described = new Set(incoming.map((row) => row && row.id).filter(Boolean));
  for (const company of db.of('companies')) {
    for (const local of db.of('files', company.id)) {
      if (local.id && !described.has(local.id)) kept.push(local);
    }
  }
  return kept;
}

/** The files on their own, for the separate file a person keeps beside their books backup. */
export function exportAttachments(db, companyId) {
  const company = db.get('companies', companyId);
  return {
    app: 'rookeepa',
    kind: 'attachments',
    version: 1,
    exportedAt: new Date().toISOString(),
    companyId: companyId || null,
    companyName: company?.name || null,
    files: filesForCompany(db, companyId).map((f) => ({ ...f })),
  };
}

/**
 * Read a files export back in.
 *
 * Matched by id, so importing the same export twice does not double anything, and a file that is already on
 * this device with its contents is left alone.
 */
export function importAttachments(db, snapshot) {
  if (!snapshot || snapshot.kind !== 'attachments' || !Array.isArray(snapshot.files)) {
    throw new Error('That is not an attachments file. Choose one exported from Settings → Attachments.');
  }
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const refused = [];
  // Measured here rather than taken from the row: an imported file is not more trustworthy than a picked one,
  // and a supplied `size` is a claim. Totals are kept per company and adjusted for anything being replaced,
  // so importing the same export twice still changes nothing.
  const totals = new Map();
  const totalFor = (companyId) => {
    if (!totals.has(companyId)) totals.set(companyId, attachmentTotals(db, companyId).bytes);
    return totals.get(companyId);
  };
  for (const row of snapshot.files) {
    if (!row || !row.id || !row.data) { skipped += 1; continue; }
    const existing = db.get('files', row.id);
    const size = dataUrlBytes(row.data);
    if (!size) { refused.push({ name: row.name || row.id, reason: 'no contents could be read' }); skipped += 1; continue; }
    if (size > MAX_FILE_BYTES) {
      refused.push({ name: row.name || row.id, reason: `it is ${formatBytes(size)}, over the ${formatBytes(MAX_FILE_BYTES)} limit for one file` });
      skipped += 1;
      continue;
    }
    const companyId = row.companyId || existing?.companyId || null;
    if (companyId) {
      const held = totalFor(companyId);
      const replacing = existing && existing.companyId === companyId ? dataUrlBytes(existing.data) : 0;
      if (held - replacing + size > MAX_TOTAL_BYTES) {
        refused.push({ name: row.name || row.id, reason: `this company file would then hold more than ${formatBytes(MAX_TOTAL_BYTES)} of attachments` });
        skipped += 1;
        continue;
      }
      totals.set(companyId, held - replacing + size);
    }
    if (existing && existing.data && existing.data === row.data) { skipped += 1; continue; }
    db.put('files', { ...row, size }, { silent: true });
    if (existing) updated += 1;
    else added += 1;
  }
  db.notify({ collection: 'files', action: 'import', added, updated });
  return { added, updated, skipped, refused };
}
