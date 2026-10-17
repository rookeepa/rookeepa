/**
 * Rookeepa — a tiny Chrome DevTools Protocol driver.
 *
 * Used by scripts/smoke.mjs to drive the real app in a real browser without
 * pulling in Playwright or Puppeteer. Node 22 has fetch and WebSocket built in,
 * so this file has no dependencies at all.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Find a Chromium-family browser. Distributions and CI images disagree about the binary
 * name, and a check that cannot find one should say what it looked for rather than
 * assume a single path. CHROME_PATH wins if it is set.
 */
function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'headless_shell',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes('/')) { if (existsSync(c)) return c; continue; }
    const which = spawnSync('which', [c], { encoding: 'utf8' });
    if (which.status === 0 && (which.stdout || '').trim()) return which.stdout.trim();
  }
  return process.env.CHROME_PATH || 'google-chrome';
}

export const CHROME = resolveChrome();
export const CHROME_TRIED = [
  'CHROME_PATH', 'Google Chrome (macOS)', 'Chromium (macOS)', '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
];

/** Extra flags for the browser, e.g. CHROME_FLAGS="--no-sandbox" in a container. */
const EXTRA_FLAGS = (process.env.CHROME_FLAGS || '').split(/\s+/).filter(Boolean);

/** How long to wait for a freshly started browser to accept a tab. A cold CI container can
 *  be far slower than a warm laptop, and waiting too little turns slowness into a failure. */
const START_TIMEOUT_MS = Number(process.env.CHROME_START_TIMEOUT_MS || 45000);

const PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = process.env.CDP_PROFILE || join(tmpdir(), 'rookeepa-smoke-chrome');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint(path = '/json/version') {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * A browser that answers on the debugging port is not necessarily one that works: an
 * instance midway through shutting down still responds. Open and close a throwaway tab
 * to prove it can actually do the job.
 */
async function usable() {
  try {
    let res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    if (!res.ok) res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`);
    if (!res.ok) return false;
    const tab = await res.json();
    if (!tab || !tab.id) return false;
    await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`);
    return true;
  } catch {
    return false;
  }
}

/** Kill any browser left over from an earlier run against this harness profile. */
function killStaleBrowsers() {
  try {
    spawnSync('pkill', ['-f', PROFILE], { stdio: 'ignore' });
  } catch { /* nothing running, or pkill unavailable */ }
}

/** Start headless Chrome if it is not already listening, and wait for it. */
export async function ensureChrome({ headless = true } = {}) {
  if (await endpoint() && await usable()) return;

  // A port that answers but cannot open a tab is a browser on its way out — usually the
  // previous run's instance shutting down. Two instances sharing one profile wreck
  // IndexedDB, and the symptom is a blank page that looks exactly like an app bug, so
  // clear any stale instance before starting our own.
  killStaleBrowsers();
  await sleep(700);
  if (await endpoint() && await usable()) return;

  if (!existsSync(CHROME)) {
    throw new Error(`No browser found. Tried: ${CHROME_TRIED.join(', ')}. Set CHROME_PATH to your browser binary.`);
  }
  mkdirSync(PROFILE, { recursive: true });
  // Keep the browser's own output. When it refuses to start — a container, a sandbox, a
  // missing library — its stderr is the only thing that says why, and discarding it turns
  // a one-line fix into guesswork.
  const logPath = join(PROFILE, 'browser-output.log');
  let logFd;
  try { logFd = openSync(logPath, 'a'); } catch { logFd = 'ignore'; }
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-dev-shm-usage',
    '--window-size=1440,1000',
    '--hide-scrollbars',
    ...EXTRA_FLAGS,
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  let answered = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const child = spawn(CHROME, args, { detached: true, stdio: ['ignore', 'ignore', logFd] });
    child.unref();
    answered = false;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await endpoint()) answered = true;
      if (await usable()) {
        if (typeof logFd === 'number') { try { closeSync(logFd); } catch { /* fine */ } }
        return;
      }
      await sleep(250);
    }
    // A cold container can take a long time to open the port, and one failed launch should
    // not fail a whole build: clear it and try once more before giving up.
    if (attempt === 1) {
      killStaleBrowsers();
      await sleep(2500);
    }
  }
  if (typeof logFd === 'number') { try { closeSync(logFd); } catch { /* fine */ } }
  let tail = '(nothing was written)';
  try { tail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-12).join('\n      '); } catch { /* keep the default */ }
  throw new Error(
    'Chrome never became usable, twice.\n'
    + `      port answered: ${answered}\n`
    + `      command: ${CHROME} ${args.slice(0, 3).join(' ')} …\n`
    + `      waited: ${START_TIMEOUT_MS}ms per attempt\n`
    + `      last output:\n      ${tail}`,
  );
}

export async function closeTab(targetId) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${targetId}`);
    await sleep(150);
  } catch { /* ignore */ }
}

/**
 * Close leftover page targets (from an earlier crashed run, say).
 *
 * This matters: a tab still holding the origin's IndexedDB open makes the next
 * `Storage.clearDataForOrigin` pending, and a pending delete blocks the next
 * `indexedDB.open()`. The symptom is a blank page that looks like an app bug.
 */
export async function closeTabs(predicate = () => true) {
  await ensureChrome();
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  let closed = 0;
  for (const t of targets) {
    if (t.type !== 'page' || !t.url || t.url === 'about:blank') continue;
    if (!predicate(t)) continue;
    await closeTab(t.id);
    closed++;
  }
  return closed;
}

export async function newTab(url = 'about:blank') {
  await ensureChrome();
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Could not open a tab: ${res.status} ${await res.text()}`);
  const target = await res.json();
  const session = new Session(target.webSocketDebuggerUrl, target.id);
  await session.connect();
  return session;
}

