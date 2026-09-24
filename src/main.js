import * as THREE from 'three';
import { createEnvironments } from './env.js';
import { createProbe } from './probe.js';
import { createRig, buildRigPanels, RIG } from './lights.js';
import { createCassette, DIM } from './cassette.js';
import { createSoftFloor } from './floor.js';
import { createComposer } from './post.js';
import { Orbit } from './controls.js';
import { clamp, damp, ease, Timeline } from './anim.js';
import * as TX from './textures.js';
import { TapeAudio } from './audio.js';
import { readTags, looksLikeAudio } from './tags.js';

const $ = (s) => document.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = $('#gl');

/* ============================== theme presets ============================ */
const THEMES = {
  noir: {
    env: 'noir', dust: 0.40, hal: 0.072, ao: 1.0,
    grade: { bloom: 0.32, ca: 0.85, grain: 0.050, vig: 0.85, sat: 1.0, edge: 1.0, focus: 0.26 },
    toon: { on: 0 },
    bg: {
      stops: [[0, '#12151a'], [0.44, '#1e232a'], [0.64, '#0d1014'], [1, '#040507']],
      spot: { u: 0.849, v: 0.48, r: 0.40, color: 'rgba(140,162,200,0.75)' },
    },
    floor2: 0x101317, floorMix: 0.60, shadowOp: 0.44,
    pool: 0xff8a3c, poolOp: 0.09,
  },
  studio: {
    env: 'studio', dust: 0.16, hal: 0.020, ao: 0.92,
    grade: { bloom: 0.32, ca: 0.85, grain: 0.050, vig: 0.85, sat: 1.0, edge: 1.0, focus: 0.26 },
    toon: { on: 0 },
    bg: {
      stops: [[0, '#9aa0a8'], [0.46, '#c2c7ce'], [0.78, '#d8dade'], [1, '#e9ebee']],
      spot: { u: 0.849, v: 0.48, r: 0.44, color: 'rgba(255,255,255,0.50)' },
    },
    floor2: 0x9ba1a9, floorMix: 0.38, shadowOp: 0.26,
    pool: 0xffffff, poolOp: 0.04,
  },
  toon: {
    // 三渲二: flat high-key light, posterised luminance, inked creases
    env: 'studio', dust: 0.09, hal: 0.012, ao: 0.50,
    grade: { bloom: 0.20, ca: 0.22, grain: 0.026, vig: 0.48, sat: 1.12, edge: 1.0, focus: 0.26 },
    toon: { on: 1, levels: 4, flat: 0.88, ink: 0.60, width: 1.5 },
    bg: {
      stops: [[0, '#b4b9c1'], [0.46, '#d8dbdf'], [0.78, '#eef0f2'], [1, '#f8f9fa']],
      spot: { u: 0.849, v: 0.50, r: 0.52, color: 'rgba(255,255,255,0.60)' },
    },
    floor2: 0xb6bbc2, floorMix: 0.26, shadowOp: 0.22,
    pool: 0xffffff, poolOp: 0.03,
  },
};
for (const T of Object.values(THEMES)) {
  T.cFloor2 = new THREE.Color(T.floor2);
  T.cPool = new THREE.Color(T.pool);
}
let themeName = 'studio';

/* ============================== renderer ================================= */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  document.body.innerHTML = '<p style="color:#eee;font:14px/1.6 system-ui;padding:3rem">当前浏览器无法初始化 WebGL，请使用 Chrome / Edge 打开。</p>';
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 1, 220);

/* ============================== studio set =============================== */
const backdropMaps = {};
let backdrop, backdropIn;
{
  const g = new THREE.SphereGeometry(70, 32, 24);
  backdrop = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false }));
  backdrop.frustumCulled = false;
  scene.add(backdrop);
  /* The room's background is a baked texture with no in-between, and it is the
     largest single surface in the frame — 暗房 is near black and 影棚 pale grey,
     so cutting the map was the loudest thing in the whole transition. This
     second shell carries the incoming room across instead. Both are BackSide
     with depthWrite off, so the depth buffer never distinguishes them and only
     the draw order matters: the base is opaque (opaque pass), this one is
     transparent (transparent pass, after it). It sits at the same radius —
     nothing depends on which is nearer. */
  backdropIn = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    side: THREE.BackSide, depthWrite: false, transparent: true, opacity: 0,
  }));
  backdropIn.frustumCulled = false;
  backdropIn.visible = false;
  scene.add(backdropIn);
}
/* `interval: 2` is the mirror's documented behaviour — the reflection is
   blurred by design and the floor under it is dark, so on a still camera an
   alternate-frame refresh is invisible and halves a whole extra scene render.
   A moving camera forces every frame (see the loop's camMoved), and anything
   the mirror actually shows moving — the drift, the reels — is either slower
   than a texel a frame or behind the smoke glass. */
const floorBase = createSoftFloor({ base: 0x0b0c0e, mix: 0.62, y: -1.62, interval: 2 });
scene.add(floorBase.mesh);
const shadowCatcher = new THREE.Mesh(
  new THREE.PlaneGeometry(46, 46),
  new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.42, transparent: true, depthWrite: false })
);
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.position.y = -1.612;
shadowCatcher.receiveShadow = true;
shadowCatcher.renderOrder = 2;
scene.add(shadowCatcher);
const poolMat = new THREE.MeshBasicMaterial({
  map: TX.radialTexture(512, { inner: 'rgba(255,255,255,1)', color: '255,255,255', p: 0.18 }),
  color: 0xff8a3c, transparent: true, opacity: 0.2,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const pool = new THREE.Mesh(new THREE.CircleGeometry(9, 48), poolMat);
pool.rotation.x = -Math.PI / 2;
pool.renderOrder = 3;
scene.add(pool);

/* the stage sinks as the shell opens, so the lower layers never fall through
   the floor — the exploded stack is ~7.4 units tall, the floor has to get out
   of its way */
const FLOOR_Y = -1.62;
function setFloorDrop(d) {
  floorBase.mesh.position.y = FLOOR_Y - d;
  shadowCatcher.position.y = FLOOR_Y + 0.008 - d;
  pool.position.y = FLOOR_Y + 0.02 - d;
}
setFloorDrop(0);
/* ============================== dust ==================================== */
const dustLayers = [
  { n: 220, size: 0.055, color: 0xffe6c8, opacity: 0.5, spread: 26, rise: 0.09 },
  { n: 70, size: 0.34, color: 0xffc79a, opacity: 0.16, spread: 20, rise: 0.045 },  // out-of-focus bokeh motes
].map((cfg) => {
  const { n } = cfg;
  const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), seed = new Float32Array(n);
  // per-mote brightness, so a mote can fade out before it is recycled to the
  // bottom of the volume. Additive blending means scaling the vertex colour
  // *is* fading it — the material colour still carries the layer's tint.
  const tint = new Float32Array(n * 3).fill(1);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * cfg.spread;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 15;
    pos[i * 3 + 2] = (Math.random() - 0.5) * cfg.spread;
    vel[i * 3] = (Math.random() - 0.5) * 0.05;
    vel[i * 3 + 1] = cfg.rise * (0.5 + Math.random());
    vel[i * 3 + 2] = (Math.random() - 0.5) * 0.05;
    seed[i] = Math.random() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(tint, 3));
  const mat = new THREE.PointsMaterial({
    size: cfg.size, map: TX.dustSprite(), color: cfg.color, transparent: true,
    opacity: cfg.opacity, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    vertexColors: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  return { ...cfg, pts, pos, vel, seed, tint, geo, mat };
});
const dust = dustLayers[0];
/* both ends of the column are on screen, and a mote is recycled from the top of
   one to the bottom of the other at a new x/z — so it has to be at zero
   brightness at *both* ends or you watch it blink out of one place and into
   another. */
const DUST_TOP = 8.5, DUST_BOT = -7.5, DUST_FADE = 1.6;
const dustFade = (v, a, b) => { const f = clamp((v - a) / b, 0, 1); return f * f * (3 - 2 * f); };
function driftDust(dt, t) {
  for (const L of dustLayers) {
    const p = L.pos, c = L.tint;
    for (let i = 0; i < L.n; i++) {
      const j = i * 3;
      p[j] += (L.vel[j] + Math.sin(t * 0.5 + L.seed[i]) * 0.02) * dt;
      p[j + 1] += L.vel[j + 1] * dt;
      p[j + 2] += (L.vel[j + 2] + Math.cos(t * 0.42 + L.seed[i]) * 0.02) * dt;
      if (p[j + 1] > DUST_TOP) {
        p[j + 1] = DUST_BOT;
        p[j] = (Math.random() - 0.5) * L.spread;
        p[j + 2] = (Math.random() - 0.5) * L.spread;
      }
      // out over the last stretch below the top wrap, in over the first stretch
      // above the bottom one: zero at both wraps, so the recycle is invisible
      const y = p[j + 1];
      const k = dustFade(DUST_TOP - 0.2, -DUST_FADE, y) * dustFade(DUST_BOT + 0.1, DUST_FADE, y);
      c[j] = c[j + 1] = c[j + 2] = k;
    }
    L.geo.attributes.position.needsUpdate = true;
    L.geo.attributes.color.needsUpdate = true;
  }
}

/* ============================== model =================================== */
let cas = null, envs = null, rig = null, composer = null, grade = null, bloom = null;
let probe = null, rigPanels = null, probeDirty = false, probeBound = false;

/* Handling the model is a detour, not a destination: five seconds after the last
   drag or zoom the camera eases back to the framing the panel says it is on —
   the vantage you last chose, or the record's own view if one is open. Without
   it a stray drag leaves the tape at whatever three-quarter angle you let go of,
   and the read-out down the side keeps naming a vantage the lens has left. The
   timer is armed only by *manual* handling; anything the app does itself (arrows,
   a record, 拆解, the double-click home) already ends on a framing, so it
   disarms instead. 巡览 beats it: with the model turning by itself there is
   nothing to return to. */
const HOME_DELAY = 5.0;
let homeArmed = false;
function armHome() { if (!autoRotate) homeArmed = true; }
function goHome() {
  homeArmed = false;
  orbit.setPreset(vi >= 0 ? VANTAGES[vi].v : cur().view, false);
  if (orbit.tween) orbit.tween.dur = 1.6;
}
const orbit = new Orbit(canvas, camera, {
  theta: 1.18, phi: 1.34, radius: 40, target: new THREE.Vector3(0, 0.05, 0),
  minR: 11, maxR: 52, minPhi: 0.16, maxPhi: 1.52,
  auto: false,
  reduce,
  onInteract: (dragging) => {
    document.body.classList.toggle('dragging', dragging);
    document.body.classList.add('moved');
    // the countdown starts when the hand comes off, not when it lands
    if (!dragging) armHome();
  },
  onManual: armHome,
  onReset: () => {
    // the double-click home *is* VANTAGES[0], so the panel follows the camera
    // back to the first vantage. Without this it keeps showing 04 / MACRO and
    // keeps the dossier narrowed for a lens that is no longer close in.
    vi = 0;
    homeArmed = false;
    render();
  },
});
/* the tape is ~9.6 units across, so the framing wants the lens well back of the
   old product-shot distance — at 18 units the subject alone filled the frame and
   there was no room left for the panel down the right-hand side */
orbit.home = { theta: 0.62, phi: 1.03, radius: 33 };

const audio = new TapeAudio();

/* ============================== the tape's music ========================= */
/* What is inside the shell is whatever was put there last: the page boots with
   the record it shipped with, and ADD MUSIC (or a file dropped on the page, or
   O) hands it another one. The three lines the README used to ask for by hand —
   title, artist, album — come off the file's own ID3 tags instead, and the label
   on the cassette is rewritten to match (see applyTrack). */
const TRACK_DEFAULT = {
  title: 'Sacred Play Secret Place',
  artist: 'Matryoshka',
  album: 'Laideronnette',
  src: 'assets/sacred-play-secret-place.mp3',
  file: null,
};
const TRACK = { ...TRACK_DEFAULT };
/* the blob URL of the track the user added, so the next one can let it go */
let objUrl = null;
const audioEl = $('#tape-audio');
let mode = 'idle';          // idle | play | rew
let muted = false;
/* The music's own level, and the only thing the wheel over the speaker changes.
   It used to be whatever the <audio> element defaults to — 1.0 — with the tape
   bed ducked to 0.30 to compensate; now the music sits at 0.10 to begin with and
   the bed keeps its own mix, which is what a transport actually does. */
let volume = 0.10;
const VOL_STEP = 0.05;
/* The tape bed is mixed *against* the music — 0.30 against a full-scale track is
   the balance that was tuned by ear — so it has to follow the wheel as well, or
   turning the music down would leave the hiss sitting on top of it. Muting still
   leaves the machine audible: that is the point of that state, and the one place
   the bed is set on its own. (Declared up here because ?p=1 reaches togglePlay
   during module evaluation, long before the rest of the volume wiring exists.) */
const bedLevel = () => (prefs.hiss ? (muted ? 0.45 : 0.30 * volume) : 0);
const audioOk = () => audioEl.readyState >= 2 && isFinite(audioEl.duration) && audioEl.duration > 0;

/* ============================== putting a track in =======================
   A label is a baked texture and pointing a material at a new one is a step, so
   a swap is not a swap: it is a *rewrite*. The incoming print is drawn onto the
   copy of the plate the write head carries (see cassette.js), the head crosses
   the card over SWAP_DUR, and only then does the plate itself take the new map
   (updateLabelSwap below).

   Everything the page says about the track changes on that last frame and not
   one frame sooner — the handwriting on the label, its MINUTES caption, the
   badge on the masthead, the chip in the middle, the two counters down in the
   corner, the tab's own title. That is why the new duration is held here rather
   than going straight to the cassette: it is the one piece of the change the
   browser hands over several hundred milliseconds *before* the print does.
   ======================================================================== */
const SWAP_DUR = 1.2;
const swap = { state: 'idle', p: 0, press: 0, neu: null, old: null, dur: 0, play: false, meta: null };
/* Every load carries a ticket. A load spends a few hundred milliseconds waiting
   on the media element, and REINITIALIZE can land inside that window — without
   this the load would come back from the await and print itself over the reset
   that just cancelled it. */
let loadSeq = 0;
const brandCode = $('#brand-code');
/* what the transport is actually holding, for the failure message: TRACK only
   catches up at the end of a swap, and by then the error has been reported */
let currentName = TRACK_DEFAULT.src;
let audioFailed = false;

const tapeMinutes = (dur) => String(clamp(Math.round(dur / 60), 1, 99)).padStart(2, '0');

/** the transport's read-out: the total is however long the loaded audio is */
function setDur() {
  const d = audioEl.duration;
  if (!isFinite(d) || d <= 0) return;
  // mid-swap the plate still reads the old length; land the new one with the print
  if (swap.state !== 'idle') { swap.dur = d; return; }
  cas.st.duration = d;
}
function setNowChip() {
  $('#now-title').textContent = TRACK.title;
  const credits = [TRACK.artist, TRACK.album].filter(Boolean).join(' · ');
  $('#now-sub').textContent = audioFailed ? '音频加载失败 · 仅走带动画' : (credits || '未知曲目');
}

/** the file's own length as a promise — the media element is the only thing that
    knows it. 2.5 s is generous for a local blob and short enough that a file the
    browser cannot decode does not leave the button stuck. */
function whenPlayable() {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(ok, 2500);
    function cleanup() {
      clearTimeout(timer);
      audioEl.removeEventListener('loadedmetadata', ok);
      audioEl.removeEventListener('durationchange', ok);
      audioEl.removeEventListener('error', bad);
    }
    function finish(v) { if (done) return; done = true; cleanup(); resolve(v); }
    function ok() { finish(isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0); }
    function bad() { finish(0); }
    audioEl.addEventListener('loadedmetadata', ok);
    audioEl.addEventListener('durationchange', ok);
    audioEl.addEventListener('error', bad);
    if (audioEl.readyState >= 1) ok();
  });
}

