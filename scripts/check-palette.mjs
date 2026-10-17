// Verify the palettes land in the running app: computed token values in all four
// theme paths (system light/dark and an explicit choice each way), then screenshots
// of real screens in both palettes.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { newTab, sleep, ensureChrome, closeTabs } from './cdp.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:5173/app/';
const SHOTS = process.argv[3] || '/tmp/palette-shots';
mkdirSync(SHOTS, { recursive: true });
await ensureChrome();

const s = await newTab('about:blank');
await s.init();
await s.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 2, mobile: false });

// Same boot sequence the browser suite uses: the harness profile keeps its IndexedDB
// between runs, so clear the origin first or a company from an earlier run is still
// there and the welcome screen never appears.
const origin = new URL(BASE).origin;
await closeTabs((t) => t.url.startsWith(origin));
await sleep(400);
await s.send('Storage.enable').catch(() => {});
await s.clearStorage(origin);
let booted = false;
for (let attempt = 1; attempt <= 3 && !booted; attempt++) {
  await s.goto(`${BASE}#/dashboard`);
  try { await s.waitFor(`return !!document.querySelector('.welcome')`, { timeout: 15000 }); booted = true; }
  catch { console.log(`  boot attempt ${attempt}: nothing rendered, retrying`); await sleep(800); }
}
if (!booted) throw new Error('the app did not reach its first-run screen');

await s.clickText('Explore with demo data', { tag: 'button' });
await s.waitFor(`return !!document.querySelector('.sidebar')`, { timeout: 25000 });
await sleep(1500);
console.log('demo company loaded\n');

const read = () => s.evaluate(`
  const cs = getComputedStyle(document.documentElement);
  const names = ['bg','surface','surface-2','surface-3','border','text','text-muted','text-faint','accent','accent-strong','accent-contrast','positive','negative','warn','info','table-head','table-head-ink','sidebar-bg','sidebar-muted','series-1','series-2','series-3','seq-3','div-mid'];
  const o = {};
  for (const n of names) o[n] = cs.getPropertyValue('--' + n).trim();
  o.__attr = document.documentElement.getAttribute('data-theme') || '(system)';
  return o;
`);

const setTheme = async (attr, media) => {
  await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: media }] });
  await s.evaluate(`document.documentElement.${attr ? `setAttribute('data-theme', '${attr}')` : "removeAttribute('data-theme')"}; return 1;`);
  await sleep(350);
  return read();
};

const green = { bg: '#FAF8F0', surface: '#FFFFFF', 'surface-2': '#F4F1E2', 'surface-3': '#E2DCC3', border: '#E2DCC3', text: '#13261B', 'text-muted': '#4A5D51', 'text-faint': '#6B786F', accent: '#00843D', 'accent-strong': '#0B4F2C', 'accent-contrast': '#FFFFFF', positive: '#00843D', negative: '#C8312F', warn: '#8A6500', info: '#0B4F2C', 'table-head': '#00843D', 'table-head-ink': '#FFFFFF', 'sidebar-bg': '#0B4F2C', 'sidebar-muted': '#A9C9B4', 'series-1': '#00843D', 'series-2': '#F2B800', 'series-3': '#0B4F2C', 'seq-3': '#9CC266', 'div-mid': '#EFECE0' };
const flag = { bg: '#0A1430', surface: '#111E42', 'surface-2': '#18285A', 'surface-3': '#1C2E66', border: '#26386E', text: '#F2F5FA', 'text-muted': '#A9B4CC', 'text-faint': '#7E8CAE', accent: '#4F8DFF', 'accent-strong': '#9EC0FF', 'accent-contrast': '#0A1430', positive: '#3FD49A', negative: '#FF4D5E', warn: '#F2B800', info: '#9EC0FF', 'table-head': '#18285A', 'table-head-ink': '#A9B4CC', 'sidebar-bg': '#111E42', 'sidebar-muted': '#8C97B3', 'series-1': '#F2F5FA', 'series-2': '#FF4D5E', 'series-3': '#4F8DFF', 'seq-3': '#4F8DFF', 'div-mid': '#2A3558' };

let bad = 0;
function compare(label, got, want) {
  const wrong = Object.entries(want).filter(([k, v]) => (got[k] || '').toUpperCase() !== v.toUpperCase());
  console.log(`${wrong.length ? 'FAIL' : 'ok  '} ${label}  (attribute: ${got.__attr})`);
  for (const [k, v] of wrong) { console.log(`       --${k}: expected ${v}, got ${got[k]}`); bad++; }
}

// Every combination a user can actually be in.
compare('system preference dark  -> flag palette', await setTheme(null, 'dark'), flag);
compare('explicit dark            -> flag palette', await setTheme('dark', 'dark'), flag);
compare('explicit light over a dark system preference', await setTheme('light', 'dark'), green);
compare('system preference light  -> green and gold', await setTheme(null, 'light'), green);

