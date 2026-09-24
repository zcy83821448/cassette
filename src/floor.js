import * as THREE from 'three';
import { roughTex } from './textures.js';

/* Real-time planar reflection, computed by hand instead of via the Reflector
   addon: the addon hooks onBeforeRender, which fires again inside the glass's
   transmission pass and re-enters renderer.setRenderTarget mid-render. Doing
   the mirror pass ourselves — once per frame, before the composer — keeps the
   renderer state clean and lets us drop it on weak GPUs. */

const VERT = /* glsl */`
  uniform mat4 textureMatrix;
  varying vec4 vProj;
  varying vec3 vWorld;
  void main() {
    vProj = textureMatrix * vec4(position, 1.0);
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform vec3 color;
  uniform sampler2D tDiffuse;
  uniform sampler2D tRough;
  uniform float uBlurV, uBlurH, uMix, uOpacity, uInner, uOuter;
  uniform float uBlurVar, uWorldScale;
  varying vec4 vProj;
  varying vec3 vWorld;

  void main() {
    vec2 uv = vProj.xy / max(vProj.w, 1e-5);

    // a real polished floor is not a perfect mirror: polishing leaves large
    // scale variation, so the blur radius breathes across the surface.
    //
    // Keep that breathing slow. The mirror camera is built from this one, so
    // the mirror itself is exact and the projection adds no distortion — the
    // tap offsets below are the only thing that can soften the reflection, and
    // they soften it twice: through the kernel width, and through the mip the
    // hardware picks, because texture2D() takes its gradient from the
    // *argument* uv + off. Noise in the offset therefore inflates the LOD, and
    // high-frequency noise here shows up as patches of reflection going soft
    // along a hard edge — which is what a stretched-looking streak is.
    float n = texture2D(tRough, vWorld.xz * uWorldScale).r;
    float blurV = uBlurV * (1.0 + (n - 0.5) * uBlurVar);
    float blurH = uBlurH * (1.0 + (n - 0.5) * uBlurVar * 0.6);

    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    // 13 taps, gaussian-ish, stretched along screen Y (a stone floor smears
    // the reflection vertically, not uniformly)
    for (int i = 0; i < 13; i++) {
      float t = float(i) / 12.0 - 0.5;
      float w = exp(-t * t * 6.5);
      vec2 off = vec2(t * blurH, t * blurV * (1.0 + abs(t) * 0.7));
      acc += texture2D(tDiffuse, clamp(uv + off, vec2(0.0015), vec2(0.9985))).rgb * w;
      wsum += w;
    }
    vec3 refl = acc / wsum;

    // Where the sample lands outside the mirror render there is no reflection to
    // be had — nothing was drawn there. Clamping it to the edge is what makes a
    // streak out of it, so those last pixels are given up instead: the reflection
    // fades out over the outermost 1.4% of the frame and the floor's own colour
    // shows through, which is what the surface under a reflection looks like
    // anyway. (The mirror's frustum is matched to the camera's exactly, so this
    // only ever catches the frame's own edge.)
    vec2 edge = smoothstep(vec2(0.0), vec2(0.014), uv)
              * smoothstep(vec2(0.0), vec2(0.014), 1.0 - uv);

    float d = length(vWorld.xz);
    float fade = 1.0 - smoothstep(uInner, uOuter, d);
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);       // more mirror at grazing angles
    float k = clamp(uMix * fade * mix(0.5, 1.0, fres), 0.0, 1.0) * edge.x * edge.y;
    gl_FragColor = vec4(mix(color, refl, k), uOpacity * fade);
  }
`;

