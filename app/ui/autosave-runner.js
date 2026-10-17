import { exportCompany } from '../core/backup.js';
import { exportAttachments } from '../core/attachments.js';
import { recallFolder, folderPermission, saveToFolder } from '../core/autosave.js';

/*
 * The one owner of the automatic-backup timer.
 *
 * It lives outside the settings screen for two reasons. The timer has to keep running when that screen is
 * closed — and, more importantly, it has to save whatever company is open at the moment it fires. The screen's
 * own version closed over the company that was open the first time Settings was rendered, so switching
 * companies and waiting produced a backup of the wrong one; if that company had since been deleted, the save
 * wrote a file with a company's name and no companies in it, which cannot be restored.
 *
 * The shell passes a getter, not a snapshot, and it is called at fire time.
 */

let timer = null;
let handle = null;
let minutes = 15;
let last = null;
let busy = false;
let getContext = () => ({ db: null, companyId: null, company: null });
const listeners = new Set();

export function autosaveState() {
  return { handle, minutes, last, scheduled: !!timer };
}

export function onAutosaveChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of [...listeners]) {
    try { fn(autosaveState()); } catch { /* a listener failing is not a save failing */ }
  }
}

/** Called once by the shell, at boot: it finds the remembered folder and schedules with it. */
export async function startAutosave(get) {
  if (typeof get === 'function') getContext = get;
  try { handle = await recallFolder(); } catch { handle = null; }
  reschedule();
  return autosaveState();
}

export function setHandle(next) {
  handle = next || null;
  reschedule();
}

export function setMinutes(next) {
  const n = Number(next);
  minutes = Number.isFinite(n) && n > 0 ? n : 15;
  reschedule();
}

function reschedule() {
  if (timer) { clearInterval(timer); timer = null; }
  if (handle && minutes > 0) {
    timer = setInterval(() => {
      // Quietly: nobody is watching, and a failed unattended save should not throw across a timer.
      saveNow({ quiet: true }).catch(() => {});
    }, minutes * 60 * 1000);
  }
  emit();
}

/**
 * One save into the folder, for a company read now rather than remembered.
 *
 * Returns what was written, or null when there was nothing to do. Throws only when the person asked for it
 * and it could not be done, so the screen can say why.
 */
export async function saveNow({ quiet = false } = {}) {
  if (!handle) {
    if (quiet) return null;
    throw new Error('Choose a folder first.');
  }
  if (busy) return null;
  busy = true;
  try {
    const permission = await folderPermission(handle, { request: !quiet });
    if (permission !== 'granted') {
      if (quiet) return null;
      throw new Error('The folder needs permission again — choose it again to allow writing.');
    }
    const { db, companyId, company } = getContext() || {};
    // No company file open, or the one that was open has been deleted: there is nothing honest to write.
    if (!db || !companyId || !company) return null;
    const books = exportCompany(db, companyId);
    const attachments = company.attachmentsEnabled === false ? null : exportAttachments(db, companyId);
    const out = await saveToFolder(handle, { company, books, attachments });
    last = out.at;
    emit();
    return out;
  } finally {
    busy = false;
  }
}
