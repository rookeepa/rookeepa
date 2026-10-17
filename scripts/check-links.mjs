/**
 * Link checker: every link in the shipped pages and the documentation, resolved the way a
 * reader would.
 *
 * Internal targets are checked against the filesystem, resolved relative to the file that
 * links to them — a link written in `docs/` resolves differently from one written at the
 * root, and assuming a single base is exactly how a broken link survives review. Anchors,
 * mailto: and template placeholders are skipped rather than reported as failures.
 *
 * External links are only fetched with --online, because a checker that needs the network
 * cannot run in every environment, and a flaky network should not look like a broken link.
 *
 *   node scripts/check-links.mjs            # internal links only
 *   node scripts/check-links.mjs --online   # also request every external URL
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const online = process.argv.includes('--online');

/** Files whose links a reader can click. */
function sources() {
  const out = ['index.html', 'app/index.html', 'README.md', 'CONTRIBUTING.md', 'LICENSE'];
  const walk = (dir, match) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', '.git', '.smoke'].includes(entry.name)) walk(rel, match); }
      else if (match(entry.name)) out.push(rel);
    }
  };
  walk('docs', (n) => n.endsWith('.md'));
  // The app builds its links in JavaScript too, and those are exactly the ones a source scan
  // of the HTML misses — which is how three of them pointed at files that were never deployed.
  walk('app', (n) => n.endsWith('.js'));
  return out.filter((f) => existsSync(join(ROOT, f)));
}

/**
 * Where a link is resolved from. A link written in a module under app/ is followed by the
 * *page* (app/index.html), not by the module file, so it resolves against the app directory.
 * Resolving it against the module's own directory would invent a broken path that the
 * browser never sees — and would hide the real ones.
 */
function linkBase(rel) {
  if (rel.startsWith('app/') && rel.endsWith('.js')) return join(ROOT, 'app');
  return join(ROOT, dirname(rel));
}

const SKIP = /^(#|mailto:|tel:|data:|javascript:|https?:\/\/127\.0\.0\.1|https?:\/\/localhost|\$)/i;

function linksIn(text, isJs = false) {
  const found = [];
  // Markdown links (documentation only: in JavaScript, `](...)` is a regex fragment).
  if (!isJs) for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/(?:href|src)\s*[:=]\s*["']([^"']+)["']/g)) found.push(m[1]);
  // Paths written as plain strings, which is how the app builds its document links.
  if (isJs) for (const m of text.matchAll(/["']((?:\.\.?\/)[^"'\s]+)["']/g)) found.push(m[1]);
  const urlPattern = isJs
    ? /https?:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s"'`)<>,;]*/g
    : /https?:\/\/[^\s"'`)<>]+/g;
  for (const m of text.matchAll(urlPattern)) found.push(m[0]);

  const out = [];
  for (const raw of found) {
    const link = raw.trim().replace(/[.,;)]+$/, '');
    if (!link || SKIP.test(link)) continue;
    if (/^https?:\/\//i.test(link)) { out.push(link); continue; }
    // An internal target has to look like a path. Without this, a regex literal such as
    // \d{1,2} in a scanner reads as a file name and is reported as a broken link.
    const path = link.split('#')[0].split('?')[0];
    if (!path || !/^[A-Za-z0-9._~/-]+$/.test(path)) continue;
    out.push(link);
  }
  return out;
}

const internal = new Map();   // target -> [where]
const external = new Map();

for (const rel of sources()) {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  // Module specifiers look exactly like relative links and are not links: `import x from
  // './ledger.js'` resolves against the module, not against a browser. Strip those first.
  const text = rel.endsWith('.js')
    ? raw
      .replace(/^\s*import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/gm, '')
      .replace(/^\s*(?:import|export)\s+[\s\S]*?from\s*['"][^'"]+['"];?/gm, '')
      .replace(/^\s*import\s*['"][^'"]+['"];?/gm, '')
      .replace(/import\s*\(\s*['"][^'"]+['"]\s*\)/g, '')
    : raw;
  for (const link of linksIn(text, rel.endsWith('.js'))) {
    if (/^https?:\/\//i.test(link)) {
      if (!external.has(link)) external.set(link, []);
      external.get(link).push(rel);
    } else {
      // A relative link resolves against the page that carries it.
      const base = link.startsWith('/') ? ROOT : linkBase(rel);
      const target = resolve(base, link.split('#')[0].split('?')[0]);
      if (!internal.has(target)) internal.set(target, []);
      internal.get(target).push(`${rel} → ${link}`);
    }
  }
}

let broken = 0;
console.log(`Checked ${internal.size} internal target(s) from ${sources().length} file(s).`);
for (const [target, from] of internal) {
  const ok = existsSync(target) && statSync(target).size > 0;
  if (!ok) {
    broken++;
    console.log(`  BROKEN  ${target.replace(`${ROOT}/`, '')}`);
    for (const f of from) console.log(`           linked from ${f}`);
  }
}
if (!broken) console.log('  every internal link resolves to a file that exists');

console.log(`\n${external.size} external URL(s):`);
if (!online) {
  for (const url of external.keys()) console.log(`  ${url}`);
  console.log('  (run with --online to request each one)');
} else {
  for (const [url, from] of external) {
    let status = 'no response';
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      status = String(res.status);
      if (res.status === 405 || res.status === 403) {
        const get = await fetch(url, { method: 'GET', redirect: 'follow' });
        status = String(get.status);
      }
    } catch (err) {
      status = `failed (${err?.cause?.code || err?.message || 'unknown'})`;
    }
    const ok = /^2|^3/.test(status);
    if (!ok) broken++;
    console.log(`  ${ok ? 'ok     ' : 'BROKEN '} ${status.padEnd(6)} ${url}  (from ${[...new Set(from)].join(', ')})`);
  }
}

console.log(broken ? `\n${broken} broken link(s).` : '\nNo broken links.');
process.exit(broken ? 1 : 0);
