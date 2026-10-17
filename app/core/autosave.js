/**
 * Saving into a folder you choose.
 *
 * The browser will not let a page write wherever it likes, and this app has no server to do it for you. What
 * *is* possible — in Chrome and Edge, on a desktop — is the File System Access API: you pick a folder once,
 * the page is handed a handle to it, and it can write there while it is open. Two consequences follow and
 * neither can be engineered away:
 *
 *  - **the page has to be open.** There is no background process, so "automatic" means "while Rookeepa is
 *    open", and a save that was due while the browser was closed simply happens next time;
 *  - **Safari and Firefox have no such API.** There the honest answer is the manual export, and the screen
 *    says so rather than offering a button that cannot work.
 *
 * The folder handle is kept in its own little database, deliberately not in the company file: a handle is not
 * JSON, so it could not survive a backup, and a backup that cannot be restored is worse than one that is
 * plain.
 */

const HANDLE_DB = 'rookeepa-autosave';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'folder';
const MACHINE_KEY = 'machine';

/** Whether this browser can do it at all. */
export function folderSupported() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/** What gets written, and what it is called. One file for the books, one for the files. */
export function autosaveFileNames(company, slugify, tag) {
  const slug = slugify(company?.name || 'company');
  const mine = tag ? `-${tag}` : '';
  return { books: `${slug}-books${mine}.json`, attachments: `${slug}-attachments${mine}.json` };
}

/* --------------------------------------------------------------- the handle itself */

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('Could not open the place where the folder is remembered.'));
  });
}

async function putValue(value, key) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(value, key);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(new Error('Could not remember that folder.'));
  });
}

async function putHandle(handle) {
  return putValue(handle, HANDLE_KEY);
}

/**
 * A short tag for this browser.
 *
 * Two computers saving into one folder — the same OneDrive folder, a laptop and a desktop, work and home —
 * must not write over each other, and a folder of files named only by company has no way to tell them apart.
 * The tag is made once and kept here; it is four characters because it is a distinguisher, not a secret.
 */
export async function machineTag() {
  try {
    const db = await openHandleDb();
    const existing = await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(MACHINE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(new Error('Could not read this computer\u2019s tag.'));
    });
    if (existing) return existing;
    const made = Math.random().toString(36).slice(2, 6);
    await putValue(made, MACHINE_KEY);
    return made;
  } catch {
    // No database, no tag: the save still works, it just cannot promise to be distinguishable.
    return 'local';
  }
}

export async function recallFolder() {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(new Error('Could not read the remembered folder.'));
    });
  } catch {
    return null;
  }
}

export async function forgetFolder() {
  const db = await openHandleDb();
  return new Promise((resolve) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

/** Ask for a folder, and remember it. Must be called from a click — the browser insists on a gesture. */
export async function pickFolder() {
  if (!folderSupported()) {
    throw new Error('This browser cannot write to a folder. Chrome or Edge on a desktop can; the export buttons work everywhere.');
  }
  const handle = await globalThis.showDirectoryPicker({ id: 'rookeepa', mode: 'readwrite', startIn: 'documents' });
  // Remembering the handle is a convenience, not the feature. A private window, or a browser that will not
  // store a handle, should still be able to save into the folder for this sitting — and if remembering fails
  // the person would otherwise lose the whole thing to a dialog that appeared to work.
  try {
    await putHandle(handle);
  } catch {
    // Not remembered. The card still shows the folder and still saves; the next visit just asks again.
  }
  return handle;
}

/**
 * Whether the folder is still usable.
 *
 * A handle outlives the page but its permission does not necessarily: 'prompt' means the person has to agree
 * again, and that needs a click, so a timer cannot do it silently.
 */
export async function folderPermission(handle, { request = false } = {}) {
  if (!handle) return 'none';
  const opts = { mode: 'readwrite' };
  if (typeof handle.queryPermission !== 'function') return 'granted';
  const state = await handle.queryPermission(opts);
  if (state === 'granted') return 'granted';
  if (!request || typeof handle.requestPermission !== 'function') return state;
  return handle.requestPermission(opts);
}

/* ------------------------------------------------------------------- writing */

/** Write files into the folder. Anything but a plain object with name/text is refused. */
export async function writeFiles(handle, files) {
  if (!handle || typeof handle.getFileHandle !== 'function') throw new Error('There is no folder to save into.');
  const written = [];
  for (const file of files) {
    if (!file || !file.name || typeof file.text !== 'string') throw new Error('That is not a file to write.');
    const fileHandle = await handle.getFileHandle(file.name, { create: true });
    const stream = await fileHandle.createWritable();
    await stream.write(file.text);
    await stream.close();
    written.push({ name: file.name, bytes: file.text.length });
  }
  return written;
}

/**
 * One save: the books, and the attachments in their own file.
 *
 * The same two exports the manual buttons produce, written under the same names — so a folder of automatic
 * saves and a folder of manual ones are the same thing, and either can be restored.
 */
export async function saveToFolder(handle, { company, books, attachments, tag }) {
  const names = autosaveFileNames(
    company,
    (t) => String(t || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    tag === undefined ? await machineTag() : tag,
  );
  const files = [{ name: names.books, text: JSON.stringify(books, null, 2) }];
  if (attachments) files.push({ name: names.attachments, text: JSON.stringify(attachments, null, 2) });
  const written = await writeFiles(handle, files);
  return { written, at: new Date().toISOString() };
}

/* ------------------------------------------------------------------- reading */

/**
 * The backups a folder holds, newest name first.
 *
 * This is what makes a folder shared between two computers useful rather than dangerous: the files are already
 * there, named by company and by which computer wrote them, and opening the newest one is the whole of "carry
 * on where I left off". Only the newest few are read — a folder that has been saving daily for a year should
 * not cost a year of reading to answer "which is the latest?".
 *
 * A file's contents are returned as well as its summary, unreadable ones are reported rather than thrown on,
 * and nothing here writes anything.
 */
export async function listBackups(handle, { limit = 12 } = {}) {
  if (!handle || typeof handle.values !== 'function') throw new Error('There is no folder to read from.');
  const candidates = [];
  for await (const entry of handle.values()) {
    if (entry.kind === 'file' && /-books.*\.json$/i.test(entry.name)) candidates.push(entry);
  }
  // Ordered by when each file was written, not by its name: names carry a computer's tag, which says nothing
  // about age, so choosing the twelve that sort first could drop the newest one entirely. Asking a handle for
  // its File is cheap — the contents are only read for the handful that survive the cut.
  const dated = [];
  for (const entry of candidates) {
    let modified = 0;
    try { modified = (await entry.getFile()).lastModified || 0; } catch { modified = 0; }
    dated.push({ entry, modified });
  }
  dated.sort((a, b) => (b.modified - a.modified) || b.entry.name.localeCompare(a.entry.name));
  const found = [];
  for (const { entry } of dated.slice(0, limit)) {
    try {
      const file = await entry.getFile();
      const snapshot = JSON.parse(await file.text());
      const company = (snapshot?.data?.companies || [])[0] || null;
      found.push({
        name: entry.name,
        bytes: file.size,
        modified: file.lastModified,
        savedAt: snapshot?.savedAt || null,
        company: company?.name || null,
        entries: Array.isArray(snapshot?.data?.entries) ? snapshot.data.entries.length : null,
        snapshot,
      });
    } catch {
      found.push({ name: entry.name, bytes: 0, modified: 0, unreadable: true, snapshot: null });
    }
  }
  return found;
}
