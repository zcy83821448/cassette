import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  deterministc value noise (tileable) + derived maps
 * ------------------------------------------------------------------ */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

export function fbm(size, octaves = 4, seed = 7, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, cells = 2;
  for (let o = 0; o < octaves; o++) {
    const r = rng(seed + o * 977);
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = r();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells, y0 = fy | 0, ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      const y1 = (y0 + 1) % cells;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells, x0 = fx | 0, tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const x1 = (x0 + 1) % cells;
        const i00 = g[y0 * cells + x0], i10 = g[y0 * cells + x1];
        const i01 = g[y1 * cells + x0], i11 = g[y1 * cells + x1];
        out[y * size + x] += amp * ((i00 * (1 - sx) + i10 * sx) * (1 - sy) + (i01 * (1 - sx) + i11 * sx) * sy);
      }
    }
    norm += amp; amp *= gain; cells *= 2;
  }
  const k = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

function dataTex(data, size, srgb = false) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // DataTexture defaults to NearestFilter with no mipmaps — on procedural
  // micro-detail that reads as blocky aliasing
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** fine micro-surface normal map — used for soft-touch plastic & paper */
export function normalTex(size = 256, { octaves = 4, seed = 11, strength = 1.5 } = {}) {
  const h = fbm(size, octaves, seed);
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x], v = h[((y + 1) % size) * size + x];
      const nx = (l - r) * strength, ny = (u - v) * strength, nz = 1;
      const il = 1 / Math.hypot(nx, ny, nz), i = (y * size + x) * 4;
      d[i] = (nx * il * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * il * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * il * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  return dataTex(d, size);
}

/** magnetic tape surface: the coating is drawn on in one direction, so the
    grain runs lengthwise. Returns colour / roughness / normal maps that share
    one streak field, so the highlight and the bumpiness line up.
    `cut` is where the tape's cross-section is split: the two cut edges take up
    the tape's thickness over its perimeter (against a 3.81 mm width), which is
    the same fraction the ribbon's own v bands are cut to — RIB_EDGE in
    cassette.js, one number, so the texture and the geometry cannot drift. */
export function tapeMaps(size = 512, cut = 0.02) {
  const r = rng(1234);
  const h = new Float32Array(size * size);

  // streak amplitudes across the width (constant along the length)
  const row = new Float32Array(size);
  let cur = 0.5, tgt = 0.5;
  for (let y = 0; y < size; y++) {
    if (r() > 0.965) tgt = r();
    cur += (tgt - cur) * 0.55;
    row[y] = cur;
  }
  // sweep along the length with occasional joins, then detrend so the tile
  // wraps seamlessly in u (it repeats 60× along the ribbon)
  const line = new Float32Array(size);
  for (let y = 0; y < size; y++) {
    let v = row[y], t = v, run = 0, first = 0;
    for (let x = 0; x < size; x++) {
      if (run-- <= 0) {
        t = row[(y + ((r() * 7 | 0) - 3) + size) % size];
        run = 40 + (r() * 280 | 0);
      }
      v += (t - v) * 0.35;
      if (x === 0) first = v;
      line[x] = v;
    }
    const drift = line[size - 1] - first;
    for (let x = 0; x < size; x++) h[y * size + x] = line[x] - drift * (x / (size - 1));
  }
  const mottle = fbm(size, 4, 77);
  for (let i = 0; i < h.length; i++) h[i] = h[i] * 0.72 + mottle[i] * 0.28;

  // UV bands, matching RIB_V: cut edge | back coating | cut edge | oxide face.
  // Oxide is a near-black brown (albedo ~4%), the back coating a little greyer
  // and much rougher, the cut PET edge lighter and glossier.
  const BAND = [
    { c: [104, 88, 72], coarse: 30, rough: [0.20, 0.34], nrm: 0.6 },   // cut edge
    { c: [58, 48, 41], coarse: 14, rough: [0.58, 0.82], nrm: 1.4 },   // back coating
    { c: [104, 88, 72], coarse: 30, rough: [0.20, 0.34], nrm: 0.6 },   // cut edge
    { c: [46, 34, 27], coarse: 11, rough: [0.26, 0.54], nrm: 1.0 },   // oxide face
  ];
  const bandOf = (v) => (v < cut || (v >= 0.5 && v < 0.5 + cut)) ? 0 : (v < 0.5 ? 1 : 3);

  const col = new Uint8Array(size * size * 4);
  const rgh = new Uint8Array(size * size * 4);
  const nrm = new Uint8Array(size * size * 4);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    const b = BAND[bandOf(y / size)];
    for (let x = 0; x < size; x++) {
      const i = y * size + x, o = i * 4, v = h[i];
      const d = (v - 0.5) * b.coarse * 2;
      col[o] = clamp8(b.c[0] + d);
      col[o + 1] = clamp8(b.c[1] + d * 0.92);
      col[o + 2] = clamp8(b.c[2] + d * 0.85);
      col[o + 3] = 255;
      const rr = (b.rough[0] + (b.rough[1] - b.rough[0]) * v) * 255;
      rgh[o] = rgh[o + 1] = rgh[o + 2] = rr; rgh[o + 3] = 255;
      const nx = (at(x - 1, y) - at(x + 1, y)) * 1.5 * b.nrm;
      const ny = (at(x, y - 1) - at(x, y + 1)) * 1.5 * b.nrm;
      const nz = 1, il = 1 / Math.hypot(nx, ny, nz);
      nrm[o] = (nx * il * 0.5 + 0.5) * 255;
      nrm[o + 1] = (ny * il * 0.5 + 0.5) * 255;
      nrm[o + 2] = (nz * il * 0.5 + 0.5) * 255;
      nrm[o + 3] = 255;
    }
  }
  return {
    map: dataTex(col, size, true),
    roughnessMap: dataTex(rgh, size, false),
    normalMap: dataTex(nrm, size, false),
  };
}
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** grayscale roughness variation */
export function roughTex(size = 512, { lo = 0.4, hi = 0.8, octaves = 5, seed = 5 } = {}) {
  const h = fbm(size, octaves, seed);
  const d = new Uint8Array(size * size * 4);
  for (let i = 0; i < h.length; i++) {
    const v = (lo + (hi - lo) * h[i]) * 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return dataTex(d, size);
}

/* ------------------------------------------------------------------ *
 *  canvas helpers
 * ------------------------------------------------------------------ */
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function tex(c, { srgb = true, aniso = 16, rep = 1 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.repeat.set(rep, rep);
  t.needsUpdate = true;
  return t;
}

/** letter-spaced text (canvas letterSpacing isn't universal) */
export function tracked(ctx, text, x, y, { track = 0, align = 'left' } = {}) {
  const chars = [...text];
  let w = 0;
  for (const ch of chars) w += ctx.measureText(ch).width + track;
  w -= track;
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const ch of chars) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + track; }
  ctx.textAlign = prev;
  return w;
}

/** A run of print measured to fit its box.
 *
 *  This page used to know the title in advance, so `fillText` could just be
 *  pointed at the card. Now the title is whatever file the user picked, and the
 *  card is a fixed 9.52 units wide: a long name ran straight off the edge of the
 *  label and into the thickness of the shell. The size comes down a little
 *  first, and only past a floor does it get cut with an ellipsis — shrinking
 *  alone turns a sentence into unreadable print, and cutting alone throws away a
 *  title that would have fitted two points smaller.
 *
 *  `track` is counted in, because tracked() sets every glyph on its own with
 *  that much air between them, and the last glyph carries none. */
export function fitRun(ctx, text, font, size, maxW, { track = 0, min = 0.62 } = {}) {
  const width = (s) => ctx.measureText(s).width + track * Math.max(0, [...s].length - 1);
  ctx.font = font(size);
  let s = size;
  while (s > size * min + 1e-6 && width(text) > maxW) {
    s = Math.max(size * min, s * 0.94);
    ctx.font = font(s);
  }
  let out = text;
  if (width(out) > maxW) {
    out = '';
    for (const ch of text) {
      if (width(out + ch + '…') > maxW) break;
      out += ch;
    }
    out = out.replace(/\s+$/, '') + '…';
  }
  return { text: out, size: s, w: width(out) };
}

export function grain(ctx, w, h, amount = 0.06, seed = 3) {
  const r = rng(seed);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 255 * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------------ *
 *  watercolour
 * ------------------------------------------------------------------ */

/** smooth closed blob — an ellipse whose radius wobbles on three harmonics
    plus a smoothed per-point jitter, so no two washes dry to the same shape */
function blobPath(g, cx, cy, rx, ry, rot, rnd, wob = 0.2) {
  const n = 64;
  const p0 = rnd() * 6.2832, p1 = rnd() * 6.2832, p2 = rnd() * 6.2832;
  const j = new Float32Array(n);
  for (let i = 0; i < n; i++) j[i] = rnd() - 0.5;
  for (let k = 0; k < 3; k++)
    for (let i = 0; i < n; i++)
      j[i] = (j[(i - 1 + n) % n] + j[i] * 2 + j[(i + 1) % n]) * 0.25;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const px = new Float32Array(n), py = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.2832;
    const k = 1 + wob * (Math.sin(a * 2 + p0) * 0.42 + Math.sin(a * 3 + p1) * 0.30
                       + Math.sin(a * 5 + p2) * 0.20 + j[i] * 1.1);
    const u = Math.cos(a) * rx * k, v = Math.sin(a) * ry * k;
    px[i] = cx + u * cs - v * sn;
    py[i] = cy + u * sn + v * cs;
  }
  g.beginPath();
  g.moveTo((px[n - 1] + px[0]) * 0.5, (py[n - 1] + py[0]) * 0.5);
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    g.quadraticCurveTo(px[i], py[i], (px[i] + px[k]) * 0.5, (py[i] + py[k]) * 0.5);
  }
  g.closePath();
}

