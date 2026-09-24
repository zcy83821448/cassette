import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as TX from './textures.js';
import { clamp, damp, smoothstep } from './anim.js';

/* ============================== dimensions ==============================
   compact cassette — 1 unit = 1 cm  (100.4 x 63.8 x 12.0 mm)
   x = width, z = depth (head opening at +z), y = thickness
   ======================================================================= */
export const DIM = {
  W: 10.04, H: 6.38, D: 1.20,
  hw: 5.02, hh: 3.19, hd: 0.60,
  rOut: 0.30,
  PT: 0.11, BV: 0.03,          // plate thickness / bevel
  wall: 0.30,
  labelInset: 0.26,
  win: { hw: 3.50, hz0: -1.85, hz1: 1.65, r: 0.26 },
  hub: { x: 2.15, z: -0.30, r: 0.62, h: 0.88 },
  tapeW: 0.381,
  guide: { x: 1.78, z: 2.42, r: 0.085 },
  head: 1.48,
  slot: [2.62, 3.98],
  rHub: 0.615, rMax: 2.02,
  tTape: 0.030,                // visual layer thickness (transfer rate)
  v: 4.76,                     // cm/s
  tile: 0.20,                  // cm of tape per repeat of the coating texture
  lead: 0.010,                 // the clear leader, as a share of the tape's length
  podX: 4.30, podZ: 2.40,
};
const D = DIM;
const PODS = [[-D.podX, -D.podZ], [D.podX, -D.podZ], [-D.podX, D.podZ], [D.podX, D.podZ], [0, -D.podZ]];

/* ============================== geometry helpers ======================== */

/* Auto-smooth, the way a modeller means it: normals are averaged across every
   edge that is *shallower* than the crease angle and left hard across the ones
   that are not. ExtrudeGeometry hands back flat-shaded triangles (its own
   computeVertexNormals on a non-indexed buffer can only ever produce face
   normals), so every rounded corner on this model was drawing as a chain of
   facets, and every bevel was a single facet rather than a highlight.

   18°, and the number is not free. ExtrudeGeometry builds the lid out of the
   *same vertex ring* the bevel starts from, so a vertex on the cap is shared
   with the first bevel facet — and on a rounded corner that facet is tilted only
   ~23° from the cap, not the 45° it is along a straight run. Crease anything
   above that and the corner lids get averaged with the bevel: the cap picks up a
   tilted normal at three corners of a huge earcut triangle, which shades as a
   soft diagonal fold across an otherwise flat face. (Measured on the front
   frame: 1044 lid vertices pulled off the cap at 25°, none at 22° or below.)
   18° keeps the bevels hard — which is what a chamfer *is*, a facet — while the
   rrect arcs (9° per segment) and the lathes (12.9° or finer) stay smooth. */
const CREASE = THREE.MathUtils.degToRad(18);
const autoSmooth = (g, crease = CREASE) => toCreasedNormals(g, crease);

function rrect(w, h, r, cx = 0, cz = 0) {
  const s = new THREE.Shape();
  const x = cx - w / 2, y = cz - h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}
const win = (shape, w, h, r, cx, cz) => (shape.holes.push(rrect(w, h, r, cx, cz)), shape);

/** plan-view (x,z) shape extruded downwards — top face at y = 0 */
function extrudeY(shape, depth, bevel = D.BV) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelOffset: 0, bevelSegments: 2, curveSegments: 10,
  });
  g.rotateX(Math.PI / 2);
  return autoSmooth(g);
}
/** elevation (x,y) shape extruded along +z. With a bevel the extrusion grows by
    one bevel at each end, so the caller's depth is what the part ends up deep —
    ExtrudeGeometry adds the two bevels on top of `depth`. */
function extrudeZ(shape, depth, bevel = 0) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: bevel > 0 ? depth - bevel * 2 : depth,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelOffset: 0, bevelSegments: 2, curveSegments: 10,
  });
  return autoSmooth(g);
}

/** a cylinder with its rims broken, which is what a moulded or machined round
    part has and what CylinderGeometry never gives you: the cap and the wall meet
    at a true 90° there, and a true 90° edge catches no highlight at all. Built
    as a lathe so the chamfer is real geometry rather than a shading trick. */
function latheCyl(rTop, rBot, h, chamfer = 0.03, segs = 32) {
  const c = Math.min(chamfer, h / 2 - 1e-3, Math.min(rTop, rBot) * 0.5);
  const pts = [
    new THREE.Vector2(0, -h / 2),
    new THREE.Vector2(Math.max(1e-4, rBot - c), -h / 2),
    new THREE.Vector2(rBot, -h / 2 + c),
    new THREE.Vector2(rTop, h / 2 - c),
    new THREE.Vector2(Math.max(1e-4, rTop - c), h / 2),
    new THREE.Vector2(0, h / 2),
  ];
  const g = new THREE.LatheGeometry(pts, segs);
  return autoSmooth(g);
}
const alignTop = (g, y) => (g.computeBoundingBox(), g.translate(0, y - g.boundingBox.max.y, 0), g);
const alignBottom = (g, y) => (g.computeBoundingBox(), g.translate(0, y - g.boundingBox.min.y, 0), g);
const box = (w, h, d, r = 0.03) => (r > 0
  ? new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) / 2))
  : new THREE.BoxGeometry(w, h, d));
function mesh(g, m, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = o.receiveShadow = true;
  return o;
}

/** A hub in one piece: a closed profile revolved, so the outer wall, the bore,
    both end annuli and four chamfers are one surface. Three separate pieces
    (wall + bore tube + two rings) met at true 90° rims, which are the sharpest
    edges on the whole model and the ones the eye finds first through the
    window. The profile is traced anticlockwise in (r, y) so the normals come
    out of the material — which is also why the bore no longer needs flipping:
    it is the inside of a solid, facing the spindle. */
function hubShell(r, bore, h, chamfer = 0.045, segs = 48) {
  const c = Math.min(chamfer, h / 2 - 1e-3, (r - bore) / 3);
  const v = (a, b) => new THREE.Vector2(a, b);
  const profile = [
    v(bore, -h / 2 + c), v(bore + c, -h / 2), v(r - c, -h / 2), v(r, -h / 2 + c),
    v(r, h / 2 - c), v(r - c, h / 2), v(bore + c, h / 2), v(bore, h / 2 - c),
    v(bore, -h / 2 + c),                       // closes the loop
  ];
  return autoSmooth(new THREE.LatheGeometry(profile, segs));
}

/* ---- draw call reduction -------------------------------------------------
   three pays per-object CPU (frustum test, material + uniform upload) on every
   pass, and this scene renders twice per frame. Static parts sharing a material
   get baked into one mesh; a failed merge falls back to the original meshes
   rather than breaking the model. */
function bake(meshes, material, castShadow = true) {
  const geos = [];
  for (const m of meshes) {
    m.updateMatrix();
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrix);
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!merged) return meshes;
  const out = new THREE.Mesh(merged, material);
  out.castShadow = castShadow;
  out.receiveShadow = true;
  return out;
}
function bakeInto(parent, meshes, castShadow = true) {
  const byMat = new Map();
  for (const m of meshes) {
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material).push(m);
  }
  for (const [mat, list] of byMat) {
    if (list.length === 1) parent.add(list[0]);
    else {
      const baked = bake(list, mat, castShadow);
      if (Array.isArray(baked)) list.forEach((m) => parent.add(m));
      else parent.add(baked);
    }
  }
}