/** The one way a track gets into the shell. The audio element is switched first,
    so the metadata is already on its way while the tags are read; the rewrite
    then waits for a length, because a card printed with the previous track's
    minutes is a lie for exactly as long as the browser takes to answer. */
async function applyTrack({ title, artist, album, src, file }) {
  const seq = ++loadSeq;
  const stale = objUrl;
  objUrl = src.startsWith('blob:') ? src : null;
  const short = file?.name || src;
  currentName = short;

  if (cas.st.playing) togglePlay(false);      // the tape that was playing is gone
  mode = 'idle';
  document.body.classList.remove('rewinding');
  audioEl.pause();
  audioEl.src = src;
  audioEl.load();
  audioEl.currentTime = 0;
  cas.setProgress(0);                         // and it sits at the head again
  document.body.classList.remove('no-audio');
  audioFailed = false;
  if (stale && stale !== src) URL.revokeObjectURL(stale);

  swap.meta = { title, artist, album, src, file };
  swap.state = 'arming';
  swap.dur = 0;
  const dur = await whenPlayable();
  if (seq !== loadSeq) return;                // a reset overtook this load

  /* drawn here, on a still frame: two 2048px canvases are the one expensive part
     of a swap, and a hitch before anything moves reads far better than a hitch
     in the middle of a sweep */
  const staged = cas.setLabel({ title, artist, album, minutes: dur > 0 ? tapeMinutes(dur) : '--' });
  swap.neu = staged.neu;
  swap.old = staged.old;
  cas.sweepLabel(0);                          // parked off the leading edge
  audio.clunk(0.9);                           // the head comes down on the tape
  swap.p = 0;
  swap.state = 'sweep';
}

/** the write head crossing the card — cassette.js owns what the numbers mean */
function updateLabelSwap(dt) {
  // the light runs on its own clock and outlives the sweep, so this is ticked
  // before the state check rather than under it
  cas.stepHead(dt);
  if (swap.state !== 'sweep') return;
  swap.p = Math.min(1, swap.p + dt / SWAP_DUR);
  const k = ease.inOut(swap.p);
  cas.sweepLabel(k);
  // the machine takes the load: pressed down under the head, up again after it
  swap.press = Math.sin(Math.PI * k) * 0.10;
  if (swap.p >= 1) settleSwap();
}

function settleSwap() {
  swap.state = 'idle';
  swap.press = 0;
  cas.commitLabel();
  // The plates' ghost copies hold the maps that are about to go — move them off
  // first. bindProbe() does the same dance for the probe, for the same reason.
  for (const e of ghosts) {
    const i = swap.old.indexOf(e.m.map);
    if (i >= 0) e.m.map = swap.neu[i];
  }
  for (const t of swap.old) t.dispose();
  swap.neu = swap.old = null;

  Object.assign(TRACK, swap.meta);
  swap.meta = null;
  // no duration (a file the browser cannot decode) leaves the total where it
  // was, and the card keeps the '--' it was printed with
  if (swap.dur > 0) {
    cas.st.duration = swap.dur;
    brandCode.textContent = 'C—' + tapeMinutes(swap.dur);
  }
  setNowChip();
  flashAdd(null);
  // a play pressed while the head was moving waits for the tape, not the tape bed
  if (swap.play) { swap.play = false; togglePlay(true); }
}

/** the track that was loading is dropped without being read: nothing was ever
    printed with it, so there is nothing to put back */
function cancelSwap() {
  loadSeq++;                                  // ...and any load still waiting bails
  swap.state = 'idle';
  swap.press = 0;
  swap.meta = null;
  swap.dur = 0;
  swap.play = false;
  if (swap.neu) for (const t of swap.neu) t.dispose();
  swap.neu = swap.old = null;
  cas.warmLabel(false);
}

/** REINITIALIZE puts the shipped record back, print and all. No sweep: this
    button *is* the reset, and a reset that eases into place is not a reset. */
function reinitTrack() {
  if (swap.state !== 'idle') cancelSwap();
  if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
  const T = TRACK_DEFAULT;
  currentName = T.src;
  audioEl.pause();
  audioEl.src = T.src;
  audioEl.load();
  audioEl.currentTime = 0;
  cas.setProgress(0);
  audioFailed = false;
  Object.assign(TRACK, T);
  const staged = cas.setLabel({ title: T.title, artist: T.artist, album: T.album, minutes: '05' });
  for (const e of ghosts) {
    const i = staged.old.indexOf(e.m.map);
    if (i >= 0) e.m.map = staged.neu[i];
  }
  cas.commitLabel();
  for (const t of staged.old) t.dispose();
  cas.warmLabel(false);
  brandCode.textContent = 'C—05';
  setNowChip();
  swap.dur = 0;
}

/* deep-linkable state:  ?v=front&x=1&f=1&t=studio&p=1&ui=0&intro=0 */
const Q = new URLSearchParams(location.search);
/* `camera` is false while the intro is going to play. The intro *is* a camera
   move, so landing the URL's vantage on top of it cancels the whole thing —
   ?intro=1&r=03 should still open record 03, it just shouldn't grab the lens.
   Everything else in the query applies either way. */
function applyQuery(camera = true) {
  if (Q.get('ui') === '0') document.querySelector('.ui').style.display = 'none';
  if (Q.get('fps') === '1') {
    perfEl = document.createElement('div');
    perfEl.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:99;font:11px/1.4 Consolas,monospace;letter-spacing:.08em;color:#8dffb0;background:rgba(0,0,0,.55);padding:3px 10px;border-radius:99px';
    document.body.appendChild(perfEl);
  }
  if (Q.has('t')) setTheme(Q.get('t'), true);
  // through VANTAGES rather than a private table, so ?v=detail lands in the
  // same state as clicking there — including the panel narrowing itself
  const vk = camera && Q.has('v') ? VANTAGES.findIndex((x) => x.k === Q.get('v')) : -1;
  if (vk >= 0) { vi = vk; orbit.setPreset(VANTAGES[vk].v, true); }
  else if (camera && [...Q.keys()].length && !Q.has('x')) orbit.setPreset(orbit.home, true);
  // instant, like x=1 and r=: this URL exists to be screenshotted, and a flip
  // that eases over a second gets caught mid-turn
  if (Q.get('f') === '1') setFlip(true, true);
  if (Q.get('x') === '1') setExplode(true, true);
  // ?r=03 opens that record: the id, not the index, so a link keeps working
  if (Q.has('r')) {
    const r = RECORDS.findIndex((x) => x.no === Q.get('r').padStart(2, '0'));
    if (r >= 0) { ri = r; readRecord(true, camera); }
  }
  if (Q.get('p') === '1') togglePlay(true);
  if (Q.get('spin') === '1') setAuto(true);
  else if (Q.get('spin') === '0') setAuto(false);
  render();          // 'v' and 'r' both move state the panel has to reflect
}

/* ============================== annotations ============================= */
/* Every leader runs to the left edge: the right half of the frame belongs to
   the dossier, and a callout landing on top of the spec table is unreadable. */
const ANNOS = [
  { key: 'shell', side: 'left', n: '01', t: '烟灰上壳', s: 'POLYCARBONATE · 1.1 mm' },
  { key: 'glass', side: 'left', n: '02', t: '观察窗', s: 'PC GLASS · TRANSMISSION 1.0' },
  { key: 'screw', side: 'left', n: '03', t: '自攻螺钉', s: 'STEEL · M2 × 5 · ×5' },
  { key: 'tape', side: 'left', n: '04', t: '磁带', s: 'γ-Fe₂O₃ · 3.81 mm' },
  { key: 'hub', side: 'left', n: '05', t: '轮毂与带盘', s: 'POM · 6-SPLINE · ⌀12' },
];
const ui = document.querySelector('.ui');
const lines = $('#lines');
const slots = { left: 0, right: 0 };
for (const a of ANNOS) {
  const el = document.createElement('div');
  el.className = 'anno';
  el.dataset.side = a.side;
  el.innerHTML = `<u>${a.n}</u><b>${a.t}</b><i>${a.s}</i>`;
  ui.appendChild(el);
  a.el = el;
  a.slot = slots[a.side]++;
  const ns = 'http://www.w3.org/2000/svg';
  a.line = document.createElementNS(ns, 'line');
  a.dot = document.createElementNS(ns, 'circle');
  a.dot.setAttribute('r', '3');
  lines.append(a.line, a.dot);
  // the label's own transform depends on nothing but which side it hangs on,
  // so it is written once here rather than every frame out in the update
  el.style.transform = a.side === 'right' ? 'translate(-100%,-50%)' : 'translate(0,-50%)';
}
const measure = () => {
  for (const a of ANNOS) a.w = a.el.getBoundingClientRect().width;
};

const annoVec = new THREE.Vector3();
/* An SVG attribute written only when it has actually moved. This runs every
   frame, and a settled exploded view is a still diagram: sixty times a second
   it was writing five style strings, ten attributes and two opacities to values
   nothing had changed, which is a style recalculation and a layout of the label
   subtree per frame, plus a fresh string per value for the collector. The last
   value is kept on the annotation and compared first — as a number, so the
   string is only ever built when it is going to be used. */
const wAttr = (a, k, el, v) => { if (a[k] === v) return; a[k] = v; el.setAttribute(k, v); };
let explodedShown = null;
function updateAnnotations() {
  const e = cas.st.explode;
  const on = e > 0.02;
  if (explodedShown !== on) {
    explodedShown = on;
    document.body.classList.toggle('exploded', on);
    lines.style.opacity = on ? '1' : '0';
  }
  // shut, nothing is named: forgetting here is what keeps a later 拆解 from
  // resurrecting the name of whatever was read a while ago
  if (!on) { lastFocus = null; return; }
  // Which labels belong to this moment. A settled exploded view is the diagram,
  // so all five are named; a record names only its own part. Coming back together
  // is the third case and needs its own answer: the part you were reading keeps
  // its name while the shell closes and fades out with it, rather than the whole
  // diagram appearing for the length of the animation and fading afterwards.
  const closing = cas.st.explodeTarget < e - 1e-4;
  const solo = closing ? lastFocus : focusKey;
  const v = annoVec;
  const narrow = innerWidth < 900;
  for (const a of ANNOS) {
    // while a record is open, only its part keeps a leader line — the label is
    // hidden by CSS, but the line and dot are SVG and need telling separately
    const shown = (!solo && !closing) || a.key === solo;
    // The class is written here rather than in render() because which labels
    // belong on screen now depends on how far the shell has come back, and that
    // is a per-frame question. Style, not attribute: the labels these belong to
    // fade over 0.6 s, and a line that blinks out under a label that is still
    // fading reads as the annotation tearing in half. All three move together,
    // so one guard covers them.
    if (a.muted !== !shown) {
      a.muted = !shown;
      a.el.classList.toggle('mute', !shown);
      a.line.style.opacity = shown ? 1 : 0;
      a.dot.style.opacity = shown ? 1 : 0;
    }
    if (!shown) continue;
    cas.anchors[a.key].getWorldPosition(v).project(camera);
    const x = (v.x * 0.5 + 0.5) * innerWidth;
    const y = (-v.y * 0.5 + 0.5) * innerHeight;
    const lx = a.side === 'right' ? innerWidth - (narrow ? 24 : 56) : (narrow ? 24 : 56);
    // five callouts have to fit between the masthead and the deck, so the
    // spacing is set by that band rather than by the frame
    const ly = innerHeight * (0.20 + a.slot * 0.125);
    const lxr = lx + (a.side === 'right' ? (1 - e) * 40 : -(1 - e) * 40);
    if (a.lx !== lxr) { a.lx = lxr; a.el.style.left = lxr + 'px'; }
    if (a.ly !== ly) { a.ly = ly; a.el.style.top = ly + 'px'; }
    const ex = a.side === 'right' ? lxr - a.w - 12 : lxr + a.w + 12;
    wAttr(a, 'x1', a.line, ex); wAttr(a, 'y1', a.line, ly);
    wAttr(a, 'x2', a.line, x); wAttr(a, 'y2', a.line, y);
    wAttr(a, 'cx', a.dot, x); wAttr(a, 'cy', a.dot, y);
  }
}

