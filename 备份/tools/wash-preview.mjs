/* dev: look at the day card's wash without opening a browser.
 *
 * It lifts the wash code straight out of src/textures.js and runs it in Node, so
 * there is no second copy of the algorithm to drift out of step — only the
 * preview around it (composite + PNG writer) lives here. Prints what each glaze
 * deposited and how long it took, and writes tools/_wash.png:
 *
 *   left   the sheet at tape size, i.e. what the cassette actually shows
 *   right  a 1:1 crop of the margin and head band, where the wash has to hold up
 *
 *   node tools/wash-preview.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/* ------------------------------------------------------- lift the wash out */
const src = readFileSync('src/textures.js', 'utf8');
const grab = (from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to);
  if (a < 0 || b < 0 || b <= a) throw new Error(`markers not found: ${from} / ${to}`);
  return src.slice(a, b);
};
writeFileSync('tools/_wash_extract.mjs', grab('function rng(seed) {', 'export function fbm(')
  + grab('const WASH = { gw:', 'function glazeCanvas(')
  + grab('const DAY_GLAZES = [', 'const DAY_LOAD =')
  + '\nexport { inkWash, washPaper, DAY_GLAZES };\n');
const { inkWash, washPaper, DAY_GLAZES } = await import('./_wash_extract.mjs');

const { gw, gh } = { gw: 448, gh: 276 };
const LOAD = 1.45, DENSITY = 1.9;                // must match src/textures.js
const paper = washPaper(gw, gh, 7);
let ms = 0;
const glazes = DAY_GLAZES.map((G) => {
  const t0 = Date.now();
  const sim = inkWash(gw, gh, G.strokes, { paper, load: LOAD });
  ms += Date.now() - t0;
  let sum = 0, max = 0, ink = 0;
  for (let i = 0; i < sim.dH.length; i++) {
    const v = sim.dH[i] + sim.dL[i];
    sum += v; if (v > max) max = v;
    if (1 - Math.exp(-v * DENSITY) > 0.3) ink++;
  }
  const n = sim.dH.length;
  console.log(`glaze ${G.core.join(',').padEnd(12)} mean ${(sum / n).toFixed(4)}`
    + `  max ${max.toFixed(2)}  cells above 0.3 alpha: ${(100 * ink / n).toFixed(1)}%`);
  return { ...G, ...sim };
});
console.log(`3 glazes: ${ms} ms`);

/* ---------------------------------------------------------------- preview */
const PAPER = [245, 241, 232];
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function composite(tw, th, x0 = 0, y0 = 0, x1 = 1, y1 = 1) {
  const out = new Uint8Array(tw * th * 4);
  const wx0 = 0.132, wx1 = 0.868, wy0 = 0.218, wy1 = 0.815;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const u = x0 + (x / tw) * (x1 - x0), v = y0 + (y / th) * (y1 - y0);
      const gx = Math.min(gw - 1, (u * gw) | 0), gy = Math.min(gh - 1, (v * gh) | 0);
      const i = (y * tw + x) * 4;
      if (u > wx0 && u < wx1 && v > wy0 && v < wy1) { out[i] = out[i + 1] = out[i + 2] = 44; out[i + 3] = 255; continue; }
      let r = PAPER[0], g = PAPER[1], b = PAPER[2];
      for (const G of glazes) {
        const j = gy * gw + gx;
        const h = G.dH[j], l = G.dL[j], total = h + l;
        if (total <= 0) continue;
        const a = 1 - Math.exp(-total * DENSITY);
        const f = h / total;
        const cr = G.halo[0] + (G.core[0] - G.halo[0]) * f;
        const cg = G.halo[1] + (G.core[1] - G.halo[1]) * f;
        const cb = G.halo[2] + (G.core[2] - G.halo[2]) * f;
        r = r * (1 - a) + ((cr * r) / 255) * a;
        g = g * (1 - a) + ((cg * g) / 255) * a;
        b = b * (1 - a) + ((cb * b) / 255) * a;
      }
      out[i] = clamp8(r); out[i + 1] = clamp8(g); out[i + 2] = clamp8(b); out[i + 3] = 255;
    }
  }
  return { buf: out, w: tw, h: th };
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TILE = 470, TH = Math.round((TILE * gh) / gw);
const CW = 470, CH = 560;
const tape = composite(TILE, TH);
const zoom = composite(CW, CH, 0, .06, .235, .60);
const W = TILE + CW, H = Math.max(TH, CH);
const out = new Uint8Array(W * H * 4).fill(255);
for (let y = 0; y < TH; y++) out.set(tape.buf.subarray(y * TILE * 4, (y + 1) * TILE * 4), y * W * 4);
for (let y = 0; y < CH; y++) out.set(zoom.buf.subarray(y * CW * 4, (y + 1) * CW * 4), (y * W + TILE) * 4);
writeFileSync('tools/_wash.png', png(W, H, out));
console.log(`tools/_wash.png  ${W}x${H}  (left: tape size, right: 1:1 crop)`);
