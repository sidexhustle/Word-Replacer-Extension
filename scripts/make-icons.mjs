/**
 * make-icons.mjs — Generates the extension icons (extension/icons/icon{16,32,48,128}.png).
 *
 * Purpose: keep the repo free of binary-editing tools. Draws a rounded blue→violet square with two
 * white "swap" arrows (⇄) using 4×4 supersampling, and encodes PNGs with Node's zlib only.
 * Usage: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4;

/** CRC-32 (PNG chunk checksum). */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Builds one PNG chunk (length, type, data, CRC). */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes RGBA pixels (Uint8Array, size*size*4) as a PNG file buffer. */
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** True when (x, y) in unit coordinates is inside the rounded background square. */
function inRoundedSquare(x, y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** True when (x, y) is inside a horizontal arrow (shaft + triangular head). */
function inArrow(x, y, cy, fromX, toX) {
  const dir = Math.sign(toX - fromX);
  const headLen = 0.2;
  const headHalf = 0.15;
  const shaftHalf = 0.055;
  const headBase = toX - dir * headLen;
  const lo = Math.min(fromX, headBase);
  const hi = Math.max(fromX, headBase);
  if (x >= lo && x <= hi && Math.abs(y - cy) <= shaftHalf) return true;
  const t = (x - headBase) * dir; // 0 at head base … headLen at tip
  return t >= 0 && t <= headLen && Math.abs(y - cy) <= headHalf * (1 - t / headLen);
}

/** Renders one icon size to RGBA. */
function render(size) {
  const px = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxX = 0; pxX < size; pxX++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (pxX + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!inRoundedSquare(x, y)) continue;
          bg++;
          if (inArrow(x, y, 0.36, 0.2, 0.8) || inArrow(x, y, 0.64, 0.8, 0.2)) fg++;
        }
      }
      const n = SAMPLES * SAMPLES;
      const t = (pxX + py) / (2 * size); // diagonal gradient #3b82f6 → #7c3aed
      const base = [0x3b + (0x7c - 0x3b) * t, 0x82 + (0x3a - 0x82) * t, 0xf6 + (0xed - 0xf6) * t];
      const w = bg ? fg / bg : 0;
      const i = (py * size + pxX) * 4;
      px[i] = Math.round(base[0] * (1 - w) + 255 * w);
      px[i + 1] = Math.round(base[1] * (1 - w) + 255 * w);
      px[i + 2] = Math.round(base[2] * (1 - w) + 255 * w);
      px[i + 3] = Math.round((bg / n) * 255);
    }
  }
  return px;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
