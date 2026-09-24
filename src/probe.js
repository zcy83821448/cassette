import * as THREE from 'three';

/* A reflection probe: one cubemap render from the subject's centre, filtered
   through PMREM so rough materials still get properly blurred reflections.

   This is what gives the cassette its self- and inter-object reflections — the
   chrome guide pins show the tape, the smoked window shows the shell rim, the
   glossy lid shows the label edge — without the per-frame cost of screen-space
   ray marching, and without SSR's habit of losing anything that leaves frame. */
export function createProbe(renderer, scene, { size = 256, near = 0.25, far = 90, layer = 2, at = [0, 2.4, 3.4] } = {}) {
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cam = new THREE.CubeCamera(near, far, rt);
  cam.layers.enable(layer);
  cam.position.set(at[0], at[1], at[2]);
  scene.add(cam);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let current = null, stale = null;

  function capture() {
    cam.update(renderer, scene);
    const next = pmrem.fromCubemap(rt.texture);
    // hold the previous generation one cycle: materials are re-pointed right
    // after this returns, and disposing early leaves them sampling a dead
    // texture for a frame
    if (stale) stale.dispose();
    stale = current;
    current = next;
    return current.texture;
  }

  return {
    camera: cam,
    capture,
    get texture() { return current ? current.texture : null; },
    dispose() {
      rt.dispose();
      pmrem.dispose();
      if (current) current.dispose();
    },
  };
}