/* ============================== theme =================================== */
function setTheme(name, first = false) {
  // a bad ?t= used to reach THEMES[name].env as undefined and take the whole
  // boot down with it
  if (!THEMES[name]) name = 'studio';
  const prev = themeName;
  themeName = name;
  // the whole room walks from here: one clock for the lamps, the exposure, the
  // grade, the floor and the background (see themeRate)
  if (!first) {
    themeP = 0;
    themeProbe = true;
    iblFrom = roomSrgb(THEMES[prev]);   // the room being left
    iblTo = roomSrgb(THEMES[name]);     // and the one being entered
  } else {
    iblFrom = iblTo = iblRef = roomSrgb(THEMES[name]);   // laid, not walked
  }
  document.documentElement.dataset.theme = name;
  // the segmented control is styled off a class, not off [data-theme], so it
  // has to be told. Without this the highlight sits on 影棚 no matter which
  // room you are actually standing in.
  for (const b of document.querySelectorAll('#theme button')) {
    b.classList.toggle('on', b.dataset.theme === name);
    b.setAttribute('aria-pressed', String(b.dataset.theme === name));
  }
  render();                               // the illumination column marks the live one
  scene.environment = envs[THEMES[name].env];
  setBackdrop(name, first);
  if (rigPanels) {
    scene.remove(rigPanels);
    rigPanels.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    rigPanels = buildRigPanels(name, 2);
    scene.add(rigPanels);
    markProbeDirty();
  }
}

/** hand the incoming room to the second shell; `fadeBackdrop` walks it in */
function setBackdrop(name, first = false) {
  const map = backdropMaps[name];
  if (!map) return;
  if (first) {                                  // boot and deep links land settled
    backdrop.material.map = map;
    backdrop.material.needsUpdate = true;
    return;
  }
  // a fade already in flight: if it is more than half there, the room it is
  // carrying is the one the eye is in — promote it first, so the next room
  // fades in over what is actually on screen rather than over the one before it
  if (backdropIn.visible && backdropIn.material.opacity >= 0.5) {
    backdrop.material.map = backdropIn.material.map;
    backdrop.material.needsUpdate = true;
    backdropIn.material.opacity = 0;
  }
  backdropIn.material.map = map;
  backdropIn.material.needsUpdate = true;
  backdropIn.visible = true;
}

/* The room change runs on a clock, not on an exponential decay. A decay drops
   most of its range in the first third of a second: going brighter that is
   barely noticeable, and going darker it reads as the lights being cut — 影棚
   to 暗房 came back as "突然变暗" for exactly that reason. This walks the
   transition linearly instead, eased at both ends, so the room gets dark at a
   rate the eye can follow.

   A rate cannot be written down in advance the way a decay can, because the
   distance each value has to cover differs; what is shared is the *progress*.
   For dx/dt = rate·(target − x) with rate = p′/(1 − q), the solution is
   x = x₀ + (target − x₀)·q — the damper every value here already uses, driven
   by a rate that turns it into a linear walk in q. Each value therefore lands
   exactly on q(p), which is what keeps a colour, a light *and* an opacity in
   step with each other no matter how far each has to travel. */
const THEME_DUR = 1.6;
let themeP = 1;                        // 0 → 1 while a room change is walking
function themeQ() {                    // eased progress, the shape every value lands on
  const p = themeP;
  return p * p * (3 - 2 * p);
}
function themeRate() {
  if (themeP >= 1) return 2.8;         // settled: back to an ordinary ease
  const s = themeQ();
  return (6 * themeP * (1 - themeP)) / (THEME_DUR * Math.max(1e-3, 1 - s));
}

function applyTheme(dt, instant = false) {
  const T = THEMES[themeName];
  themeP = Math.min(1, themeP + dt / THEME_DUR);
  const l = themeRate();
  rig.apply(RIG[themeName], dt, instant, l);
  const k = instant ? 1 : 1 - Math.exp(-l * dt);
  /* `instant` is documented at the boot call site as "land the whole preset
     before the first frame" — but damp(x, y, l, 0) is a *no-op*, not a snap, so
     everything that eases through damp() was staying on its default and then
     drifting into the preset over the first second of the page. k-scaled values
     snap; damped ones need telling. */
  const to = (cur, tgt) => (instant ? tgt : damp(cur, tgt, l, dt));
  renderer.toneMappingExposure += ((RIG[themeName].exposure ?? 1) - renderer.toneMappingExposure) * k;
  scene.environmentIntensity += ((RIG[themeName].envInt ?? 1) - (scene.environmentIntensity ?? 1)) * k;
  dust.mat.opacity = to(dust.mat.opacity, T.dust);
  floorBase.uniforms.color.value.lerp(T.cFloor2, k);
  floorBase.uniforms.uMix.value = to(floorBase.uniforms.uMix.value, T.floorMix);
  shadowCatcher.material.opacity = to(shadowCatcher.material.opacity, T.shadowOp);
  grade.uniforms.uHal.value = to(grade.uniforms.uHal.value, T.hal);
  const G = T.grade ?? {};
  grade.uniforms.uGrain.value = to(grade.uniforms.uGrain.value, G.grain ?? 0.05);
  grade.uniforms.uCA.value = to(grade.uniforms.uCA.value, G.ca ?? 0.85);
  grade.uniforms.uVig.value = to(grade.uniforms.uVig.value, G.vig ?? 0.85);
  grade.uniforms.uSat.value = to(grade.uniforms.uSat.value, G.sat ?? 1);
  // the lens' own defocus was the one stage no theme could reach: it sat at its
  // default in all three rooms, so 动画 got the same wide-open blur as 暗房.
  // Same numbers everywhere today — this is here so a theme *can* own it.
  grade.uniforms.uEdge.value = to(grade.uniforms.uEdge.value, G.edge ?? 1);
  grade.uniforms.uFocus.value = to(grade.uniforms.uFocus.value, G.focus ?? 0.26);
  if (bloom) bloom.strength = to(bloom.strength, G.bloom ?? 0.32);
  const TO = T.toon ?? { on: 0 };
  grade.uniforms.uToon.value = to(grade.uniforms.uToon.value, TO.on ?? 0);
  grade.uniforms.uFlat.value = to(grade.uniforms.uFlat.value, TO.flat ?? 0);
  grade.uniforms.uInk.value = to(grade.uniforms.uInk.value, TO.ink ?? 0);
  if (TO.levels) grade.uniforms.uLevels.value = TO.levels;
  if (TO.width) grade.uniforms.uInkWidth.value = TO.width;
  if (composer?.ao) composer.ao.strength = to(composer.ao.strength, T.ao ?? 1);
  poolMat.color.lerp(T.cPool, k);
  poolMat.opacity = to(poolMat.opacity, T.poolOp);
  // the background crosses over on the same clock as everything else, and once
  // it has arrived the incoming room simply becomes the base. This replaces the
  // shutter dip that used to cover the map swap: there is nothing left to hide,
  // and a full-frame brightness drop is a flash the page should not be adding.
  if (backdropIn.visible) {
    const bm = backdropIn.material;
    bm.opacity = to(bm.opacity, 1);
    if (bm.opacity > 0.999) {
      backdrop.material.map = bm.map;
      backdrop.material.needsUpdate = true;
      bm.opacity = 0;
      backdropIn.visible = false;
    }
  }
  intro.fade = reduce ? 1 : damp(intro.fade, 1, 1.6, dt);
  grade.uniforms.uFade.value = intro.fade;
  applyIblFade(dt);
}

/* ============================== reflection probe ======================== */
/** the probe is captured from the subject's centre and filtered through PMREM;
    every cassette material reflects the rig *and* the cassette itself */
function bindProbe(tex) {
  if (!tex || !cas) return;
  for (const m of Object.values(cas.materials)) {
    if (!m || !m.isMaterial) continue;
    m.envMap = tex;
    if (!probeBound) m.needsUpdate = true;   // one recompile, then just swap
  }
  // the travelling ghost copies are not in `materials`; without this a part
  // caught mid-ghost when the theme changes keeps the old probe and goes flat
  for (const e of ghosts) {
    e.m.envMap = tex;
    if (!probeBound) e.m.needsUpdate = true;
  }
  // And neither are the write head's layers, which is worse: they are *meant* to
  // be invisible stand-ins for the label plates, so a layer outside this pipeline
  // is lit by a different room than the plate it covers. The reveal then reads as
  // a brightness band crossing the card — bright or dark depending on which way
  // the two rooms differ — and the frame the head is taken off it, the whole
  // label snaps back to the plate's shading. That snap is what looked like a
  // white light being switched off at the end of the sweep.
  for (const m of cas.headMaterials) {
    m.envMap = tex;
    if (!probeBound) m.needsUpdate = true;
  }
  probeBound = true;
}

/** A capture produces a whole new texture, and pointing every material at it is
    one uniform write — there is no gradual version of that. Blending two IBLs
    in the shader is a lot of machinery, so instead the tape's grip on the probe
    is walked down to nothing, the capture is taken there, and the new room's
    reflections come back up over the rest of the change (see applyIblFade).
    The capture is a step either way; this only decides whether anyone is
    looking at the frame it happens in. */
function markProbeDirty() { probeDirty = true; }

/* A room change always leaves the probe stale, and pointing every material at
   the new one is a single assignment — so the tape cannot be *faded* through a
   re-take. It is *matched* instead: whatever the room's brightness is at this
   moment, the tape holds that much light. The probe it is holding may be the
   outgoing room's or the incoming one's; `envMapIntensity` makes up the
   difference either way. That is what keeps the shell from going dark in the
   middle of a room change — a fade to nothing put the tape in the dark half a
   second before the room got there, which is a thing the eye reads
   immediately — and it also means the capture can land on any frame without the
   shell changing brightness. What does change at that moment is which room the
   reflections *are*, which is why the capture waits for the darker of the two
   rooms (see the loop).

   The room's own brightness is the backdrop's: two rooms crossing is an alpha
   blend of sRGB values, so that is the space this walks in, and the one
   conversion to light is the 2.2. */
let themeProbe = false;
let iblFrom = 1, iblTo = 1;              // the two rooms' sRGB luminances
let iblSrgb = 1, iblRef = 1;             // the room now, and the room the bound probe is
let iblK = 1, iblWritten = 1;            // the cassette's envMapIntensity, tracked

function writeIbl(k) {
  if (!cas) return;
  for (const m of Object.values(cas.materials)) if (m?.isMaterial) m.envMapIntensity = k;
  for (const e of ghosts) e.m.envMapIntensity = k;
  // ...and the write head's layers, which hold the same brightness as the plate
  for (const m of cas.headMaterials) m.envMapIntensity = k;
}
/** the backdrop's average luminance, in the sRGB the stops are written in */
function roomSrgb(T) {
  const l = T.bg.stops.reduce((a, [, hex]) => {
    const v = parseInt(hex.slice(1), 16);
    return a + 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
  }, 0);
  return l / T.bg.stops.length / 255;
}
iblSrgb = iblRef = roomSrgb(THEMES.studio);
iblFrom = iblTo = iblSrgb;

/** hold as much light as the room currently has, whichever room's probe is in
    hand. `iblWritten` makes this a writer only while it has something to say,
    which is also what keeps it away from the ghost list before that list
    exists. */
function applyIblFade(dt) {
  iblSrgb = themeProbe ? iblFrom + (iblTo - iblFrom) * themeQ() : iblTo;
  const want = Math.pow(iblSrgb / iblRef, 2.2);
  const next = damp(iblK, want, 11, dt);
  iblK = Math.abs(next - want) < 0.002 ? want : next;
  if (iblK === iblWritten) return;
  iblWritten = iblK;
  writeIbl(iblK);
}

/** Capture as if the room had already finished changing. The probe photographs
    the backdrop along with everything else, and for the first second of a theme
    change that backdrop is still crossing over — a capture taken then bakes the
    room we are leaving into the reflections for the rest of the session. Six
    cube faces render synchronously, so nothing but the probe sees this. */
function captureProbe() {
  const fading = backdropIn.visible;
  const held = backdrop.material.map;
  if (fading) {
    backdrop.material.map = backdropIn.material.map;
    backdrop.material.needsUpdate = true;
    backdropIn.visible = false;
  }
  // and the tape is mid-fade for the same reason — it is being captured
  // reflecting the room, and a cassette with its IBL switched off reflects
  // nothing, so the probe would bake a matte body into every later reflection
  // of itself
  const heldK = iblK;
  if (heldK !== 1) writeIbl(1);
  const tex = probe.capture();
  if (heldK !== 1) writeIbl(heldK);
  themeProbe = false;                    // whichever room asked for it, it is fresh now
  iblRef = iblTo;                        // and it is this room's light the tape is holding
  if (fading) {
    backdrop.material.map = held;
    backdrop.material.needsUpdate = true;
    backdropIn.visible = true;
  }
  bindProbe(tex);
}

/* ============================== boot ==================================== */
const loaderBar = $('#lbar'), loaderLbl = $('#llbl'), loaderPct = $('#lpct');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
function showError(msg) {
  console.error(msg);
  if (loaderLbl.parentElement) {
    loaderPct.textContent = 'ERR';
    loaderLbl.textContent = String(msg).slice(0, 160);
    loaderLbl.style.color = '#e0684a';
  }
}
addEventListener('error', (e) => showError(e.error?.stack || e.message));
addEventListener('unhandledrejection', (e) => showError(e.reason?.stack || e.reason?.message || String(e.reason)));
async function step(label, pct, fn) {
  loaderLbl.textContent = label;
  loaderBar.style.width = pct + '%';
  loaderPct.textContent = pct + '%';
  await nextFrame();
  await fn?.();
  await nextFrame();
}

