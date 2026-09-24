import * as THREE from 'three';
import { clamp, damp, ease } from './anim.js';

/** damped orbit with inertia, pointer parallax, pinch zoom and idle drift */
export class Orbit {
  constructor(dom, camera, opt = {}) {
    this.dom = dom;
    this.cam = camera;
    this.target = opt.target?.clone() || new THREE.Vector3();
    this.theta = this.gTheta = opt.theta ?? 0.66;
    this.phi = this.gPhi = opt.phi ?? 1.04;
    this.radius = this.gRadius = opt.radius ?? 16.5;
    this.vTheta = this.vPhi = 0;
    this.minPhi = opt.minPhi ?? 0.18;
    this.maxPhi = opt.maxPhi ?? 1.50;
    this.minR = opt.minR ?? 9.5;
    this.maxR = opt.maxR ?? 30;
    this.dragging = false;
    this.idle = 10;
    this.autoOn = opt.auto !== false;   // user-facing toggle
    this.auto = this.autoOn ? 1 : 0;    // eased weight, so the toggle ramps in/out
    this.reduceMotion = !!opt.reduce;   // the view still changes, it just cuts
    this.parallax = new THREE.Vector2();
    this.aim = new THREE.Vector2();
    this.tween = null;
    this.onInteract = opt.onInteract;
    this.onReset = opt.onReset;
    this._ptrs = new Map();
    this._pinch = 0;
    this._last = new THREE.Vector3();
    this._bind();
    this.apply();
  }

  _bind() {
    const d = this.dom;
    this._onDown = (e) => {
      if (e.target.closest?.('.ui-hit')) return;
      d.setPointerCapture?.(e.pointerId);
      this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.tween = null;
      this.idle = 0;
      if (this._ptrs.size === 1) { this.dragging = true; this.vTheta = this.vPhi = 0; }
      else if (this._ptrs.size === 2) this._pinch = this._dist();
      this.onInteract?.(true);
    };
    this._onMove = (e) => {
      const p = this._ptrs.get(e.pointerId);
      if (!p) {
        // hover parallax
        this.aim.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      this.idle = 0;
      if (this._ptrs.size >= 2) {
        const dst = this._dist();
        if (this._pinch > 0) this.gRadius = clamp(this.gRadius * Math.pow(this._pinch / dst, 0.9), this.minR, this.maxR);
        this._pinch = dst;
        return;
      }
      const k = 0.0062;
      this.gTheta -= dx * k;
      this.gPhi = clamp(this.gPhi - dy * k, this.minPhi, this.maxPhi);
      this.vTheta = -dx * k * 26;
      this.vPhi = dy * k * 26;
    };
    this._onUp = (e) => {
      this._ptrs.delete(e.pointerId);
      if (this._ptrs.size < 2) this._pinch = 0;
      if (this._ptrs.size === 0) { this.dragging = false; this.onInteract?.(false); }
    };
    this._onWheel = (e) => {
      // the archive overlay scrolls its own list. Anywhere else the wheel drives
      // the lens — and "anywhere else" has to include the buttons, because they
      // are the only pointer-events:auto things on the page and the transport
      // bar is the natural place to have the cursor while scrolling.
      if (e.target?.closest?.('.index')) return;
      e.preventDefault();
      this.tween = null;
      this.idle = 0;
      this.gRadius = clamp(this.gRadius * Math.exp(e.deltaY * 0.0011), this.minR, this.maxR);
      // zooming counts as handling the model: the owner arms its return-to-frame
      // timer off this, exactly as it does for a drag
      this.onManual?.();
    };
    this._onDbl = () => {
      const home = this.home || { theta: 0.66, phi: 1.04, radius: 16.5 };
      // the second parameter of setPreset is `hard`, not a duration: passing
      // 1.1 there made this an instant snap instead of a move. The owner also
      // needs telling — the panel indexes the vantages, and it has to stop
      // claiming to be in one the camera has just left.
      this.setPreset({ ...home, dur: 1.1 });
      this.onReset?.();
    };

    d.addEventListener('pointerdown', this._onDown);
    d.addEventListener('pointermove', this._onMove);
    addEventListener('pointerup', this._onUp);
    addEventListener('pointercancel', this._onUp);
    addEventListener('wheel', this._onWheel, { passive: false });
    d.addEventListener('dblclick', this._onDbl);
    d.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _dist() {
    const [a, b] = [...this._ptrs.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  setPreset({ theta, phi, radius, dur = 1.15 }, hard = false) {
    let t = theta;
    while (t - this.theta > Math.PI) t -= Math.PI * 2;
    while (t - this.theta < -Math.PI) t += Math.PI * 2;
    // `hard` is the caller asking for a cut; reduced motion wants the same thing
    // from every caller, so it gets the same branch rather than a shorter tween
    if (hard || this.reduceMotion) { this.theta = this.gTheta = t; this.phi = this.gPhi = phi; this.radius = this.gRadius = radius; return; }
    this.tween = { t: 0, dur, from: { theta: this.gTheta, phi: this.gPhi, radius: this.gRadius }, to: { theta: t, phi, radius } };
    this.idle = 0;
  }

  setAuto(on) { this.autoOn = !!on; }

  update(dt) {
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      const p = clamp(tw.t / tw.dur, 0, 1), e = ease.inOut(p);
      this.gTheta = tw.from.theta + (tw.to.theta - tw.from.theta) * e;
      this.gPhi = tw.from.phi + (tw.to.phi - tw.from.phi) * e;
      this.gRadius = tw.from.radius + (tw.to.radius - tw.from.radius) * e;
      if (p >= 1) this.tween = null;
    } else {
      if (!this.dragging) {
        this.idle += dt;
        // inertia
        this.gTheta += this.vTheta * dt;
        this.gPhi = clamp(this.gPhi + this.vPhi * dt, this.minPhi, this.maxPhi);
        const decay = Math.exp(-3.4 * dt);
        this.vTheta *= decay; this.vPhi *= decay;
        if (Math.abs(this.vTheta) < 0.002) this.vTheta = 0;
        if (Math.abs(this.vPhi) < 0.002) this.vPhi = 0;
      }
      // Auto-rotate. The toggle gates it, idleness delays the start, and the
      // eased weight means flipping the switch never snaps the camera.
      this.auto = damp(this.auto, this.autoOn ? 1 : 0, 2.2, dt);
      if (this.idle > 1.6) this.gTheta += 0.075 * this.auto * dt;
    }
    const rate = this.dragging ? 14 : 7;
    this.theta = damp(this.theta, this.gTheta, rate, dt);
    this.phi = damp(this.phi, this.gPhi, rate, dt);
    this.radius = damp(this.radius, this.gRadius, 6, dt);
    this.parallax.x = damp(this.parallax.x, this.dragging ? 0 : this.aim.x, 3, dt);
    this.parallax.y = damp(this.parallax.y, this.dragging ? 0 : this.aim.y, 3, dt);
    this.apply();
  }

  apply() {
    const th = this.theta + this.parallax.x * 0.05;
    const ph = clamp(this.phi - this.parallax.y * 0.028, 0.12, Math.PI - 0.12);
    const r = this.radius;
    const sp = Math.sin(ph);
    this.cam.position.set(
      this.target.x + r * sp * Math.sin(th),
      this.target.y + r * Math.cos(ph),
      this.target.z + r * sp * Math.cos(th)
    );
    this.cam.lookAt(this.target);
  }
}
