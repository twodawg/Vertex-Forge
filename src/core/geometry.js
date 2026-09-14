/**
 * Pure geometry helpers. No dependency on three.js so this module can be
 * unit-tested in Node and reused by any future exporter.
 *
 * World convention: right-handed, Y up (matches three.js and glTF).
 */

export const EPS = 1e-9;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Snap a scalar to a step grid. */
export function snap(v, step) {
  if (!step || step <= 0) return v;
  return Math.round(v / step) * step;
}

/** Round to `d` decimals, killing -0 and float noise. */
export function round(v, d = 4) {
  const f = 10 ** d;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a) {
  const l = length(a);
  return l < EPS ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Newell normal of a polygon - robust for non-planar and degenerate loops
 * (unlike a single cross product of the first two edges).
 * Returns a unit vector, or [0,0,0] when the loop has no area.
 */
export function newellNormal(pts) {
  const n = [0, 0, 0];
  const count = pts.length;
  if (count < 3) return n;
  for (let i = 0; i < count; i++) {
    const cur = pts[i];
    const nxt = pts[(i + 1) % count];
    n[0] += (cur[1] - nxt[1]) * (cur[2] + nxt[2]);
    n[1] += (cur[2] - nxt[2]) * (cur[0] + nxt[0]);
    n[2] += (cur[0] - nxt[0]) * (cur[1] + nxt[1]);
  }
  return normalize(n);
}

/**
 * Build a right-handed orthonormal 2D basis for a plane (`up` = unit normal),
 * i.e. `cross(u, v)` points along `up`.
 *
 * The handedness matters: ear-clipping normalizes the loop to CCW in the
 * projected 2D frame, so a left-handed frame would mirror the result and emit
 * triangles whose winding is opposite to the polygon's normal. The previous
 * axis-dropping shortcut was right-handed for +X/+Y/+Z planes but left-handed
 * for -X/-Y/-Z, which silently inverted every back-facing polygon.
 */
export function planeBasis(up) {
  // Pick a reference axis far from `up` so cross() stays well-conditioned.
  const ref = Math.abs(up[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(up, ref));
  const v = cross(up, u); // already unit: up and u are unit and perpendicular
  return { u, v };
}

/** Signed area of a 2D closed loop (positive = counter-clockwise). */
export function signedArea2(points2) {
  let a = 0;
  for (let i = 0; i < points2.length; i++) {
    const p = points2[i];
    const q = points2[(i + 1) % points2.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function pointInTriangle2(p, a, b, c) {
  const d1 = (p[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (p[1] - a[1]);
  const d2 = (p[0] - b[0]) * (c[1] - b[1]) - (c[0] - b[0]) * (p[1] - b[1]);
  const d3 = (p[0] - c[0]) * (a[1] - c[1]) - (a[0] - c[0]) * (p[1] - c[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon given as a flat array of
 * local 2D points `[x,y]` in loop order. Returns triangle index triples into
 * the original loop, always counter-clockwise.
 */
export function earClip(loop2) {
  const n = loop2.length;
  if (n < 3) return [];
  let idx = [];
  for (let i = 0; i < n; i++) idx.push(i);

  // Work in a counter-clockwise order so cross products sign-check cleanly.
  if (signedArea2(loop2) < 0) idx.reverse();

  const tris = [];
  let guard = n * n + 10; // safety valve for self-intersecting input

  while (idx.length > 3 && guard-- > 0) {
    let earFound = false;
    for (let i = 0; i < idx.length; i++) {
      const iPrev = (i - 1 + idx.length) % idx.length;
      const iNext = (i + 1) % idx.length;
      const a = loop2[idx[iPrev]];
      const b = loop2[idx[i]];
      const c = loop2[idx[iNext]];

      const crossZ = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (crossZ <= EPS) continue; // reflex or collinear -> not an ear tip

      let contains = false;
      for (let j = 0; j < idx.length; j++) {
        const k = idx[j];
        if (k === idx[iPrev] || k === idx[i] || k === idx[iNext]) continue;
        if (pointInTriangle2(loop2[k], a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      tris.push([idx[iPrev], idx[i], idx[iNext]]);
      idx.splice(i, 1);
      earFound = true;
      break;
    }
    if (!earFound) break; // no ear available: polygon is self-intersecting
  }

  if (idx.length === 3) {
    tris.push([idx[0], idx[1], idx[2]]);
  } else if (idx.length > 3) {
    // Degenerate fallback: fan from the first remaining vertex. Guarantees the
    // area is still covered instead of silently losing faces.
    for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
  }
  return tris;
}

/**
 * Triangulate a 3D polygon loop in world space.
 * @param {number[][]} pts loop vertices as [x,y,z]
 * @returns {number[][]} triangles referencing indices into `pts`
 */
export function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  const up = newellNormal(pts);
  if (length(up) < EPS) {
    // Zero-area loop: fan it anyway so the caller still gets geometry.
    const out = [];
    for (let i = 1; i + 1 < n; i++) out.push([0, i, i + 1]);
    return out;
  }
  const { u, v } = planeBasis(up);
  const loop2 = pts.map((p) => [dot(p, u), dot(p, v)]);
  return earClip(loop2);
}

/**
 * Axis-aligned bounding box of a point list. Accepts `[x,y,z]` arrays or
 * `{x,y,z}` objects (the document's vertex shape) so callers never have to
 * map first.
 */
export function boundsOf(points) {
  if (!points.length) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0], radius: 0 };
  }
  const at = (p, i) => (Array.isArray(p) ? p[i] : i === 0 ? p.x : i === 1 ? p.y : p.z);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      const v = at(p, i);
      if (!Number.isFinite(v)) continue;
      if (v < min[i]) min[i] = v;
      if (v > max[i]) max[i] = v;
    }
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min, max, center, size, radius: length(size) / 2 };
}

/**
 * Merge a set of undirected edges into a single closed loop when the graph is
 * one simple cycle. Used to stitch closed edge outlines into face-ready rings.
 * @param {string[][]} edges pairs of vertex ids
 * @returns {string[]|null} vertex ids in loop order, or null when not a cycle
 */
export function stitchLoop(edges) {
  if (edges.length < 3) return null;
  const adjacency = new Map();
  for (const [a, b] of edges) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  }
  for (const list of adjacency.values()) {
    if (list.length !== 2) return null; // every vertex must be degree 2
  }
  const start = adjacency.keys().next().value;
  const loop = [start];
  const used = new Set([start]);
  let prev = null;
  let cur = start;
  for (;;) {
    const nexts = adjacency.get(cur).filter((x) => x !== prev);
    const nxt = nexts.find((x) => !used.has(x)) ?? nexts[0];
    if (!nxt || nxt === start) break;
    if (used.has(nxt)) return null;
    used.add(nxt);
    loop.push(nxt);
    prev = cur;
    cur = nxt;
    if (loop.length > adjacency.size) return null;
  }
  return loop.length === adjacency.size ? loop : null;
}
