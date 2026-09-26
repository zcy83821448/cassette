import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/* Screen-space ambient occlusion from the depth buffer the main render already
   produced (three resolves it for free as part of the MSAA blit, so no prepass).

   Quality decisions, given the GPU sits idle:
   - full resolution, so screw counterbores and the tape gap actually resolve
   - two scales in one tap budget: a tight near radius for contact and creases,
     a wide far radius for the occlusion inside the window and hub openings
   - a separable depth-aware (bilateral) blur, so noise comes off without
     smearing occlusion across silhouettes — the thing that makes cheap SSAO
     look like a grey wash
   - a fixed per-pixel rotation: a time-varying one trades banding for temporal
     noise, which reads as a shimmering outline on every crease

   Why it does not flicker. Three separate things used to move the result around
   between frames faster than the picture itself was moving:

   1. The depth texture is a *resolved* depth — the MSAA blit picks one sample
      per pixel (`gl.blitFramebuffer(..., NEAREST)`). At a silhouette a pixel
      holds the object on one frame and the background on the next. Deriving the
      surface normal from raw depth derivatives let that single pixel tilt the
      whole hemisphere, and the occlusion of its entire 2x2 quad jumped with it.
      Neighbours that break from the centre are now collapsed onto the centre's
      tangent plane, so a popped neighbour changes nothing.

   2. The occlusion test was a step — `diff > bias ? 1 : 0` — so a sample moved
      from "fully occluding" to "not occluding" on a depth change far below a
      pixel's worth of motion. It ramps now: the same drift only nudges it.

   3. Neither of those removes the aliased silhouette itself, which steps by a
      whole pixel as the subject drifts; that is what the temporal pass at the
      end is for. Each frame is reprojected into the previous one and blended,
      with the history depth-checked so nothing stale survives a real change,
      and clamped to the current frame's neighbourhood so the reels turning or a
      part sliding out during the explode can never leave a ghost behind.

   One more trap, in the composer rather than here: the render targets a pass
   chain alternates between are a clone, and three clones a depth texture along
   with its target. The AO would then be handed last frame's depth on every
   other frame. post.js points both buffers at one depth texture; see the note
   there. */

const KERNEL = 96;
const HISTORY_ALPHA = 0.90;      // weight carried over; the rest is this frame
const HISTORY_DEPTH_TOL = 0.03;  // reject history past this relative depth error
const HOLD_FRAMES = 3;           // frames a silhouette dropout may keep its value

function makeKernel(n) {
  const half = n / 2;
  const k = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random());
    const z = Math.sqrt(Math.max(0, 1 - r * r * 0.8));
    const t = (i % half) / half;
    // near half clusters at the origin, far half reaches out
    const len = i < half ? 0.15 + 0.85 * t * t : 0.45 + 0.55 * Math.pow(t, 0.6);
    k.push(new THREE.Vector3(Math.cos(a) * r * len, Math.sin(a) * r * len, z * len));
  }
  return k;
}