/** one pigment mass laid onto the paint layer: a silhouette, a body built from
    two or three passes on the same spot, and the thicker rim the pigment leaves
    where the water pulled back. All of its character comes later from dissolve() —
    a mass drawn here is only its outline and its weight. Narrow + tall makes a
    run of water that drained down the card; wide + shallow makes a band. */
function wash(g, o) {
  const {
    x, y, rx, ry, rot = 0, color = [58, 112, 146], alpha = 0.28, seed = 1,
    wob = 0.20, rim = 0.30, layers = 3,
  } = o;
  const rnd = rng(seed), col = color.join(',');
  g.save();
  for (let i = 0; i < layers; i++) {
    const f = layers > 1 ? i / (layers - 1) : 0;
    const cx = x + (rnd() - 0.5) * rx * 0.5, cy = y + (rnd() - 0.5) * ry * 0.5;
    const s = 1 - f * 0.30;
    blobPath(g, cx, cy, rx * s, ry * s, rot + (rnd() - 0.5) * 0.5, rnd, wob + f * 0.12);
    g.fillStyle = `rgba(${col},${alpha * (0.55 + f * 0.45)})`;
    g.fill();
    // the rim is stroked twice, a wide faint pass under a narrow stronger one.
    // That is what a wash does as it dries — the water retreats to the edge and
    // leaves the pigment banked there — and the dissolve then eats the stroke
    // into fragments, which is the ragged line a wet edge actually has. One
    // single-width stroke reads as a drawn outline instead.
    if (rim > 0) {
      const w0 = Math.max(1, Math.min(rx, ry) * 0.012) + f;
      g.strokeStyle = `rgba(${col},${alpha * rim * 0.5})`;
      g.lineWidth = w0 * 2.4;
      g.stroke();
      g.strokeStyle = `rgba(${col},${alpha * rim * (0.5 + f)})`;
      g.lineWidth = w0;
      g.stroke();
    }
  }
  g.restore();
}

/** what turns flat silhouettes into a wash. Drying paint does not fade evenly:
    where the film is thin it breaks up and leaves the paper bare, and where it
    is thick it stays put. So the noise rides on the paint's own density and the
    product is thresholded — a mass comes back with a solid core, a ragged
    shoulder, and the bare paper showing through the thin places. Scaling the
    opacity by noise instead would leave the silhouette a clean step, because a
    step scaled is still a step. */
function dissolve(c, w, h) {
  const g = c.getContext('2d');
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const fine = noiseField(w, 9, 71, 0.74);
  const coarse = noiseField(w, 4, 83, 0.80);
  let fn = Infinity, fx = -Infinity, cn = Infinity, cx = -Infinity;
  for (let i = 0; i < fine.length; i++) {
    if (fine[i] < fn) fn = fine[i];
    if (fine[i] > fx) fx = fine[i];
    if (coarse[i] < cn) cn = coarse[i];
    if (coarse[i] > cx) cx = coarse[i];
  }
  const fs = 1 / (fx - fn || 1), cs = 1 / (cx - cn || 1);
  // This pass now only ever runs on the night card. It wants a glow: a wide
  // knee over a low floor, so the wash keeps a soft shoulder it can fade out
  // along. (It used to serve both faces, with a second set of numbers for the
  // day card — a narrow knee over a high floor, which kept the paper bare in
  // the thin places. That worked for washes drawn as silhouettes and fails
  // completely for washes that arrive as gradients: a high floor deletes every
  // load under about 0.3 alpha, so a soft wash came back as nothing but its
  // core. The day card now carries its own dissolving — see inkWash — and this
  // pass no longer has to.)
  const knee = 0.24;
  const floor = 0.20;
  const wet = 0.14;
  const body = 0.55;
  const bodyGain = 0.85;
  const peak = 0.80;
  const peakGain = 0.35;
  for (let k = 0; k < w * h; k++) {
    const i = k * 4, a = d[i + 3];
    if (a === 0) continue;
    const n = (fine[k] - fn) * fs, m = (coarse[k] - cn) * cs;
    const t = floor + wet * m;                    // how wet this spot dried
    let v = (a / 255) * (body + bodyGain * n);
    v = (v - t) / knee;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    d[i + 3] = v * v * (3 - 2 * v) * (peak + peakGain * m) * 255;
    const s = 0.95 + 0.10 * m;                    // and the pigment separates
    d[i] = Math.min(255, d[i] * s);
    d[i + 2] = Math.min(255, d[i + 2] * (1.04 - 0.08 * m));
  }
  g.putImageData(img, 0, 0);
}

const noiseCache = new Map();
/* fbm()'s default gain of 0.5 is right for the broad fields the shell and floor
   use, but it makes a texture field useless: by the eighth octave the amplitude
   is down to 0.4% and the finest detail has no weight at all. Paper and pigment
   need the high octaves to actually count, so everything here asks for a gain
   near 0.75 — coarse octaves for the blotch, fine ones for the grain. */
function noiseField(size, octaves, seed, gain = 0.75) {
  const key = `${size}:${octaves}:${seed}:${gain}`;
  if (!noiseCache.has(key)) noiseCache.set(key, fbm(size, octaves, seed, gain));
  return noiseCache.get(key);
}

/** catmull-rom through the given points — a pencil line is never a polyline */
function resample(pts, n = 72) {
  const out = [], segs = pts.length - 1;
  const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const k = (a, b, c, d, u) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u
                                    + (-a + 3 * b - 3 * c + d) * u * u * u);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * segs, s = Math.min(segs - 1, Math.floor(t)), u = t - s;
    const P = [at(s - 1), at(s), at(s + 1), at(s + 2)];
    out.push([k(P[0][0], P[1][0], P[2][0], P[3][0], u), k(P[0][1], P[1][1], P[2][1], P[3][1], u)]);
  }
  return out;
}

/** dry-brush stroke: one line drawn several times, each pass shorter and wider
    than the last. That is how a taper has to be faked on a canvas whose lines
    are all one width — and the passes drifting apart is what reads as bristles */
function inkStroke(g, pts, o = {}) {
  const {
    color = '46,49,55', alpha = 0.40, width = 4, seed = 5,
    blend = 'multiply', passes = 4, flecks = true,
  } = o;
  const p = resample(pts), n = p.length, rnd = rng(seed);
  g.save();
  g.globalCompositeOperation = blend;
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (let i = 0; i < passes; i++) {
    const f = i / Math.max(1, passes - 1);
    const a = Math.floor((n - 1) * 0.30 * f), b = n - 1 - Math.floor((n - 1) * 0.40 * f);
    const off = (rnd() - 0.5) * width * 0.8;
    g.beginPath();
    for (let q = a; q <= b; q++) {
      const jx = (rnd() - 0.5) * width * 0.5, jy = (rnd() - 0.5) * width * 0.5 + off;
      q === a ? g.moveTo(p[q][0] + jx, p[q][1] + jy) : g.lineTo(p[q][0] + jx, p[q][1] + jy);
    }
    g.strokeStyle = `rgba(${color},${alpha * (0.55 - f * 0.32)})`;
    g.lineWidth = width * (0.40 + f * 0.80);
    g.stroke();
  }
  if (flecks) {
    g.fillStyle = `rgba(${color},${alpha * 0.35})`;
    for (let i = 0; i < 40; i++) {
      const q = (rnd() * (n - 1)) | 0;
      g.fillRect(p[q][0] + (rnd() - 0.5) * width * 6, p[q][1] + (rnd() - 0.5) * width * 6,
                 1 + rnd() * 3, 1 + rnd() * 2);
    }
  }
  g.restore();
}

/** cold-press tooth: one fbm field split into a light and a dark half, laid
    down as two passes so the grain reads as the paper's own texture rather
    than as noise sprinkled over it */
function tooth(g, W, H, { size = 512, seed = 3, dark = 0.10, light = 0.09 } = {}) {
  const h = noiseField(size, 8, seed, 0.78);
  const up = canvas(size, size), dn = canvas(size, size);
  const ug = up.getContext('2d'), dg = dn.getContext('2d');
  const a = ug.createImageData(size, size), b = dg.createImageData(size, size);
  for (let i = 0; i < h.length; i++) {
    const v = h[i] - 0.5;
    a.data[i * 4] = 255; a.data[i * 4 + 1] = 250; a.data[i * 4 + 2] = 240;
    a.data[i * 4 + 3] = Math.max(0, v) * 2 * light * 255;
    b.data[i * 4] = 42; b.data[i * 4 + 1] = 40; b.data[i * 4 + 2] = 36;
    b.data[i * 4 + 3] = Math.max(0, -v) * 2 * dark * 255;
  }
  ug.putImageData(a, 0, 0);
  dg.putImageData(b, 0, 0);
  g.save();
  g.imageSmoothingEnabled = true;
  g.globalCompositeOperation = 'screen'; g.drawImage(up, 0, 0, W, H);
  g.globalCompositeOperation = 'multiply'; g.drawImage(dn, 0, 0, W, H);
  g.restore();
}

/* ------------------------------------------------------------------ *
 *  paper label face  (label plate spans x:-4.76..4.76  z:-2.93..2.93)
 * ------------------------------------------------------------------ */
const LX = 4.76, LZ = 2.93;
const WIN = { x0: -3.5, x1: 3.5, z0: -1.85, z1: 1.65 };