async function boot() {
  await step('正在建立几何体', 12, () => {
    cas = createCassette({ title: TRACK.title, artist: TRACK.artist, album: TRACK.album, minutes: '05' });
    scene.add(cas.root);
    rig = createRig(scene);
    // the shell only breathes slowly, so the shadow map does not need a full
    // re-render every frame — refresh it on alternate frames instead
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    setDur();
    audioEl.addEventListener('loadedmetadata', setDur);
    audioEl.addEventListener('durationchange', setDur);
    audioEl.addEventListener('error', () => {
      // the loader is already gone by the time a late 404 lands, so the failure
      // has to say so somewhere the user can still see: the now-playing chip
      audioFailed = true;
      document.body.classList.add('no-audio');
      if (swap.state === 'idle') setNowChip();
      showError('音频加载失败（' + (audioEl.error?.code ?? '?') + '）：' + currentName);
    });
    audioEl.addEventListener('ended', () => {
      mode = 'rew';
      cas.st.driven = false;
      cas.st.playing = true;
      cas.st.dir = 1;                                    // spool back, then play again
      document.body.classList.add('rewinding');
    });
    setNowChip();
  });
  await step('正在合成材质与纹理', 42, () => {});
  await step('正在烘焙环境光照', 68, () => {
    envs = createEnvironments(renderer);
    for (const k of Object.keys(THEMES)) backdropMaps[k] = TX.backdropTexture(THEMES[k].bg);
    // softboxes as geometry on a hidden layer, so the probe sees the rig
    rigPanels = buildRigPanels('noir', 2);
    scene.add(rigPanels);
    // the probe sits outside the shell, above and in front: from there it sees
    // the lighting rig *and* the cassette's own body, so glossy and chrome parts
    // pick up the studio and their neighbouring parts in the same reflection
    probe = createProbe(renderer, scene, { size: 512, at: [0, 2.4, 3.4] });
  });
  await step('正在解算自反射', 78, () => {
    captureProbe();
  });
  await step('正在编译着色器', 88, () => {
    composer = createComposer(renderer, scene, camera);
    grade = composer.grade; bloom = composer.bloom;
    setTheme(themeName, true);
    applyTheme(0, true);          // land the whole preset before the first frame
  });
  await step('准备就绪', 100, async () => {
    onResize();
    // Every ghost copy is built now and held on its mesh just long enough for
    // the compiler to see it. three keys a program on `opaque`, and a ghost is
    // transparent, so each one needs a second program — built lazily that was a
    // burst of compiles on the first frame of the first 读取, i.e. the picture
    // stopping for a beat the instant you click. Pay for it here instead.
    const restore = [];
    cas.assembly.traverse((o) => {
      if (!o.isMesh || Array.isArray(o.material)) return;
      restore.push([o, o.material]);
      o.material = ghostFor(o).m;
    });
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
    for (const [o, src] of restore) o.material = src;   // parts stay real until asked

    // Compiling them is not enough on its own. three keeps a program only while
    // some material is using it, and a compile pass hands the materials back
    // straight away — so the variants that only a ghost ever asks for (the
    // transparent pass *and* the probe's cube-UV envmap sampling) are dropped
    // again, and the first 读取 of each record re-links three to eight of them on
    // the spot. Measured: 75 programs after boot, +8 the first time 轮毂 is
    // read, +3 more for 上壳, and nothing at all on the second read of the same
    // record — i.e. they survive once built. So build them here and *use* them:
    // one real frame per record, behind the loader, and every later click is
    // free.
    for (const R of RECORDS) {
      applyFocus(R.key);
      composer.composer.render();
    }
    applyFocus(null);
    // and put the scene back exactly as a settled ghost fade would leave it:
    // every part on its own material, in its own draw order, painted at k = 0
    for (const e of ghosts) {
      paintGhost(e, 0);
      e.o.material = e.base;
      e.o.renderOrder = e.order;
      e.live = false;
    }
    ghosts.length = 0;
    composer.composer.render();
    // ...and the write head's two layers, which stay invisible until a track is
    // loaded. A program is built on the first frame a material is *drawn*, so
    // without this the first sweep would build two of them on the frame it
    // starts — a stutter in the middle of a move. Open the window over the print
    // that is already on the card: nothing changes on screen, and it is still
    // behind the loader.
    cas.warmLabel(true);
    composer.composer.render();
    cas.warmLabel(false);
  });
  document.body.classList.add('ready');
  measure();
  render();
  pinPanel();          // measured with a record's sheet in it, not an empty one
  applyPrefs();        // the remembered switches, now that there is a scene to apply them to
  // ?intro=1 forces it and ?intro=0 refuses it — any other query at all, which is
  // how a link meant to be photographed lands, has never played it. Otherwise the
  // setting decides.
  const qIntro = Q.get('intro');
  const wantsIntro = qIntro === '1' ? true : qIntro === '0' ? false
    : prefs.intro && ![...Q.keys()].length;
  if (!wantsIntro) intro.fade = 1;
  else runIntro();
  applyQuery(!wantsIntro);
  loop();
}

/* ============================== intro =================================== */
const intro = { y: 0, tilt: 0, spin: 0, fade: 0 };
/* The lift starts *on* the floor, not under it. Coming up through the floor
   from below meant the tape spent the first two seconds of the page buried in
   a sheet it has no business being inside — and every frame of that was a
   slab pushing through a plane, which is the one thing this scene is otherwise
   careful never to do. It now waits on the floor for 0.7s (long enough to be
   seen resting there) and then floats up to the height it belongs at. */
const FLOOR_REST = FLOOR_Y + DIM.hd;

/* linear for most of the way and eased out into the last of it. A straight
   ease over this distance spends the whole travel braking and never reads as a
   rise; a straight line arrives like a lift. This is the shape the hover has:
   a rate, with the floor coming up to meet it. */
const LIFT = (t) => (t < 0.62 ? (t / 0.62) * 0.82 : 0.82 + 0.18 * ease.out((t - 0.62) / 0.38));

let tl = null;
function runIntro() {
  if (reduce) {
    intro.fade = 1; intro.y = 0; intro.tilt = 0;
    orbit.setPreset(orbit.home, true);
    return;
  }
  intro.y = FLOOR_REST; intro.tilt = 0; intro.spin = 2.4; intro.fade = 0;
  orbit.theta = orbit.gTheta = 1.32;
  orbit.phi = orbit.gPhi = 1.38;
  orbit.radius = orbit.gRadius = 42;
  tl = new Timeline();
  tl.add({
    delay: 0.7, dur: 2.4, ease: LIFT,
    onUpdate: (e) => { intro.y = FLOOR_REST * (1 - e); },
  });
  tl.add({ delay: 3.6, dur: 0, onDone: markProbeDirty });   // the probe was captured before the lift
  tl.play();
  orbit.setPreset(orbit.home, false);
  if (orbit.tween) orbit.tween.dur = 3.4;
}

/* ============================== the index ===============================
   Everything the page can do is a file in an index. Five columns of them:
   ←/→ walks the columns, ↑/↓ walks the files inside one, and ENTER — or the
   ACCESS FILE button, or a second click on an already-selected row — reads
   the file. Reading is what actually moves the scene, so browsing the list is
   free and nothing changes under you while you are reading it.

   The labels are functions wherever a file is a toggle, so the dossier always
   names the action it is about to perform rather than the state it is in.
   ===================================================================== */
/* The model does not turn by itself until asked to. 巡览 used to start on, and
   the same switch also gates the slow drift the camera picks up after a drag
   (controls.js scales it by the eased auto weight), so leaving it off means the
   tape simply holds still until something moves it. */
let exploded = false, flipped = false, autoRotate = false;

/* One record per thing that is actually on this tape: the whole unit, and the
   five parts the exploded drawing is made of. A record carries its own real
   spec sheet, its own framing, and — for a part — the node that stays in its
   true materials while the rest of the shell drops back to a ghost. The three
   numbers in `spec` are the only made-up thing here; everything else is read
   off the model. */
const RECORDS = [
  {
    no: '00', cn: '整机', en: 'MAGNETIC TAPE · TYPE II',
    note: '聚碳酸酯外壳，γ-Fe₂O₃ 磁层，3.81 mm 带基。工程与手感之间，一段沉默的机械。',
    spec: [['外壳', '聚碳酸酯 · 烟灰'], ['磁层', 'γ-Fe₂O₃ · 12 µm'], ['带基', 'PET · 3.81 mm'],
      ['屏蔽', '冷轧钢 · 0.8 mm'], ['轮毂', 'POM · 六齿']],
    act: '读取整机', key: null,
    view: { theta: 0.62, phi: 1.03, radius: 33 }, viewName: '等轴机位', viewEn: 'ISOMETRIC',
  },
  {
    no: '01', cn: '烟灰上壳', en: 'POLYCARBONATE SHELL',
    note: '注塑上壳，细纹面半哑清漆。观察窗、标签与全部印刷都落在这一层。',
    spec: [['材料', '聚碳酸酯 · 烟灰'], ['壁厚', '1.1 mm'], ['表面', '细纹 · 半哑'], ['印刷', 'SIDE A · 丝印']],
    act: '读取上壳', key: 'shell',
    view: { theta: 0.78, phi: 0.98, radius: 33 }, viewName: '专用机位', viewEn: 'SHELL LIFT',
  },
  {
    no: '02', cn: '观察窗', en: 'SMOKED WINDOW',
    note: '烟灰 PC 玻璃，双面清漆。透光压到三成，走带清晰而不抢外壳的形。',
    spec: [['材料', 'PC 玻璃 · 烟灰'], ['透射', '0.30'], ['厚度', '0.03'], ['工艺', '双面清漆']],
    act: '读取观察窗', key: 'glass',
    view: { theta: 0.60, phi: 0.86, radius: 33 }, viewName: '专用机位', viewEn: 'WINDOW LIFT',
  },
  {
    no: '03', cn: '自攻螺钉', en: 'SELF-TAPPING SCREW',
    note: '五颗 M2 自攻螺钉，两前两后一颗中置，直接拧入聚碳酸酯柱。',
    spec: [['规格', 'M2 × 5'], ['数量', '5 枚'], ['材料', '冷轧钢 · 镀镍'], ['分布', '四角 + 中置']],
    act: '读取螺钉', key: 'screw',
    view: { theta: 0.45, phi: 0.80, radius: 33 }, viewName: '专用机位', viewEn: 'POD PLAN',
  },
  {
    no: '04', cn: '磁带', en: 'MAGNETIC TAPE',
    note: 'γ-Fe₂O₃ 磁层涂在 3.81 mm 带基上，以 4.76 cm/s 走过磁头。',
    spec: [['磁层', 'γ-Fe₂O₃'], ['带宽', '3.81 mm'], ['带速', '4.76 cm/s'], ['带基', 'PET · 12 µm']],
    act: '读取磁带', key: 'tape',
    view: { theta: 1.00, phi: 0.98, radius: 33 }, viewName: '专用机位', viewEn: 'RIBBON PATH',
  },
  {
    no: '05', cn: '轮毂与带盘', en: 'HUB & PACK',
    note: '六齿 POM 轮毂带动带盘，半径按带面积守恒实时变化。',
    spec: [['轮毂', 'POM · 六齿'], ['轴径', '⌀12'], ['满盘半径', '⌀40.4'], ['驱动', '恒线速']],
    act: '读取轮毂', key: 'hub',
    view: { theta: 0.88, phi: 0.76, radius: 33 }, viewName: '专用机位', viewEn: 'HUB MACRO',
  },
];

/* the camera's four filed vantages, independent of whatever record is open */
const VANTAGES = [
  { k: 'iso', cn: '等轴机位', en: 'ISOMETRIC', v: { theta: 0.62, phi: 1.03, radius: 33 } },
  { k: 'front', cn: '正视机位', en: 'ELEVATION', v: { theta: 0.06, phi: 1.30, radius: 31 } },
  { k: 'top', cn: '俯视机位', en: 'PLAN', v: { theta: 0.34, phi: 0.30, radius: 34 } },
  { k: 'detail', cn: '细节特写', en: 'MACRO', v: { theta: 0.95, phi: 1.14, radius: 21 } },
];

let ri = 0, vi = 0;               // record, vantage; vi < 0 means a record's own framing
let savedVi = 0;                  // the vantage an exploded pull-back stepped away from
const cur = () => RECORDS[ri];
const MACRO = VANTAGES.findIndex((v) => v.en === 'MACRO');

const D = {
  colCn: $('#col-cn'), colCn2: $('#col-cn-2'), colEn: $('#col-en'),
  colI: $('#col-i'), colN: $('#col-n'),
  fileno: $('.fileno'), caret: $('.fileno .caret'),
  fileId: $('#file-id'), fileCn: $('#file-cn'), fileEn: $('#file-en'),
  fileNote: $('#file-note'), fileSpec: $('#file-spec'), doc: $('.doc'),
  selI: $('#sel-i'), selN: $('#sel-n'),
  refList: $('#ref-list'), cols: $('#cols'),
  access: $('#btn-access'), accessLabel: $('#access-label'),
  dossier: $('#dossier'), dbody: $('#dbody'), fold: $('#btn-fold'),
};
D.colN.textContent = String(VANTAGES.length).padStart(2, '0');
D.selN.textContent = RECORDS[RECORDS.length - 1].no;

/* the pick list and the ticks, built once. The records never change — only
   which of them is live — so `render` only ever toggles their classes, and the
   markers get to slide instead of being replaced mid-stride. */
