/**
 * generate-icons.mjs
 * Creates icons/icon16.png, icons/icon48.png, icons/icon128.png
 * using only Node.js built-ins (no extra dependencies).
 *
 * Design: purple (#6C63FF) rounded background with a white lightning bolt.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '..', 'icons');
mkdirSync(iconsDir, { recursive: true });

// =============================================================
// Minimal PNG encoder
// =============================================================

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const tBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const combined = Buffer.concat([tBuf, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([lenBuf, tBuf, data, crcBuf]);
}

/**
 * Build a PNG from an RGBA pixel array (row-major, top-to-bottom).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba  - width * height * 4 bytes
 */
function buildPNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Each row: 1 filter byte (None) + 4 bytes per pixel
  const raw = Buffer.allocUnsafe(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      raw[dst]     = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// =============================================================
// Icon renderer
// Draws a purple rounded square with a white "F" monogram.
// =============================================================

const BG  = [0x6c, 0x63, 0xff, 0xff]; // #6C63FF
const FG  = [0xff, 0xff, 0xff, 0xff]; // white
const T   = [0x00, 0x00, 0x00, 0x00]; // transparent

function renderIcon(size) {
  const rgba = new Uint8Array(size * size * 4);

  const r = Math.round(size * 0.2); // corner radius (20 % of size)

  // Helper: distance from nearest corner edge
  function inRoundedRect(x, y) {
    const cx = Math.max(r, Math.min(size - 1 - r, x));
    const cy = Math.max(r, Math.min(size - 1 - r, y));
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  }

  // Paint background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = inRoundedRect(x, y) ? BG : T;
      rgba[i] = px[0]; rgba[i+1] = px[1]; rgba[i+2] = px[2]; rgba[i+3] = px[3];
    }
  }

  // Draw a lightning-bolt '⚡' approximation using filled rectangles
  // Scaled relative to icon size
  const s = size;
  function fill(x1, y1, x2, y2, color) {
    for (let y = Math.max(0, y1); y < Math.min(s, y2); y++) {
      for (let x = Math.max(0, x1); x < Math.min(s, x2); x++) {
        const i = (y * s + x) * 4;
        if (rgba[i + 3] === 0) continue; // outside rounded rect
        rgba[i] = color[0]; rgba[i+1] = color[1]; rgba[i+2] = color[2]; rgba[i+3] = color[3];
      }
    }
  }

  // Lightning bolt: two parallelogram-ish rects
  // Top part: upper-right to middle-left
  // Bottom part: middle-right to lower-left
  const m  = Math.round;
  const p  = 0.18; // padding fraction
  const pad = m(s * p);
  const mid = m(s / 2);
  const t   = m(s * 0.06); // stroke thickness

  // Top triangle / bar
  for (let y = pad; y < mid; y++) {
    const progress = (y - pad) / (mid - pad); // 0 → 1
    const xLeft  = m(s * 0.55 - progress * s * 0.22);
    const xRight = m(s * 0.75 - progress * s * 0.22);
    fill(xLeft, y, xRight, y + 1, FG);
  }
  // Bottom triangle / bar  
  for (let y = mid; y < s - pad; y++) {
    const progress = (y - mid) / (s - pad - mid); // 0 → 1
    const xLeft  = m(s * 0.28 - progress * s * 0.0  + progress * s * 0.0);
    const xRight = m(s * 0.50);
    const lx = m(s * 0.26 + progress * s * 0.01);
    const rx = m(s * 0.46 + progress * s * 0.01);
    fill(lx, y, rx, y + 1, FG);
  }

  // Simpler, cleaner bolt: just use a classic zig-zag path
  // Reset the FG area and redraw
  // Overwrite with a clean bolt geometry
  const pw = Math.max(1, m(s * 0.12)); // stroke width pixels

  // Left side of bolt (upper half)
  for (let y = pad; y <= mid; y++) {
    const t2 = (y - pad) / (mid - pad);
    const cx = m(s * (0.62 - t2 * 0.20));
    fill(cx, y, cx + pw, y + 1, FG);
  }
  // Right side of bolt (upper half)
  for (let y = pad; y <= mid; y++) {
    const t2 = (y - pad) / (mid - pad);
    const cx = m(s * (0.72 - t2 * 0.20));
    fill(cx, y, cx + pw, y + 1, FG);
  }
  // Bottom of upper triangle (horizontal bar at mid)
  fill(m(s*0.42), mid - pw, m(s*0.74), mid, FG);
  // Top of lower triangle (horizontal bar at mid)
  fill(m(s*0.26), mid, m(s*0.58), mid + pw, FG);
  // Left side of bolt (lower half)
  for (let y = mid; y <= s - pad; y++) {
    const t2 = (y - mid) / (s - pad - mid);
    const cx = m(s * (0.28 + t2 * 0.20));
    fill(cx, y, cx + pw, y + 1, FG);
  }
  // Right side of bolt (lower half)
  for (let y = mid; y <= s - pad; y++) {
    const t2 = (y - mid) / (s - pad - mid);
    const cx = m(s * (0.38 + t2 * 0.20));
    fill(cx, y, cx + pw, y + 1, FG);
  }

  return rgba;
}

// =============================================================
// Generate & write
// =============================================================

for (const size of [16, 48, 128]) {
  const rgba = renderIcon(size);
  const png  = buildPNG(size, size, rgba);
  const out  = join(iconsDir, `icon${size}.png`);
  writeFileSync(out, png);
  console.log(`✓  icons/icon${size}.png  (${png.length} bytes)`);
}

console.log('\nAll icons generated successfully.');