/* the painting on the card. It is sparse on purpose: the cover it answers is
   mostly bare paper with the colour gathered into a few knots, so the paper is
   left alone wherever nothing needs saying. Everything is placed in fractions
   of the canvas, and only the frame around the smoke window survives the
   cut-out — so the masses are sized to run well underneath it. A wash that
   stopped at the window's edge would read as a painted border around a hole;
   one that runs under it reads as a hole cut through a painting.

   The same layer serves both faces: multiplied onto the day card's paper,
   screened onto the night card's dark ground. */

const CARD_INK = [40, 43, 49];
const PALETTE = {
  blue: [58, 112, 146], cyan: [46, 138, 164], rose: [176, 112, 104],
  coral: [188, 62, 32], ochre: [150, 122, 70], olive: [116, 120, 84],
};

/* The day card's pigments live in DAY_GLAZES, further down: they belong to the
   wash simulation now, as a heavy core and a light halo per glaze, rather than
   to a flat list of colours. */

/** a fall of hair. Strands leave a tight crown and fan as they run out, each
    one tapering and running out of paint before its end. Width matters more
    than count: strands fine enough to merge into one dark mass at the size the
    card is read, which is what hair looks like, and separate into lines only
    when the card is looked at closely. */
function hairFall(g, W, H, o) {
  const {
    x0, y0, x1, y1, wx = 0, wy = 0, wx2 = wx, wy2 = wy, n = 7, seed = 1,
    blend = 'multiply', color = '58,64,78', alpha = .30, width = .026, bow = .05,
  } = o;
  const X = (f) => f * W, Y = (f) => f * H, U = (u) => u * W / (LX * 2);
  const rnd = rng(seed);
  for (let i = 0; i < n; i++) {
    const f = n > 1 ? i / (n - 1) - .5 : 0;
    const s = .55 + rnd() * .9;                       // how far this one got
    const ax = X(x0 + f * wx), ay = Y(y0 + f * wy);
    const ex = X(x0 + (x1 - x0) * s + f * wx2 * s), ey = Y(y0 + (y1 - y0) * s + f * wy2 * s);
    const mx = (ax + ex) * .5 + X(bow) * (rnd() - .5) * 2;
    const my = (ay + ey) * .5 + Y(bow) * (rnd() - .5) * 2;
    inkStroke(g, [[ax, ay], [mx, my], [ex, ey]], {
      color, alpha: alpha * (.55 + rnd() * .70), width: U(width * (.55 + rnd() * .85)),
      seed: (seed * 31 + i * 7) | 0, blend, passes: 3, flecks: i % 3 === 0,
    });
  }
}

/** the cover's bird, at the size the tape actually shows it: a compact dark
    head, a firm line for the long beak, the neck rising out of the band. Line
    work alone disappears at this size, so the head is carried by weight — and
    the wash behind it is one of the field's strokes, not a second pass here. */
function birdSketch(g, W, H) {
  const X = (f) => f * W, Y = (f) => f * H, U = (u) => u * W / (LX * 2);
  const ink = '52,58,72';
  // neck rising out of the band
  inkStroke(g, [[X(.848), Y(.220)], [X(.812), Y(.162)], [X(.792), Y(.106)]],
    { color: ink, alpha: .40, width: U(.030), seed: 1151, blend: 'multiply', passes: 3, flecks: false });
  // the head, twice over so the mass closes up
  inkStroke(g, [[X(.818), Y(.080)], [X(.788), Y(.056)], [X(.752), Y(.062)], [X(.740), Y(.082)]],
    { color: ink, alpha: .50, width: U(.034), seed: 1152, blend: 'multiply', passes: 3, flecks: false });
  inkStroke(g, [[X(.806), Y(.070)], [X(.778), Y(.062)], [X(.748), Y(.072)]],
    { color: ink, alpha: .40, width: U(.030), seed: 1156, blend: 'multiply', passes: 2, flecks: false });
  // the long beak
  inkStroke(g, [[X(.744), Y(.092)], [X(.704), Y(.110)], [X(.660), Y(.124)]],
    { color: ink, alpha: .46, width: U(.030), seed: 1153, blend: 'multiply', passes: 3, flecks: false });
  // the crest swept back off the crown
  inkStroke(g, [[X(.788), Y(.058)], [X(.822), Y(.034)], [X(.850), Y(.022)]],
    { color: ink, alpha: .34, width: U(.022), seed: 1154, blend: 'multiply', passes: 2, flecks: false });
  // the eye
  g.fillStyle = 'rgba(44,50,62,.80)';
  g.beginPath();
  g.ellipse(X(.778), Y(.084), U(.015), U(.015), 0, 0, 6.2832);
  g.fill();
}

/* ------------------------------------------------------------------ *
 *  ink wash  (水墨晕染), simulated rather than brushed on
 * ------------------------------------------------------------------ *
 *  Drawing a wash as a shape with a soft edge gets an airbrush: one even
 *  tone, one even falloff, an outline that is round because it was drawn
 *  round. A wash is not that. It is water spreading through paper, and what
 *  it leaves is the record of *where the water stopped* — so simulate that,
 *  on a small grid, and let the picture be the record.
 *
 *  Five rules, all of them cheap, do the whole thing:
 *
 *   1  PAPER, at three scales. `perm` is how thirsty a cell is; `fib`, two
 *      noises stretched at right angles, is which way the fibres run; `fine`
 *      is the tooth. The outline comes out ragged at three scales *coherently*,
 *      because the fingers follow fields. That is what a noise-thresholded
 *      silhouette can never do: there the raggedness is per-pixel, which reads
 *      as dirt rather than as paper.
 *   2  A FRONT THAT FREEZES. Water is handed outward while it still has
 *      pressure over the paper's resistance; the tooth decides whether it may
 *      pass a given cell, and pressure only ever falls. The outline therefore
 *      sets like a tide line, at a different moment in every direction.
 *   3  PIGMENT RIDES THE WATER, by donor-cell upwind. That alone banks pigment
 *      up at the edge, and the drying rule reinforces it: a cell that runs dry
 *      drops whatever it still holds. The dark water-line is not drawn, it
 *      falls out of the rules.
 *   4  DEPOSIT AND LIFT. Pigment drops out of suspension as the film thins and
 *      is lifted again where water arrives later. Clean water dropped on a
 *      drying wash therefore lifts pigment and pushes it outward into a bloom
 *      with a pale middle — the mark everyone reads as a wash and nobody gets
 *      from a gradient.
 *   5  TWO PIGMENTS. Watercolour separates: the heavy grains settle where they
 *      were laid, the light ones travel with the water and dry as a wider,
 *      cooler halo. Carrying both in the same water is what gives a wash a core
 *      and a bloom instead of one flat tone.
 *
 *  Cost is a few hundred milliseconds once per sheet, at 448x276 — the sizes
 *  that matter here are all many cells across, and the field is upsampled with
 *  smoothing when it is drawn.
 */
const WASH = { gw: 448, gh: 276 };

