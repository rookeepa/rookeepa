/**
 * The logo is two colours per theme, and every place the site points at it must exist.
 *
 * A delivered asset pack carries claims about itself in a README. These tests check the
 * pixels instead, so a future re-export that drifts off the palette, or a rename that
 * leaves a broken reference, fails the build rather than showing a hole in a page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colourCensus } from '../scripts/png-colours.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KANGAROO = join(ROOT, 'app/assets/kangaroo');

// The palette values the mark is allowed to use, taken from palettes.css.
const THEMES = {
  light: { ink: '#00843d', fill: '#f2b800' },
  dark: { ink: '#f2f5fa', fill: '#0a1430' },
};
const SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];

test('the transparent logo uses only its two palette colours, at every size', () => {
  for (const [theme, { ink, fill }] of Object.entries(THEMES)) {
    for (const size of SIZES) {
      const file = join(KANGAROO, theme, `kangaroo-${theme}-${size}.png`);
      assert.ok(existsSync(file), `${theme}/${size}: file is missing`);
      const colours = colourCensus(file).map((c) => c.colour);
      const unexpected = colours.filter((c) => c !== 'transparent' && c !== ink && c !== fill);
      assert.deepEqual(unexpected, [], `${theme}/${size}: colours outside the palette: ${unexpected.join(', ')}`);
      // Both colours must actually be painted, or the mark has silently become a blob.
      assert.ok(colours.includes(ink), `${theme}/${size}: the ink colour is never used`);
      assert.ok(colours.includes(fill), `${theme}/${size}: the fill colour is never used`);
    }
  }
});

test('the app icons are opaque and on-palette', () => {
  for (const [theme, { ink, fill }] of Object.entries(THEMES)) {
    for (const size of [180, 192, 512]) {
      const file = join(KANGAROO, theme, `app-icon-${size}.png`);
      assert.ok(existsSync(file), `${theme}/app-icon-${size}: file is missing`);
      const colours = colourCensus(file).map((c) => c.colour);
      assert.ok(!colours.includes('transparent'), `${theme}/app-icon-${size}: an app icon should be opaque`);
      const unexpected = colours.filter((c) => c !== ink && c !== fill);
      assert.deepEqual(unexpected, [], `${theme}/app-icon-${size}: colours outside the palette: ${unexpected.join(', ')}`);
    }
  }
});

test('the favicons are real, non-empty icon files', () => {
  for (const theme of Object.keys(THEMES)) {
    const file = join(KANGAROO, theme, 'favicon.ico');
    assert.ok(existsSync(file), `${theme}/favicon.ico is missing`);
    const buf = readFileSync(file);
    assert.equal(buf.readUInt16LE(0), 0, `${theme}/favicon.ico: not an icon file`);
    assert.ok(buf.length > 1000, `${theme}/favicon.ico: suspiciously small (${buf.length} bytes)`);
    assert.ok(buf.readUInt16LE(4) >= 1, `${theme}/favicon.ico: claims no images`);
  }
});

test('every kangaroo asset the pages reference exists on disk', () => {
  // A reference resolves against the file that makes it: the landing page sits at the
  // repository root and reaches into app/, while the app's own files sit beside the assets.
  // Checking every reference against one base is how a broken path slips through.
  const sources = [
    ['index.html', ROOT],
    ['app/index.html', join(ROOT, 'app')],
    ['app/main.js', join(ROOT, 'app')],
    ['app/styles.css', join(ROOT, 'app')],
  ];
  let checked = 0;
  for (const [rel, base] of sources) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const refs = new Set();
    for (const m of text.matchAll(/(?:app\/)?assets\/kangaroo\/[\w./-]+/g)) {
      // main.js writes `...-${size}.png`; the literal scan stops at the brace, leaving a
      // half-path that is not a real reference. The template branch below adds the real ones.
      if (!m[0].endsWith('-') && !m[0].endsWith('/')) refs.add(m[0]);
    }
    // main.js builds its paths from a template, so expand the sizes it actually asks for.
    for (const m of text.matchAll(/kangaroo-(?:light|dark)-\$\{size\}/g)) {
      void m;
      for (const size of [64, 512]) {
        refs.add(`assets/kangaroo/light/kangaroo-light-${size}.png`);
        refs.add(`assets/kangaroo/dark/kangaroo-dark-${size}.png`);
      }
    }
    for (const ref of refs) {
      checked++;
      assert.ok(existsSync(join(base, ref)), `${rel} references ${ref}, which does not exist`);
    }
  }
  assert.ok(checked >= 8, `expected several asset references, found ${checked}`);
});

test('the theme icon script follows the app theme, and the CSS switches variant without JavaScript', () => {
  const js = readFileSync(join(KANGAROO, 'theme-icons.js'), 'utf8');
  assert.ok(/data-theme/.test(js), 'theme-icons.js does not read the theme attribute');
  const css = readFileSync(join(KANGAROO, 'kangaroo.css'), 'utf8');
  assert.ok(/\[data-theme="dark"\]/.test(css), 'kangaroo.css does not switch on an explicit dark theme');
  assert.ok(/prefers-color-scheme: dark/.test(css), 'kangaroo.css does not follow the system preference');
  // The landing page must keep working with JavaScript disabled, so its icon switching
  // has to be the CSS `media` attribute on the link tags.
  const landing = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(!/<script/i.test(landing), 'the landing page has grown a script tag');
  assert.ok(/rel="icon"[^>]*media="\(prefers-color-scheme: dark\)"/.test(landing),
    'the landing page has no dark-theme favicon');
});