/* ============================== materials =============================== */
/** One face's printed label, tied to the plate's raw shape UVs — which run
    -4.76..4.76 by -2.93..2.93 rather than 0..1, hence the repeat. Called again
    whenever the user puts a different track in (see `setLabel`). */
function makeLabelMap(face, opts) {
  const t = TX.labelTexture(face, opts);
  t.repeat.set(1 / 9.52, face === 'A' ? -1 / 5.86 : 1 / 5.86);
  t.offset.set(0.5, 0.5);
  return t;
}

export function createMaterials(labelOpts = {}) {
  const micro = TX.normalTex(256, { octaves: 5, strength: 1.7, seed: 11 });
  const micro2 = TX.normalTex(256, { octaves: 5, strength: 2.6, seed: 23 });
  const rgh = TX.roughTex(512, { lo: 0.40, hi: 0.72, seed: 5 });
  const paperN = TX.normalTex(512, { octaves: 6, strength: 2.6, seed: 31 });
  const brush = TX.brushedTexture(512, [152, 154, 160]);
  // tape grain is fine and runs lengthwise. One repeat, one tile per `D.tile` of
  // tape — the ribbon's own u is already counted in those units (see Ribbon), so
  // the coating is slid by a single number on `offset.x` rather than by rebuilding
  // the ribbon's uvs every frame.
  const tapeM = TX.tapeMaps(512, RIB_EDGE);
  for (const m of [tapeM.map, tapeM.roughnessMap, tapeM.normalMap]) {
    m.wrapS = m.wrapT = THREE.RepeatWrapping;
    m.repeat.set(1, 1);
    m.anisotropy = 16;
    m.needsUpdate = true;
  }
  // and the clear leader, on a channel of its own. Its u spans the whole strip —
  // the magnetic tape plus a leader at each end — so the share the band takes is
  // `lead` of the tape over the strip the tape and its two leaders make.
  const leadA = TX.leaderAlpha(2048, 128, { lead: D.lead / (1 + 2 * D.lead), cut: RIB_EDGE });
  leadA.channel = 1;

  // transparent, and depth-writing still: the oxide is opaque and wants the
  // depth it always had (the AO and the toon ink both read the depth buffer,
  // and an outline that stops at the tape is worse than a leader that cannot
  // quite be seen through). forceSinglePass because the ribbon is a closed
  // prism — there is no back face to draw, and three would build a second
  // program for it every frame.
  const tape = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: tapeM.map,
    alphaMap: leadA, transparent: true, forceSinglePass: true,
    roughness: 1.0, roughnessMap: tapeM.roughnessMap,
    metalness: 0.08,
    normalMap: tapeM.normalMap, normalScale: new THREE.Vector2(0.55, 0.55),
    // the coating is drawn on lengthwise, so the highlight streaks along the
    // tape rather than sitting as a round blob
    anisotropy: 0.55, anisotropyRotation: 0,
    sheen: 0.45, sheenColor: new THREE.Color(0x9c6636), sheenRoughness: 0.45,
    iridescence: 0.12, iridescenceIOR: 1.28, iridescenceThicknessRange: [120, 420],
    clearcoat: 0.18, clearcoatRoughness: 0.42,
    envMapIntensity: 0.9, side: THREE.DoubleSide,
  });
  /* The outside of a pack *is* the tape — the outermost layer, seen from the
     outside — so it is not given a material of its own that resembles the tape's,
     it is given the tape's: cloned, so the same maps, the same anisotropy (round
     the circumference, which is the tape's length) and the same sheen follow any
     change to the tape itself. What it drops is what only belongs to a stretch of
     tape: the leader's alpha and two-sidedness. The wall is a winding, and its
     coating is fixed to the reel rather than sliding along it (see alignPack). */
  const packSide = tape.clone();
  packSide.alphaMap = null;
  packSide.transparent = false;
  packSide.forceSinglePass = false;
  packSide.side = THREE.FrontSide;
  /* ...with copies of the tape's three maps rather than the maps themselves. The
     ribbon's coating slides along it — `alignTape` writes `offset.x` on those
     three every frame — and the outside of a pack does not slide, it turns with
     the reel. Copying them is what lets the wall wear exactly the tape's grain
     without inheriting the tape's travel. */
  for (const k of ['map', 'roughnessMap', 'normalMap']) packSide[k] = tape[k].clone();

  const labelMap = (face) => makeLabelMap(face, labelOpts);

  return {
    micro, micro2, rgh, paperN, brush,
    shell: new THREE.MeshPhysicalMaterial({
      color: 0x14171b, metalness: 0, roughness: 0.34,
      roughnessMap: rgh, clearcoat: 0.9, clearcoatRoughness: 0.16,
      normalMap: micro, normalScale: new THREE.Vector2(0.20, 0.20),
      envMapIntensity: 1.15, sheen: 0.18, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x6b7a8c),
    }),
    shellMatt: new THREE.MeshPhysicalMaterial({
      color: 0x191d22, metalness: 0, roughness: 0.66, roughnessMap: rgh,
      clearcoat: 0.22, clearcoatRoughness: 0.65,
      normalMap: micro2, normalScale: new THREE.Vector2(0.34, 0.34), envMapIntensity: 0.95,
    }),
    inner: new THREE.MeshStandardMaterial({
      color: 0x0c0e10, metalness: 0.05, roughness: 0.82,
      normalMap: micro2, normalScale: new THREE.Vector2(0.5, 0.5), envMapIntensity: 0.5,
    }),
    // Smoked window. This used to be a real transmission material, which costs
    // an entire extra scene render per frame (three renders all opaque objects
    // into a separate target so the glass can refract them). At 0.055 thickness
    // the refraction was invisible anyway, so a transparent clearcoat surface
    // gets the same look for none of the cost.
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x39414a, metalness: 0, roughness: 0.06,
      transparent: true, opacity: 0.30, depthWrite: false,
      clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6,
      specularIntensity: 1,
    }),
    hub: new THREE.MeshPhysicalMaterial({
      color: 0xded7c9, metalness: 0, roughness: 0.42,
      clearcoat: 0.28, clearcoatRoughness: 0.45, sheen: 0.2, envMapIntensity: 0.85,
    }),
    metal: new THREE.MeshPhysicalMaterial({
      color: 0xb8bcc4, metalness: 1, roughness: 0.30,
      roughnessMap: brush, anisotropy: 0.55, envMapIntensity: 1.35,
    }),
    metalDark: new THREE.MeshPhysicalMaterial({
      color: 0x5a5f65, metalness: 1, roughness: 0.62, roughnessMap: brush, envMapIntensity: 0.85,
    }),
    rubber: new THREE.MeshStandardMaterial({
      color: 0x15171a, metalness: 0, roughness: 0.93,
      normalMap: micro2, normalScale: new THREE.Vector2(0.7, 0.7), envMapIntensity: 0.5,
    }),
    // physical, not standard: sheen only exists on MeshPhysicalMaterial, and on
    // a Standard one three drops all three properties with a console warning —
    // the felt pad was rendering as flat black rubber
    felt: new THREE.MeshPhysicalMaterial({
      color: 0x2a2521, metalness: 0, roughness: 0.97,
      normalMap: micro2, normalScale: new THREE.Vector2(1.3, 1.3), envMapIntensity: 0.35,
      sheen: 0.5, sheenColor: new THREE.Color(0x6b5a48), sheenRoughness: 0.9,
    }),
    tape,
    packSide,
    /* The pack's top face: the stacked cut edges of every layer on it, so it is
       lit like the cut edges are — the tape's metalness, the tape's sheen, the
       gloss the cut band has in `tapeMaps` (0.20–0.34 → 0.28 here). Only the
       *rings* in it are the pack's own, and their colour is that same band's:
       see tapeEdgeTexture. Two of the tape's properties are deliberately not
       carried over: anisotropy, because a disc's grain runs round it and an
       anisotropy rotation is one direction for a whole mesh; and iridescence,
       which models the coating's thin film — and this disc is the PET between
       the layers, not the coating. */
    packFace: new THREE.MeshPhysicalMaterial({
      map: TX.tapeEdgeTexture(1024, BORE_V), metalness: 0.08, roughness: 0.28,
      sheen: 0.45, sheenColor: new THREE.Color(0x9c6636), sheenRoughness: 0.45,
      clearcoat: 0.18, clearcoatRoughness: 0.42, envMapIntensity: 0.9,
    }),
    labelA: new THREE.MeshPhysicalMaterial({
      map: labelMap('A'), metalness: 0, roughness: 0.84,
      normalMap: paperN, normalScale: new THREE.Vector2(0.22, 0.22),
      sheen: 0.12, sheenColor: new THREE.Color(0xf6ecd8), sheenRoughness: 0.85,
      envMapIntensity: 0.6, clearcoat: 0.10, clearcoatRoughness: 0.65,
    }),
    labelB: new THREE.MeshPhysicalMaterial({
      map: labelMap('B'), metalness: 0, roughness: 0.84,
      normalMap: paperN, normalScale: new THREE.Vector2(0.22, 0.22),
      sheen: 0.12, sheenColor: new THREE.Color(0xf6ecd8), sheenRoughness: 0.85,
      envMapIntensity: 0.6, clearcoat: 0.10, clearcoatRoughness: 0.65,
    }),
  };
}