/** tileable value noise; cellsX/cellsY let it be stretched into fibres */
function noise2(gw, gh, cellsX, cellsY, octaves, seed, gain = 0.68) {
  const out = new Float32Array(gw * gh);
  let amp = 1, norm = 0, cx = cellsX, cy = cellsY;
  for (let o = 0; o < octaves; o++) {
    const r = rng(seed + o * 977);
    const cw = Math.max(2, Math.round(cx)), ch = Math.max(2, Math.round(cy));
    const g = new Float32Array(cw * ch);
    for (let i = 0; i < g.length; i++) g[i] = r();
    for (let y = 0; y < gh; y++) {
      const fy = (y / gh) * ch, y0 = fy | 0, ty = fy - y0, sy = ty * ty * (3 - 2 * ty), y1 = (y0 + 1) % ch;
      for (let x = 0; x < gw; x++) {
        const fx = (x / gw) * cw, x0 = fx | 0, tx = fx - x0, sx = tx * tx * (3 - 2 * tx), x1 = (x0 + 1) % cw;
        const a = g[y0 * cw + x0], b = g[y0 * cw + x1], c = g[y1 * cw + x0], d = g[y1 * cw + x1];
        out[y * gw + x] += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
      }
    }
    norm += amp; amp *= gain; cx *= 2; cy *= 2;
  }
  const k = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

function unitField(a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
  const s = 1 / (hi - lo || 1);
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * s;
  return a;
}

const paperCache = new Map();
/** one sheet, shared by every glaze on it — the fibres belong to the paper */
function washPaper(gw, gh, seed = 7) {
  const key = `${gw}:${gh}:${seed}`;
  if (paperCache.has(key)) return paperCache.get(key);
  const fibA = noise2(gw, gh, 3, 34, 3, seed + 23, 0.78);
  const fibB = noise2(gw, gh, 34, 3, 3, seed + 29, 0.78);
  const fib = new Float32Array(gw * gh);
  for (let i = 0; i < fib.length; i++) fib[i] = fibA[i] - fibB[i];
  const paper = {
    perm: noise2(gw, gh, 9, 9, 5, seed + 11, 0.74),
    fib,
    fine: unitField(noise2(gw, gh, 90, 90, 3, seed + 31, 0.78)),
    blotch: unitField(noise2(gw, gh, 46, 46, 3, seed + 37, 0.78)),
    streakH: unitField(noise2(gw, gh, 3, 60, 3, seed + 41, 0.78)),
    streakV: unitField(noise2(gw, gh, 60, 3, 3, seed + 43, 0.78)),
  };
  paperCache.set(key, paper);
  return paper;
}

const washClamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** run one glaze: stamp its strokes, then let the water do the rest.
    Returns the settled heavy and light pigment as two Float32Arrays. */
function inkWash(gw, gh, strokes, P = {}) {
  const {
    give = 0.15,        // share of its water a cell offers outward, per step
    evap = 0.948,       // per step
    need = 0.20,        // the paper's resistance to the front
    amp = 0.9,          // how much the fibres steer it
    open = 0.50,        // how far into the tooth's rough side the front reaches
    dep = 0.22,         // deposition rate as the film thins
    whalf = 0.26,       // film thickness at which deposition is half rate
    light = 0.45,       // share of the load that is the travelling pigment
    carryH = 0.85,      // how much of each species the moving water takes
    carryL = 0.97,
    kH = 0.05,          // the two species wander at different rates, which is
    kL = 0.16,          // the whole of chromatography
    dis = 0.35,         // re-dissolve rate where water arrives later
    drain = 0.16,       // capillary drain toward the rim
    dry = 0.75,         // share of what a drying cell holds that it drops
    gran = 0.16,        // how unevenly the pigment settles
    steps = 66,
    load = 1,           // how much paint the brush was carrying
    paper = washPaper(gw, gh),
  } = P;
  const N = gw * gh;
  const { perm, fib, fine, streakH, streakV } = paper;
  const w = new Float32Array(N);
  const p = new Float32Array(N), q = new Float32Array(N);        // heavy / light
  const dH = new Float32Array(N), dL = new Float32Array(N);
  const wd = new Float32Array(N), pd = new Float32Array(N), qd = new Float32Array(N);

  /* a wash: a pool whose edge is warped by the paper before the water has even
     spread, plus satellites. gx/gy is the direction the brush left more water
     in, which is what gives a wash an internal ramp instead of one flat tone. */
  function stamp(o) {
    const {
      x, y, rx, ry = rx, rot = 0, water = 1, mass = 1, wob = 0.42,
      seed = 1, drops = 0, dropR = 0.20, only = false, gx = 0, gy = 0, streak = 0,
    } = o;
    const rnd = rng(seed);
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const px = x * gw, py = y * gh, prx = rx * gw, pry = ry * gh;
    const x0 = Math.max(1, Math.floor(px - prx * 1.7)), x1 = Math.min(gw - 2, Math.ceil(px + prx * 1.7));
    const y0 = Math.max(1, Math.floor(py - pry * 1.7)), y1 = Math.min(gh - 2, Math.ceil(py + pry * 1.7));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const i = cy * gw + cx;
        const u = cx - px, v = cy - py;
        const a = (u * cs + v * sn) / prx, b = (-u * sn + v * cs) / pry;
        const warp = fib[i] * 0.5 + (perm[i] - 0.5) * 1.2;
        const r = Math.hypot(a, b) * (1 + wob * warp);
        if (r >= 1.04) continue;
        const t = r <= 0.42 ? 1 : 1 - (r - 0.42) / 0.62;
        let m = t * t * (3 - 2 * t);
        // dry brush: where the hairs did not touch, the paper stays bare, in
        // streaks that run with the grain
        if (streak > 0) {
          const s = fib[i] > 0 ? streakH[i] : streakV[i];
          const k = s < 0.34 ? 0 : s > 0.62 ? 1 : (s - 0.34) / 0.28;
          m *= 1 - streak * (1 - k * k * (3 - 2 * k));
        }
        const ramp = Math.max(0.15, 1 + gx * (a * 0.5) + gy * (b * 0.5));
        w[i] += m * water * load;
        if (!only) { p[i] += m * mass * ramp * (1 - light) * load; q[i] += m * mass * ramp * light * load; }
      }
    }
    for (let d = 0; d < drops; d++) {
      const ang = rnd() * 6.2832, dist = (0.75 + rnd() * 0.75) * prx;
      const dx = px + Math.cos(ang) * dist, dy = py + Math.sin(ang) * dist * (pry / prx);
      const rr = Math.max(1.5, prx * dropR * (0.30 + rnd() * 0.85));
      const ax = Math.max(1, Math.floor(dx - rr * 2)), bx = Math.min(gw - 2, Math.ceil(dx + rr * 2));
      const ay = Math.max(1, Math.floor(dy - rr * 2)), by = Math.min(gh - 2, Math.ceil(dy + rr * 2));
      for (let cy = ay; cy <= by; cy++) {
        for (let cx = ax; cx <= bx; cx++) {
          const i = cy * gw + cx;
          const r = Math.hypot(cx - dx, cy - dy) / rr;
          if (r >= 1) continue;
          const m = (1 - r * r) * 0.85;
          w[i] += m * water * load;
          if (!only) { p[i] += m * mass * load * (1 - light); q[i] += m * mass * load * light; }
        }
      }
    }
  }

  for (const s of strokes) if ((s.at || 0) <= 0) stamp(s);

  for (let step = 1; step <= steps; step++) {
    for (const s of strokes) if (s.at === step) stamp(s);

    /* 1 — the front. A dry cell is wetted when a wet neighbour still has
       pressure left, and the tooth decides whether that pressure gets it
       through here. Pressure only ever falls, so a cell the tooth refuses stays
       refused: that is where the ragged, frozen outline comes from. The flow is
       sized off the resistance rather than off what the neighbour holds, so the
       front creeps instead of lurching. */
    wd.set(w);
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const j = y * gw + x;
        if (w[j] > 0) continue;
        const f = fib[j], tooth = fine[j];
        let best = 0, src = -1;
        for (let k = 0; k < 4; k++) {
          const i = k === 0 ? j - 1 : k === 1 ? j + 1 : k === 2 ? j - gw : j + gw;
          const wi = wd[i];
          if (wi <= 0) continue;
          const along = k < 2 ? f : -f;                  // running with the grain
          const resist = need * (0.45 + 1.1 * perm[j]) * (1 - amp * along * 0.45);
          const excess = wi * give - resist;
          if (excess <= 0) continue;
          if (tooth > washClamp(open * (excess / resist), 0.05, 0.97)) continue;
          const flow = Math.min(wi * 0.45, resist * 1.05);
          if (flow > best) { best = flow; src = i; }
        }
        if (src >= 0) {
          const wi = wd[src];
          w[j] = best;
          const ch = best * (p[src] / wi) * carryH;
          const cl = best * (q[src] / wi) * carryL;
          p[j] += ch; p[src] -= ch;
          q[j] += cl; q[src] -= cl;
          wd[src] = wi - best; w[src] = wd[src];
        }
      }
    }

    /* 1b — the drain. Inside the wet area the water keeps running toward the
       thinnest film, which is always the rim: that is the capillary flow toward
       the pinned edge, and it is why a wash ends up darker where it stopped.
       Without it the interior just dries where it stands, flat. */
    if (drain > 0) {
      wd.set(w); pd.set(p); qd.set(q);
      for (let y = 1; y < gh - 1; y++) {
        for (let x = 1; x < gw - 1; x++) {
          const i = y * gw + x;
          const wi = wd[i];
          if (wi <= 1e-3) continue;
          let low = -1, lw = wi;
          for (let k = 0; k < 4; k++) {
            const j = k === 0 ? i - 1 : k === 1 ? i + 1 : k === 2 ? i - gw : i + gw;
            if (wd[j] < lw) { lw = wd[j]; low = j; }
          }
          if (low < 0) continue;
          const flow = (wi - lw) * drain;
          const ch = flow * (pd[i] / wi), cl = flow * (qd[i] / wi);
          w[i] -= flow; w[low] += flow;
          p[i] -= ch; p[low] += ch;
          q[i] -= cl; q[low] += cl;
        }
      }
    }

    /* 2 — dry out, 3 — let each species wander at its own rate,
       4 — deposit, or lift again where water arrives */
    pd.set(p); qd.set(q);
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const i = y * gw + x;
        if (w[i] <= 0 && p[i] <= 0 && q[i] <= 0) continue;
        const wasWet = w[i] > 0;
        w[i] *= evap;
        if (w[i] < 4e-3) w[i] = 0;
        if (kH > 0) {
          const a = (pd[i - 1] + pd[i + 1] + pd[i - gw] + pd[i + gw]) * 0.25;
          p[i] += (a - pd[i]) * kH;
        }
        if (kL > 0) {
          const a = (qd[i - 1] + qd[i + 1] + qd[i - gw] + qd[i + gw]) * 0.25;
          q[i] += (a - qd[i]) * kL;
        }
        const t = w[i] / (w[i] + whalf);
        const sink = (1 - t) * (0.68 + 0.52 * perm[i]);
        const dh = p[i] * dep * sink;
        const dl = q[i] * dep * 0.35 * sink;             // the light one hangs on
        p[i] -= dh; dH[i] += dh;
        q[i] -= dl; dL[i] += dl;
        // the water retreating off this cell leaves what it was carrying behind
        if (wasWet && w[i] === 0) {
          dH[i] += p[i] * dry; p[i] *= 1 - dry;
          dL[i] += q[i] * dry * 0.6; q[i] *= 1 - dry * 0.6;
        }
        // and water arriving later lifts pigment again
        const lift = dis * Math.min(1, w[i] * 3.0);
        const rh = dH[i] * lift, rl = dL[i] * lift;
        dH[i] -= rh; p[i] += rh;
        dL[i] -= rl; q[i] += rl;
      }
    }
  }

  for (let i = 0; i < N; i++) { dH[i] += p[i]; dL[i] += q[i]; }

  /* granulation: pigment settles unevenly into the sheet, which is the value
     mottling inside a wash — without it a wash is one flat tone, however good
     its edge is */
  if (gran > 0) {
    const { blotch, fine: f2 } = paper;
    for (let i = 0; i < N; i++) {
      const m = 1 + gran * ((blotch[i] - 0.5) * 1.5 + (f2[i] - 0.5) * 0.5);
      dH[i] *= m; dL[i] *= m;
    }
  }
  return { dH, dL };
}