const refRows = [], ticks = [];
for (let i = 0; i < RECORDS.length; i++) {
  const r = RECORDS[i];
  // click selects; clicking the row you already selected reads it, so the
  // list can be driven end to end without reaching for the button
  const pick = () => { if (i === ri) readRecord(); else { ri = i; render(true); } };

  const b = document.createElement('button');
  b.className = 'row';
  b.innerHTML = `<span class="rn">${r.no}</span><span class="rt">${r.cn}</span><i class="rd"></i>`;
  b.addEventListener('click', pick);
  const li = document.createElement('li');
  li.appendChild(b);
  D.refList.appendChild(li);
  refRows.push(b);

  const t = document.createElement('button');
  t.className = 'tick';
  t.title = `${r.no} · ${r.cn}`;
  t.setAttribute('aria-label', `${r.no} ${r.cn}`);
  t.addEventListener('click', pick);
  D.cols.appendChild(t);
  ticks.push(t);
}

/* ---------- ghosting: the part you are reading stays real ----------
   The parts that step aside travel to the ghost over about half a second
   rather than being swapped onto it. Everything the ghost is — its grey, its
   flatness, its transparency — is reached by animating the material's own
   uniforms: colour, roughness, metalness, clearcoat and normal scale all walk
   to the target, and the opacity follows them down. The old version cut
   straight to a translucent grey material, and next to a camera move and an
   explode that both ease, that one hard cut read as a glitch.

   The travelling copy has to be per-mesh, because the originals are shared:
   every part using `M.shell` points at the same material, so dimming one would
   dim all of them. The clone is made once, at boot, and kept — after that the
   only thing changing per frame is uniforms, so nothing recompiles. Building
   them lazily put the *first* program of each transparent variant on the first
   frame of the first read instead; see the warm-up in `boot`.

   The ghost is deliberately darker than the room, not paler: the room is
   already near-white, and a light ghost dissolves into it and turns the frame
   to mush. depthWrite stays off so a ghost never occludes the part you asked
   to see. */
const GHOST = {
  color: new THREE.Color(0x8a8375),
  opacity: 0.30, roughness: 0.92, metalness: 0, env: 0.25,
};
/* A transparent object cannot occlude anything, so whatever is drawn *after* it
   blends straight over the top — and the floor, the shadow catcher and the light
   pool are all transparent, sitting at renderOrder 1–3, i.e. after every ghost
   (they were all at 0). The floor fragment seen through the cassette is far
   beyond it, and the floor's own radial fade means that when the lens looks
   *down* at the shell, that fragment is close enough to be near full opacity.

   So look down and every ghost was painted over by the floor: a part fading
   back in never appeared to change at all. It stayed buried until the frame it
   went opaque, wrote depth, and had the floor rejected all in one go — which is
   the part snapping into existence instead of materialising. Looking from a low
   angle the floor behind the shell is past its fade radius and contributes
   nothing, which is why that view looked right.

   Ghosts therefore sort after the floor group, and in front of the window glass
   — transparent too, and it belongs on top of everything inside the shell. */
const GHOST_ORDER = 4;
const ghosts = [];

function focusSets(key) {
  const P = cas.parts;
  const reels = new Set(P.reels.map((r) => r.grp));
  switch (key) {
    case 'shell': return { keep: new Set([P.gTop]), drop: new Set([P.glass]) };
    case 'glass': return { keep: new Set([P.glass]) };
    case 'screw': return { keep: new Set([P.screwd]) };
    case 'tape': return { keep: new Set([P.gTape]), drop: reels };
    case 'hub': return { keep: reels };
    default: return null;
  }
}

let focusKey = null;
/* The part that was last named. A record names its own part, and that name has
   to outlive the record for as long as the shell takes to come back together —
   reading 整机 (or pressing E to close) clears focusKey on the first frame of the
   collapse, and without this the whole five-line diagram flashes up for the
   length of the animation and only then fades. */
let lastFocus = null;

/** the travelling copy for one mesh, created once and kept for the life of the
    page. Originals are shared — every part using `M.shell` points at the same
    material, so fading one would fade them all — hence one copy per mesh. */
function ghostFor(o) {
  let e = o.userData._g;
  if (e) return e;
  const src = o.material;
  const m = src.clone();
  m.transparent = true;
  m.depthWrite = false;
  // three renders a transparent DoubleSide material as two passes, flipping
  // `side` and setting needsUpdate each time — which re-acquires one program and
  // releases the other, and a released program is destroyed, so the next frame
  // compiles both again. Forever. The tape is DoubleSide, so every frame the
  // ghosted tape lived was two shader builds: reading 上壳 (tape ghosts) hitched
  // and reading 磁带 (tape stays real) did not, which is exactly what the
  // compile counter showed. forceSinglePass is three's own flag for this; the
  // ghost is a 30% grey stand-in, so the blend order the second pass buys is
  // not worth a shader build per frame.
  m.forceSinglePass = true;
  e = o.userData._g = {
    o, m, base: src, k: 0, t: 1, live: false, order: o.renderOrder,
    src: {
      color: src.color.clone(),
      opacity: src.opacity,
      roughness: src.roughness,
      metalness: src.metalness,
      clearcoat: src.clearcoat,
      sheen: src.sheen,
      env: src.envMapIntensity,
      ns: src.normalScale ? src.normalScale.clone() : null,
    },
  };
  return e;
}

function embrace(o) {
  const e = ghostFor(o);
  // the probe can have been re-captured since this copy was made (they are all
  // made at boot now), and a stale envMap is the one thing that would show
  e.m.envMap = e.base.envMap;
  if (o.material !== e.m) o.material = e.m;
  o.renderOrder = GHOST_ORDER;      // see GHOST_ORDER: the floor draws first
  e.t = 1;
  if (!e.live) { e.live = true; ghosts.push(e); }
}

function release(o) {
  const e = o.userData._g;
  if (e) e.t = 0;
}

/** k = 0 is the part's own material, k = 1 is the ghost */
const DEFINE_FLOOR = 0.004;
function paintGhost(e, k) {
  const m = e.m, s = e.src;
  m.color.copy(s.color).lerp(GHOST.color, k);
  m.opacity = s.opacity + (GHOST.opacity - s.opacity) * k;
  /* A transparent object cannot occlude anything: whatever is drawn after it
     blends over the top, even when it is behind. The reels are the clearest
     case — the wound pack is a full disc of the reel's own radius, its top face
     sits *below* the hub's top ring, and it is the later of the two in draw
     order, so a hub fading back in stayed washed grey under the disc until the
     frame it went opaque and depth took over.

     Once a part is opaque enough that it is hiding things anyway, let it write
     depth. Whatever is genuinely in front of it still blends as it should, and
     everything behind it is rejected however the sort ordered the two. A ghost
     proper (0.30) and the 0.30 window glass never reach the line, so neither of
     them ever starts occluding. */
  m.depthWrite = m.opacity >= 0.7;
  m.roughness = s.roughness + (GHOST.roughness - s.roughness) * k;
  m.metalness = s.metalness + (GHOST.metalness - s.metalness) * k;
  // three builds a shader program per *whether* clearcoat and sheen are on
  // (`HAS_CLEARCOAT = material.clearcoat > 0`, same for sheen), so easing either
  // one down to exactly zero compiles a fresh program on that frame — a dozen of
  // them landing together as the fade ends, which is the hitch a beat after
  // 读取 on the parts that carry both. Stop a hair short instead: at 0.004 the
  // layer contributes nothing visible and the define never flips.
  if (s.clearcoat > 0) m.clearcoat = Math.max(s.clearcoat * (1 - k), DEFINE_FLOOR);
  if (s.sheen > 0) m.sheen = Math.max(s.sheen * (1 - k), DEFINE_FLOOR);
  if (s.env !== undefined) m.envMapIntensity = s.env + (GHOST.env - s.env) * k;
  if (s.ns) m.normalScale.set(s.ns.x * (1 - k), s.ns.y * (1 - k));
}

function updateGhost(dt) {
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const e = ghosts[i];
    if (Math.abs(e.t - e.k) > 0.0015) {
      e.k = reduce ? e.t : damp(e.k, e.t, 5.0, dt);
      paintGhost(e, e.k);
    } else if (e.k !== e.t) {
      e.k = e.t;
      paintGhost(e, e.k);
    }
    if (e.t === 0 && e.k === 0) {
      e.o.material = e.base;          // back on the shared original
      e.o.renderOrder = e.order;
      e.live = false;
      ghosts.splice(i, 1);
    }
  }
}

function applyFocus(key) {
  focusKey = key;
  if (key) lastFocus = key;
  const sets = key ? focusSets(key) : null;
  cas.assembly.traverse((o) => {
    // the write head's layers are a transition device rather than a part: they
    // are only on screen while a track is being loaded, and the ghost system's
    // per-frame opacity is the one thing that would fight the sweep
    if (!o.isMesh || Array.isArray(o.material) || o.userData.noGhost) return;
    let keep = !sets;
    if (sets) {
      for (let n = o; n && n !== cas.assembly; n = n.parent) {
        if (sets.drop?.has(n)) { keep = false; break; }
        if (sets.keep.has(n)) { keep = true; break; }
      }
    }
    if (keep) release(o); else embrace(o);
  });
  document.body.classList.toggle('focused', !!key);
  // the labels' own visibility is set every frame in updateAnnotations: which of
  // them belong on screen also depends on the shell coming back together, and
  // that is not something this function is called to see
}

/* a record is "live" when it is the one on screen and the scene is actually
   showing it — the unit record is live only while the shell is shut */
const live = (r, i) => i === ri && (r.key ? focusKey === r.key : !exploded && focusKey === null);

/* Changing record rewrites the sheet that is being read — its name, its note and
   its specs. Without this it reads as text being overwritten in place, and the
   eye has nothing to follow; restarting a keyframe on it gives the change a
   direction. It is only that sheet: the number has a cursor of its own to be
   written by, the breadcrumb and the counters are one line each, and the
   reference list is the thing being clicked — a whole-panel flash took all of
   them with it, including the row under the pointer. */
function swapIn(h0) {
  const el = D.doc;
  /* A grow from the last pick may still be in flight. Put the box back on auto
     before measuring, or this one reads the height the last one is passing
     through and walks to a height that was never the sheet's. (Nothing is painted
     in between — the layout is read and written inside one frame.) */
  clearTimeout(docT);
  el.classList.remove('grow');
  el.style.height = '';
  el.classList.remove('swap');
  void el.offsetWidth;
  el.classList.add('swap');
  /* The sheet is a different length for every record — a spec row more or less, a
     note a line longer — and rewriting it used to move everything under it in a
     single frame. Held to the height it had for one frame and walked to the one
     it needs on the same clock as the fade above, the growth is one motion: the
     button under it rides down at the speed the box grows, because it is in the
     flow of that box and nothing else has to animate. */
  const h1 = el.getBoundingClientRect().height;
  if (reduce || !(h0 > 0) || Math.abs(h1 - h0) < 0.5) return;
  el.style.height = h0 + 'px';
  el.classList.add('grow');
  void el.offsetHeight;                  // let the old height be the starting one
  el.style.height = h1 + 'px';
  clearTimeout(docT);
  docT = setTimeout(() => {
    el.classList.remove('grow');
    el.style.height = '';                // back to auto, at the height it landed on
  }, 460);
}
let docT = 0;

/** Where the panel hangs from: half of what it measures when it is framed at its
    own length. Set once and on resize — never on a record change, or the panel
    would walk up the screen one record at a time. */
function pinPanel() {
  const h = D.dossier.getBoundingClientRect().height;
  if (h > 0) D.dossier.style.setProperty('--panel-half', (h / 2).toFixed(1) + 'px');
}

/* Folded, the panel has vacated the middle of the frame, so the subject takes
   it; open, the subject keeps to the left half. This is the single writer for
   the view offset — explode and record framing used to set it directly, and
   three writers meant whichever ran last won. */
function syncViewShift() {
  // Folded, the panel retracts to the right and the subject takes the middle.
  // The tape is ~36% of the frame wide, so at 0.05 its right edge lands around
  // 63% — clear of the retracted panel, which starts at 80%.
  viewShiftTarget = exploded ? 0.10 : (folded ? 0.05 : 0.155);
}

/* The panel's length is not a state that gets toggled, it is a function of how
   close the lens is. It rests 20% short (the CSS default) and gives up another
   30% over the run from the home framing to the closest the wheel will come,
   linearly. The far end is clamped: pulling back out past the home framing is
   not a reason for the panel to grow into the frame. Damping is the margin-left
   transition the fold already runs on, so a wheel still turning is a target that
   keeps moving rather than a second smoothing stacked on top of the first. */
const GIVE_FROM = orbit.home.radius, GIVE_TO = orbit.minR, GIVE_MAX = 30;
/* Where the shortening stops being a shorter panel and becomes no panel.

   A notch and a half short of the closest framing: 让出 45%, the column down to
   55% of its length. Pushed all the way to the stop it was too late — the fold
   only arrived once the lens had nothing left to do — and a third of the way in
   (30%, then 33%) was too early, so the line sits just inside the end of the
   travel now, and 收起详情 is still there for folding a readable panel by hand at
   any framing. Pushing it deeper is one number: 让出 40% is FOLD_AT 20.

   One line, crossed both ways. It used to fold at ten points of give but only
   unfold back at zero — the framing right in at the home radius — so pulling the
   wheel out to where it had just left from left the panel away, and it took
   another two thirds of a retreat to bring it back. The wheel's own position is
   the thing the eye is holding while it scrolls, so that is the thing the fold
   follows: the same line in both directions.

   What it is *not* is a pure function of where the wheel is. The decision is
   taken on the crossing, not on the side the wheel happens to be on: otherwise
   收起详情 could not be used at all — every frame would put the panel straight
   back the way the wheel wants it — and that button is the one way to fold a
   perfectly readable panel out of the way. Between crossings, whatever it is
   stays what it is. Nothing flaps on the line either: a notch is about five
   points of give at this end of the range, so there is no landing on it. */
