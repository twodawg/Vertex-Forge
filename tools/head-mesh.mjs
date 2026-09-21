/**
 * Procedural stylised human (woman) head — a colour test asset generator.
 *
 * Emits one mesh with per-vertex sRGB colours and named face groups, so the
 * same geometry can be written out as OBJ (vertex colour), OBJ+MTL, PLY ascii,
 * PLY binary, glTF COLOR_0, glTF materials, and a textured glTF. Every format
 * must round-trip to the same face colours, which is what makes it a test.
 *
 * Pure Node + plain maths: no three.js, no DOM.
 */

export const SKIN = [0.941, 0.776, 0.643];
export const SKIN_SHADE = [0.808, 0.627, 0.510];
export const HAIR = [0.176, 0.114, 0.094];
export const LIPS = [0.788, 0.451, 0.427];
export const BROW = [0.235, 0.153, 0.118];
export const SCLERA = [0.949, 0.949, 0.937];
export const IRIS = [0.412, 0.294, 0.180];
export const PUPIL = [0.043, 0.039, 0.047];

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Isotropic gaussian falloff, 1 at the centre. */
const bump = (p, c, s) => {
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  const dz = p[2] - c[2];
  return Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * s * s));
};
/** Anisotropic gaussian: `a` scales each axis before the distance. */
const bumpA = (p, c, a, s) => {
  const d = [0, 1, 2].map((i) => (p[i] - c[i]) * a[i]);
  return Math.exp(-(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) / (2 * s * s));
};

const AXIS = [0.78, 1.02, 0.88];

/** Skull/jaw silhouette: narrows from cheekbone to chin, flat-ish at the back. */
function basePoint(phi, th) {
  const sp = Math.sin(phi);
  return [sp * Math.cos(th) * AXIS[0], Math.cos(phi) * AXIS[1], sp * Math.sin(th) * AXIS[2]];
}

function radial(p) {
  const l = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
}

/** Hairline height: high on the forehead, sweeping down over the occiput. */
function hairlineY(z) {
  const w = (z + AXIS[2]) / (2 * AXIS[2]); // 0 = back, 1 = front
  return lerp(-0.30, 0.45, smooth(0.0, 0.62, w));
}

function headColour(p, base) {
  const [x, y, z] = base;

  if (y > hairlineY(z)) {
    // Scalp hair, with a faint strand variation so a flat-shaded import shows
    // up as *not* a single uniform blob.
    const strand = 0.9 + 0.1 * Math.sin(x * 26 + y * 9);
    return [HAIR[0] * strand, HAIR[1] * strand, HAIR[2] * strand];
  }

  const brow = Math.max(
    bumpA(p, [0.30, 0.20, 0.66], [1.0, 3.4, 1.0], 0.055),
    bumpA(p, [-0.30, 0.20, 0.66], [1.0, 3.4, 1.0], 0.055),
  );
  if (brow > 0.55) return BROW;

  const lip = bumpA(p, [0, -0.46, 0.80], [1.15, 2.9, 1.0], 0.075);
  if (lip > 0.5) {
    const t = clamp(lip);
    return [lerp(SKIN[0], LIPS[0], t), lerp(SKIN[1], LIPS[1], t), lerp(SKIN[2], LIPS[2], t)];
  }

  // Skin with a soft ambient shading term: warm highlights on the convex front
  // features, cool occlusion at the temples/underside. Without this, a colour
  // bug that drops one channel is hard to see by eye.
  const front = clamp((z / AXIS[2] + 1) / 2);
  const under = smooth(0.1, -0.9, y);
  const shade = clamp(bumpA(p, [0, -0.12, 0.86], [2.6, 1.3, 1.2], 0.30) * 0.5 + front * 0.5 - under * 0.35);
  const grain = 0.015 * Math.sin(x * 41) * Math.sin(y * 37 + 1.3);
  const t = clamp(shade + grain);
  return [lerp(SKIN_SHADE[0], SKIN[0], t), lerp(SKIN_SHADE[1], SKIN[1], t), lerp(SKIN_SHADE[2], SKIN[2], t)];
}

function deform(p, base) {
  const [x, y, z] = base;
  const n = radial(p);
  const push = (d) => {
    p[0] += n[0] * d;
    p[1] += n[1] * d;
    p[2] += n[2] * d;
  };

  // Cranium: a touch wider above the ears.
  p[0] *= 1 + 0.06 * bump([x, y, z], [0, 0.35, 0], 0.55);

  // Jaw: taper toward the chin and pull the chin forward.
  const k = smooth(0.05, -0.85, y);
  p[0] *= 1 - 0.44 * k;
  p[2] *= 1 - 0.13 * k;
  push(0.17 * bumpA([x, y, z], [0, -0.80, 0.55], [1.6, 1.0, 1.0], 0.24));

  // Occipital flatten.
  p[2] -= 0.09 * smooth(0.1, -0.8, z) * clamp(1 - Math.abs(y) * 0.6);

  // Eye sockets.
  push(-0.085 * Math.max(bump([x, y, z], [0.30, 0.09, 0.62], 0.15), bump([x, y, z], [-0.30, 0.09, 0.62], 0.15)));

  // Brow ridge.
  push(0.045 * bumpA([x, y, z], [0, 0.24, 0.70], [0.55, 1.9, 1.0], 0.26));

  // Nose: narrow bridge flaring to the tip.
  push(0.10 * bumpA([x, y, z], [0, 0.06, 0.80], [3.4, 0.55, 1.0], 0.20));
  push(0.20 * bumpA([x, y, z], [0, -0.14, 0.82], [2.6, 1.5, 1.0], 0.11));

  // Lips and philtrum.
  push(0.085 * bumpA([x, y, z], [0, -0.44, 0.78], [1.2, 1.9, 1.0], 0.10));

  // Cheeks.
  push(0.035 * Math.max(bumpA([x, y, z], [0.44, -0.18, 0.55], [1.2, 1.2, 1.0], 0.22), bumpA([x, y, z], [-0.44, -0.18, 0.55], [1.2, 1.2, 1.0], 0.22)));

  // Hair volume.
  if (y > hairlineY(z)) push(0.055 * smooth(hairlineY(z), hairlineY(z) + 0.5, y) + 0.02);

  return p;
}