const AO_FRAG = /* glsl */`
  #define KERNEL ${KERNEL}
  #define HALF ${KERNEL / 2}
  uniform sampler2D tDepth;
  uniform mat4 uProj, uProjInv, uViewInv;
  uniform float uRadiusNear, uRadiusFar;
  uniform float uBiasNear, uBiasFar;
  uniform float uStrengthNear, uStrengthFar;
  uniform vec2 uTexel;
  uniform vec3 uKernel[KERNEL];
  varying vec2 vUv;

  // stronger than fract(sin(dot())) — that one shows structure on some GPUs
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  vec3 viewPos(vec2 uv, float d) {
    vec4 c = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return c.xyz / c.w;
  }

  /* A neighbour of the centre pixel, unless its depth breaks from the centre's.
     The resolved depth at a silhouette is a coin flip between the object and
     the background, and a background tap reconstructs a point on the far plane
     — a normal built from it is nonsense that changes every time the coin
     lands the other way. Collapsing it onto the centre leaves the plane the
     surface actually has, so the flip becomes a no-op. */
  vec3 surfaceTap(vec2 uv, float z0, vec3 P, float tol) {
    float d = texture2D(tDepth, uv).x;
    if (d >= 0.99999) return P;
    vec3 p = viewPos(uv, d);
    return abs(-p.z - z0) > tol * z0 ? P : p;
  }

  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }   // no geometry, no occlusion

    vec3 P = viewPos(vUv, d);
    float z0 = -P.z;
    vec3 pR = surfaceTap(vUv + vec2(uTexel.x, 0.0), z0, P, 0.05);
    vec3 pL = surfaceTap(vUv - vec2(uTexel.x, 0.0), z0, P, 0.05);
    vec3 pU = surfaceTap(vUv + vec2(0.0, uTexel.y), z0, P, 0.05);
    vec3 pD = surfaceTap(vUv - vec2(0.0, uTexel.y), z0, P, 0.05);
    vec3 n = cross(pR - pL, pU - pD);
    // every tap rejected (or a dead-flat set) degenerates to zero: the depth
    // derivatives are a worse normal, but they are never NaN
    vec3 N = dot(n, n) > 1e-12 ? normalize(n) : normalize(cross(dFdx(P), dFdy(P)));
    vec3 T = normalize(abs(N.z) < 0.9 ? cross(vec3(0.0, 0.0, 1.0), N) : cross(vec3(1.0, 0.0, 0.0), N));
    vec3 B = cross(N, T);
    // Rotate the kernel with a SMOOTH function of world position, never a
    // per-pixel hash. Any hashed rotation — screen space or world space — boils
    // the moment the subject drifts sub-pixel, because a 0.0004 unit move lands
    // on an unrelated hash value: that is the high frequency flicker. A linear
    // function varies slowly across the surface, so a sub-pixel move barely
    // changes the rotation, and neighbouring pixels share a similar pattern that
    // the bilateral pass can actually average.
    vec3 W = (uViewInv * vec4(P, 1.0)).xyz;
    // the rate is the tuning knob: the pattern must be fine enough to read as
    // noise rather than bands, yet slow enough that a frame's worth of subject
    // drift (0.0004 units) rotates the kernel far less than one sample spacing
    // (2*pi/96 = 0.065 rad). 12 lands at 0.004 rad per frame — stable.
    float rot = (W.x * 0.83 + W.y * 0.61 + W.z * 0.47) * 12.0;
    float ca = cos(rot), sa = sin(rot);
    mat3 basis = mat3(T * ca + B * sa, -T * sa + B * ca, N);

    float occNear = 0.0, occFar = 0.0;
    for (int i = 0; i < KERNEL; i++) {
      bool near = i < HALF;
      float rad = near ? uRadiusNear : uRadiusFar;
      vec3 sp = P + basis * uKernel[i] * rad;
      vec4 o = uProj * vec4(sp, 1.0);
      vec2 suv = (o.xy / o.w) * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
      vec3 SP = viewPos(suv, texture2D(tDepth, suv).x);
      float diff = SP.z - sp.z;                      // > 0: geometry in front of the sample
      // smooth on both ends. The old test was a step at the bias, which flipped
      // a sample's whole contribution on a depth change of a fraction of a
      // pixel; the ramp means the same change only nudges it.
      float bias = near ? uBiasNear : uBiasFar;
      float occ = smoothstep(bias, bias + rad * 0.6, diff)
                * (1.0 - smoothstep(rad * 1.2, rad * 1.8, diff));
      if (near) occNear += occ; else occFar += occ;
    }

    float ao = 1.0 - 0.5 * (
      occNear / float(HALF) * uStrengthNear +
      occFar / float(HALF) * uStrengthFar
    );
    gl_FragColor = vec4(clamp(ao, 0.0, 1.0));
  }
`;

const BLUR_FRAG = /* glsl */`
  uniform sampler2D tAO, tDepth;
  uniform vec2 uDir;
  uniform float uNear, uFar, uSharp;
  varying vec2 vUv;

  float viewDist(vec2 uv) {
    float d = texture2D(tDepth, uv).x * 2.0 - 1.0;
    return 2.0 * uNear * uFar / max(uFar + uNear - d * (uFar - uNear), 1e-4);
  }

  void main() {
    float z0 = viewDist(vUv);
    float sum = 0.0, wsum = 0.0;
    for (int i = -4; i <= 4; i++) {
      vec2 suv = vUv + uDir * float(i);
      float w = exp(-float(i * i) * 0.13) * exp(-abs(viewDist(suv) - z0) * uSharp);
      sum += texture2D(tAO, suv).r * w;
      wsum += w;
    }
    gl_FragColor = vec4(sum / max(wsum, 1e-4));
  }
`;

