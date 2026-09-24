import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { damp } from './anim.js';

/* A photographic rig rather than a "3D scene" rig.

   RectAreaLight is the only three.js light that behaves like a softbox: the
   rectangle is the emitter, so a glossy surface shows the softbox itself as a
   soft rectangular highlight, and falloff across the subject reads like real
   inverse-square + size falloff. It cannot cast shadows, so one directional
   light sits in the key's position purely to drop the cast/contact shadow.

   The five positions are the classic ones:
     key    45° off the camera axis, ~35° up, warm (the only "hard" source)
     fill   opposite side, close to the camera axis, big and dim, cool
     rim    narrow strip behind, tracing the silhouette
     bounce white card on the table in front-left, warm, lifts the underside
     top    wide overhead wash so the label face stays readable
   ======================================================================= */

export const RIG = {
  noir: {
    exposure: 0.98, envInt: 0.55,
    key: { c: 0xfff0dc, i: 1.75, w: 9.0, h: 6.0, p: [-6.4, 5.2, 6.6] },
    fill: { c: 0xd6e4ff, i: 0.45, w: 12, h: 8.0, p: [8.6, 1.8, 5.2] },
    rim: { c: 0xc4daff, i: 2.00, w: 1.3, h: 13, p: [4.2, 4.6, -8.6] },
    bounce: { c: 0xffd7a8, i: 0.40, w: 12, h: 12, p: [0.5, -3.4, 3.8] },
    top: { c: 0xeef3ff, i: 0.22, w: 12, h: 12, p: [-0.8, 8.8, 1.2] },
    shadow: { i: 0.75, p: [-6.4, 5.2, 6.6] },
  },
  toon: {
    // flat, high key ratio so posterising has as few gradations as possible
    exposure: 1.0, envInt: 0.90,
    key: { c: 0xfff6ea, i: 1.55, w: 18, h: 14, p: [-7.0, 8.5, 8.0] },
    fill: { c: 0xeef4ff, i: 1.35, w: 20, h: 16, p: [8.5, 4.0, 7.0] },
    rim: { c: 0xffffff, i: 1.05, w: 2.5, h: 16, p: [2.0, 6.0, -10.0] },
    bounce: { c: 0xfff4e6, i: 0.80, w: 16, h: 16, p: [0.5, -3.4, 4.0] },
    top: { c: 0xffffff, i: 0.60, w: 18, h: 18, p: [0.0, 11.0, 1.0] },
    shadow: { i: 0.35, p: [-7.0, 8.5, 8.0] },
  },
  studio: {
    exposure: 0.90, envInt: 0.70,
    key: { c: 0xfff8ee, i: 2.05, w: 14, h: 10, p: [-7.6, 6.6, 7.6] },
    fill: { c: 0xeaf1ff, i: 0.95, w: 15, h: 11, p: [9.4, 2.6, 5.8] },
    rim: { c: 0xffffff, i: 1.25, w: 1.8, h: 16, p: [0.8, 6.2, -10.5] },
    bounce: { c: 0xfff4e6, i: 0.62, w: 13, h: 13, p: [0.4, -3.2, 4.2] },
    top: { c: 0xffffff, i: 0.55, w: 15, h: 15, p: [0, 10.5, 1.0] },
    shadow: { i: 0.50, p: [-7.6, 6.6, 7.6] },
  },
};

/** the rig as geometry on a hidden layer: a reflection probe that enables the
    layer sees the softboxes and the subject in the same capture */
export function buildRigPanels(themeName, layer = 2) {
  const preset = RIG[themeName] || RIG.noir;
  const group = new THREE.Group();
  group.name = 'rigPanels';
  for (const name of ['key', 'fill', 'rim', 'bounce', 'top']) {
    const p = preset[name];
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(p.w, p.h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(p.c).multiplyScalar(p.i), side: THREE.DoubleSide })
    );
    m.position.set(p.p[0], p.p[1], p.p[2]);
    m.lookAt(0, 0, 0);
    m.layers.set(layer);
    group.add(m);
  }
  return group;
}

export function createRig(scene) {
  RectAreaLightUniformsLib.init();

  const lights = {};
  for (const name of ['key', 'fill', 'rim', 'bounce', 'top']) {
    const l = new THREE.RectAreaLight(0xffffff, 1, 1, 1);
    l.position.set(0, 1, 0);
    l.lookAt(0, 0, 0);
    scene.add(l);
    lights[name] = l;
  }

  // shadow twin of the key
  const shadow = new THREE.DirectionalLight(0xffffff, 1);
  shadow.castShadow = true;
  // 2048 over a ±8.5 unit ortho box is ~0.8 mm per texel — far finer than this
  // object needs, and a quarter of the fill of 4096
  shadow.shadow.mapSize.set(2048, 2048);
  shadow.shadow.camera.near = 1;
  shadow.shadow.camera.far = 40;
  const d = 8.5;
  Object.assign(shadow.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
  shadow.shadow.bias = -0.0004;
  shadow.shadow.normalBias = 0.018;
  shadow.shadow.radius = 7;
  scene.add(shadow);

  // bake the colour strings into Color objects once — apply() runs every frame
  for (const preset of Object.values(RIG)) {
    for (const name of ['key', 'fill', 'rim', 'bounce', 'top']) preset[name].col = new THREE.Color(preset[name].c);
  }

  const target = RIG.noir;
  /* `rate` is the owner's to choose: a room change walks its lamps on the same
     clock as everything else, and that clock is not a fixed decay (see
     themeRate in main.js). 2.6 is what a caller that does not care gets. */
  const apply = (preset, dt, instant = false, rate = 2.6) => {
    const k = instant ? 1 : 1 - Math.exp(-rate * dt);
    for (const name of ['key', 'fill', 'rim', 'bounce', 'top']) {
      const p = preset[name], l = lights[name];
      l.color.lerp(p.col, k);
      l.intensity += (p.i - l.intensity) * k;
      l.width += (p.w - l.width) * k;
      l.height += (p.h - l.height) * k;
      l.position.x += (p.p[0] - l.position.x) * k;
      l.position.y += (p.p[1] - l.position.y) * k;
      l.position.z += (p.p[2] - l.position.z) * k;
      l.lookAt(0, 0, 0);
    }
    shadow.color.lerp(preset.key.col, k);
    shadow.intensity += (preset.shadow.i - shadow.intensity) * k;
    shadow.position.x += (preset.shadow.p[0] - shadow.position.x) * k;
    shadow.position.y += (preset.shadow.p[1] - shadow.position.y) * k;
    shadow.position.z += (preset.shadow.p[2] - shadow.position.z) * k;
  };

  apply(target, 0, true);
  return { lights, shadow, apply, dump: () => target };
}