/* ============================== tape ribbon ============================= */
/* One ring = 8 vertices, two per cross-section face, so each face gets its own
   UV band. The bands are cut to the cross-section's actual perimeter, which
   keeps texel density even around the tape and lets the oxide face, the back
   coating and the cut edges carry different material.

   And the cross-section is 3.81 mm by **one drawn layer** — `DIM.tTape`, the same
   0.3 mm the transport unwinds per turn and the same 0.3 mm one ring of the
   pack's top face is (see `alignPack`). That is the invariant this model is now
   built on: a layer of tape is one thickness everywhere it can be seen, so the
   ribbon that leaves the pack sits flush with the windings it came out of. The
   medium itself is 12 µm; the model is 25× that, which is what makes a 5 minute
   song worth watching a pack unwind for. Both the geometry's v bands and the
   texture's are derived from the one number below, so they cannot drift apart. */
const RIB_EDGE = D.tTape / (2 * (D.tapeW + D.tTape));   // one cut edge, as a share of the perimeter
/* How much of a pack's top face the hub stands on, as a share of the texture
   that face is drawn with. It is a *constant* even though the packs change size,
   because `alignPack` scales that disc until one layer is one ring: whatever is
   inside the hub's radius is always the same length of tape, so it always lands
   on the same part of the texture. Nothing is drawn there — the tape winds round
   the hub rather than through it, and the spindle hole should show the dark of
   the shell, not layers. */
const BORE_V = (D.hub.r * 2 * TX.EDGE_PITCH) / D.tTape;
const RIB_CORNERS = [[1, 1], [-1, 1], [-1, -1], [1, -1]];   // (normal side, up)
const RIB_MAP = [0, 1, 1, 2, 2, 3, 3, 0];
/* the same table split into its two columns, so the ribbon's inner loop — eight
   corners of n points, rebuilt whenever the pack radius moves a visible amount,
   which during playback is most frames — reads two numbers instead of pulling a
   pair out of a pair out of an array */
const RIB_SN = RIB_MAP.map((i) => RIB_CORNERS[i][0]);
const RIB_SY = RIB_MAP.map((i) => RIB_CORNERS[i][1]);
const RIB_V = [0, RIB_EDGE, RIB_EDGE, 0.5, 0.5, 0.5 + RIB_EDGE, 0.5 + RIB_EDGE, 1.0];

/* The ribbon carries two uv channels, and the difference between them is the
   whole reason the tape can move and still end where it ends.

     uv  (channel 0) is arc length along the *path*, in units of `D.tile`, so the
         coating texture is laid on at an even density the whole way round — the
         old i / (n - 1) ran the sampler off the sample count, and the samples are
         not evenly spaced (a 14-step run across the head is 3.5 cm, the same 14
         steps round a 1.7 mm guide pin is half a millimetre, so the grain was
         being stretched 60× between the two). It is written once per rebuild and
         then *slid* by one texture offset.

     uv1 (channel 1) is the tape's own material coordinate, in cm, measured from
         the head: material at the path's start has already run past the head by
         the free span's length, and material at the end of the path is about to.
         The leader alpha lives on this channel, because only a coordinate that
         knows where the *tape's* ends are can put a band at 1% and 99% of it —
         anything tiled to the path would repeat that band every 20 cm.

   Both channels run backwards (the head's arc minus the sample's), which is what
   the tape does: the material entering the free span is the newer material, so a
   mark on the tape travels toward the take-up as the position climbs. */
