export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
};

/** tiny timeline runner */
export class Timeline {
  constructor() { this.items = []; this.t = 0; this.playing = false; }
  add({ delay = 0, dur = 1, ease: e = ease.out, onUpdate, onDone }) {
    this.items.push({ delay, dur, ease: e, onUpdate, onDone, started: false, done: false });
    return this;
  }
  play() { this.playing = true; return this; }
  /** jump everything to the end state */
  finish() {
    for (const it of this.items) {
      if (it.done) continue;
      it.onUpdate?.(1); it.onDone?.(); it.done = true; it.started = true;
    }
    this.playing = false;
  }
  update(dt) {
    if (!this.playing) return;
    this.t += dt;
    let busy = false;
    for (const it of this.items) {
      if (it.done) continue;
      if (this.t < it.delay) { busy = true; continue; }
      const p = it.dur <= 0 ? 1 : clamp((this.t - it.delay) / it.dur, 0, 1);
      it.onUpdate?.(it.ease(p), p);
      if (p >= 1) { it.done = true; it.onDone?.(); } else busy = true;
    }
    if (!busy) this.playing = false;
  }
}