// Screenshots of real screens in both palettes.
for (const [name, attr, media] of [['dark', 'dark', 'dark'], ['light', 'light', 'light']]) {
  await setTheme(attr, media);
  for (const [view, hash] of [['dashboard', '#/dashboard'], ['sales', '#/sales'], ['report-pnl', '#/reports/pnl']]) {
    await s.evaluate(`location.hash = '${hash}'; return 1;`);
    await sleep(1100);
    await s.screenshot(join(SHOTS, `${name}-${view}.png`));
  }
  console.log(`  shot ${name}: dashboard, sales, pnl`);
}

/* ------------------------------------------------------------------ contrast audit
   Walk every visible element that renders text, work out what it is actually drawn on
   (compositing translucent backgrounds up the tree), and check the pair against WCAG AA.
   Token values matching the palette says nothing about whether the combinations the app
   builds from them are readable, and the app builds a lot: pills from a colour plus its
   own tint, hints on the third surface, badges on chips. */
const AUDIT = `
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  const pageBg = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  const out = [];
  const path = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');

  for (const el of document.querySelectorAll('body *')) {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim().length > 1).map((n) => n.textContent.trim()).join(' ');
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.5) continue;
    if (!el.getClientRects().length) continue;
    const fg = parse(cs.color); if (!fg) continue;
    // Composite translucent backgrounds up the tree until something is opaque.
    let bg = pageBg, node = el;
    const stack = [];
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      if (c && c.a >= 1) break;
      node = node.parentElement;
    }
    for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg);
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r < need) out.push({ el: path(el), text: own.slice(0, 42), size: Math.round(size), weight, ratio: Math.round(r * 100) / 100, need });
  }
  return out;
`;

let violations = 0;
// Audit every screen, not just the ones being photographed: a lower-contrast pairing
// tends to live on whichever screen nobody looked at.
const AUDIT_VIEWS = [['dashboard', '#/dashboard'], ['sales', '#/sales'], ['purchases', '#/purchases'], ['contacts', '#/contacts'], ['items', '#/items'], ['banking', '#/banking'], ['recurring', '#/recurring'], ['journal', '#/journal'], ['accounts', '#/accounts'], ['report-pnl', '#/reports/pnl'], ['report-pnl-cash', '#/reports/pnl?basis=cash'], ['settings', '#/settings']];

// States that only exist after an action. A banner that appears in exactly one situation
// (another tab holds the write lease) hid a 1.02:1 text pairing from this audit for a whole
// round. If a state is reachable in the app, the audit has to reach it too.
const AUDIT_STATES = [
  ['new document form', async () => {
    await s.evaluate(`location.hash = '#/sales'; return 1;`);
    await sleep(800);
    await s.clickText('New invoice', { tag: 'button' });
    await sleep(900);
  }],
  ['read-only in this tab', async () => {
    // Another tab holds the write lease. Forge it, then make this tab re-read it: the app notices a
    // foreign lease only when something tells it to look — a storage event from the other tab, or
    // its own heartbeat. This used to be triggered by reloading the page, and that raced the app's
    // own claim on a CI runner: sometimes the reloaded tab took the lease straight back, the state
    // was never reached, and the audit timed out instead of auditing it. Asking the lease directly
    // is the same code path a real second tab triggers, without the race.
    await s.evaluate(`
      localStorage.setItem('rookeepa:writer-lease', JSON.stringify({ tabId: 'another-tab', at: Date.now() }));
      if (window.__rookeepa && window.__rookeepa.state && window.__rookeepa.state.lease) {
        window.__rookeepa.state.lease.inspect();
      }
      return 1;
    `);
    await s.waitFor(`return /Read-only in this tab/.test(document.body.textContent)`, { timeout: 15000 });
    await sleep(400);
  }],
];

for (const [name, attr, media] of [['dark', 'dark', 'dark'], ['light', 'light', 'light']]) {
  await setTheme(attr, media);
  for (const [view, hash] of AUDIT_VIEWS) {
    await s.evaluate(`location.hash = '${hash}'; return 1;`);
    await sleep(900);
    const found = await s.evaluate(AUDIT);
    for (const v of found) {
      violations++;
      console.log(`  ${name}/${view}: ${v.el} ${v.size}px/${v.weight} — ${v.ratio}:1 needs ${v.need} — "${v.text}"`);
    }
  }
  for (const [state, reach] of AUDIT_STATES) {
    await reach();
    const found = await s.evaluate(AUDIT);
    for (const v of found) {
      violations++;
      console.log(`  ${name}/${state}: ${v.el} ${v.size}px/${v.weight} — ${v.ratio}:1 needs ${v.need} — "${v.text}"`);
    }
  }
  // Clear the forged lease and the open form before the next theme.
  await s.evaluate(`localStorage.removeItem('rookeepa:writer-lease'); return 1;`);
  await s.goto(`${BASE}#/dashboard`);
  await sleep(700);
}
console.log(violations ? `\n${violations} text pair(s) below AA` : '\ncontrast audit: every visible text element clears AA in both palettes');

console.log(bad ? `\n${bad} token value(s) did not match the palette` : 'every token matches the intended palette in all four paths');
console.log('errors:', JSON.stringify((s.errors() || []).slice(0, 3)));
s.close();
process.exit(bad || violations ? 1 : 0);