class Ribbon {
  constructor(n, hw, ht, headI) {
    this.n = n; this.hw = hw; this.ht = ht;
    this.headI = headI;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 8 * 3);
    const nrm = new Float32Array(n * 8 * 3);
    const uv = new Float32Array(n * 8 * 2);
    const uv1 = new Float32Array(n * 8 * 2);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 8; j++) {
        uv[(i * 8 + j) * 2 + 1] = RIB_V[j];
        uv1[(i * 8 + j) * 2 + 1] = RIB_V[j];
      }
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      for (let f = 0; f < 4; f++) {
        const a = i * 8 + f * 2, b = a + 1;
        const c = (i + 1) * 8 + f * 2 + 1, d = c - 1;
        idx.push(a, b, c, a, c, d);
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 14);
    this.geo = g;
    this.nrm = nrm;
    this.arc = new Float32Array(n);      // arc length at each sample, cm
    this.headArc = 0;                    // arc length at the head
  }
  setPath(pts) {
    const { n, hw, ht, arc } = this;
    const pos = this.geo.attributes.position.array;
    const nrm = this.nrm;
    let acc = 0, px0 = pts[0], pz0 = pts[1];
    for (let i = 0; i < n; i++) {
      const px = pts[i * 2], pz = pts[i * 2 + 1];
      acc += Math.hypot(px - px0, pz - pz0);
      px0 = px; pz0 = pz;
      arc[i] = acc;
      const ai = Math.max(0, i - 1) * 2, bi = Math.min(n - 1, i + 1) * 2;
      let tx = pts[bi] - pts[ai], tz = pts[bi + 1] - pts[ai + 1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      const nx = -tz, nz = tx;
      const o = i * 24;
      for (let j = 0; j < 8; j++) {
        const sn = RIB_SN[j], sy = RIB_SY[j];
        // width (3.81 mm) always runs along Y — the shell's thickness — so the
        // coated face looks out of the head opening; only the 12 µm thickness
        // is measured along the in-plane normal
        pos[o + j * 3] = px + nx * ht * sn;
        pos[o + j * 3 + 1] = hw * sy;
        pos[o + j * 3 + 2] = pz + nz * ht * sn;
        // the four faces are flat planes meeting at hard edges, so their
        // normals are known exactly — no per-frame triangle pass needed
        const f = j >> 1;
        nrm[o + j * 3] = f === 1 ? -nx : f === 3 ? nx : 0;
        nrm[o + j * 3 + 1] = f === 0 ? 1 : f === 2 ? -1 : 0;
        nrm[o + j * 3 + 2] = f === 1 ? -nz : f === 3 ? nz : 0;
      }
    }
    this.headArc = arc[this.headI];
    const uv = this.geo.attributes.uv.array;
    const uv1 = this.geo.attributes.uv1.array;
    for (let i = 0; i < n; i++) {
      const back = this.headArc - arc[i];           // cm behind the head, negative ahead
      const u = back / D.tile;
      for (let j = 0; j < 8; j++) {
        uv[(i * 8 + j) * 2] = u;
        uv1[(i * 8 + j) * 2] = back;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.attributes.uv1.needsUpdate = true;
  }
}

/* ============================== build =================================== */
export function createCassette(labelOpts = {}) {
  const M = createMaterials(labelOpts);
  const root = new THREE.Group();
  const assembly = new THREE.Group();
  root.add(assembly);

  const gTop = new THREE.Group();
  const gBot = new THREE.Group();
  const gMid = new THREE.Group();
  const gTape = new THREE.Group();
  assembly.add(gMid, gTop, gBot, gTape);

  const yTopFace = D.hd, yBotFace = -D.hd;
  const yIn = D.hd - D.PT;                 // inner face of the plates
  const wallH = yIn * 2;
  const winW = D.win.hw * 2, winH = D.win.hz1 - D.win.hz0;
  const winCz = (D.win.hz0 + D.win.hz1) / 2;

  /* ---------------- top plate / glass / label ---------------- */
  const topShape = win(rrect(D.W, D.H, D.rOut), winW, winH, D.win.r, 0, winCz);
  const topPlate = mesh(alignTop(extrudeY(topShape, D.PT - D.BV * 2), yTopFace), M.shell);
  gTop.add(topPlate);

  const glass = mesh(alignTop(extrudeY(rrect(winW + 0.02, winH + 0.02, D.win.r + 0.01, 0, winCz), 0.03, 0.01), yTopFace - 0.010), M.glass);
  glass.castShadow = glass.receiveShadow = false;
  // in front of the ghosted parts (main.js GHOST_ORDER = 4): the window is
  // transparent, so it has to be blended last of everything inside the shell
  glass.renderOrder = 10;
  gTop.add(glass);

  const labA = mesh(alignTop(extrudeY(win(rrect(D.W - D.labelInset * 2, D.H - D.labelInset * 2, 0.24), winW, winH, D.win.r, 0, winCz), 0.008, 0.005), yTopFace + 0.008), M.labelA);
  gTop.add(labA);

  /* ---------------- bottom plate / label / screws ---------------- */
  const botShape = rrect(D.W, D.H, D.rOut);
  for (const sx of [-1, 1]) botShape.holes.push(rrect(D.hub.r * 2 + 0.10, D.hub.r * 2 + 0.10, D.hub.r + 0.05, sx * D.hub.x, D.hub.z));
  for (const [px, pz] of PODS) botShape.holes.push(rrect(0.37, 0.37, 0.18, px, pz));
  const botPlate = mesh(alignBottom(extrudeY(botShape, D.PT - D.BV * 2), yBotFace), M.shell);
  gBot.add(botPlate);

  const labBShape = rrect(D.W - D.labelInset * 2, D.H - D.labelInset * 2, 0.24);
  for (const [px, pz] of PODS) labBShape.holes.push(rrect(0.40, 0.40, 0.20, px, pz));
  for (const sx of [-1, 1]) labBShape.holes.push(rrect(D.hub.r * 2 + 0.20, D.hub.r * 2 + 0.20, D.hub.r + 0.10, sx * D.hub.x, D.hub.z));
  const labB = mesh(alignBottom(extrudeY(labBShape, 0.008, 0.005), yBotFace - 0.008), M.labelB);
  gBot.add(labB);

  /* ---------------- the write head ----------------
     Putting a different track in does not swap the label, it *rewrites* it (see
     main.js updateLabelSwap): the incoming print arrives on a copy of the same
     plate a few microns above it and is let in through a window that crosses the
     card, and the base's own map is only handed over once that window has left
     the far edge. Both layers carry the same paper otherwise — same grain, same
     sheen, same roughness map — or the rewrite would change more than the
     printing.

     The window is an alphaMap slid past its clamp, so this costs two uniform
     writes a frame and no texture re-upload at all; the card's own U axis runs
     along the writing (canvas V is the card's depth), which is why the sweep
     reads as a line of print being laid down rather than as a wipe across it.

     The head's light is a band, not a line, and it keeps its own clock. It
     tracks the window's soft edge across the card while the window is moving;
     the moment its leading edge reaches the far end of the label it stops there
     and dims out over HEAD_FADE, which it does *after* the sweep has settled
     (see stepHead) — a light that died on the same frame the print finished was
     a light being switched off mid-stroke. */
  const headLayers = [];
  const headX = -(D.W - D.labelInset * 2) / 2;       // the card's own left edge
  const headW = (D.W - D.labelInset * 2) / 2;        // and its right, from centre
  const HEAD_W = 0.78;                               // the light's own width
  /* Where its centre comes to rest: far enough right that its leading edge is on
     the card's right edge, and no further — the plastic past the label is not
     the head's business. */
  const HEAD_STOP_X = headW - HEAD_W / 2;
  /* And where it is *finished*, a little short of that: the light starts dying
     before it has stopped moving, so the deceleration is covered by the fade
     rather than reading as the light being switched off at the end of the line. */
  const HEAD_END_X = HEAD_STOP_X - 0.55;
  const HEAD_START_X = headX - HEAD_W / 2;
  /* A light that is meant to be seen going out has to be loud enough to be seen
     at all: on this page the label it crosses is pale and near-white in 影棚, and
     an additive band only adds — 0.17 across that paper is a change of about a
     tenth, so most of its fade happened below the threshold of noticing. It is
     additive and has bloom behind it, which is the only way to be brighter than
     the paper. */
  const HEAD_LIT = 0.30;
  const HEAD_FADE = 0.8;                             // seconds, end to gone
  const head = { x: HEAD_START_X, enter: 0, dying: false, fade: 0 };
  {
    const mk = (src, dy, streakY, up) => {
      const geo = src.geometry.clone();
      geo.translate(0, dy, 0);
      const mat = src.material.clone();
      mat.transparent = true;
      mat.depthWrite = false;
      mat.alphaMap = TX.sweepAlpha();
      mat.alphaMap.repeat.copy(src.material.map.repeat);
      mat.alphaMap.offset.copy(src.material.map.offset);
      const o = new THREE.Mesh(geo, mat);
      // receiveShadow has to match the plate it copies, not the glass: it is
      // standing in for that plate, and any difference in what lights it is a
      // difference the reveal will show
      o.castShadow = false;
      o.receiveShadow = true;
      o.renderOrder = 8;                 // over the plate it copies, under the glass
      o.visible = false;
      o.userData.noGhost = true;         // a transition device, not a part
      const st = new THREE.Mesh(
        new THREE.PlaneGeometry(HEAD_W, D.H - D.labelInset * 2 - 0.30),
        new THREE.MeshBasicMaterial({
          map: TX.headStreak(), transparent: true, opacity: 0, color: 0xffe9c8,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        })
      );
      st.rotation.x = up ? -Math.PI / 2 : Math.PI / 2;
      st.position.set(HEAD_START_X, streakY, 0);
      st.renderOrder = 9;
      st.visible = false;
      st.userData.noGhost = true;
      src.parent.add(o, st);
      headLayers.push({ o, mat, st });
    };
    // A: the print faces up, so the copy sits above it and the head above that
    mk(labA, 0.004, yTopFace + 0.014, true);
    mk(labB, -0.004, yBotFace - 0.014, false);
  }
  /** whatever the light is doing right now: lit by how far it has come onto the
      card, and taken down by its own fade once it has reached the end */
  function paintHead() {
    const op = HEAD_LIT * head.enter * (1 - smoothstep(0, 1, head.fade));
    /* It broadens as it dies as well as dimming. Two reasons: a light going out
       spreads before it goes, which is what the eye is looking for at the end of
       a stroke — and the brightness ramp alone is a poor signal on a pale label,
       where tone mapping eats most of it, so the tail needs a shape as well as a
       number. */
    const wide = 1 + head.fade * 0.8;
    for (const L of headLayers) {
      L.st.material.opacity = op;
      L.st.position.x = head.x;
      L.st.scale.x = wide;
    }
  }

  const screwd = new THREE.Group();
  const screwBits = [];
  for (const [px, pz] of PODS) {
    // the boss and the head are lathes so their rims are chamfered: the mould
    // ejects better that way, and a chamfer is what puts the highlight line
    // round the head that tells you it is a screw
    screwBits.push(mesh(latheCyl(0.235, 0.26, 0.92, 0.035, 28), M.shellMatt, px, -0.02, pz));
    screwBits.push(mesh(latheCyl(0.155, 0.155, 0.05, 0.014, 32), M.metal, px, yBotFace + 0.030, pz));
    const ring = mesh(new THREE.TorusGeometry(0.148, 0.020, 8, 26), M.metalDark, px, yBotFace + 0.050, pz);
    ring.rotation.x = Math.PI / 2;
    screwBits.push(ring);
    screwBits.push(mesh(box(0.21, 0.06, 0.038, 0.006), M.inner, px, yBotFace + 0.053, pz));
    screwBits.push(mesh(box(0.038, 0.06, 0.21, 0.006), M.inner, px, yBotFace + 0.053, pz));
  }
  bakeInto(screwd, screwBits, false);
  gBot.add(screwd);

  // moulded ribs + write protect tabs
  const ribBits = [];
  for (const rz of [-2.25, -1.40, 2.25]) ribBits.push(mesh(box(6.6, 0.10, 0.10, 0.03), M.inner, 0, -yIn + 0.07, rz));
  for (const sx of [-1, 1]) ribBits.push(mesh(box(0.12, 0.10, 4.2, 0.03), M.inner, sx * 4.5, -yIn + 0.07, 0));
  bakeInto(gBot, ribBits, false);

  /* ---------------- moulded frame ---------------- */
  const frontShape = rrect(D.W - D.wall * 2, wallH, 0.10);
  frontShape.holes.push(rrect(D.head * 2, 0.80, 0.06, 0, 0));
  for (const sx of [1, -1]) {
    const [a, b] = D.slot;
    frontShape.holes.push(rrect(b - a, 0.68, 0.08, sx * (a + b) / 2, 0));
  }
  const frontG = extrudeZ(frontShape, D.wall, 0.022);
  frontG.computeBoundingBox();
  frontG.translate(0, 0, D.hh - D.wall - frontG.boundingBox.min.z);
  const frameBits = [mesh(frontG, M.shellMatt)];
  // back edge, split around the two write-protect tabs
  const TAB = { x: 1.30, w: 0.60, z: -D.hh + 0.06 };
  const backSpans = [[-D.hw + D.wall, -TAB.x - TAB.w / 2], [-TAB.x + TAB.w / 2, TAB.x - TAB.w / 2], [TAB.x + TAB.w / 2, D.hw - D.wall]];
  for (const [a, b] of backSpans) {
    frameBits.push(mesh(box(b - a, wallH, D.wall, 0.05), M.shellMatt, (a + b) / 2, 0, -D.hh + D.wall / 2));
  }
  for (const sx of [-1, 1]) {
    gBot.add(mesh(box(TAB.w, wallH - 0.10, 0.18, 0.03), M.shellMatt, sx * TAB.x, 0.02, -D.hh + 0.15));
  }
  for (const sx of [1, -1]) frameBits.push(mesh(box(D.wall, wallH, (D.hh - D.wall) * 2 + 0.06, 0.05), M.shellMatt, sx * (D.hw - D.wall / 2), 0, 0));
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const a0 = sx > 0 ? (sz > 0 ? 0 : Math.PI * 1.5) : (sz > 0 ? Math.PI / 2 : Math.PI);
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.absarc(0, 0, D.rOut, a0, a0 + Math.PI / 2, false);
      s.lineTo(0, 0);
      const g = alignBottom(extrudeY(s, wallH, D.BV * 0.6), -yIn);
      g.translate(sx * (D.hw - D.rOut), 0, sz * (D.hh - D.rOut));
      frameBits.push(mesh(g, M.shellMatt));
    }
  }
  bakeInto(gMid, frameBits);

  /* ---------------- reels ---------------- */
  const reels = [];
  for (const sx of [-1, 1]) {
    const grp = new THREE.Group();
    grp.position.set(sx * D.hub.x, 0, D.hub.z);
    const spin = new THREE.Group();
    grp.add(spin);
    const r = D.hub.r, bore = r - 0.28;
    // one revolved solid: wall, bore, both annuli and their chamfers. It used to
    // be four pieces — an open wall, a flipped bore tube and two flat ring
    // meshes — which met at 90° rims and had to be culled into looking whole.
    const hubBits = [mesh(hubShell(r, bore, D.hub.h), M.hub)];
    // six spline teeth reaching inward into the spindle hole — this is what
    // makes the rotation readable from above
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const t = mesh(box(0.19, D.hub.h, 0.115, 0.018), M.hub, Math.cos(a) * 0.325, 0, Math.sin(a) * 0.325);
      t.rotation.y = -a; t.castShadow = false;
      hubBits.push(t);
    }
    bakeInto(spin, hubBits, false);
    const pack = new THREE.Group();
    // The pack's body is one layer smaller than the pack's radius, because the
    // outermost layer is the ribbon itself (see `fillPath`, and the pack's scale
    // in update), and the wall is a hair inside even that so nothing is ever
    // coplanar with the ribbon's own surface.
    const side = new THREE.Mesh(new THREE.CylinderGeometry(0.998, 0.998, D.tapeW, 72, 1, true), M.packSide);
    const fT = new THREE.Mesh(new THREE.CircleGeometry(1, 72), M.packFace);
    fT.rotation.x = -Math.PI / 2; fT.position.y = D.tapeW / 2;
    const fB = new THREE.Mesh(new THREE.CircleGeometry(1, 72), M.packFace);
    fB.rotation.x = Math.PI / 2; fB.position.y = -D.tapeW / 2;
    side.castShadow = fT.castShadow = fB.castShadow = false;
    pack.add(side, fT, fB);
    spin.add(pack);
    gTape.add(grp);
    // The wall wears the same coating texture as the ribbon, so its v has to be
    // the oxide face's band of it and nothing else: the other three bands are the
    // tape's back coat and the two cut edges, and none of those is the surface of
    // a pack. (v runs 0 at the bottom of the cylinder — the tape's edge — to 1 at
    // the top, so the band maps straight across.) Its u is counted in tiles round
    // the circumference, which `alignPack` does, because the circumference is not
    // the same length on the two reels.
    const wuv = side.geometry.attributes.uv.array;
    for (let k = 0; k < wuv.length; k += 2) {
      wuv[k + 1] = 0.5 + RIB_EDGE + wuv[k + 1] * (0.5 - RIB_EDGE);
    }
    reels.push({
      grp, spin, pack, side,
      faces: [fT, fB],
      wall0: wuv.filter((_, k) => k % 2 === 0),          // the wall's u, as modelled
      face0: Float32Array.from(fT.geometry.attributes.uv.array),   // and the disc's uv
    });
  }

  /* ---------------- tape path ----------------
     The path is the tape's *centre line*, and the tape lies **on** what it
     touches rather than through it: on a pack its inner face is at the pack's
     radius, so its centre line is half a thickness inside that (and the pack's
     own meshes are one whole thickness smaller — see the reel loop), and on a
     guide pin it is half a thickness outside the pin. Both offsets are the same
     `HT`, so a tangent between a pack and a guide stays a tangent to the tape. */
  const RG = D.guide.r;
  const HT = D.tTape / 2;
  const TURN = Math.PI * 2;
  const C = [{ x: -D.hub.x, z: D.hub.z }, { x: D.hub.x, z: D.hub.z }];
  const G = [{ x: -D.guide.x, z: D.guide.z }, { x: D.guide.x, z: D.guide.z }];
  /** outward tangent normal angle from a pack to its guide */
  function tangentAngle(c, r, g, side, rg = RG + HT) {
    const dx = g.x - c.x, dz = g.z - c.z, L = Math.hypot(dx, dz);
    const a = Math.atan2(dz, dx), da = Math.acos(clamp((r - rg) / L, -1, 1));
    const c1 = Math.cos(a - da);
    return (side < 0 ? c1 < 0 : c1 > 0) ? a - da : a + da;
  }
  /* A pack's arc is a *whole* turn, not a token wrap: the outer layer of a wound
     pack is one circumference of tape, so drawing one circumference of ribbon on
     it is not an approximation — it is that layer. It also means the tape
     arriving from the guides and the tape lying on the pack are the same strip,
     the same material and the same texture, so there is nothing to seam: the
     coating runs off the free span and round the pack and back to where it
     leaves. (It used to be 1.25 rad, and the pack under it was a cylinder with a
     material of its own, which is exactly where the join showed.) 128 steps is
     under a degree and a half per step at the largest pack: smooth enough that
     no facet reads, cheap enough to rebuild while the radius moves. */
  const SEG = { p: 128, l: 10, g: 14, m: 14 };
  const SAMPLES = SEG.p * 2 + SEG.l * 2 + SEG.g * 2 + SEG.m + 1;
  // flat [x,z,x,z,…]: rebuilding this every frame used to allocate 111 small
  // arrays, which is pure GC pressure at 165 fps
  const pts = new Float32Array(SAMPLES * 2);
  function fillPath(rL, rR) {
    const a1 = tangentAngle(C[0], rL - HT, G[0], -1);
    const a2 = tangentAngle(C[1], rR - HT, G[1], 1);
    let k = 0;
    const arc = (cx, cz, r, from, to, steps, skip) => {
      for (let i = skip ? 1 : 0; i <= steps; i++) {
        const a = from + (to - from) * (i / steps);
        pts[k++] = cx + Math.cos(a) * r;
        pts[k++] = cz + Math.sin(a) * r;
      }
    };
    const line = (x0, z0, x1, z1, steps) => {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        pts[k++] = x0 + (x1 - x0) * t;
        pts[k++] = z0 + (z1 - z0) * t;
      }
    };
    const FRONT = Math.PI / 2;   // +z tangent of a guide
    const gR = RG + HT;          // where the tape's centre line wraps a guide
    arc(C[0].x, C[0].z, rL - HT, a1 + TURN, a1, SEG.p, false);                                // the whole outer layer of the left pack
    line(C[0].x + Math.cos(a1) * (rL - HT), C[0].z + Math.sin(a1) * (rL - HT),
      G[0].x + Math.cos(a1) * gR, G[0].z + Math.sin(a1) * gR, SEG.l);                         // -> left guide
    arc(G[0].x, G[0].z, gR, a1, FRONT, SEG.g, true);                                          // wrap left guide
    line(G[0].x, G[0].z + gR, G[1].x, G[1].z + gR, SEG.m);                                    // across the head
    arc(G[1].x, G[1].z, gR, FRONT, a2, SEG.g, true);                                          // wrap right guide
    line(G[1].x + Math.cos(a2) * gR, G[1].z + Math.sin(a2) * gR,
      C[1].x + Math.cos(a2) * (rR - HT), C[1].z + Math.sin(a2) * (rR - HT), SEG.l);           // -> right pack
    arc(C[1].x, C[1].z, rR - HT, a2, a2 - TURN, SEG.p, true);                                 // the whole outer layer of the right pack
  }

  /* the sample standing in front of the head: the middle of the run that crosses
     it. It is where the tape's own coordinate is measured from, so it has to be
     the run the head reads and not, say, the first sample of the loop. */
  const HEAD_I = SEG.p + SEG.l + SEG.g + SEG.m / 2;
  // half the thickness: the ribbon is one drawn layer thick, which is the same
  // 0.3 mm a turn of the reel adds to a pack's radius (see RIB_EDGE)
  const ribbon = new Ribbon(SAMPLES, D.tapeW / 2, D.tTape / 2, HEAD_I);
  const tapeMesh = new THREE.Mesh(ribbon.geo, M.tape);
  tapeMesh.castShadow = false;
  gTape.add(tapeMesh);

  /* ---------------- head assembly + pinch rollers ---------------- */
  for (const sx of [1, -1]) {
    gMid.add(mesh(latheCyl(RG, RG, 0.92, 0.03, 28), M.metal, sx * D.guide.x, 0, D.guide.z));
    gMid.add(mesh(latheCyl(RG + 0.045, RG + 0.045, 0.06, 0.018, 28), M.metalDark, sx * D.guide.x, 0.40, D.guide.z));
    gMid.add(mesh(latheCyl(0.40, 0.40, 0.60, 0.05, 32), M.rubber, sx * (D.slot[0] + D.slot[1]) / 2, -0.02, D.guide.z - 0.06));
  }
  gMid.add(mesh(box(1.05, 0.58, 0.16, 0.05), M.felt, 0, 0, D.guide.z - 0.14));
  const spring = mesh(box(1.30, 0.70, 0.035, 0.02), M.metalDark, 0, 0, D.guide.z - 0.28);
  spring.rotation.x = 0.20;
  gMid.add(spring);
  gMid.add(mesh(box(2.42, 0.86, 0.035, 0.02), M.metalDark, 0, 0, D.guide.z - 0.40));

  /* ---------------- transport state ---------------- */
  const A_TOTAL = Math.PI * (D.rMax ** 2 - D.rHub ** 2) * 2;
  const radius = (a) => Math.sqrt(Math.max(a, 0) / Math.PI + D.rHub ** 2);
  /* The tape's own length in the units the transport counts in (the layer
     thickness is the model's, not the medium's — see DIM.tTape), and the clear
     leader at each end of it. A real leader is 15 cm against 194 m of tape; here
     it is 1% of the tape, which at the drawn speed is three seconds of clear PET
     running past the head — long enough to be the thing you notice at the end of
     a side, which is exactly what it is for. */
  const TAPE_LEN = A_TOTAL / D.tTape;          // cm of tape, drawn
  const LEAD = TAPE_LEN * D.lead;              // cm of leader at each end
  const STRIP = TAPE_LEN + LEAD * 2;
  M.tape.alphaMap.repeat.x = 1 / STRIP;        // uv1 is in cm (see Ribbon)
  /* A full rewind always takes this long. A deck spools a side back in about a
     fortieth of the time it took to play it: this side plays in 5:17, so eight
     seconds and a half. At the 4.2 s this used to be, the rim was turning ten
     times a second at the start of the spool-back and fifty at the end of it —
     a blur, which is not what a rewind looks like. */
  const REW_SECONDS = 8.5;
  const st = {
    areaL: A_TOTAL, rL: 0, rR: 0, playing: false, dir: -1,
    explode: 0, explodeTarget: 0, flip: 0, flipTarget: 0,
    time: 0, duration: A_TOTAL / (D.tTape * D.v), driven: false,
  };
  st.rL = radius(st.areaL); st.rR = radius(A_TOTAL - st.areaL);
  fillPath(st.rL, st.rR);
  ribbon.setPath(pts);

  /** Where the coating sits on the tape, and where the leader falls on it. Both
      are one offset each: the ribbon's uv channels are arc length and the tape's
      own length (see Ribbon), so a frame of running tape costs four numbers and
      no upload, and the leader lands at either end of the *tape* because that is
      what its coordinate is measured in — not at either end of the path, which is
      where a band drawn into the tiled texture would repeat itself every 20 cm. */
  function alignTape() {
    const s0 = (A_TOTAL - st.areaL) / D.tTape;      // cm that have run past the head
    const off = (s0 / D.tile) % 1;
    M.tape.map.offset.x = off;
    M.tape.roughnessMap.offset.x = off;
    M.tape.normalMap.offset.x = off;
    M.tape.alphaMap.offset.x = (LEAD + s0) / STRIP;
  }
  alignTape();

  /** The packs, re-parameterized from the radius they are holding.
   *
      One ring of a pack's top face is one layer of tape — the same `DIM.tTape` the
      transport unwinds per turn, and the same thickness the ribbon is — so the
      layer texture is scaled about the disc's centre by however many layers this
      pack has on it: a full pack shows ninety-odd rings, a nearly empty one shows
      two, and the pitch is 0.3 mm either way. The wall's u is the circumference
      counted in `D.tile` tiles, a whole number of them so the seam still wraps.
      Both are writes into geometry that already exists, both are gated on the
      radius having moved enough to show (it drifts 3.5e-5 a frame at 60 fps), and
      a whole-tile jump is invisible because the pattern wraps — which is why the
      wall's grain can be fixed to the reel and only the ribbon slides. */
  const lastPack = [-1, -1];
  function alignPack(i) {
    const r = i ? st.rR : st.rL;
    if (Math.abs(r - lastPack[i]) < 2e-3) return;
    lastPack[i] = r;
    // the discs are the layers *under* the ribbon, so they are measured from the
    // pack's body radius, not from the pack's
    const body = r - D.tTape;
    const s = (2 * body * TX.EDGE_PITCH) / D.tTape;
    const src = reels[i].face0;
    for (const disc of reels[i].faces) {
      const uv = disc.geometry.attributes.uv;
      for (let k = 0; k < uv.array.length; k++) uv.array[k] = 0.5 + (src[k] - 0.5) * s;
      uv.needsUpdate = true;
    }
    const wall = reels[i].side.geometry.attributes.uv;
    const w0 = reels[i].wall0;
    const tiles = Math.max(2, Math.round((Math.PI * 2 * body) / D.tile));
    for (let k = 0; k < w0.length; k++) wall.array[k * 2] = w0[k] * tiles;
    wall.needsUpdate = true;
  }
  alignPack(0); alignPack(1);

  /* ---------------- analysis anchors ---------------- */
  const anchor = (parent, x, y, z) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };
  const anchors = {
    shell: anchor(topPlate, 4.30, 0.62, -2.15),
    glass: anchor(glass, 1.35, 0.60, 1.05),
    tape: anchor(tapeMesh, 0.05, 0.06, D.guide.z),
    hub: anchor(reels[0].grp, 0.30, 0.45, 0.20),
    pack: anchor(reels[1].grp, 0.95, 0.19, 0.35),
    screw: anchor(screwd, D.podX, yBotFace - 0.02, -D.podZ),
  };

  /* ---------------- explode ---------------- */
  const EXPLODE = [[labA, 3.70], [glass, 3.05], [topPlate, 2.25], [gTape, -1.10], [botPlate, -2.25], [labB, -3.70], [screwd, -2.25]];
  const baseY = new Map(EXPLODE.map(([o]) => [o, o.position.y]));

  /** drive the tape from outside (e.g. an <audio> element's currentTime) */
  function setProgress(frac) {
    st.areaL = clamp(A_TOTAL * (1 - clamp(frac, 0, 1)), 0, A_TOTAL);
    st.driven = true;
  }

  let lastR = -1;
  let spinArea = st.areaL;
  /** the hub angle is an accumulator nothing ever reads back, so folding it into
      one turn is invisible. Left to climb it passes ~1e5 rad in a long session,
      where float32 spacing is 0.01 rad and the spline teeth start to judder. */
  const foldAngle = (a) => a % (Math.PI * 2);
  function update(dt) {
    // ---- transport
    if (st.playing && !st.driven) {
      // internal simulation: the whole tape lasts st.duration seconds
      if (st.dir < 0) {
        st.areaL = Math.max(0, st.areaL - (A_TOTAL / Math.max(st.duration, 1)) * dt);
        if (st.areaL <= 0) { st.areaL = 0; st.dir = 1; }
      } else {
        st.areaL = Math.min(A_TOTAL, st.areaL + (A_TOTAL / REW_SECONDS) * dt);
        if (st.areaL >= A_TOTAL) { st.areaL = A_TOTAL; st.dir = -1; }
      }
    }
    st.rL = radius(st.areaL); st.rR = radius(A_TOTAL - st.areaL);
    st.time = ((A_TOTAL - st.areaL) / A_TOTAL) * st.duration;
    // the coating slides with the same position the reels are turning by, so the
    // two can never disagree about which way the tape is going
    alignTape();

    // reels follow whatever moved the tape: ω = v / r,  v = -dA/dt / layer.
    // measured against the *previous frame*, not against the top of this call,
    // because setProgress() (audio clock) writes areaL before update() runs
    const dA = (st.areaL - spinArea) / Math.max(dt, 1e-4);
    spinArea = st.areaL;
    if (Math.abs(dA) > 1e-9) {
      const vTape = -dA / D.tTape;
      reels[0].spin.rotation.y = foldAngle(reels[0].spin.rotation.y + (vTape / Math.max(st.rL, 0.25)) * dt);
      reels[1].spin.rotation.y = foldAngle(reels[1].spin.rotation.y + (vTape / Math.max(st.rR, 0.25)) * dt);
    }
    // the pack's *body* is one layer in from the pack's radius: the ribbon is
    // drawing the outermost layer, and it has to have somewhere to sit
    const bl = st.rL - D.tTape, br = st.rR - D.tTape;
    reels[0].pack.scale.set(bl, 1, bl);
    reels[1].pack.scale.set(br, 1, br);
    alignPack(0); alignPack(1);
    // the pack radius drifts ~3.5e-5 units per frame at 60 fps — rebuilding the
    // ribbon every frame bought nothing visible, so gate it on 1.5e-3
    if (lastR < 0 || Math.abs(st.rL - lastR) > 1.5e-3 || Math.abs(st.rR - lastR) > 1.5e-3) {
      fillPath(st.rL, st.rR);
      ribbon.setPath(pts);
      lastR = st.rL;
    }
    // ---- explode / flip
    st.explode = damp(st.explode, st.explodeTarget, 3.4, dt);
    st.flip = damp(st.flip, st.flipTarget, 4.2, dt);
    const e = st.explode;
    for (const [o, y] of EXPLODE) o.position.y = baseY.get(o) + y * e;
    assembly.rotation.x = -Math.PI * st.flip;
    // flipping about X sweeps a radius of ~3.25 (half width + half thickness),
    // far below the floor plane — so the shell arcs up out of the way first,
    // the way you would lift it off the table to turn it over
    assembly.position.y = Math.sin(Math.PI * st.flip) * 2.75;
    return st;
  }

  return {
    root, assembly, materials: M, anchors, st, update, setProgress,
    A_TOTAL,
    /* The write head's own materials. They are copies of the label materials and
       are *not* part of `materials`, which is what the probe and the room's IBL
       walk — so main.js has to hand them the same envMap and the same
       envMapIntensity the plates get, or the print they reveal is lit by a
       different room than the plate under it (see bindProbe). */
    headMaterials: headLayers.map((L) => L.mat),
    setExplode: (on) => { st.explodeTarget = on ? 1 : 0; },
    setFlip: (on) => { st.flipTarget = on ? 1 : 0; },

    /* ---- the write head, driven from outside ---------------------------
       `setLabel` draws a new print and parks it off the leading edge,
       `sweepLabel` walks the window across the card (0 → 1), and `commitLabel`
       hands the print over to the plate itself. Nothing here animates on its
       own — the caller owns the clock, so a sweep can be interrupted, skipped
       or run instantly without this needing to know. */
    setLabel(opts) {
      const neu = [makeLabelMap('A', opts), makeLabelMap('B', opts)];
      const old = [M.labelA.map, M.labelB.map];
      head.x = HEAD_START_X;              // the light comes back to the near edge
      head.enter = 0;
      head.dying = false;
      head.fade = 0;
      for (let i = 0; i < 2; i++) {
        headLayers[i].mat.map = neu[i];
        headLayers[i].o.visible = true;
        headLayers[i].st.visible = true;
      }
      paintHead();
      return { neu, old };
    },
    sweepLabel(p) {
      const k = clamp(p, 0, 1);
      // the window starts past the far edge of the card and ends past the near
      // one — the print is complete at exactly k = 1
      const off = 1.05 - k * 1.15;
      for (const L of headLayers) {
        L.mat.alphaMap.offset.x = 0.5 + off;
      }
      // and the light follows that window's soft edge across the card. It comes
      // on as it slides onto the label, and once its leading edge has reached the
      // far end there is nothing left for it to write: it latches here and the
      // fade takes over (stepHead, on its own clock)
      const x = (0.45 - off) * (D.W - D.labelInset * 2);
      head.x = Math.min(x, HEAD_STOP_X);
      head.enter = smoothstep(0.03, 0.14, k);
      if (x >= HEAD_END_X) head.dying = true;
      paintHead();
    },
    /** The light's own clock, ticked once a frame by the caller. A no-op until
        the head has reached the end of the label, and it keeps running after the
        sweep has settled — the print is finished before the light is, and a light
        that vanished on the frame the print landed read as a cut, not as a fade. */
    stepHead(dt) {
      if (!head.dying || head.fade >= 1) return;
      head.fade = Math.min(1, head.fade + dt / HEAD_FADE);
      paintHead();
      if (head.fade >= 1) for (const L of headLayers) L.st.visible = false;
    },
    /** the print changes hands here, with the window already past the card. The
        textures it replaces are handed back by `setLabel` and must be kept alive
        until every material that points at them has been moved — the ghost
        copies of these plates hold the same map.
        The light is deliberately left alone: if it is still on its way out, it
        finishes that on the card (stepHead). */
    commitLabel() {
      M.labelA.map = headLayers[0].mat.map;
      M.labelB.map = headLayers[1].mat.map;
      for (const L of headLayers) L.o.visible = false;
    },
    /** One frame with both head layers on screen and the window wide open, over
        the print that is already on the card — nothing changes on screen, but
        the two programs then exist, instead of being built on the first frame of
        the first sweep (which is a stutter in the middle of a move). Off is also
        how a cancelled swap is put away. */
    warmLabel(on) {
      for (const L of headLayers) {
        L.o.visible = on;
        L.st.visible = on;
        L.st.material.opacity = 0;
        L.mat.alphaMap.offset.x = on ? 0.4 : 1.55;
        L.st.position.x = HEAD_START_X;
        L.st.scale.x = 1;
      }
      head.x = HEAD_START_X;
      head.enter = 0;
      head.dying = false;
      head.fade = 0;
    },
    parts: { gTop, gBot, gMid, gTape, topPlate, botPlate, labA, labB, glass, tapeMesh, reels, screwd },
    dispose: () => assembly.traverse((o) => { if (o.isMesh) o.geometry.dispose?.(); }),
  };
}