const FOLD_AT = 25;
let lastGive = 0;              // where the wheel stood when the fold last looked
const giveFor = (r) => clamp((GIVE_FROM - r) / (GIVE_FROM - GIVE_TO), 0, 1) * GIVE_MAX;

let given = -1;
function syncPanelGive() {
  const give = giveFor(orbit.radius);
  // this lands on an element that is already animating, every frame; a tenth of
  // a percent is well under anything the transition can show
  if (Math.abs(give - given) < 0.1) return;
  given = give;
  D.dossier.style.setProperty('--give', give.toFixed(1));
}

/* One writer for the fold, and two reasons to want it. 细节特写 is one: that
   vantage puts the lens in close enough that the tape runs under this column, so
   the vantage folds the panel itself, deliberately and at once — it used to be
   asked to shorten 34% and ended up folding anyway, two beats late, because the
   distance mapping had already taken more off it than that. The wheel is the
   other, once the shortening has gone past 30% (FOLD_AT above).
   Both read the wheel's *target*, not the damped radius: the camera eases in
   asymptotically and would never quite arrive at the clamp, and the fold has to
   fire on the notch that asks for it rather than a second later. The latch is
   what keeps the two from arguing over the panel — whatever it is between the
   lines stays, so one unfolded by hand stays unfolded. */
let wantFold = false;
function syncPanelFold() {
  const give = giveFor(orbit.gRadius);
  const over = give >= FOLD_AT;
  const wasOver = lastGive >= FOLD_AT;
  lastGive = give;
  let want = wantFold;
  if (vi === MACRO) want = true;
  else if (over !== wasOver) want = over;      // the wheel crossed the line
  if (want === wantFold) return;
  wantFold = want;
  setFold(want);
}

let folded = false, foldCamT = 0;
function setFold(on) {
  folded = on;
  D.dossier.classList.toggle('folded', on);
  D.fold.setAttribute('aria-expanded', String(!on));
  D.fold.textContent = on ? '展开详情' : '收起详情';
  // the camera moves on the second beat: it waits for the body to finish
  // collapsing, then travels in with the retract. Unfolding is the reverse —
  // the camera comes back first, while the body is still shut.
  // the delay exists to wait out the panel's own two-beat collapse; with the
  // transitions off there is nothing to wait for
  clearTimeout(foldCamT);
  if (on && !reduce) foldCamT = setTimeout(syncViewShift, 400);
  else syncViewShift();
}
D.fold.addEventListener('click', () => {
  setFold(!folded);
  audio.tick();
  document.body.classList.add('moved');
});

/* ---------- the number, written rather than switched ----------
   The bar beside the file number is a nib, not a cursor (it does not blink — see
   .caret), and it works the number over the way a hand would: a stroke to the
   left laying a mask down behind it, a beat with the whole number covered, then a
   stroke back to the right taking the mask away again.

   The mask is what does the erasing. The nib does not delete digits one at a
   time, which pops a glyph out of the line every time it moves — it covers them:
   the digits to its right are hidden under a clip whose edge *is* the nib, so the
   number is wiped away rather than eaten. Nothing is removed until all of it is
   under the mask, and that is where the old digits trade places with the new ones
   — where nobody can see it happen. The clip is on the number alone: the label
   beside it, the rule under it, the panel and the scene are all untouched.

   Three things have to line up for this to read, and only the first is obvious:
   the nib's edge has to be on the mask's edge (it is the nib that hides the hard
   cut, so it is centred on it); the nib has to travel *past* the number, not stop
   at it (its stroke is twice the number's width, which carries it out into the
   gap and leaves it standing just short of the label); and the stroke has to
   arrive — fast off the mark, slowing, stopped — because a nib that slides in at
   a constant speed and reverses reads as a wipe rather than as a hand.

   Driven from the main loop's clock like everything else in the scene: a CSS
   animation would run in wall-clock time, and the mask would drift out from under
   the nib the moment a frame cost more than the last. */
/* Off the mark, slowing, stopped — the shape a hand has. A stroke spends most of
   its deceleration on the overrun past the number (the mask is already across
   before the nib has finished travelling), so the phases are kept short: the wipe
   is the first half of a stroke and the rest of it is the nib settling. */
const NO_ERASE = 0.30, NO_HOLD = 0.12, NO_TYPE = 0.36;
/* How far one stroke runs, as a multiple of the number's own width. Past 1 the
   nib clears the far end of the number and comes to rest just outside it; at
   exactly 1 it stops on the last digit, which reads as being cut short. */
const NO_TRAVEL = 1.75;
const no = {
  on: false, phase: 0, p: 0, d: 0, d0: 0, lead: 0, w: 0, travel: 0, cap: 2, from: '', to: '',
};
let noText = D.fileId.textContent;        // the value, not whatever is painted
const NO_STROKE = (t) => ease.out(t);     // fast, then slowing, then stopped

/** one instant of the stroke.
    `d` is how far the nib has travelled from where it stands at rest, `lead` is
    the distance between that rest and the near end of the number, so the mask
    only starts to cover once the nib has crossed the lead and it is full — for
    the rest of the stroke — at the far end of the number. */
function paintNo() {
  const m = clamp(no.d - no.lead, 0, no.w);       // how much of the number is under it
  D.fileId.textContent = no.phase === 0 ? no.from : no.to;
  D.fileId.style.clipPath = m <= 0.02 ? '' : `inset(0 ${m.toFixed(2)}px 0 0)`;
  D.caret.style.transform = `translate(${(-no.d).toFixed(2)}px, .06em)`;
}

function endNo() {
  no.on = false;
  no.d = 0;
  D.fileId.textContent = noText;
  D.fileId.style.minWidth = '';
  D.fileId.style.clipPath = '';
  D.caret.style.transform = '';
}

/** the one writer of the number. `animate: false` is how a deep link lands — that
    URL exists to be photographed, and a nib caught mid-stroke is not it. */
function setFileNo(text, animate = true) {
  if (text === noText) return;
  noText = text;
  if (!animate || reduce) { endNo(); return; }
  /* A browse that lands mid-stroke carries on from where the nib is. An erase or
     a beat that is interrupted only retargets — the mask is already where it is,
     and `to` is the whole of what changes. A *return* that is interrupted turns
     the nib around: it goes back over the digits it had been revealing, which is
     what a hand does when it changes its mind halfway through a line. */
  if (!no.on) { no.from = D.fileId.textContent; no.d = 0; no.phase = 0; no.p = 0; }
  else if (no.phase === 2) { no.from = no.to; no.phase = 0; no.p = 0; }
  /* phase 0 (mid-erase): the stroke carries on — same clock, same mask, and only
     the destination changed. phase 1 (the beat): the mask is already across, so
     the beat finishes and the new number is revealed under it. */
  no.d0 = no.d;
  no.to = text;
  no.cap = Math.max(no.from.length, no.to.length, 1);
  no.on = true;
  D.fileId.style.minWidth = no.cap + 'ch';   // the reserve has to be in place first
  no.w = D.fileId.getBoundingClientRect().width;   // so this reads the box, not the text
  // the nib's rest sits one flex gap clear of the number, so the mask cannot
  // start until it has crossed that gap; and it is centred on the mask's edge,
  // because a 6px nib is the only thing hiding that cut
  const gap = parseFloat(getComputedStyle(D.fileno).columnGap) || 0;
  no.lead = gap + D.caret.offsetWidth / 2;
  no.travel = no.w * NO_TRAVEL;
  paintNo();
}

/** land it settled (deep links, reduced motion, a reset) */
function snapFileNo() {
  if (no.on) endNo();
  else D.fileId.textContent = noText;
}

function updateFileNo(dt) {
  if (!no.on) return;
  no.p += dt / (no.phase === 0 ? NO_ERASE : no.phase === 1 ? NO_HOLD : NO_TYPE);
  if (no.p >= 1) {
    if (no.phase === 0) {
      no.phase = 1;                       // the mask is across: now the beat, and the
      no.p = 0;                           // two numbers trade places inside it, where
      no.d = no.travel;                   // nothing of either of them can be seen
      paintNo();
      return;
    }
    if (no.phase === 1) {
      no.phase = 2;
      no.p = 0;
      no.d = no.travel;
      paintNo();
      return;
    }
    endNo();
    return;
  }
  // The beat stands still — nib and mask both. (Falling through to the stroke
  // below was the bug: the beat has no travel of its own, so it recomputed the
  // position from the erase's starting point and threw the nib back to the right
  // for a tenth of a second before the return began.)
  if (no.phase === 1) return;
  no.d = no.phase === 2
    ? no.travel * (1 - NO_STROKE(no.p))    // ...and the return is a stroke too: fast
    : no.d0 + (no.travel - no.d0) * NO_STROKE(no.p);   // off the mark, then stopped
  paintNo();
}

function render(bump = false) {
  const R = cur();
  // measured before the sheet is rewritten: swapIn() walks the box from this
  const docH = D.doc.getBoundingClientRect().height;
  D.colCn.textContent = R.cn;
  setFileNo(R.no);
  D.fileCn.textContent = R.cn;
  D.fileEn.textContent = R.en;
  D.fileNote.textContent = R.note;
  D.selI.textContent = R.no;
  D.accessLabel.textContent = R.act;
  D.access.classList.toggle('done', live(R, ri));
  // only rebuild the spec rows when the record actually changed — render runs
  // on every arrow press and theme switch, and a rebuild drops hover state
  if (D.fileSpec.dataset.no !== R.no) {
    D.fileSpec.dataset.no = R.no;
    D.fileSpec.replaceChildren(...R.spec.map(([k, v]) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${k}</span><b>${v}</b>`;
      return li;
    }));
  }

  // 细节特写 folds the panel (see syncPanelFold). This is the state it falls
  // back into if that fold is undone by hand: still narrowed, because the tape
  // is still running under the column, but with the spec table back on screen
  D.dossier.classList.toggle('tight', vi === MACRO);

  // the vantage read-out falls back to the record's own framing, and says so
  const V = vi >= 0 ? VANTAGES[vi] : null;
  D.colI.textContent = V ? String(vi + 1).padStart(2, '0') : '--';
  D.colCn2.textContent = V ? V.cn : R.viewName;
  D.colEn.textContent = V ? V.en : R.viewEn;

  // the pick list and the ticks are the same six records at two sizes. Both
  // were built once, further up — rebuilding them here would replace the
  // elements, and a fresh element starts already in its final state, so the
  // marker would jump instead of sliding
  for (let i = 0; i < RECORDS.length; i++) {
    const l = live(RECORDS[i], i);
    refRows[i].className = 'row' + (i === ri ? ' sel' : '') + (l ? ' done' : '');
    ticks[i].className = 'tick' + (i === ri ? ' on' : '') + (l ? ' done' : '');
  }
  syncIndexSel();
  if (bump) swapIn(docH);
}

/* Reading is the one action that changes the scene: it opens the shell,
   isolates the record's part and reframes the camera onto it. Browsing with
   the arrows only moves the cursor, so nothing jumps while you read. */
function readRecord(instant = false, moveCam = true) {
  const R = cur();
  homeArmed = false;                  // a record ends on its own framing
  applyFocus(R.key);
  exploded = !!R.key;
  cas.setExplode(exploded);
  if (instant || reduce) cas.st.explode = cas.st.explodeTarget;   // deep links land settled
  $('#btn-explode').classList.toggle('on', exploded);
  $('#btn-explode').setAttribute('aria-pressed', String(exploded));
  // with the lens left alone (the intro is driving it) the panel keeps naming
  // the vantage that is actually on screen — the intro lands on VANTAGES[0]
  if (moveCam) {
    vi = -1;                                 // the record brings its own framing
    orbit.setPreset(R.view, instant);
    if (!instant && orbit.tween) orbit.tween.dur = 1.6;
  }
  syncViewShift();
  measure();
  audio.tick();
  document.body.classList.add('moved');
  render(true);
  if (instant) snapFileNo();               // a deep link lands settled, cursor included
}
function moveRecord(d) { ri = (ri + d + RECORDS.length) % RECORDS.length; audio.tick(); render(true); }
function setVantage(i) {
  // `vi = -1` is a record's own framing: there is no vantage to count from, so
  // the first step lands on the end it is stepping toward — ← goes to the last
  // vantage, → to the first. Wrapping from -1 lands on 03 instead, which is
  // neither the previous nor the last one.
  vi = vi < 0 ? (i < 0 ? VANTAGES.length - 1 : 0) : (i + VANTAGES.length) % VANTAGES.length;
  homeArmed = false;                  // this *is* a framing, not a detour from one
  orbit.setPreset(VANTAGES[vi].v, false);
  if (orbit.tween) orbit.tween.dur = 1.2;
  audio.tick();
  document.body.classList.add('moved');
  render();
}

function setAuto(on) {
  autoRotate = on;
  if (on) homeArmed = false;          // the model turning itself beats returning
  orbit.setAuto(on);
  $('#btn-auto').classList.toggle('on', on);
  $('#btn-auto').setAttribute('aria-pressed', String(on));
}
function setMute(on) {
  muted = on;
  audioEl.muted = on;
  document.body.classList.toggle('muted', on);
  $('#btn-mute').setAttribute('aria-pressed', String(on));
  audio.setLevel(bedLevel());
}


/* the speaker is a knob as well as a switch: wheel over it to set the level,
   click (or M) to cut the music. Turning it all the way down *is* muted, so the
   icon can never claim to be playing something it is not; turning it back up
   lifts the mute, which is what a hand on a knob expects. */
const volRead = $('#vol-read');
const muteBtn = $('#btn-mute');
let volFlash = 0;
function showVolume() {
  volRead.textContent = muted ? '静音' : `${Math.round(volume * 100)}%`;
  muteBtn.classList.add('show-vol');
  clearTimeout(volFlash);
  volFlash = setTimeout(() => muteBtn.classList.remove('show-vol'), 1100);
}
function setVolume(v, { unmute = false, flash = true } = {}) {
  // snapping through the 5% grid in one step rather than v/0.05*0.05, which
  // lands on 0.30000000000000004 and prints as "30%" only by luck of rounding
  volume = Math.max(0, Math.min(1, Math.round(v * 20) / 20));
  audioEl.volume = volume;
  // the arcs follow the level too: one below half, two above, none when silent
  muteBtn.classList.toggle('vol-lo', volume < 0.5);
  if (volume === 0 && !muted) setMute(true);
  else if (unmute && muted && volume > 0) setMute(false);
  audio.setLevel(bedLevel());
  if (flash) showVolume();
}
/* ---------- the full index, for when five columns do not fit on screen ---- */
const indexEl = $('#index'), indexCols = $('#index-cols');
let indexOpen = false;
function buildIndex() {
  indexCols.replaceChildren(...RECORDS.map((R, x) => {
    const d = document.createElement('div');
    d.className = 'icol' + (x === ri ? ' on' : '');
    const h = document.createElement('button');
    h.className = 'icol-h';
    h.innerHTML = `<span>${R.no} ${R.cn}</span><em>${R.en}</em>`;
    h.addEventListener('click', () => { ri = x; closeIndex(); readRecord(); });
    d.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'spec';
    ul.replaceChildren(...R.spec.map(([k, v]) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${k}</span><b>${v}</b>`;
      return li;
    }));
    d.appendChild(ul);
    return d;
  }));
  syncIndexSel();
}
function syncIndexSel() {
  if (!indexOpen) return;
  indexCols.querySelectorAll('.icol').forEach((c, x) => c.classList.toggle('on', x === ri));
}
function openIndex() {
  indexOpen = true;
  buildIndex();
  indexEl.hidden = false;
  requestAnimationFrame(() => indexEl.classList.add('open'));
  document.body.classList.add('moved');
}
function closeIndex() {
  if (!indexOpen) return;
  indexOpen = false;
  indexEl.classList.remove('open');
  setTimeout(() => { if (!indexOpen) indexEl.hidden = true; }, 600);
}
const toggleIndex = () => (indexOpen ? closeIndex() : openIndex());