/** Append a UV sphere (eyeball) with a directional iris/pupil colour ramp. */
function addEyeball(mesh, cx, sign) {
  const R = 0.112;
  const NU = 18;
  const NV = 12;
  const start = mesh.positions.length / 3;
  const F = [sign > 0 ? 1 : 1, 0, 0]; // forward, +z
  void F;
  for (let iv = 0; iv <= NV; iv++) {
    const phi = (iv / NV) * Math.PI;
    for (let iu = 0; iu <= NU; iu++) {
      const th = (iu / NU) * Math.PI * 2;
      const d = [Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)];
      const i = mesh.positions.length / 3;
      mesh.positions.push(cx[0] + d[0] * R, cx[1] + d[1] * R, cx[2] + d[2] * R);
      mesh.uvs.push(iu / NU, iv / NV);
      // Facing the viewer => iris ring, dead ahead => pupil.
      const fwd = d[2];
      const off = Math.hypot(d[0], d[1]);
      let c;
      if (fwd > 0.86 && off < 0.30) c = PUPIL;
      else if (fwd > 0.62 && off < 0.62) c = IRIS;
      else c = SCLERA;
      mesh.colors.push(c[0], c[1], c[2]);
    }
  }
  const ring = (iv) => start + iv * (NU + 1);
  const faces = [];
  for (let iv = 0; iv < NV; iv++) {
    for (let iu = 0; iu < NU; iu++) {
      const a = ring(iv) + iu;
      const b = a + 1;
      const cc = ring(iv + 1) + iu;
      const dd = cc + 1;
      faces.push(mesh.quads.length);
      mesh.quads.push([a, b, dd, cc]);
    }
  }
  mesh.groups.push({ name: 'eye', faces });
}

export function buildHead() {
  const NU = 56;
  const NV = 46;
  const mesh = { positions: [], colors: [], uvs: [], quads: [], groups: [] };

  const groupOf = new Map(); // vertex -> region name
  for (let iv = 0; iv <= NV; iv++) {
    const phi = (iv / NV) * Math.PI;
    for (let iu = 0; iu <= NU; iu++) {
      const th = (iu / NU) * Math.PI * 2 - Math.PI; // 0 at the back, PI at ... see z-front handling
      const base = basePoint(phi, th);
      const p = deform([base[0], base[1], base[2]], base);
      const i = mesh.positions.length / 3;
      mesh.positions.push(p[0], p[1], p[2]);
      mesh.uvs.push(iu / NU, iv / NV);
      const c = headColour(p, base);
      mesh.colors.push(c[0], c[1], c[2]);
      groupOf.set(i, base[1] > hairlineY(base[2]) ? 'hair' : 'skin');
    }
  }

  const headFaces = [];
  const skinFaces = [];
  const hairFaces = [];
  for (let iv = 0; iv < NV; iv++) {
    for (let iu = 0; iu < NU; iu++) {
      const a = iv * (NU + 1) + iu;
      const b = a + 1;
      const c = (iv + 1) * (NU + 1) + iu;
      const d = c + 1;
      headFaces.push(mesh.quads.length);
      mesh.quads.push([a, b, d, c]);
      const region = groupOf.get(a);
      (region === 'hair' ? hairFaces : skinFaces).push(mesh.quads.length - 1);
    }
  }
  mesh.groups.push({ name: 'skin', faces: skinFaces });
  mesh.groups.push({ name: 'hair', faces: hairFaces });

  // Eye sockets are indented; globes sit slightly behind the surface.
  addEyeball(mesh, [0.30, 0.09, 0.60], 1);
  addEyeball(mesh, [-0.30, 0.09, 0.60], -1);

  mesh.vertexCount = mesh.positions.length / 3;
  mesh.bounds = boundsOfPositions(mesh.positions);
  return mesh;
}

export function boundsOfPositions(flat) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < flat.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = flat[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max, size: max.map((v, k) => v - min[k]) };
}

/** Average a face's vertex colours into a display-space hex. */
export function faceHex(mesh, quad) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of quad) {
    r += mesh.colors[i * 3];
    g += mesh.colors[i * 3 + 1];
    b += mesh.colors[i * 3 + 2];
  }
  const n = quad.length;
  const h = (v) => Math.round(clamp(v / n) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
