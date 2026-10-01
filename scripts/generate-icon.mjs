#!/usr/bin/env node
/**
 * Generates `media/icon.png` (the marketplace icon) without any dependency.
 *
 * The PNG is written with Node's built-in zlib deflate plus a hand written
 * CRC32 — no image library, no binary download, fully reproducible:
 *
 *   node scripts/generate-icon.mjs
 *
 * The artwork itself is drawn with simple pixel math (rounded square, gradient
 * and three bars), so the repository never contains a binary blob that nobody
 * can regenerate.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const CORNER_RADIUS = 52;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, '..', 'media', 'icon.png');

/** Gradient stops (Dev Wrapped palette). */
const GRADIENT_START = { r: 0x4d, g: 0x9f, b: 0xff };
const GRADIENT_END = { r: 0xa3, g: 0x71, b: 0xf7 };
const BAR_COLOR = { r: 0xf2, g: 0xf6, b: 0xff };

const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) {
    return;
  }
  const index = (y * SIZE + x) * 4;
  const alpha = a / 255;
  const existing = pixels[index + 3] / 255;
  const outAlpha = alpha + existing * (1 - alpha);
  if (outAlpha <= 0) {
    return;
  }
  pixels[index] = Math.round((r * alpha + pixels[index] * existing * (1 - alpha)) / outAlpha);
  pixels[index + 1] = Math.round((g * alpha + pixels[index + 1] * existing * (1 - alpha)) / outAlpha);
  pixels[index + 2] = Math.round((b * alpha + pixels[index + 2] * existing * (1 - alpha)) / outAlpha);
  pixels[index + 3] = Math.round(outAlpha * 255);
}

function inRoundedSquare(x, y, size, radius) {
  const cx = Math.min(Math.max(x + 0.5, radius), size - radius);
  const cy = Math.min(Math.max(y + 0.5, radius), size - radius);
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  return Math.sqrt(dx * dx + dy * dy) <= radius;
}

function mix(start, end, t) {
  return {
    r: Math.round(start.r + (end.r - start.r) * t),
    g: Math.round(start.g + (end.g - start.g) * t),
    b: Math.round(start.b + (end.b - start.b) * t),
  };
}

function roundedBar(x0, y0, width, height, radius, color) {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      const cx = Math.min(Math.max(x + 0.5, x0 + radius), x0 + width - radius);
      const cy = Math.min(Math.max(y + 0.5, y0 + radius), y0 + height - radius);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (Math.sqrt(dx * dx + dy * dy) <= radius) {
        setPixel(x, y, color.r, color.g, color.b, 255);
      }
    }
  }
}

// Background: rounded square with a diagonal blue -> purple gradient.
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    if (!inRoundedSquare(x, y, SIZE, CORNER_RADIUS)) {
      continue;
    }
    const t = Math.min(1, Math.max(0, (x / SIZE) * 0.55 + (y / SIZE) * 0.65));
    const color = mix(GRADIENT_START, GRADIENT_END, t);
    setPixel(x, y, color.r, color.g, color.b, 255);
  }
}

// Bars: three ascending bars plus a baseline, the "wrapped" chart mark.
const baselineY = 196;
const barWidth = 30;
const bars = [
  { x: 62, height: 54 },
  { x: 113, height: 92 },
  { x: 164, height: 132 },
];
for (const bar of bars) {
  roundedBar(bar.x, baselineY - bar.height, barWidth, bar.height, 12, BAR_COLOR);
}
roundedBar(58, baselineY + 10, 140, 12, 6, BAR_COLOR);

/* ------------------------------ PNG encoding ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, png);
console.log(`Wrote ${outputPath} (${SIZE}x${SIZE}, ${png.length} bytes)`);