/* ---------- settings ----------
   Five switches for the things a visitor to a tape deck would actually reach for,
   and every one of them is a knob the page already had: the opening move, what
   happens when the tape runs out, whether the machine hisses, whether the key
   legend is in the way, and whether the floor keeps its mirror. Nothing here
   needed new machinery — it needed a handle on machinery that was already there.
   The sheet is the ARCHIVE INDEX overlay with five rows in it, because the page
   has exactly one way of putting a sheet over itself and this is it.

   The switches are remembered (localStorage, guarded: a blocked store just means
   the page boots as it shipped). They are the one thing here that is *supposed*
   to outlive a reload — the music deliberately is not (see 音乐 in the README). */
const PREF_KEY = 'ohmtape.prefs';
const prefs = { intro: true, loop: true, hiss: true, keys: true, mirror: true };
try {
  const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  for (const k of Object.keys(prefs)) if (typeof saved[k] === 'boolean') prefs[k] = saved[k];
} catch { /* no store: the defaults are the page */ }
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* nothing to do */ } };

const SETTINGS = [
  { k: 'intro', cn: '开场动画', en: 'OPENING MOVE', note: '打开时那 3.4 秒的推轨与浮起，下次打开生效。' },
  { k: 'loop', cn: '循环播放', en: 'AUTO REVERSE', note: '放完自动倒带重放；关掉则倒回开头停住。' },
  { k: 'hiss', cn: '磁带底噪', en: 'TAPE BED', note: '走带时的嘶声与马达嗡声，不含换向声与旋钮声。' },
  { k: 'keys', cn: '按键提示', en: 'KEY LEGEND', note: '底部那行快捷键说明。' },
  { k: 'mirror', cn: '地面镜像', en: 'FLOOR MIRROR', note: '地面实时反射，关掉可省一整遍场景渲染。' },
];

/** what a switch does. `intro` is read once by the boot flow and `loop` where the
    tape runs out, so neither has anything to do here. */
function applyPref(k) {
  if (k === 'hiss') audio.setLevel(bedLevel());
  else if (k === 'keys') document.body.classList.toggle('keys-off', !prefs.keys);
  else if (k === 'mirror') floorBase.setEnabled(prefs.mirror && quality > 0.8);
}
function applyPrefs() { for (const k of Object.keys(prefs)) applyPref(k); }

const settingsEl = $('#settings'), setList = $('#set-list'), settingsBtn = $('#btn-settings');
let setOpen = false;

function syncSettings() {
  for (const s of SETTINGS) {
    for (const b of s.seg.children) {
      const on = (b.dataset.v === '1') === prefs[s.k];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
}
function setPref(s, v) {
  if (prefs[s.k] === v) return;
  prefs[s.k] = v;
  savePrefs();
  applyPref(s.k);
  syncSettings();
  audio.tick();
  document.body.classList.add('moved');
}
/* built when the sheet is opened, like the index's cards, and rebuilt each time:
   the state can only have changed from in here */
function buildSettings() {
  setList.replaceChildren(...SETTINGS.map((s) => {
    const li = document.createElement('li');
    li.className = 'set-row';
    const t = document.createElement('div');
    t.className = 'set-t';
    t.innerHTML = `<b>${s.cn}</b><i>${s.en}</i><em>${s.note}</em>`;
    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const v of [true, false]) {
      const b = document.createElement('button');
      b.className = 'ui-hit';
      b.textContent = v ? '开' : '关';
      b.dataset.v = v ? '1' : '0';
      b.addEventListener('click', () => setPref(s, v));
      seg.appendChild(b);
    }
    s.seg = seg;
    li.append(t, seg);
    return li;
  }));
  syncSettings();
}
function openSettings() {
  setOpen = true;
  buildSettings();
  settingsEl.hidden = false;
  requestAnimationFrame(() => settingsEl.classList.add('open'));
  // the gear stays turned while the sheet is up, so the button reads as open
  settingsBtn.classList.add('open');
  settingsBtn.setAttribute('aria-expanded', 'true');
  document.body.classList.add('moved');
}
function closeSettings() {
  if (!setOpen) return;
  setOpen = false;
  settingsEl.classList.remove('open');
  settingsBtn.classList.remove('open');
  settingsBtn.setAttribute('aria-expanded', 'false');
  setTimeout(() => { if (!setOpen) settingsEl.hidden = true; }, 600);
}
const toggleSettings = () => (setOpen ? closeSettings() : openSettings());

settingsBtn.addEventListener('click', () => { toggleSettings(); audio.tick(); });
$('#settings-close').addEventListener('click', () => { closeSettings(); audio.tick(); });
settingsEl.addEventListener('click', (e) => { if (e.target === settingsEl) closeSettings(); });

function reinit() {
  ri = 0; vi = 0; savedVi = 0;
  // the intro owns the lens *and* the cassette's lift for its first three
  // seconds. Left running, it keeps writing intro.y every frame and the shell
  // floats on up out of a reset that was supposed to put it back on the table.
  tl = null;
  intro.y = 0; intro.tilt = 0; intro.spin = 0; intro.fade = 1;
  setFold(false);
  closeIndex();
  closeSettings();
  applyFocus(null);
  setMute(false);
  setAuto(false);
  setFlip(false);
  exploded = false;
  cas.setExplode(false);
  $('#btn-explode').classList.remove('on');
  $('#btn-explode').setAttribute('aria-pressed', 'false');
  syncViewShift();
  if (cas.st.playing) togglePlay(false);
  audioEl.currentTime = 0;
  mode = 'idle';
  document.body.classList.remove('rewinding');
  reinitTrack();                      // ...and the record it shipped with
  setTheme('studio');
  orbit.setPreset(VANTAGES[0].v, false);
  if (orbit.tween) orbit.tween.dur = 1.4;
  audio.clunk(0.7);
  render();
}

/* ---------- wiring ---------- */
$('#btn-auto').addEventListener('click', () => { setAuto(!autoRotate); audio.tick(); render(); });
$('#btn-auto').classList.toggle('on', autoRotate);
$('#btn-auto').setAttribute('aria-pressed', String(autoRotate));
$('#btn-play').addEventListener('click', () => { togglePlay(); audio.tick(); render(); });
$('#btn-mute').addEventListener('click', () => { setMute(!muted); showVolume(); audio.tick(); render(); });
/* The wheel is captured on the button itself and stopped there: the orbit
   control listens on `window`, so without stopPropagation the same notch would
   set the volume *and* push the lens. preventDefault keeps the page from
   scrolling behind it. */
$('#btn-mute').addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation();
  // one notch is one step, however coarse the device's delta is; and scrolling
  // up out of a mute lifts the mute rather than sitting there doing nothing
  const up = e.deltaY < 0;
  setVolume(volume + (up ? VOL_STEP : -VOL_STEP), { unmute: up });
  audio.tick();
}, { passive: false });
setVolume(volume, { flash: false });
$('#btn-explode').addEventListener('click', () => { setExplode(!exploded); audio.tick(); render(); });
$('#btn-flip').addEventListener('click', () => { setFlip(!flipped); audio.tick(); render(); });
$('#theme').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) { setTheme(b.dataset.theme); audio.tick(); document.body.classList.add('moved'); }
});
// wrapped, not passed by reference: readRecord's first parameter is `instant`,
// and a listener called with the click event would read that MouseEvent as
// `true` — snapping the shell open and cutting the camera instead of easing
$('#btn-access').addEventListener('click', () => readRecord());
$('#btn-index').addEventListener('click', toggleIndex);
$('#index-close').addEventListener('click', closeIndex);
$('#btn-reinit').addEventListener('click', reinit);

/* ---------- ADD MUSIC ----------
   One file, and it replaces what is in the shell — the page is a single tape,
   and the ARCHIVE INDEX is a list of parts rather than of tracks. Whatever the
   user picks is named by its own tags where it has them and by its file name
   where it does not (src/tags.js), and the plate is rewritten to say so. */
const addBtn = $('#btn-add'), addRead = $('#add-read'), fileInput = $('#tape-file');
let addFlash = 0;
function flashAdd(msg) {
  clearTimeout(addFlash);
  if (!msg) { addBtn.classList.remove('show-vol'); return; }
  addRead.textContent = msg;
  addBtn.classList.add('show-vol');
  addFlash = setTimeout(() => addBtn.classList.remove('show-vol'), 1400);
}
function openPicker() {
  // clearing first, so re-picking the file that is already in there still fires
  fileInput.value = '';
  fileInput.click();
  audio.tick();
}
async function addFiles(files) {
  const file = [...files].find(looksLikeAudio);
  if (!file) { flashAdd('不是音频文件'); return; }
  if (swap.state !== 'idle') { flashAdd('正在装入'); return; }
  flashAdd('正在装入');
  const tags = await readTags(file);          // guarded inside: always an object
  applyTrack({ ...tags, src: URL.createObjectURL(file), file });
}
addBtn.addEventListener('click', openPicker);
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) addFiles(fileInput.files);
});
/* and one dropped anywhere on the page does the same. `dragover` has to be
   cancelled or the browser navigates away to the file instead of handing it
   over — and the canvas' own drag is pointer-based, so the two never meet. */
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});
indexEl.addEventListener('click', (e) => { if (e.target === indexEl) closeIndex(); });
for (const b of document.querySelectorAll('.pk')) {
  b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'prev-file') moveRecord(-1);
    else if (a === 'next-file') moveRecord(1);
    else if (a === 'prev-col') setVantage(vi - 1);
    else setVantage(vi + 1);
    b.classList.add('flash');
    setTimeout(() => b.classList.remove('flash'), 240);
  });
}

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  // a focused control owns Space and Enter; intercepting them here would make
  // Tab-to-the-fold-button then Enter read a record instead of folding
  const tag = e.target?.tagName;
  if ((k === ' ' || k === 'Enter') && (tag === 'BUTTON' || tag === 'INPUT')) return;
  // one layer at a time: the overlay, then the shell, then the panel
  if (k === 'Escape') {
    if (setOpen) closeSettings();           // the sheet on top closes first
    else if (indexOpen) closeIndex();
    else if (exploded) { setExplode(false); audio.tick(); render(); }
    else if (folded) { setFold(false); audio.tick(); render(); }
    return;
  }
  if (k === 'Enter') {
    e.preventDefault();
    // read with the index still up and the whole scene changes behind an
    // opaque panel. Close first, exactly like the cards do.
    if (indexOpen) closeIndex();
    readRecord();
    return;
  }
  if (k === 'ArrowUp') { e.preventDefault(); moveRecord(-1); return; }
  if (k === 'ArrowDown') { e.preventDefault(); moveRecord(1); return; }
  if (k === 'ArrowLeft') { e.preventDefault(); setVantage(vi - 1); return; }
  if (k === 'ArrowRight') { e.preventDefault(); setVantage(vi + 1); return; }
  if (k === ' ') { e.preventDefault(); togglePlay(); render(); return; }
  const l = k.toLowerCase();
  if (l === 'e') setExplode(!exploded);
  else if (l === 'f') setFlip(!flipped);
  else if (l === 'a') setAuto(!autoRotate);
  else if (l === 'm') { setMute(!muted); showVolume(); }
  else if (l === 'i') toggleIndex();
  else if (l === ',') toggleSettings();
  else if (l === 'o') { openPicker(); return; }      // the picker is the feedback
  else return;
  document.body.classList.add('moved');
  render();
});

