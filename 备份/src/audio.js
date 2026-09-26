/** tape transport sound : hiss + motor hum + soft capstan whir */
export class TapeAudio {
  constructor() { this.ctx = null; this.on = false; this.level = 0.42; }

  /** master level — ducked while the music plays */
  setLevel(v) {
    this.level = v;
    if (this.ctx && this.on) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.5);
  }

  _noise(ctx, seconds = 2) {
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    }
    return buf;
  }

  /** the context and its graph, built once and shared by the tape bed and the
      UI. Built lazily on a gesture, because that is the only time a browser
      will let us have one. */
  _ensure() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // the UI detent lives outside `master`: it must tick whether or not the
    // tape is running, and it must not be ducked when the music starts
    this.ui = ctx.createGain();
    this.ui.gain.value = 0.5;
    this.ui.connect(ctx.destination);

    {
      // hiss
      const hiss = ctx.createBufferSource();
      hiss.buffer = this._noise(ctx, 3);
      hiss.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1600;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 7200;
      this.hissGain = ctx.createGain();
      this.hissGain.gain.value = 0.34;
      hiss.connect(hp).connect(lp).connect(this.hissGain).connect(this.master);

      // motor hum
      const hum = ctx.createOscillator();
      hum.type = 'sawtooth'; hum.frequency.value = 49.5;
      const hlp = ctx.createBiquadFilter();
      hlp.type = 'lowpass'; hlp.frequency.value = 220; hlp.Q.value = 3;
      this.humGain = ctx.createGain(); this.humGain.gain.value = 0.16;
      hum.connect(hlp).connect(this.humGain).connect(this.master);

      // capstan whir
      const whir = ctx.createBufferSource();
      whir.buffer = this._noise(ctx, 2); whir.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 1.4;
      this.whirGain = ctx.createGain(); this.whirGain.gain.value = 0.03;
      whir.connect(bp).connect(this.whirGain).connect(this.master);

      // slow wobble on the hum
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.7;
      const lfoG = ctx.createGain(); lfoG.gain.value = 60;
      lfo.connect(lfoG).connect(hlp.frequency);

      const t = ctx.currentTime;
      hiss.start(t); hum.start(t); whir.start(t); lfo.start(t);
      this.wobble = () => { lfoG.gain.value = 60 + Math.random() * 4; };
    }
    return true;
  }

  /** resume() is a promise, and it rejects (or stays pending) when the page has
      not had a gesture yet — which is exactly the state a deep link boots in.
      Nothing here can act on that, and an unhandled rejection would surface as
      a page error in the loader. */
  _resume() {
    try { this.ctx.resume?.().catch?.(() => {}); } catch { /* no context yet */ }
  }

  start() {
    if (this.on) return;
    if (!this._ensure()) return;
    this._resume();
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(this.level, this.ctx.currentTime, 0.5);
    this.on = true;
  }

  stop() {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.22);
    this.on = false;
  }

  /** index detent — one short click per step through the record list, so
      browsing has the same weight as turning a knob */
  tick() {
    if (!this._ensure()) return;
    this._resume();
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(2100, t);
    o.frequency.exponentialRampToValueAtTime(1150, t + 0.02);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(this.ui);
    o.start(t); o.stop(t + 0.06);
  }

  /** transport switch noise (rewind / fast forward) */
  clunk(pitch = 1) {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noise(ctx, 0.35);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.setValueAtTime(900 * pitch, t);
    f.frequency.exponentialRampToValueAtTime(260 * pitch, t + 0.3);
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.36);
  }
}