const TEMPORAL_FRAG = /* glsl */`
  uniform sampler2D tCur, tHist, tDepth;
  uniform mat4 uProjInv, uViewInv, uPrevViewProj;
  uniform vec2 uTexel;
  uniform float uAlpha, uTol, uHold;
  varying vec2 vUv;

  vec3 viewPos(vec2 uv, float d) {
    vec4 c = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return c.xyz / c.w;
  }
  bool hasGeom(vec2 uv) { return texture2D(tDepth, uv).x < 0.99999; }

  void main() {
    float cur = texture2D(tCur, vUv).r;
    vec4 hSame = texture2D(tHist, vUv);
    float d = texture2D(tDepth, vUv).x;

    if (d >= 0.99999) {
      /* Nothing under this pixel this frame. At a silhouette that is almost
         always the resolved depth dropping the object for a frame or two, not
         the object actually leaving — keeping the value we already had stops
         the edge from blinking, and the streak cap means a real departure still
         clears in a few frames. Gated on a neighbour still having geometry so
         the open background behind a part can never hold a stale shadow. */
      float streak = hSame.b + 1.0;
      bool near = hasGeom(vUv + vec2(uTexel.x, 0.0)) || hasGeom(vUv - vec2(uTexel.x, 0.0))
               || hasGeom(vUv + vec2(0.0, uTexel.y)) || hasGeom(vUv - vec2(0.0, uTexel.y));
      float keep = (near && hSame.g > 0.0 && streak <= uHold) ? 0.94 : 0.0;
      float ao = mix(1.0, hSame.r, keep);
      gl_FragColor = vec4(ao, keep > 0.0 ? hSame.g : 0.0, streak, 1.0);
      return;
    }

    // where this piece of surface was last frame
    vec3 P = viewPos(vUv, d);
    float z = -P.z;
    vec4 pc = uPrevViewProj * vec4((uViewInv * vec4(P, 1.0)).xyz, 1.0);
    vec2 puv = (pc.xy / max(abs(pc.w), 1e-5)) * 0.5 + 0.5;

    vec4 h = texture2D(tHist, puv);
    bool ok = pc.w > 0.0
      && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0
      && h.g > 0.0 && abs(h.g - z) <= uTol * z;

    // clamp the history into what this frame reports nearby: a stale value can
    // then never win over a real change, only ever soften one. mn/mx are seeded
    // with cur, so skipping the centre in the loop below drops one fetch out of
    // nine and leaves the same eight neighbours deciding the clamp
    float mn = cur, mx = cur;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        if (i == 0 && j == 0) continue;
        float s = texture2D(tCur, vUv + vec2(float(i), float(j)) * uTexel).r;
        mn = min(mn, s); mx = max(mx, s);
      }
    }

    float ao = ok ? mix(cur, clamp(h.r, mn, mx), uAlpha) : cur;
    gl_FragColor = vec4(ao, z, 0.0, 1.0);
  }
`;

const COMBINE_FRAG = /* glsl */`
  uniform sampler2D tDiffuse, tAO;
  uniform float uAmount;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float ao = texture2D(tAO, vUv).r;
    gl_FragColor = vec4(c * mix(1.0, ao, uAmount), 1.0);
  }
`;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

function mk(frag, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: frag,
    depthTest: false, depthWrite: false,
  });
}

export class AOPass extends Pass {
  constructor(camera, width, height) {
    super();
    this.camera = camera;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtB = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtA.texture.name = 'AO';
    // ping-pong: rgb unused but kept 4-channel, a half float holds an exact
    // integer well past the streak cap
    this.rtH = [new THREE.WebGLRenderTarget(w, h, opts), new THREE.WebGLRenderTarget(w, h, opts)];
    this.rtH[0].texture.name = 'AO.hist0';
    this.rtH[1].texture.name = 'AO.hist1';
    this._hi = 0;
    this._reset = true;
    this._view = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();

    this.aoMaterial = mk(AO_FRAG, {
      tDepth: { value: null },
      uProj: { value: new THREE.Matrix4() },
      uProjInv: { value: new THREE.Matrix4() },
      uViewInv: { value: new THREE.Matrix4() },
      uRadiusNear: { value: 0.17 },
      uRadiusFar: { value: 0.85 },
      uBiasNear: { value: 0.018 },
      uBiasFar: { value: 0.045 },
      uStrengthNear: { value: 1.0 },
      uStrengthFar: { value: 0.72 },
      uTexel: { value: new THREE.Vector2() },
      uKernel: { value: makeKernel(KERNEL) },
    });
    this.blurMaterial = mk(BLUR_FRAG, {
      tAO: { value: null },
      tDepth: { value: null },
      uDir: { value: new THREE.Vector2() },
      uNear: { value: 1 },
      uFar: { value: 220 },
      uSharp: { value: 5.0 },
    });
    this.temporalMaterial = mk(TEMPORAL_FRAG, {
      tCur: { value: null },
      tHist: { value: null },
      tDepth: { value: null },
      uProjInv: { value: new THREE.Matrix4() },
      uViewInv: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uAlpha: { value: HISTORY_ALPHA },
      uTol: { value: HISTORY_DEPTH_TOL },
      uHold: { value: HOLD_FRAMES },
    });
    this.combineMaterial = mk(COMBINE_FRAG, {
      tDiffuse: { value: null },
      tAO: { value: null },
      uAmount: { value: 1.0 },
    });
    this.fsQuad = new FullScreenQuad(this.aoMaterial);
    this.enabled = true;
    this.needsSwap = true;
    this.strength = 1.0;
    this.depthTexture = null;
    this._texel = [1 / w, 1 / h];
    this.setSize(width, height);
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.rtH[0].setSize(w, h);
    this.rtH[1].setSize(w, h);
    this._texel = [1 / w, 1 / h];
    // a resize leaves the history buffer at an undefined size and the
    // reprojection pointing at the old framing: start over
    this._reset = true;
  }