function togglePlay(force) {
  const st = cas.st;
  const on = force ?? !st.playing;
  if (on && mode === 'rew') return;               // wait for the spool-back
  // The write head is crossing the card: the duration the reels would be driven
  // from is about to be replaced, so the press is held until the print lands.
  if (swap.state !== 'idle') {
    if (on) { swap.play = true; document.body.classList.add('moved'); }
    return;
  }
  st.playing = on;
  document.body.classList.toggle('playing', on);
  // the label always names what pressing it does next, so the idling state
  // says 走带 — the same word it says before the first press
  $('#play-label').textContent = on ? '暂停' : '走带';
  if (on) {
    mode = 'play';
    if (audioOk()) {
      if (audioEl.ended || audioEl.currentTime > audioEl.duration - 0.08) audioEl.currentTime = 0;
      audioEl.play().catch(() => {});             // autoplay guard: silently ignore
    }
    audio.setLevel(bedLevel());
    audio.start();
  } else {
    audioEl.pause();
    audio.stop();
    // Pausing mid spool-back has to leave 'rew' behind as well. Left in it, the
    // guard at the top of this function ("wait for the spool-back") refuses the
    // *next* press too, and the transport is dead until a reinitialize. dir
    // stays +1, so pressing play again finishes the rewind and carries on.
    if (mode === 'rew') {
      mode = 'idle';
      document.body.classList.remove('rewinding');
    }
  }
  document.body.classList.add('moved');
}

function setExplode(on, instant = false) {
  exploded = on;
  homeArmed = false;                  // the pull-back is itself a framing
  cas.setExplode(on);
  if (instant || reduce) cas.st.explode = cas.st.explodeTarget;
  // the lit state belongs to the explode, not to reading a record — pressing E
  // or the button itself used to leave the trigger unlit, while reading a part
  // record lit it. Same writer, both paths.
  $('#btn-explode').classList.toggle('on', on);
  $('#btn-explode').setAttribute('aria-pressed', String(on));
  if (!on) applyFocus(null);          // shutting the shell releases the part
  const a = orbit.theta;
  syncViewShift();
  // no probe re-capture here: the capture lands as one discrete jump ~1.5 s
  // later, which reads as the shell abruptly changing colour mid-explode.
  // The probe is a world-space radiance field, so the stale capture is still
  // directionally right; only the theme switch re-captures, and that one is now
  // held back until the rig has finished moving (see markProbeDirty).
  //
  // Both ends of the toggle have to leave the camera somewhere the read-out can
  // name. Closing used to drop you on the default iso pose while the panel went
  // on showing the vantage you had picked — 选 04 → 拆解 → 收回来 landed at 等轴
  // with "04 MACRO" still on screen. It now comes back to that vantage. A
  // record's own framing (vi < 0) belongs to the open shell, so that one lands
  // on the first vantage, which is where the double-click reset lands too.
  let shot;
  if (on) {
    // the pull-back leaves the vantage behind, so the read-out stops naming it —
    // which also releases the panel: 细节特写 used to stay narrowed 34% for a
    // lens that had already retreated to 44
    //
    // What gets remembered is where to come *back* to. A record's own framing
    // (vi < 0) belongs to the open shell and is gone once the shell shuts, so
    // that end falls back to the first vantage — where a double-click lands —
    // instead of leaving savedVi on whatever vantage happened to be standing
    // there from several actions ago.
    savedVi = vi >= 0 ? vi : 0;
    vi = -1;
    shot = { theta: Math.max(a, 0.45), phi: 1.17, radius: 44 };
  } else {
    if (vi < 0) vi = savedVi;           // closing comes back to where it left
    shot = VANTAGES[vi].v;
  }
  if (instant) orbit.setPreset(shot, true);
  else { orbit.setPreset(shot, false); if (orbit.tween) orbit.tween.dur = 1.5; }
  measure();
  document.body.classList.add('moved');
}
function setFlip(on, instant = false) {
  flipped = on;
  cas.setFlip(on);
  if (instant || reduce) cas.st.flip = cas.st.flipTarget;
  $('#btn-flip').classList.toggle('on', on);
  $('#btn-flip').setAttribute('aria-pressed', String(on));
  audio.clunk(on ? 0.8 : 1.2);
  document.body.classList.add('moved');
}

/* ============================== resize ================================== */
let quality = 1, perfAcc = 0, perfN = 0, fps = 0, jsMs = 0;
/* The render scale only ever ratcheted down. One sustained bad window — a
   window that was briefly huge, another app holding the GPU — and the page sat
   at 0.6× for the rest of the session with the floor mirror, the first thing
   dropped, never coming back. Recovery is slow and capped on purpose: two good
   windows in a row to climb one step, never above `qualityCeil` (the level last
   *measured* as too slow, so the climb cannot become the mirror switching
   itself on and off every few seconds), and only a real window resize clears
   the ceiling — that is the one event where the GPU budget has actually
   changed. */
let qualityCeil = 1, goodWindows = 0, perfSkip = 0;
let perfEl = null;
function watchPerf(dt) {
  perfAcc += dt; perfN++;
  fps = fps ? fps * 0.94 + (1 / Math.max(dt, 1e-3)) * 0.06 : 1 / Math.max(dt, 1e-3);
  if (perfEl && (perfN & 3) === 0) {
    perfEl.textContent = `${fps.toFixed(0)} fps · js ${jsMs.toFixed(2)} ms · dpr×${quality.toFixed(1)} · `
      + `${floorBase ? (floorBase.mesh.visible ? 'mirror' : 'no-mirror') : ''} `
      + `· off ${viewShift.toFixed(3)}→${viewShiftTarget.toFixed(3)}`;
  }
  if (perfAcc < 2.5) return;
  const avg = perfAcc / perfN;
  perfAcc = 0; perfN = 0;
  // the window right after a change measures the change, not the machine
  if (perfSkip > 0) { perfSkip--; return; }
  if (avg > 0.030) {
    goodWindows = 0;
    if (quality > 0.6) {
      quality = Math.max(0.6, quality - 0.2);
      qualityCeil = Math.min(qualityCeil, quality);
      onResize();
    }
    if (quality <= 0.8 || !prefs.mirror) floorBase.setEnabled(false);   // the mirror goes first
    perfSkip = 1;
  } else if (avg < 0.018 && quality < qualityCeil) {
    if (++goodWindows >= 2) {
      goodWindows = 0;
      quality = Math.min(qualityCeil, quality + 0.2);
      onResize();
      perfSkip = 1;
      // the mirror is a whole extra scene render every frame: only the full
      // rate can be asked to pay for it
      if (quality >= 1) floorBase.setEnabled(prefs.mirror);
    }
  } else {
    goodWindows = 0;
  }
}
function onResize() {
  const w = innerWidth, h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2) * quality;
  camera.aspect = w / h;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.updateProjectionMatrix();
  // supersample when there is GPU headroom to spare (downsampled by the last pass)
  const px = w * dpr * h * dpr;
  const ss = px > 9.0e6 ? 1 : 1.25;
  const bw = Math.round(w * dpr * ss), bh = Math.round(h * dpr * ss);
  if (composer) composer.composer.setSize(bw, bh);
  if (bloom) bloom.setSize(bw, bh);
  floorBase.setSize(w, h);
  if (grade) grade.uniforms.uTexel.value.set(1 / bw, 1 / bh);
  applyViewOffset();
  measure();
  pinPanel();
}
/* the subject sits left of centre and the dossier takes the right half, so the
   offset is positive: the render window slides left and the scene follows */
let viewShift = 0.155, viewShiftTarget = 0.155;
function applyViewOffset() {
  const w = innerWidth, h = innerHeight;
  camera.clearViewOffset();
  if (w >= 900) camera.setViewOffset(w, h, w * viewShift, h * 0.025, w, h);
  camera.updateProjectionMatrix();
}
// a resize is the one event that changes what the GPU has to push, so it is
// also the only thing that re-opens the render-scale ceiling
addEventListener('resize', () => {
  qualityCeil = 1;
  goodWindows = 0;
  onResize();
});

/* ============================== loop ==================================== */
const tcEl = $('#tc'), tdEl = $('#td'), clockEl = $('#clock');
const p2 = (n) => String(n).padStart(2, '0');
const subjectPos = new THREE.Vector3();
const lastCamPos = new THREE.Vector3(0, 0, 1e9);
let last = performance.now(), t = 0, counterAcc = 0, lastTitle = '';

function loop() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  t += dt;
  const jsStart = now;

  tl?.update(dt);
  // the tape is driven by the music itself, so picture and sound never drift
  if (mode === 'rew') {
    cas.st.driven = false;
    if (cas.st.dir === -1) {                      // spooled back, at the head again
      document.body.classList.remove('rewinding');
      audioEl.currentTime = 0;
      // 循环 off: the tape still spools back, it just stands there afterwards —
      // the same state a pause leaves it in, which is what togglePlay is for
      if (prefs.loop) { mode = 'play'; audioEl.play().catch(() => {}); }
      else togglePlay(false);
    }
  } else if (audioOk() && !audioEl.paused && !audioEl.ended) {
    cas.st.driven = true;
    cas.setProgress(audioEl.currentTime / audioEl.duration);
  } else {
    // paused, blocked by autoplay policy, or no audio at all → simulate locally
    cas.st.driven = false;
  }
  // Every frame, not every other. The shell only breathes slowly, which is what
  // the half rate was for — but the *lamp* moves on a theme change, and so do
  // the shell (explode, flip) and the whole cassette (intro). A shadow map that
  // alternates between two light positions 30 times a second is a flicker along
  // every shadow edge, and no amount of easing elsewhere covers it up.
  renderer.shadowMap.needsUpdate = true;
  const st = cas.update(dt);
  updateGhost(dt);
  updateLabelSwap(dt);
  updateFileNo(dt);
  // What changes hands at a re-take is which room the reflections *are* — the
  // brightness is held level either side of it (see applyIblFade) — so the
  // frame to hand them over on is the one where they are dimmest. Going darker,
  // that is the far end of the change; coming up, it is already here, and there
  // is nothing to wait for.
  const probeReady = !themeProbe || iblTo >= iblFrom || themeP >= 1;
  if (probeDirty && probeReady && !orbit.tween && !orbit.dragging
      && Math.abs(st.explode - st.explodeTarget) < 0.004
      && Math.abs(st.flip - st.flipTarget) < 0.004) {
    probeDirty = false;
    captureProbe();
  }
  setFloorDrop(st.explode * 4.4);
  if (intro.spin > 0) {
    const k = 16 * dt;
    cas.parts.reels[0].spin.rotation.y += k;
    cas.parts.reels[1].spin.rotation.y += k * 0.72;
    intro.spin -= dt;
  }

  // idle life
  const bob = reduce ? 0 : Math.sin(t * 0.62) * 0.055 + Math.sin(t * 1.71) * 0.012;
  cas.root.position.y = intro.y + bob - swap.press;   // ...and pressed down under the write head
  cas.root.rotation.z = intro.tilt + (reduce ? 0 : Math.sin(t * 0.42) * 0.008);
  cas.root.rotation.x = reduce ? 0 : Math.sin(t * 0.33 + 1.2) * 0.006;
  if (!reduce) {
    driftDust(dt, t);
  }

  // the environment drifts almost imperceptibly, so highlights crawl across
  // the shell instead of sitting frozen
  if (!reduce) {
    scene.environmentRotation.y = (scene.environmentRotation.y || 0) + 0.0055 * dt;
    scene.environmentRotation.x = Math.sin(t * 0.07) * 0.05;
  }
  orbit.update(dt);
  if (homeArmed && !autoRotate && !orbit.dragging && !orbit.tween && orbit.idle > HOME_DELAY) goHome();
  if (reduce) {
    // the subject sliding across the frame as the panel folds is motion too
    if (viewShift !== viewShiftTarget) { viewShift = viewShiftTarget; applyViewOffset(); }
  } else if (Math.abs(viewShift - viewShiftTarget) > 2e-4) {
    viewShift = damp(viewShift, viewShiftTarget, 2.6, dt);
    applyViewOffset();
  }
  syncPanelGive();
  syncPanelFold();
  cas.root.getWorldPosition(subjectPos).project(camera);
  grade.uniforms.uCenter.value.set(subjectPos.x * 0.5 + 0.5, subjectPos.y * 0.5 + 0.5);
  grade.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
  watchPerf(dt);
  applyTheme(dt, reduce);
  updateAnnotations();
  grade.uniforms.uTime.value = t;

  // counter (throttled DOM write)
  counterAcc += dt;
  if (counterAcc > 0.2) {
    counterAcc = 0;
    const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const t1 = fmt(st.time), t2 = fmt(st.duration);
    if (tcEl.textContent !== t1) tcEl.textContent = t1;
    if (tdEl.textContent !== t2) tdEl.textContent = t2;
    const d = new Date();
    const cs = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    if (clockEl.textContent !== cs) clockEl.textContent = cs;
    // tab title doubles as a transport read-out
    const audioLive = audioOk() && !audioEl.paused && !audioEl.ended;
    // writing document.title re-titles the native window every time; only do it
    // when the string actually changes
    const title = audioLive ? `♪ ${fmt(audioEl.currentTime)} · ${TRACK.title}` : `${TRACK.title} — OHM TAPE`;
    if (title !== lastTitle) { lastTitle = title; document.title = title; }
  }

  // refresh the mirror every frame while the camera is moving; settle to every
  // other frame once it holds still
  const camMoved = camera.position.distanceToSquared(lastCamPos) > 1e-6;
  lastCamPos.copy(camera.position);
  floorBase.update(renderer, scene, camera, camMoved);
  composer.composer.render();
  // everything above is CPU: matrix updates, culling, uniform uploads, draw
  // submission. This is the number to watch when the GPU is not the bottleneck.
  jsMs = jsMs * 0.92 + (performance.now() - jsStart) * 0.08;
  requestAnimationFrame(loop);
}

boot().catch((e) => showError(e?.stack || e));