class Session {
  constructor(wsUrl, targetId) {
    this.wsUrl = wsUrl;
    this.targetId = targetId;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.events = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', (e) => reject(new Error(`CDP socket error: ${e.message || 'unknown'}`)));
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.method || ''})`));
          else res(msg.result);
          return;
        }
        if (msg.method) {
          this.events.push(msg);
          const list = this.handlers.get(msg.method) || [];
          for (const fn of list) fn(msg.params);
        }
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    // Without this, Chrome happily serves a cached module and a fix looks like
    // it did not work. Verification must always see the current files.
    await this.send('Network.enable').catch(() => {});
    await this.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
    this.problems = [];
    this.on('Runtime.exceptionThrown', (p) => {
      this.problems.push(`uncaught: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`);
    });
    this.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        this.problems.push(`console.error: ${(p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
      }
    });
    this.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') this.problems.push(`log: ${p.entry.text}`);
    });
    return this;
  }

  async goto(url, { waitFor = 'document.readyState === "complete"' } = {}) {
    await this.send('Page.navigate', { url });
    await this.waitFor(waitFor, { timeout: 15000 });
    return this;
  }

  async waitFor(expression, { timeout = 10000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression);
      if (last) return last;
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for: ${expression}${last === false ? ' (condition false)' : ''}`);
  }

  /**
   * Evaluate in the page and return the value.
   * Accepts either a bare expression ('document.title') or a statement block
   * that ends with a return ('const x = 1; return x;').
   */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const trimmed = String(expression).trim();
    const looksLikeStatements = /^(return|const|let|var|if|for|while|try|await|throw|\{|\/\/|\/\*|;)/.test(trimmed)
      || trimmed.includes(';')
      || trimmed.includes('\n');
    const body = looksLikeStatements ? trimmed : `return (${trimmed});`;
    const wrapped = /\bawait\b/.test(body) ? `(async () => { ${body} })()` : `(() => { ${body} })()`;
    const res = await this.send('Runtime.evaluate', {
      expression: wrapped,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Page error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  async click(selector, { nth = 0 } = {}) {
    const ok = await this.evaluate(`
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const node = nodes[${nth}];
      if (!node) return false;
      node.scrollIntoView({ block: 'center' });
      node.click();
      return true;
    `);
    if (!ok) throw new Error(`Nothing to click for selector: ${selector}`);
    await sleep(120);
    return this;
  }

  /** Click the first element whose text matches, optionally within a container. */
  async clickText(text, { within = 'body', tag = '*' } = {}) {
    const ok = await this.evaluate(`
      const root = document.querySelector(${JSON.stringify(within)}) || document;
      const wanted = ${JSON.stringify(text)}.trim().toLowerCase();
      const nodes = [...root.querySelectorAll(${JSON.stringify(tag)})];
      const node = nodes.find((n) => n.textContent.trim().toLowerCase() === wanted)
        || nodes.find((n) => n.textContent.trim().toLowerCase().includes(wanted));
      if (!node) return false;
      node.scrollIntoView({ block: 'center' });
      node.click();
      return true;
    `);
    if (!ok) throw new Error(`Nothing to click with text: ${text} (within ${within})`);
    await sleep(140);
    return this;
  }

  /** Type a value into an input the way the app expects (input + change events). */
  async fill(selector, value, { nth = 0 } = {}) {
    const ok = await this.evaluate(`
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const node = nodes[${nth}];
      if (!node) return false;
      const setter = Object.getOwnPropertyDescriptor(node.constructor.prototype, 'value')?.set;
      if (setter) setter.call(node, ${JSON.stringify(String(value))}); else node.value = ${JSON.stringify(String(value))};
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    `);
    if (!ok) throw new Error(`Nothing to fill for selector: ${selector}`);
    await sleep(90);
    return this;
  }

  async selectOption(selector, value, { nth = 0 } = {}) {
    const ok = await this.evaluate(`
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const node = nodes[${nth}];
      if (!node) return false;
      const wanted = ${JSON.stringify(String(value))};
      const opt = [...node.options].find((o) => o.value === wanted)
        || [...node.options].find((o) => o.textContent.trim().toLowerCase().includes(wanted.toLowerCase()));
      if (!opt) return false;
      node.value = opt.value;
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);
    if (!ok) throw new Error(`Could not select ${value} in ${selector}`);
    await sleep(120);
    return this;
  }

  async text(selector = 'body') {
    return this.evaluate(`return (document.querySelector(${JSON.stringify(selector)}) || {}).textContent || '';`);
  }

  async count(selector) {
    return this.evaluate(`return document.querySelectorAll(${JSON.stringify(selector)}).length;`);
  }

  /**
   * Wipe everything the page stored for this origin.
   *
   * Do NOT do this from inside the page: `indexedDB.deleteDatabase()` fires
   * 'blocked' while the app holds its own connection open, and the pending
   * delete then blocks the next `indexedDB.open()`, leaving a blank screen.
   */
  async clearStorage(origin) {
    await this.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    return this;
  }

  /** Navigate for real, even if only the hash changes. */
  async reload(url) {
    await this.send('Page.navigate', { url: 'about:blank' });
    await sleep(120);
    return this.goto(url);
  }

  async screenshot(path, { fullPage = false } = {}) {    const params = { format: 'png' };
    if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  /** Console/page errors seen since init(). */
  errors() {
    return this.problems || [];
  }

  clearErrors() {
    this.problems = [];
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