  setDepthTexture(depthTexture) {
    this.depthTexture = depthTexture;
    this.aoMaterial.uniforms.tDepth.value = depthTexture;
    this.blurMaterial.uniforms.tDepth.value = depthTexture;
    this.temporalMaterial.uniforms.tDepth.value = depthTexture;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const view = this._view.copy(cam.matrixWorld).invert();

    const u = this.aoMaterial.uniforms;
    u.uProj.value.copy(cam.projectionMatrix);
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uViewInv.value.copy(cam.matrixWorld);
    u.uTexel.value.set(this._texel[0], this._texel[1]);
    this.blurMaterial.uniforms.uNear.value = cam.near;
    this.blurMaterial.uniforms.uFar.value = cam.far;
    const tu = this.temporalMaterial.uniforms;
    tu.uProjInv.value.copy(cam.projectionMatrixInverse);
    tu.uViewInv.value.copy(cam.matrixWorld);
    tu.uPrevViewProj.value.copy(this._prevViewProj);
    tu.uTexel.value.set(this._texel[0], this._texel[1]);
    this.combineMaterial.uniforms.uAmount.value = this.strength;

    const prev = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    if (this._reset) {
      this._reset = false;
      // a fresh target holds undefined texels; the history marks "no value" as
      // grey = 0, so clearing is what makes the first frame fall back to itself
      for (const rt of this.rtH) { renderer.setRenderTarget(rt); renderer.clear(); }
    }

    // 1. raw occlusion, full res
    this.fsQuad.material = this.aoMaterial;
    renderer.setRenderTarget(this.rtA);
    this.fsQuad.render(renderer);

    // 2. separable bilateral blur: horizontal, then vertical
    this.blurMaterial.uniforms.tAO.value = this.rtA.texture;
    this.blurMaterial.uniforms.uDir.value.set(this._texel[0] * 2.0, 0);
    this.fsQuad.material = this.blurMaterial;
    renderer.setRenderTarget(this.rtB);
    this.fsQuad.render(renderer);

    this.blurMaterial.uniforms.tAO.value = this.rtB.texture;
    this.blurMaterial.uniforms.uDir.value.set(0, this._texel[1] * 2.0);
    renderer.setRenderTarget(this.rtA);
    this.fsQuad.render(renderer);

    // 3. accumulate against the reprojected previous frame
    const src = this.rtH[this._hi];
    const dst = this.rtH[this._hi ^ 1];
    tu.tCur.value = this.rtA.texture;
    tu.tHist.value = src.texture;
    this.fsQuad.material = this.temporalMaterial;
    renderer.setRenderTarget(dst);
    this.fsQuad.render(renderer);

    // 4. multiply into the beauty pass
    this.combineMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.combineMaterial.uniforms.tAO.value = dst.texture;
    this.fsQuad.material = this.combineMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
    this._hi ^= 1;

    // this frame becomes the reference the next one reprojects into
    this._prevViewProj.multiplyMatrices(cam.projectionMatrix, view);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.rtH[0].dispose();
    this.rtH[1].dispose();
    this.aoMaterial.dispose();
    this.blurMaterial.dispose();
    this.temporalMaterial.dispose();
    this.combineMaterial.dispose();
    this.fsQuad.dispose();
  }
}