/** a glaze as a canvas: pigment in RGB, how much of it settled in A, so the
    caller can just multiply it onto the paper like any other paint layer */
function glazeCanvas(W, H, sim, core, halo, K = 0.95) {
  const { gw, gh } = WASH;
  const c = canvas(W, H), g = c.getContext('2d');
  const img = g.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    const fy = ((y + 0.5) / H) * gh - 0.5;
    const y0 = Math.max(0, Math.min(gh - 2, Math.floor(fy))), ty = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < W; x++) {
      const fx = ((x + 0.5) / W) * gw - 0.5;
      const x0 = Math.max(0, Math.min(gw - 2, Math.floor(fx))), tx = Math.max(0, Math.min(1, fx - x0));
      const i00 = y0 * gw + x0, i10 = i00 + 1, i01 = i00 + gw, i11 = i01 + 1;
      const bl = (a, tx2, ty2) => a[i00] * (1 - tx2) * (1 - ty2) + a[i10] * tx2 * (1 - ty2)
        + a[i01] * (1 - tx2) * ty2 + a[i11] * tx2 * ty2;
      const h = bl(sim.dH, tx, ty), l = bl(sim.dL, tx, ty);
      const total = h + l;
      const o = (y * W + x) * 4;
      if (total <= 0) { d[o + 3] = 0; continue; }
      const f = h / total;                            // how much of it settled here
      d[o] = halo[0] + (core[0] - halo[0]) * f;
      d[o + 1] = halo[1] + (core[1] - halo[1]) * f;
      d[o + 2] = halo[2] + (core[2] - halo[2]) * f;
      d[o + 3] = (1 - Math.exp(-total * K)) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/* The day card's three glazes, in the order they were laid down: the cool
   field that carries the composition, the teal note worked into it while it was
   still wet, and the warm one the cover keeps for the forehead and the far end
   of the foot. One stroke list per glaze, in fractions of the sheet. */
const DAY_GLAZES = [
  { core: [88, 116, 158], halo: [126, 156, 190], strokes: [
    { x: .022, y: .200, rx: .052, ry: .190, rot: .04, seed: 803, water: 1.10, mass: 0.90, wob: .44, drops: 3, gx: -.35, gy: -.25 },
    { x: .028, y: .620, rx: .050, ry: .215, rot: -.03, seed: 804, water: 0.90, mass: 1.25, wob: .46, drops: 4, gx: .25, gy: .2 },
    { x: .026, y: .900, rx: .040, ry: .075, rot: -.02, seed: 807, water: 1.00, mass: 0.70, wob: .42, drops: 3, gx: -.3, streak: .35 },
    { x: .075, y: .075, rx: .110, ry: .058, rot: -.02, seed: 810, water: 0.85, mass: 0.38, wob: .44, drops: 4, gx: -.45, streak: .45 },
    { x: .290, y: .112, rx: .105, ry: .048, rot: -.01, seed: 811, water: 0.72, mass: 0.26, wob: .46, drops: 3, streak: .40 },
    { x: .075, y: .866, rx: .100, ry: .058, rot: -.02, seed: 815, water: 0.95, mass: 0.55, wob: .42, drops: 4, gx: -.35, streak: .40 },
    { x: .310, y: .892, rx: .100, ry: .040, rot: -.01, seed: 816, water: 0.70, mass: 0.26, wob: .46, drops: 3, streak: .3 },
    { x: .952, y: .150, rx: .030, ry: .090, rot: .02, seed: 819, water: 0.75, mass: 0.42, wob: .48, drops: 2, streak: .3 },
    // the bird's own wash, and a clean drop of water into the drying margin —
    // the drop is what lifts the pigment that is already down and blooms
    { x: .775, y: .128, rx: .038, ry: .056, rot: .05, seed: 822, water: 0.80, mass: 0.45, wob: .46, drops: 2 },
    { x: .046, y: .430, rx: .026, ry: .070, rot: .02, seed: 831, water: 1.20, mass: 0, drops: 3, at: 20, only: true },
  ] },
  { core: [76, 124, 142], halo: [112, 152, 164], strokes: [
    { x: .040, y: .480, rx: .030, ry: .070, rot: -.05, seed: 826, water: 0.90, mass: 0.62, wob: .50, drops: 2 },
    { x: .030, y: .700, rx: .024, ry: .050, rot: .04, seed: 827, water: 0.80, mass: 0.45, wob: .50, drops: 2 },
    { x: .210, y: .890, rx: .070, ry: .032, rot: -.01, seed: 828, water: 0.70, mass: 0.28, wob: .48, drops: 2, streak: .45 },
  ] },
  { core: [192, 132, 124], halo: [212, 166, 154], strokes: [
    { x: .095, y: .028, rx: .100, ry: .036, rot: -.02, seed: 836, water: 0.85, mass: 0.48, wob: .44, drops: 3, streak: .35 },
    { x: .145, y: .108, rx: .085, ry: .050, rot: -.04, seed: 837, water: 0.80, mass: 0.32, wob: .46, drops: 3 },
    { x: .780, y: .900, rx: .150, ry: .046, rot: .01, seed: 838, water: 0.85, mass: 0.30, wob: .50, drops: 3, streak: .4 },
    { x: .028, y: .950, rx: .062, ry: .052, rot: .04, seed: 839, water: 0.70, mass: 0.30, wob: .44, drops: 2 },
  ] },
];

/* How hard the brush was loaded, and how dark a unit of settled pigment reads.
   The simulation's own numbers are in cell units (one cell is a bit over a
   percent of the sheet); these two are the dials that put the result in the
   range a card is painted at — a body around 0.3 alpha, cores near 0.6, the
   pale shoulder down at 0.1 where the water ran out. */
const DAY_LOAD = 1.45;
const DAY_DENSITY = 1.9;

const glazeCache = [];
/** the glazes, run once per sheet and kept. Built at the paint layer's
    resolution rather than the card's: the wash is soft, and the pass that turns
    a 448-cell field into pixels is the expensive part of this whole exercise. */
function dayGlazes(W, H) {
  if (glazeCache.length) return glazeCache;
  const { gw, gh } = WASH;
  const paper = washPaper(gw, gh, 7);
  const lw = Math.min(LAYER_W, W), lh = Math.round((lw * H) / W);
  for (const G of DAY_GLAZES) {
    const sim = inkWash(gw, gh, G.strokes, { paper, load: DAY_LOAD });
    glazeCache.push(glazeCanvas(lw, lh, sim, G.core, G.halo, DAY_DENSITY));
  }
  return glazeCache;
}

/* The day card, painted against the cover: a loose watercolour portrait with
   the window punched through it. The glazes are the water; this is the ink laid
   on top of them. Nothing figurative goes in the middle of the sheet, because
   the middle of the sheet is the hole — so the picture is arranged round it: a
   fall of hair and a warm forehead at the left, the bird in the one clear
   stretch of the head band, the seal at the right where the cover keeps it, and
   the wash the title is written into along the foot. */
function paintDayInk(g, W, H) {
  const X = (f) => f * W, Y = (f) => f * H, U = (u) => u * W / (LX * 2);
  g.save();
  g.globalCompositeOperation = 'multiply';

  // the hair: one tight dark fall down the outer half of the margin, with a
  // knot of shorter strands at the crown. Kept narrow and dense on purpose —
  // strands spread across the margin read as scratches at tape size, and it is
  // the *mass* the cover has, not the individual line.
  hairFall(g, W, H, { x0: .012, y0: .045, x1: .046, y1: .905, wx2: .030, wy2: .07, n: 9, seed: 1010, alpha: .36, width: .015, bow: .020 });
  hairFall(g, W, H, { x0: .008, y0: .070, x1: .026, y1: .300, wx2: .028, wy2: .10, n: 6, seed: 1020, alpha: .30, width: .013, bow: .016 });
  hairFall(g, W, H, { x0: .034, y0: .040, x1: .058, y1: .150, wx2: .020, wy2: .07, n: 4, seed: 1030, alpha: .26, width: .012, bow: .014 });
  // two pale strands inside the mass, the way the cover's hair catches the light
  hairFall(g, W, H, { x0: .020, y0: .320, x1: .044, y1: .700, wx2: .014, wy2: .06, n: 2, seed: 1050, blend: 'screen', color: '240,236,224', alpha: .26, width: .010, bow: .012 });
  // a short contour where the face's edge would be, inside the band only — as
  // one long line down the card it read as a scratch
  inkStroke(g, [[X(.112), Y(.014)], [X(.100), Y(.080)], [X(.108), Y(.150)], [X(.098), Y(.206)]],
    { color: '58,64,78', alpha: .18, width: U(.012), seed: 1060, blend: 'multiply', passes: 3, flecks: false });

  birdSketch(g, W, H);
  g.restore();
}

/* The night card. Its washes are silhouettes rather than gradients, dissolved
   down to what dried: the same sheet seen from behind, with the light coming
   through it. */
function paintMasses(g, W, H) {
  const X = (f) => f * W, Y = (f) => f * H;
  const U = (u) => u * W / (LX * 2);            // one shape unit, in canvas px
  // washes glaze: where two of them overlap the paper keeps one and gets the
  // other multiplied through it, which is how the overlaps stay transparent
  g.globalCompositeOperation = 'multiply';
  const P = (o) => wash(g, { ...o, color: PALETTE[o.c] });

  // the face, left of centre: a cool under-painting, the saturated note the
  // cover keeps at its upper left, a warm knot over it, and the lips
  P({ c: 'blue', x: X(.27), y: Y(.44), rx: X(.15), ry: Y(.24), rot: -.26, alpha: .30, seed: 11 });
  P({ c: 'cyan', x: X(.20), y: Y(.28), rx: X(.085), ry: Y(.12), rot: -.30, alpha: .34, seed: 19, layers: 2 });
  P({ c: 'rose', x: X(.33), y: Y(.55), rx: X(.12), ry: Y(.16), rot: .10, alpha: .26, seed: 13 });
  P({ c: 'coral', x: X(.30), y: Y(.48), rx: X(.042), ry: Y(.048), rot: -.10, alpha: .38, seed: 23, layers: 2 });
  // a second cool knot down the right, smaller, so the card is not lopsided
  P({ c: 'blue', x: X(.80), y: Y(.72), rx: X(.10), ry: Y(.16), rot: .20, alpha: .20, seed: 12, layers: 2 });

  // earth at the foot of the card, under the title
  P({ c: 'ochre', x: X(.17), y: Y(.90), rx: X(.11), ry: Y(.075), rot: -.06, alpha: .26, seed: 14 });
  P({ c: 'olive', x: X(.31), y: Y(.94), rx: X(.085), ry: Y(.055), rot: .05, alpha: .20, seed: 15, layers: 2 });

  // the band the type sits on: a shallow tint, because the type has to stay
  // readable — the pigment goes into the two strips the type does not use, the
  // card's top edge and the line of paint just above the band's rule
  P({ c: 'blue', x: X(.44), y: Y(.105), rx: X(.44), ry: Y(.075), alpha: .12, seed: 31, wob: .08, layers: 2, rim: .2 });
  P({ c: 'ochre', x: X(.30), y: Y(.013), rx: X(.26), ry: Y(.020), alpha: .30, seed: 34, wob: .10, layers: 2 });
  P({ c: 'cyan', x: X(.66), y: Y(.011), rx: X(.20), ry: Y(.018), alpha: .28, seed: 35, wob: .12, layers: 2 });
  P({ c: 'ochre', x: X(.20), y: Y(.188), rx: X(.17), ry: Y(.026), alpha: .34, seed: 36, wob: .14, layers: 2 });
  P({ c: 'cyan', x: X(.60), y: Y(.190), rx: X(.20), ry: Y(.022), alpha: .28, seed: 37, wob: .12, layers: 2 });

  // water draining out of the top band, down the two open margins
  for (const [fx, c, sd] of [[.028, 'cyan', 41], [.062, 'blue', 42], [.094, 'rose', 43]])
    P({ c, x: X(fx), y: Y(.50), rx: X(.011), ry: Y(.30), rot: .02, alpha: .20, seed: sd, wob: .55, layers: 1, rim: 0 });
  for (const [fx, c, sd] of [[.884, 'blue', 44], [.918, 'cyan', 45], [.950, 'rose', 46]])
    P({ c, x: X(fx), y: Y(.44), rx: X(.010), ry: Y(.26), rot: -.02, alpha: .18, seed: sd, wob: .55, layers: 1, rim: 0 });

  // the cover's hot note: one small vermilion dot, dropped in the right margin
  const dx = X(.905), dy = Y(.495);
  blobPath(g, dx, dy, U(.115), U(.125), 0.3, rng(52), 0.34);
  g.fillStyle = 'rgba(188,62,32,.88)';
  g.fill();
  g.strokeStyle = 'rgba(188,62,32,.42)';
  g.lineWidth = U(.02);
  g.stroke();
}

/* The night card's paint layer, built on demand and kept. It is worked at half
   the card's resolution and upscaled on composite, which costs one pixel of
   softness at 2048 and nothing at all at the size the card is actually looked
   at — while the noise pass and the two fbm fields behind it are four times the
   work at full size, on the main thread, before the first paint. The day card
   needs none of that: its glazes are simulated at 448x276 and come back already
   dissolved. */
const LAYER_W = 1024;
let paintCacheB = null;
function paintLayer(W, H) {
  if (paintCacheB) return paintCacheB;
  const lw = Math.min(LAYER_W, W), lh = Math.round((lw * H) / W);
  const c = canvas(lw, lh), g = c.getContext('2d');
  g.save();
  g.scale(lw / W, lh / H);            // place the masses in card coordinates
  paintMasses(g, W, H);
  g.restore();
  dissolve(c, lw, lh);
  paintCacheB = c;
  return c;
}

export function labelTexture(face = 'A', { title = '', artist = '', album = '', minutes = '60' } = {}) {
  const S = 2048 / (LX * 2), W = 2048, H = Math.round(LZ * 2 * S);
  const c = canvas(W, H);
  const g = c.getContext('2d');
  // shape-space -> canvas px   ( +z front  =>  canvas top )
  const X = (x) => (x + LX) * S;
  const Y = (z) => (LZ - z) * S;
  const U = (u) => u * S;                       // unit length
  const dark = face === 'B';

  // ---- base paper. A face is a sheet off the same block as the cover: warm
  //  cold-press stock, cooler where the light falls off. B is the night card —
  //  the same painting screened onto a dark ground.
  const base = dark ? ['#252b36', '#141821'] : ['#f4f1e7', '#e5dfce'];
  const lg = g.createLinearGradient(0, 0, W * 0.34, H);
  lg.addColorStop(0, base[0]); lg.addColorStop(1, base[1]);
  g.fillStyle = lg; g.fillRect(0, 0, W, H);
  if (!dark) {   // the paper is a touch cooler where the light falls away up top
    const cool = g.createLinearGradient(0, 0, 0, H * 0.42);
    cool.addColorStop(0, 'rgba(142,152,168,.14)');
    cool.addColorStop(1, 'rgba(142,152,168,0)');
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = cool;
    g.fillRect(0, 0, W, H * 0.42);
    g.globalCompositeOperation = 'source-over';
  }

  const ink = dark ? '#e8e3d8' : '#2b2c30';
  // the day card's small print sits on paint for half its length, and at the
  // size the card is actually seen a 70% grey on a wash disappears — the night
  // card's light print has the same problem in reverse, which is why both are
  // set further from the paper than they look like they need to be
  const sub = dark ? 'rgba(206,203,214,.70)' : 'rgba(62,64,70,.86)';
  const accent = dark ? '#e2664a' : '#bf4626';
  const lead = dark ? '208,212,218' : '46,49,55';
  const blend = dark ? 'screen' : 'multiply';
  const r = rng(face === 'A' ? 21 : 33);

  // ---- layout rails (canvas px) ------------------------------------------
  //  every run of print below is pinned to one of these three boxes. The window
  //  is a cutout in the plate, so a run that strays into it is simply gone; and
  //  the band is only 1.26 units deep, so its captions have to be measured down
  //  from the band's *top* edge rather than up from the window.
  const bandZ0 = WIN.z1, bandZ1 = LZ - 0.02;
  const bandTop = Y(bandZ1), bandH = Y(bandZ0) - bandTop;
  const rz0 = -LZ + 0.02, rz1 = WIN.z0;
  const backTop = Y(rz1), backH = Y(rz0) - backTop;

  // ---- the painting: paper, then pigment glazed onto it — multiplied into the
  //  day card's paper, and screened onto the night card so the same washes read
  // ---- the painting: paper, then pigment glazed onto it. The day card's glazes
  //  come out of the wash simulation and are multiplied onto the real paper, in
  //  the order they were laid down — onto the paper and not onto a layer,
  //  because what makes them read as water is that they darken the tooth of the
  //  sheet under them. The night card is the same drawing screened onto a dark
  //  ground, so it keeps the older silhouette-plus-dissolve pass.
  tooth(g, W, H, { seed: face === 'A' ? 21 : 33, dark: dark ? .16 : .10, light: dark ? .07 : .09 });
  if (dark) {
    g.save();
    g.globalCompositeOperation = 'screen';
    g.globalAlpha = .68;
    g.drawImage(paintLayer(W, H), 0, 0, W, H);
    // screened onto a dark ground the pigment drifts brown — the earths in the
    // palette have nowhere to go. Pulling the whole card back to one hue with a
    // colour blend keeps the washes luminous and stops the night card going mud
    g.globalCompositeOperation = 'color';
    g.globalAlpha = .42;
    g.fillStyle = '#2b3c5e';
    g.fillRect(0, 0, W, H);
    g.restore();
  } else {
    g.save();
    g.globalCompositeOperation = 'multiply';
    for (const glaze of dayGlazes(W, H)) g.drawImage(glaze, 0, 0, W, H);
    g.restore();
    paintDayInk(g, W, H);
  }

  // ---- graphite, over the dry wash: long strokes that run the full width and
  //  well past it, so the cut leaves fragments in the band and the margins —
  //  which is what makes the window read as a hole through a drawing
  inkStroke(g, [[W * .03, H * .205], [W * .26, H * .176], [W * .50, H * .198], [W * .72, H * .173], [W * .90, H * .196]],
    { color: lead, alpha: dark ? .40 : .42, width: U(.030), seed: 5, blend });
  inkStroke(g, [[W * .10, H * .055], [W * .30, H * .070], [W * .46, H * .048]],
    { color: lead, alpha: .24, width: U(.014), seed: 7, blend });
  inkStroke(g, [[W * .58, H * .042], [W * .74, H * .058], [W * .93, H * .036]],
    { color: lead, alpha: .20, width: U(.012), seed: 8, blend });
  // two stems down the open margins, echoing the drawing at the cover's edge
  inkStroke(g, [[W * .050, H * .23], [W * .040, H * .44], [W * .058, H * .62]],
    { color: lead, alpha: .28, width: U(.011), seed: 9, blend });
  inkStroke(g, [[W * .898, H * .28], [W * .914, H * .50], [W * .900, H * .70]],
    { color: lead, alpha: .24, width: U(.010), seed: 10, blend });

  // the band's lower edge, drawn by hand: a rule that wavers the way a pencil
  // line does, so the band still has an edge without a printed plate of colour
  inkStroke(g, [[X(-4.62), bandTop + bandH * .99], [X(-1.6), bandTop + bandH * .972],
                [X(1.7), bandTop + bandH * .996], [X(4.62), bandTop + bandH * .978]],
    { color: lead, alpha: dark ? .34 : .38, width: U(.05), seed: 61, blend, flecks: false });

  // ---- the band, printed in ink over the wash
  g.fillStyle = ink;
  g.font = `600 ${U(0.46)}px "Segoe UI", Helvetica, Arial, sans-serif`;
  tracked(g, face === 'A' ? 'SIDE A' : 'SIDE B', X(-4.5), bandTop + bandH * 0.34, { track: U(0.05) });
  g.fillStyle = sub;
  g.font = `300 ${U(0.2)}px "Segoe UI", Helvetica, Arial, sans-serif`;
  tracked(g, 'TYPE II  ·  HIGH BIAS', X(-4.5), bandTop + bandH * 0.63, { track: U(0.06) });
  g.fillStyle = ink;
  g.font = `600 ${U(0.56)}px "Segoe UI", Helvetica, Arial, sans-serif`;
  tracked(g, minutes, X(4.5), bandTop + bandH * 0.84, { track: U(0.02), align: 'right' });
  g.fillStyle = sub;
  g.font = `300 ${U(0.18)}px "Segoe UI", Helvetica, Arial, sans-serif`;
  tracked(g, 'MINUTES', X(4.5), bandTop + bandH * 0.30, { track: U(0.08), align: 'right' });

  // ---- back band. The ruled title lines are gone: the title is written out in
  //  a calligraphic hand, the way the cover's own name is. It goes down as one
  //  run — tracked() puts each glyph on the canvas on its own, which is fine for
  //  caps but would cut the joins between script letters.
  const SCRIPT = 'Gabriola, "Segoe Script", "Lucida Handwriting", "Brush Script MT", cursive';
  const titleY = backTop + backH * 0.48;
  // the two rails this run of print has to stay inside. A title from a file name
  // is unbounded, so both runs are measured against them before they are set.
  const titleBox = X(4.5) - X(-4.32);
  const creditBox = X(4.5) - X(-4.30);
  if (title) {
    const script = (s) => `400 ${s}px ${SCRIPT}`;
    const sans = (s) => `300 ${s}px "Segoe UI", Helvetica, Arial, sans-serif`;
    const fit = fitRun(g, title, script, U(0.46), titleBox);
    const tw = fit.w;
    g.font = script(fit.size);
    g.fillStyle = dark ? 'rgba(226,220,208,.26)' : 'rgba(60,62,68,.26)';
    g.fillText(fit.text, X(-4.32) + U(.014), titleY + U(.014));   // ink sinking into the tooth
    g.fillStyle = ink;
    g.fillText(fit.text, X(-4.32), titleY);
    // and a pencil line drawn under it, stopping where the hand stopped
    inkStroke(g, [[X(-4.32) - U(.07), titleY + U(.17)], [X(-4.32) + tw * .56, titleY + U(.185)],
                  [X(-4.32) + tw + U(.12), titleY + U(.165)]],
      { color: lead, alpha: .24, width: U(.016), seed: 62, blend });
    const credits = fitRun(g, [artist, album].filter(Boolean).join('  ·  '),
      sans, U(0.145), creditBox, { track: U(0.05), min: 0.72 });
    g.fillStyle = sub;
    g.font = sans(credits.size);
    tracked(g, credits.text, X(-4.30), backTop + backH * 0.77, { track: U(0.05) });
    g.font = `300 ${U(0.125)}px "Menlo", "Consolas", monospace`;
    tracked(g, face === 'A' ? 'SIDE A · 4.76 cm/s' : 'SIDE B · 4.76 cm/s', X(-4.30), backTop + backH * 0.92, { track: U(0.04) });
  }

  // ---- side strips : vertical fine print, one column per margin. Broken into
  //  two runs so each column fits the cutout's height — as one string it ran
  //  1700px up a 753px margin, over the band and off the plate.
  const strip = face === 'A'
    ? ['γ-Fe₂O₃  ·  3.81 mm', 'MAGNETIC TAPE  ·  JAPAN']
    : ['PATENTED LOW-NOISE SHELL', 'ANTI-STATIC  ·  ⌀ 12 mm HUB'];
  g.fillStyle = sub;
  g.font = `300 ${U(0.17)}px "Segoe UI", Helvetica, Arial, sans-serif`;
  strip.forEach((s, i) => {
    g.save();
    g.translate(X(-3.82 + i * 0.28), Y(WIN.z0) - U(0.16));
    g.rotate(-Math.PI / 2);
    tracked(g, s, 0, -U(0.24), { track: U(0.055) });
    g.restore();
  });
  g.save();
  g.translate(X(3.72), Y(WIN.z1));
  g.rotate(Math.PI / 2);
  g.fillStyle = sub;
  g.font = `300 ${U(0.17)}px "Segoe UI", Helvetica, Arial, sans-serif`;
  tracked(g, face === 'A' ? '▷  PLAY THIS SIDE' : '◁  PLAY THIS SIDE', 0, -U(0.24), { track: U(0.055) });
  g.restore();

  // ---- technical block on the front band
  //  the middle column is bounded on the right by the MINUTES/05 block, so the
  //  spec line keeps clear of it and drops the run-out EQ name — the band's own
  //  left column already says TYPE II
  g.fillStyle = dark ? 'rgba(232,227,216,.74)' : 'rgba(43,44,48,.74)';
  g.font = `300 ${U(0.15)}px "Menlo", "Consolas", monospace`;
  tracked(g, '4.76 cm/s  ·  EQ 70 µs', X(-0.78), bandTop + bandH * 0.34, { track: U(0.035) });
  g.fillStyle = dark ? 'rgba(232,227,216,.5)' : 'rgba(43,44,48,.52)';
  g.font = `300 ${U(0.14)}px "Menlo", "Consolas", monospace`;
  tracked(g, face === 'A' ? 'OHM TAPE MFG.  № 000-A' : 'OHM TAPE MFG.  № 000-B', X(-0.78), bandTop + bandH * 0.64, { track: U(0.035) });

  if (dark) { // barcode on the back band
    let bx = X(2.65);
    const bh = U(0.72), by = Y(rz0) - U(0.9);
    while (bx < X(4.4)) {
      const bw = U(0.02 + r() * 0.05);
      g.fillStyle = r() > 0.32 ? 'rgba(226,222,212,.50)' : 'transparent';
      g.fillRect(bx, by, bw, bh);
      bx += bw + U(0.02);
    }
  }

  grain(g, W, H, dark ? 0.055 : 0.035, face === 'A' ? 9 : 17);

  // soft edge shading so paper doesn't look flat
  const vg = g.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, W * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, dark ? 'rgba(0,0,0,.42)' : 'rgba(70,58,42,.22)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);

  return tex(c, { srgb: true });
}

/* ------------------------------------------------------------------ *
 *  wound tape pack : concentric layer edges seen from above
 * ------------------------------------------------------------------ */
export const EDGE_RINGS = 200;
/* The ring pitch, as a radius in uv — the disc is drawn at this and then scaled
   about its centre by however many layers the pack is holding (`alignPack` in
   cassette.js), so this one number is the only thing the two sides have to agree
   on. */
export const EDGE_PITCH = 0.5 / EDGE_RINGS;

export function tapeEdgeTexture(size = 1024, bore = 0) {
  const c = canvas(size, size), g = c.getContext('2d');
  const R = size / 2;
  // what shows between two layer edges: the shadow in the groove, in the same
  // warm grey family the cut edge is drawn in (see BAND in tapeMaps)
  g.fillStyle = '#3a3229'; g.fillRect(0, 0, size, size);
  const r = rng(77);
  /* `bore` is the part of this disc the hub stands on, as a share of its radius
     — and it is a *constant*, because the caller scales the whole disc so that
     one layer is one ring: everything inside the hub's radius is always the same
     length of tape, hence always this same fraction of the texture. Nothing is
     drawn in there. The tape winds around the hub, not through it, so the only
     thing behind the spindle hole is the dark inside of the shell — and before
     this, the layers ran all the way to the centre, which is exactly what you
     saw looking into it. */
  const R0 = R * bore;
  g.fillStyle = '#0c0e10';                       // the shell's own interior
  g.beginPath(); g.arc(R, R, R0, 0, Math.PI * 2); g.fill();
  /* One ring is one layer of tape, so they run from the hub out — the pitch in
     here is only ever a relative one (the caller scales it), but a ring's
     *colour* has to be the tape's cut edge, because that is the surface these are
     the stacked edges of: rgb(104,88,72) at l = 72. */
  const rings = Math.round((1 - bore) * EDGE_RINGS);
  for (let i = rings; i > 0; i--) {
    const f = bore + (i / rings) * (1 - bore);
    const v = 0.5 + 0.5 * Math.sin(i * 2.1);
    const l = 56 + v * 24 + f * 14;
    g.beginPath();
    g.arc(R, R, R * f, 0, Math.PI * 2);
    g.lineWidth = 1.4;
    g.strokeStyle = `rgb(${(l * 1.444) | 0},${(l * 1.222) | 0},${l | 0})`;
    g.stroke();
  }
  g.globalAlpha = 0.45;
  for (let i = 0; i < 2600; i++) {
    const a = r() * Math.PI * 2, rr = R * (bore + (1 - bore) * Math.sqrt(r()));
    g.fillStyle = r() > 0.5 ? '#6a5849' : '#24201b';
    g.fillRect(R + Math.cos(a) * rr, R + Math.sin(a) * rr, 2, 1);
  }
  g.globalAlpha = 1;
  // Faint spiral + the tape end: breaks the rotational symmetry so the pack's
  // own turning is visible. Twelve turns rather than five, because the caller
  // only ever shows the inner third of this disc — the outer turns would be
  // scaled out of the window and there would be nothing left to see turn.
  g.beginPath();
  for (let t = 0; t <= 1.0001; t += 0.0015) {
    const a = t * Math.PI * 24, rad = R * (bore + (1 - bore) * t);
    const x = R + Math.cos(a) * rad, y = R + Math.sin(a) * rad;
    t === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.lineWidth = 2.2;
  g.strokeStyle = 'rgba(255,232,204,0.16)';
  g.stroke();
  g.save();
  g.translate(R, R);
  g.rotate(2.1);
  const step = g.createLinearGradient(0, -R, 0, R);
  step.addColorStop(0, 'rgba(255,236,208,0.20)');
  step.addColorStop(1, 'rgba(0,0,0,0.28)');
  g.fillStyle = step;
  g.fillRect(-1.6, -R * 0.98, 3.2, R * (0.98 - bore));
  g.restore();
  return tex(c, { srgb: true });
}

/* ------------------------------------------------------------------ *
 *  misc
 * ------------------------------------------------------------------ */
export function brushedTexture(size = 512, tint = [150, 152, 158], rot = 0) {
  const c = canvas(size, size), g = c.getContext('2d');
  g.fillStyle = `rgb(${tint[0] * 0.7 | 0},${tint[1] * 0.7 | 0},${tint[2] * 0.72 | 0})`;
  g.fillRect(0, 0, size, size);
  const r = rng(41);
  g.translate(size / 2, size / 2); g.rotate(rot); g.translate(-size / 2, -size / 2);
  for (let i = 0; i < 5200; i++) {
    const y = r() * size, x = r() * size, len = 20 + r() * 190;
    const a = 0.04 + r() * 0.12;
    g.strokeStyle = r() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    g.lineWidth = 0.6 + r() * 1.1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + (r() - 0.5) * 2); g.stroke();
  }
  return tex(c, { srgb: false, rep: 2 });
}

export function radialTexture(size = 512, { inner = 'rgba(0,0,0,1)', outer = 'rgba(0,0,0,0)', p = 0.55, color = '0,0,0' } = {}) {
  const c = canvas(size, size), g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, inner); gr.addColorStop(p, `rgba(${color},0.55)`); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return tex(c, { srgb: false });
}

