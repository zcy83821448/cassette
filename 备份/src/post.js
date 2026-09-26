import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { AOPass } from './ao.js';

const Grade = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uProjInv: { value: new THREE.Matrix4() },
    uTime: { value: 0 },
    uGrain: { value: 0.05 },
    uVig: { value: 0.85 },
    uCA: { value: 0.85 },
    uFade: { value: 0 },
    uSat: { value: 1.0 },
    uHal: { value: 0.06 },
    uEdge: { value: 1.0 },     // lens defocus strength away from the subject
    uFocus: { value: 0.26 },   // uv radius that stays sharp
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    // stylised (三渲二) stage
    uToon: { value: 0 },
    uLevels: { value: 4.0 },
    uFlat: { value: 0.85 },
    uInk: { value: 0.62 },
    uInkWidth: { value: 1.5 },
    uInkColor: { value: new THREE.Color(0x0b0a10) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tDepth;
    uniform mat4 uProjInv;
    uniform float uTime, uGrain, uVig, uCA, uFade, uSat, uHal, uEdge, uFocus;
    uniform float uToon, uLevels, uFlat, uInk, uInkWidth;
    uniform vec3 uInkColor;
    uniform vec2 uCenter, uTexel;
    varying vec2 vUv;

    float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p + 19.19); return fract(p.x * p.y); }

    // 9 tap disc — at r = 0 this collapses back to a single fetch
    vec3 disc(vec2 uv, vec2 r) {
      vec3 s = texture2D(tDiffuse, uv).rgb * 0.22;
      s += texture2D(tDiffuse, uv + vec2(r.x, 0.0)).rgb * 0.10;
      s += texture2D(tDiffuse, uv - vec2(r.x, 0.0)).rgb * 0.10;
      s += texture2D(tDiffuse, uv + vec2(0.0, r.y)).rgb * 0.10;
      s += texture2D(tDiffuse, uv - vec2(0.0, r.y)).rgb * 0.10;
      s += texture2D(tDiffuse, uv + r * 0.70).rgb * 0.095;
      s += texture2D(tDiffuse, uv - r * 0.70).rgb * 0.095;
      s += texture2D(tDiffuse, uv + vec2(r.x, -r.y) * 0.70).rgb * 0.095;
      s += texture2D(tDiffuse, uv + vec2(-r.x, r.y) * 0.70).rgb * 0.095;
      return s;
    }

    vec3 viewPos(vec2 uv, float d) {
      vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      return p.xyz / p.w;
    }
    vec3 normalAt(vec2 uv, float d) {
      vec3 p = viewPos(uv, d);
      return normalize(cross(dFdx(p), dFdy(p)));
    }

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);

      // soft wide-open falloff outside the focus radius
      float def = smoothstep(uFocus, uFocus + 0.40, distance(uv, uCenter)) * uEdge;
      vec2 blur = uTexel * (1.0 + def * 4.6);

      vec2 off = d * r2 * uCA * 0.012;
      vec3 c;
      c.r = disc(uv + off, blur).r;
      c.g = disc(uv, blur).g;
      c.b = disc(uv - off, blur).b;

      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));

      // filmic split tone — cool shadows, warm highlights
      c *= mix(vec3(0.93, 0.985, 1.07), vec3(1.055, 1.005, 0.935), smoothstep(0.16, 0.86, l));
      // halation: warm bleed off the brightest speculars
      c += vec3(1.0, 0.60, 0.32) * smoothstep(0.78, 1.0, l) * uHal;
      c = mix(vec3(l), c, uSat);

      /* ---- stylised stage: posterised luminance + inked creases ----------
         Edges come from two independent signals, because neither alone is
         reliable: the normal break (from depth derivatives) catches creases
         between touching parts, and the view-space depth step catches the
         silhouette against the floor and the void. The depth threshold scales
         with distance so a sloped surface never inks itself at grazing angles. */
      if (uToon > 0.001) {
        float d0 = texture2D(tDepth, uv).x;
        // the floor, glass and dust do not write depth, so large parts of the
        // frame have no depth at all. Reconstructing a normal from d = 1 gives
        // NaN, and NaN survives clamp()/mix() as garbage pixels — so skip
        // everything that is not solid geometry up front.
        if (d0 < 0.99999) {
        vec2 tx = uTexel * uInkWidth;
        float dR = texture2D(tDepth, uv + vec2(tx.x, 0.0)).x;
        float dL = texture2D(tDepth, uv - vec2(tx.x, 0.0)).x;
        float dU = texture2D(tDepth, uv + vec2(0.0, tx.y)).x;
        float dD = texture2D(tDepth, uv - vec2(0.0, tx.y)).x;

        float z0 = -viewPos(uv, d0).z;
        float thr = 0.013 * z0;
        float step0 = abs(-viewPos(uv + vec2(tx.x, 0.0), dR).z - z0);
        step0 = max(step0, abs(-viewPos(uv - vec2(tx.x, 0.0), dL).z - z0));
        step0 = max(step0, abs(-viewPos(uv + vec2(0.0, tx.y), dU).z - z0));
        step0 = max(step0, abs(-viewPos(uv - vec2(0.0, tx.y), dD).z - z0));
        float depthEdge = smoothstep(thr, thr * 2.2, step0);

        vec3 N = normalAt(uv, d0);
        float nd = 0.0;
        if (dR < 0.99999) nd += 1.0 - dot(N, normalAt(uv + vec2(tx.x, 0.0), dR));
        if (dU < 0.99999) nd += 1.0 - dot(N, normalAt(uv + vec2(0.0, tx.y), dU));
        float normalEdge = smoothstep(0.10, 0.55, nd);

        float edge = clamp(max(depthEdge, normalEdge) * uInk, 0.0, 1.0);

        float dith = (hash(uv * 977.0) - 0.5) * (0.85 / uLevels);
        float lq = clamp(floor(l * uLevels + 0.5 + dith) / uLevels, 0.0, 1.0);
        c *= mix(1.0, lq / max(l, 0.0015), uFlat * uToon);
        c = mix(c, uInkColor, edge * uToon);
        }
      }

      float vig = smoothstep(1.18, 0.28, length(d) * 1.42);
      c *= mix(1.0, vig, uVig);

      float g = hash(uv * vec2(1927.0, 1087.0) + fract(uTime) * 91.7);
      c += (g - 0.5) * uGrain * mix(1.35, 0.35, smoothstep(0.0, 0.8, l));

      gl_FragColor = vec4(c * uFade, 1.0);
    }
  `,
};

export function createComposer(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // a real depth texture on the beauty target: three resolves it for free as
  // part of the MSAA blit, so the AO pass needs no prepass of its own
  const depthTexture = new THREE.DepthTexture(size.x, size.y);
  depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
  depthTexture.type = THREE.UnsignedIntType;
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
    samples: 4,
    depthBuffer: true,
    depthTexture,
    resolveDepthBuffer: true,
  });
  const composer = new EffectComposer(renderer, rt);
  /* RenderPass always draws into readBuffer, and readBuffer alternates between
     the composer's two targets: the chain swaps an odd number of times per
     frame (AO, Output, Grade). rt's clone carries a *cloned* depth texture —
     three clones the depth attachment along with the target — so the AO and the
     ink edges would be handed the previous frame's depth on every other frame.
     The subject drifts ~0.08 px per frame, so that shows up as an occlusion
     pattern that flips between two slightly different images at half the frame
     rate: a shimmer on every edge, which no amount of sampling tweaking fixes.
     Point both buffers at one depth texture and the resolved depth is always
     the frame being shaded. */
  composer.renderTarget2.depthTexture = depthTexture;
  const render = new RenderPass(scene, camera);
  const ao = new AOPass(camera, size.x, size.y);
  ao.setDepthTexture(depthTexture);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.70, 0.87);
  const output = new OutputPass();
  const grade = new ShaderPass(Grade);
  grade.uniforms.uFade.value = 0;
  grade.uniforms.tDepth.value = depthTexture;
  composer.addPass(render);
  composer.addPass(ao);
  composer.addPass(bloom);
  composer.addPass(output);
  composer.addPass(grade);
  return { composer, render, ao, bloom, grade, output, depthTexture };
}