export function createSoftFloor(opt = {}) {
  const {
    radius = 70, y = -1.62, base = 0x0b0c0e, mix = 0.6,
    inner = 3.4, outer = 24, blurV = 0.0028, blurH = 0.0010, interval = 1,
    blurVar = 0.35, worldScale = 0.22,
  } = opt;

  const geo = new THREE.CircleGeometry(radius, 128);
  geo.rotateX(-Math.PI / 2);

  const uniforms = {
    color: { value: new THREE.Color(base) },
    tDiffuse: { value: null },
    textureMatrix: { value: new THREE.Matrix4() },
    uBlurV: { value: blurV },
    uBlurH: { value: blurH },
    uMix: { value: mix },
    uOpacity: { value: 1 },
    uInner: { value: inner },
    uOuter: { value: outer },
    tRough: { value: roughTex(256, { lo: 0.30, hi: 0.78, octaves: 3, seed: 9 }) },
    uBlurVar: { value: blurVar },
    uWorldScale: { value: worldScale },
  };

  const material = new THREE.ShaderMaterial({
    name: 'SoftFloor',
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = y;
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;

  // full resolution + MSAA: the mirror image is what shows up as stair-stepping
  // on the floor, and mipmaps kill the shimmer where the reflection compresses
  // 0.6 resolution: at full res this was a whole extra MSAA scene render every
  // other frame — a 2-4 ms spike landing on every second vsync, which reads as
  // a rhythmic judder. The reflection is blurred by design, so the resolution
  // costs nothing visible, while MSAA (cheap here) keeps the edges clean.
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const rt = new THREE.WebGLRenderTarget(
    Math.round(innerWidth * 0.6 * dpr), Math.round(innerHeight * 0.6 * dpr),
    {
      type: THREE.HalfFloatType, depthBuffer: true, samples: 4,
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    }
  );
  uniforms.tDiffuse.value = rt.texture;

  // --- mirror camera, rebuilt every frame (cheap)
  const virtual = new THREE.PerspectiveCamera();
  const normal = new THREE.Vector3(0, 1, 0);
  const reflectMatrix = new THREE.Matrix4();
  const v = new THREE.Vector3(), t = new THREE.Vector3(), rot = new THREE.Matrix4();
  const camPos = new THREE.Vector3();
  const bias = new THREE.Matrix4().set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1
  );
  let enabled = true, tick = 0, warmed = false;

  function update(renderer, scene, camera, force = false) {
    if (!enabled) return;
    // the reflection is blurred and the floor is mostly dark: refreshing it on
    // alternate frames is invisible and halves its per-object CPU cost
    if (!force && warmed && (tick++ % interval) !== 0) return;
    warmed = true;
    camera.updateMatrixWorld();
    mesh.updateMatrixWorld();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    if (camPos.y <= mesh.position.y + 0.05) return;   // never look from below

    rot.extractRotation(camera.matrixWorld);
    t.set(0, 0, -1).applyMatrix4(rot).add(camPos);    // a point ahead of the camera
    // mirror both about the plane y = floor
    v.copy(camPos); v.y = 2 * mesh.position.y - v.y;
    t.set(t.x, 2 * mesh.position.y - t.y, t.z);
    virtual.position.copy(v);
    virtual.up.set(0, 1, 0);
    virtual.lookAt(t);
    virtual.near = camera.near;
    virtual.far = camera.far;
    virtual.updateMatrixWorld();
    /* The projection is the main camera's, and that is right — a mirrored view is
       the main one flipped in y (that flip is what corrects the handedness of a
       camera looking at the scene from under the floor), so the frustum maps a
       point *on* the plane to its own screen position and the sampling needs no
       correction of its own.
       A *vertical* window offset, though, has to be mirrored along with it.
       Copied straight across, the frame's 2.5% downward shift (see applyViewOffset)
       came out as a 5% disagreement between the sample coordinate and the pixel it
       belonged to: the near floor — the band along the bottom of the frame — then
       asked for rows below the bottom of the mirror render, and the clamp in the
       shader smeared the last row of it sideways. That is the stretch that has
       been running along the bottom of the page. The horizontal offset needs no
       such treatment: the flip is in y. */
    if (camera.view?.enabled) {
      const w = camera.view;
      // setViewOffset() rebuilds the matrix out of the camera's own optics, so the
      // optics have to come across as well — the fov above all, or the mirror pass
      // would be rendering a wider lens than the one it is supposed to mirror
      virtual.fov = camera.fov;
      virtual.zoom = camera.zoom;
      virtual.filmGauge = camera.filmGauge;
      virtual.filmOffset = camera.filmOffset;
      virtual.setViewOffset(w.fullWidth, w.fullHeight, w.offsetX,
        w.fullHeight - w.offsetY - w.height, w.width, w.height);
    } else {
      virtual.projectionMatrix.copy(camera.projectionMatrix);
    }
    virtual.matrixWorldInverse.copy(virtual.matrixWorld).invert();

    reflectMatrix.copy(bias)
      .multiply(virtual.projectionMatrix)
      .multiply(virtual.matrixWorldInverse)
      .multiply(mesh.matrixWorld);
    uniforms.textureMatrix.value.copy(reflectMatrix);

    const prev = renderer.getRenderTarget();
    mesh.visible = false;
    renderer.setRenderTarget(rt);
    renderer.render(scene, virtual);
    renderer.setRenderTarget(prev);
    mesh.visible = true;
  }

  return {
    mesh,
    uniforms,
    update,
    setEnabled(on) { enabled = on; mesh.visible = on; uniforms.uOpacity.value = on ? 1 : 0; },
    refresh() { warmed = false; },
    setSize(w, h) {
      const d = Math.min(devicePixelRatio || 1, 2);
      rt.setSize(Math.round(w * 0.6 * d), Math.round(h * 0.6 * d));
      warmed = false;
    },
    setTheme({ color, mix: m, y: yy }) {
      if (color !== undefined) uniforms.color.value.set(color);
      if (m !== undefined) uniforms.uMix.value = m;
      if (yy !== undefined) mesh.position.y = yy;
    },
    dispose() { rt.dispose(); geo.dispose(); material.dispose(); },
  };
}