export function dustSprite(size = 128) {
  const c = canvas(size, size), g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, 'rgba(255,246,232,1)');
  gr.addColorStop(0.35, 'rgba(255,240,220,0.35)');
  gr.addColorStop(1, 'rgba(255,235,210,0)');
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return tex(c, { srgb: true });
}

/** the visible backdrop: a vertical gradient plus an optional soft pool of
    light behind the subject (i.e. a background light on the cyclorama).
    Sphere UVs put the canvas top row at the sphere's bottom, so stop 0 is the
    floor end of the gradient. */
export function backdropTexture({ stops, spot = null, size = 2048 }) {
  const h = size / 2;
  const c = canvas(size, h), g = c.getContext('2d');
  const lg = g.createLinearGradient(0, 0, 0, h);
  for (const [p, col] of stops) lg.addColorStop(p, col);
  g.fillStyle = lg; g.fillRect(0, 0, size, h);
  if (spot) {
    const cy = spot.v * h, r = spot.r * size;
    const mid = spot.color.replace(/[\d.]+\)$/, '0.42)');
    g.globalCompositeOperation = 'lighter';
    /* the sphere wraps horizontally, so a pool this far round (u ≈ 0.85) runs
       off the right edge of the canvas. Painted once it would be sliced there,
       and the cut lands on the sphere's u = 0/1 meridian — a hard seam down the
       backdrop. Paint it a canvas to each side as well and let the off-canvas
       copies clip; the two halves then meet at the meridian. */
    for (const dx of [-size, 0, size]) {
      const cx = spot.u * size + dx;
      if (cx + r < 0 || cx - r > size) continue;
      const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, spot.color);
      rg.addColorStop(0.55, mid);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, size, h);
    }
    g.globalCompositeOperation = 'source-over';
  }
  return tex(c, { srgb: true });
}

