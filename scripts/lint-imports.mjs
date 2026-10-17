#!/usr/bin/env node
/*
 * Catches the one defect class that neither the unit tests nor a module-parse check
 * can see: code calling a helper it never imported. Such a call is legal to *parse*
 * and only explodes at runtime — which is exactly how "Receive payment" shipped
 * broken: kit.button() wraps click handlers in a try/catch that turns the
 * ReferenceError into a toast most people would dismiss, while the modal silently
 * rendered with an empty body, so paying or receiving money was impossible.
 *
 * How it works, and why it is built this way:
 *   - Imports, declarations and exports are read from the raw source. Reading scope
 *     from raw text can only ever make this check quieter, never produce a false
 *     alarm, which is the direction a gate should fail in.
 *   - Call sites are found per line, with string/template *content* dropped on that
 *     line first. A cross-line state machine was tried first and silently missed the
 *     real bug the moment a backtick desynced it — an unreliable gate is worse than
 *     no gate, because it hides the very defect it was written for.
 *   - `{ name(args) { ... } }` object method shorthand is a definition, not a call.
 *
 * Known limit (deliberate, fails open): a helper called *only* inside a ${...}
 * interpolation, and nowhere in plain code position, is not reported.
 *
 * Run: node scripts/lint-imports.mjs      (exits 1 on any finding)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const appDir = join(root, 'app');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Block comments only — enough to stop docblocks being read as code. */
function stripBlockComments(src) {
  let out = '';
  let i = 0;
  let inComment = false;
  while (i < src.length) {
    if (inComment) {
      if (src[i] === '*' && src[i + 1] === '/') { inComment = false; i += 2; continue; }
      if (src[i] === '\n') out += '\n';
      i++;
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '*') { inComment = true; i += 2; continue; }
    out += src[i];
    i++;
  }
  return out;
}

/** Blank out string/template content and any trailing line comment. */
function codeOnly(line) {
  let out = '';
  let i = 0;
  let mode = null;
  while (i < line.length) {
    const c = line[i];
    if (mode) {
      if (c === '\\') { i += 2; continue; }
      if (c === mode) { mode = null; i++; continue; }
      i++;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === "'" || c === '"' || c === '`') { mode = c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

function findCalls(src, names) {
  const calls = new Map();
  for (const line of stripBlockComments(src).split('\n')) {
    const cleaned = codeOnly(line);
    if (!cleaned.includes('(')) continue;
    for (const m of cleaned.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)[ \t]*\(/g)) {
      const name = m[1];
      if (!names.has(name)) continue;
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < cleaned.length; i++) {
        if (cleaned[i] === '(') depth++;
        else if (cleaned[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
      }
      if (close !== -1) {
        let a = close + 1;
        while (cleaned[a] === ' ' || cleaned[a] === '\t') a++;
        const before = cleaned.slice(0, m.index).trimEnd().slice(-1);
        if (cleaned[a] === '{' && (before === '{' || before === ',')) continue;
      }
      calls.set(name, (calls.get(name) || 0) + 1);
    }
  }
  return calls;
}

const files = walk(appDir);
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

/** Names exported by each app module, so we only flag calls to our own helpers. */
const exported = new Map();
for (const [file, src] of sources) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  exported.set(file, names);
}
const allExported = new Set([...exported.values()].flatMap((s) => [...s]));
const problems = [];

for (const [file, src] of sources) {
  const own = exported.get(file) || new Set();
  const inScope = new Set();

  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) inScope.add(name);
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from/g)) inScope.add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from/g)) inScope.add(m[1]);
  // destructured dynamic imports, both `= await import(` and `.then(({ x }) =>`
  // (anchored and single-line: a loose `{...}` here latched onto unrelated braces)
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}\n]*)\}\s*=\s*(?:await\s+)?import\(/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().split(':').pop().trim();
      if (name) inScope.add(name);
    }
  }
  for (const m of src.matchAll(/import\([^)\n]*\)\s*\.then\(\s*\(\s*\{([^}\n]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().split(':').pop().trim();
      if (name) inScope.add(name);
    }
  }
  for (const m of src.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) inScope.add(m[1]);
  for (const m of src.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^\.\.\./, '').split(/[=:\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) inScope.add(name);
    }
  }
  for (const m of src.matchAll(/\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[=:\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) inScope.add(name);
    }
  }

  for (const [name, count] of findCalls(src, allExported)) {
    if (own.has(name) || inScope.has(name)) continue;
    problems.push({ file: relative(root, file), name, count });
  }
}

if (problems.length) {
  console.error('Missing-import check FAILED — these calls throw ReferenceError at runtime:\n');
  for (const p of problems) console.error(`  ${p.file}: calls ${p.name}() ${p.count}× but never imports or declares it`);
  console.error('\nImport the name from its module, or destructure it from the dynamic import.');
  process.exit(1);
}
console.log(`Missing-import check passed — ${files.length} modules, every helper call is in scope.`);
