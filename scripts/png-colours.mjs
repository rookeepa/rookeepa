/**
 * Read a PNG with nothing but Node's standard library: no image dependency, no build step.
 *
 * The point is to be able to make exact statements about a delivered asset — "this mark
 * contains these two colours and nothing else" — instead of trusting a note that came
 * with it. Run directly to print a census of every colour in a file:
 *
 *   node scripts/png-colours.mjs app/assets/kangaroo/light/kangaroo-light-128.png
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** Decode an 8-bit, non-interlaced PNG into { width, height, colourType, pixels }. */
export function decodePng(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);
  let off = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (interlace) throw new Error(`${path}: interlaced PNGs are not handled`);
  if (depth !== 8) throw new Error(`${path}: only 8-bit PNGs are handled (this is ${depth}-bit)`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`${path}: unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }

  const pixels = [];
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    if (colorType === 6) pixels.push([out[o], out[o + 1], out[o + 2], out[o + 3]]);
    else if (colorType === 2) pixels.push([out[o], out[o + 1], out[o + 2], 255]);
    else if (colorType === 3) {
      const idx = out[o];
      pixels.push([palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2],
        trns && idx < trns.length ? trns[idx] : 255]);
    } else if (colorType === 4) pixels.push([out[o], out[o], out[o], out[o + 1]]);
    else pixels.push([out[o], out[o], out[o], 255]);
  }
  return { width, height, colorType, pixels };
}

const hex = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Every colour in the image, with how many pixels use it, most common first. */
export function colourCensus(path) {
  const img = decodePng(path);
  const counts = new Map();
  for (const [r, g, b, a] of img.pixels) {
    const key = a === 0 ? 'transparent' : hex(r, g, b);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([colour, count]) => ({ colour, count }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node scripts/png-colours.mjs <file.png> [...]');
    process.exit(2);
  }
  for (const p of files) {
    const img = decodePng(p);
    console.log(`\n${p}  ${img.width}x${img.height}  colour type ${img.colorType}`);
    for (const { colour, count } of colourCensus(p)) console.log(`   ${colour.padEnd(14)} ${count} px`);
  }
}