/** vertical studio gradient used for the environment dome */
export function gradientTexture(stops, size = 512) {
  const c = canvas(size, size), g = c.getContext('2d');
  const lg = g.createLinearGradient(0, 0, 0, size);
  for (const [p, col] of stops) lg.addColorStop(p, col);
  g.fillStyle = lg; g.fillRect(0, 0, size, size);
  return tex(c, { srgb: true });
}

/* ------------------------------------------------------------------ *
 *  the write head (see cassette.setLabel / main.updateLabelSwap)
 *
 *  A label that has been regenerated is a new texture, and pointing a material
 *  at one is a step. The incoming print is therefore carried on a copy of the
 *  same plate and let in through a window that crosses the card, so the change
 *  is a rewrite rather than a cut.
 * ------------------------------------------------------------------ */

/** The window itself: the label's own U axis runs along the writing, so this is
    a ramp across U — solid behind the head, dropping to nothing over the last
    tenth of the card. The caller slides it by animating `offset.x`, and past the
    end of the ramp the sample clamps to the edge — which is why the wrap has to
    be ClampToEdge and the edge has to be the black end: parked beyond it, the
    whole window reads zero and nothing of the new print shows. */
export function sweepAlpha(w = 64, h = 4) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#fff');
  grad.addColorStop(0.88, '#fff');
  grad.addColorStop(1, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  // a run of the head's own striation inside the soft edge, so the boundary
  // reads as ink being laid down rather than as a gradient sliding past
  g.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 3; i++) {
    g.fillStyle = `rgba(0,0,0,${0.11 + i * 0.13})`;
    g.fillRect(Math.round(w * (0.90 + i * 0.032)), 0, 1, h);
  }
  g.globalCompositeOperation = 'source-over';
  const t = tex(c, { srgb: false, aniso: 1 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** The clear leader at each end of the ribbon, as an alpha.
 *
 *  A compact cassette splices uncoated leader to both ends of the magnetic tape,
 *  and it is the leader that makes the end of a side legible: the coating simply
 *  stops, the dark inside of the shell shows through the tape, and the two cut
 *  edges of the PET keep the ribbon's silhouette. So this is not a colour, it is
 *  a transparency — one band per end of the *tape*, laid on a uv channel of its
 *  own (see `align` in cassette.js), with the cut edges left far more opaque than
 *  the broad faces so what is left reads as clear tape rather than as a gap.
 *
 *  V is the ribbon's cross-section, cut the same way `tapeMaps` cuts it: the two
 *  cut edges and the two faces between them (the caller passes the fraction).
 *  U is the tape's own length, from
 *  the leader at one end to the leader at the other, so the caller only has to
 *  scale it (repeat) and slide it (offset) — and the clamp does the rest, since
 *  material that would sit past either end of the tape is material that does not
 *  exist, and the black band at that end is what belongs in its place. */
export function leaderAlpha(w = 2048, h = 128, { lead = 0.01, cut = 0.02, edge = 0.62, face = 0.18 } = {}) {
  const c = canvas(w, h), g = c.getContext('2d');
  const grey = (x) => { const n = Math.round(x * 255); return `rgb(${n},${n},${n})`; };
  // rows, in RIB_V's order and at RIB_V's fractions: cut edge | back coat |
  // cut edge | oxide face
  const e = Math.max(1, Math.round(h * cut)), f = Math.round(h * (0.5 - cut));
  for (const [y0, y1, k] of [[0, e, edge], [e, e + f, face], [e + f, 2 * e + f, edge], [2 * e + f, h, face]]) {
    g.fillStyle = grey(k);
    g.fillRect(0, y0, w, y1 - y0);
  }
  // and the coated tape is opaque between the two leaders. One texel of a 2048
  // across the whole tape is a few millimetres, so the joint is left hard and the
  // filtering rounds it over — which is what a splice looks like anyway.
  const x = Math.max(1, Math.round(lead * w));
  g.fillStyle = '#fff';
  g.fillRect(x, 0, w - 2 * x, h);
  const t = tex(c, { srgb: false, aniso: 1 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** the head's own light — a band, not a line: bright where it is writing, gone
    at both ends of the stroke and at the card's two edges. Everything about it
    is alpha, because the quad that carries it is additive. */
export function headStreak(w = 64, h = 32) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  // a narrow core with long tails: a light moving across the card, not a bar
  // printed on it — the brighter the core against the length of the tails, the
  // more it reads as something separate from the paper underneath
  const gx = g.createLinearGradient(0, 0, w, 0);
  gx.addColorStop(0, 'rgba(255,255,255,0)');
  gx.addColorStop(0.34, 'rgba(255,255,255,0.42)');
  gx.addColorStop(0.48, 'rgba(255,255,255,1)');
  gx.addColorStop(0.52, 'rgba(255,255,255,1)');
  gx.addColorStop(0.66, 'rgba(255,255,255,0.42)');
  gx.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gx; g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-in';
  const gy = g.createLinearGradient(0, 0, 0, h);
  gy.addColorStop(0, 'rgba(255,255,255,0)');
  gy.addColorStop(0.18, 'rgba(255,255,255,1)');
  gy.addColorStop(0.82, 'rgba(255,255,255,1)');
  gy.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gy; g.fillRect(0, 0, w, h);
  return tex(c, { srgb: true, aniso: 2 });
}
