/**
 * Geometry repair for imported meshes.
 *
 * Every external 3D format loses information on the way in: STL has no shared
 * vertices at all (each triangle carries its own three), OBJ splits a corner
 * into one vertex per UV/normal combination, and glTF is triangle-only. Loading
 * that verbatim gives you a heap of separate triangles that overlap in the
 * viewport and cannot be edited. These two passes turn it back into a model:
 *
 *   weldPositions()          -> coincident corners become ONE document vertex
 *   mergeCoplanarTriangles() -> flat triangle runs become one n-gon face
 *
 * Pure core code: no three.js, no DOM, unit-testable in Node.
 */

import { newellNormal, triangulate, dot, sub, cross, length } from './geometry.js';

/** Grid bucket size for the weld pass: invisible, but wide enough to absorb the
 *  float noise real exporters leave behind. */
export function defaultWeldTolerance(radius) {
  // radius 0 (a degenerate/empty bound) must land on the floor, not on the
  // tolerance for a unit box: a zero-size mesh welded at 1e-5 is invisible
  // corruption, welded at 1e-9 is just identity.
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  return Math.max(1e-9, r * 1e-5);
}

/**
 * Merge positions within `eps` of each other.
 *
 * A rounded 3D grid plus a 27-cell neighbourhood scan, so two duplicates that
 * straddle a cell boundary still find each other. The FIRST occurrence wins,
 * which keeps import order (and undo diffs) stable.
 *
 * @param {number[]|Float32Array} positions flat [x,y,z, x,y,z, ...]
 * @param {number} eps
 * @param {number[]|Float32Array} [colors] flat rgb 0..1 parallel to positions.
 *   When given, two coincident corners only weld if their colours match: a
 *   shared corner used by two materials (glTF primitives referencing one
 *   POSITION accessor, OBJ vertices reused across usemtl blocks) cannot carry
 *   both colours once merged, and the first one silently wins for every face.
 * @returns {{positions:number[], remap:Int32Array, merged:number}}
 *   `remap[i]` is the output index of input vertex i.
 */
export function weldPositions(positions, eps = defaultWeldTolerance(1), colors = null) {
  const total = Math.floor(positions.length / 3);
  const remap = new Int32Array(total);
  const out = [];
  if (!total) return { positions: out, remap, merged: 0 };

  const useColor = !!colors && colors.length >= total * 3;
  // 8-bit colour buckets: far coarser than any real gradient, fine enough to
  // keep two visibly different materials apart.
  const ckey = (i) => (useColor ? `${Math.round(colors[i * 3] * 255)},${Math.round(colors[i * 3 + 1] * 255)},${Math.round(colors[i * 3 + 2] * 255)}` : '');

  const near = eps > 0 ? eps : 0;
  const inv = near > 0 ? 1 / near : 0;
  const buckets = new Map();
  const candKey = new Map(); // output vertex index -> its colour key

  for (let i = 0; i < total; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    // Non-finite coordinates can never be welded; keep each one unique.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      remap[i] = out.length / 3;
      out.push(x, y, z);
      continue;
    }

    let found = -1;
    if (near > 0) {
      const myKey = ckey(i);
      const gx = Math.round(x * inv);
      const gy = Math.round(y * inv);
      const gz = Math.round(z * inv);
      search: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = buckets.get(`${gx + dx}|${gy + dy}|${gz + dz}`);
            if (!bucket) continue;
            for (const cand of bucket) {
              if (
                Math.abs(out[cand * 3] - x) <= near &&
                Math.abs(out[cand * 3 + 1] - y) <= near &&
                Math.abs(out[cand * 3 + 2] - z) <= near &&
                (!useColor || candKey.get(cand) === myKey)
              ) {
                found = cand;
                break search;
              }
            }
          }
        }
      }
    }

    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      if (useColor) candKey.set(found, ckey(i));
      const key = `${Math.round(x * inv)}|${Math.round(y * inv)}|${Math.round(z * inv)}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      bucket.push(found);
    }
    remap[i] = found;
  }

  return { positions: out, remap, merged: total - out.length / 3 };
}

/* ------------------------------------------------------------------ *
 * Coplanar triangle merging
 * ------------------------------------------------------------------ */

const COS_TOL_DEFAULT = 0.99995; // ~0.57deg: "flat", not "slightly rounded"
const MAX_RING = 400; // ear clipping is quadratic; a bigger outline stays tris
const AREA_SLACK = 0.02; // ring must cover the island within this fraction

/**
 * Re-assemble flat triangle runs into polygons.
 *
 * Gluing triangles two at a time walks into self-intersecting rings on concave
 * shapes, so each *connected island* of mutually-coplanar triangles is merged
 * as a unit: union-find the islands, take the edges used exactly once inside the
 * island (its boundary), and stitch them into one ring. The boundary of a union
 * of non-overlapping coplanar triangles is a simple polygon by construction, so
 * the ear clipper can always triangulate the result back.
 *
 * An island that does not yield exactly one clean loop - a plate with a hole in
 * it, or anything suspicious - is left as plain triangles. Wrong topology would
 * be worse than a busy mesh.
 *
 * @param {number[]|Float32Array} positions flat xyz
 * @param {number[]|Int32Array} triangles flat index triples
 * @param {object} [opts]
 * @param {number} [opts.cosTol] minimum normal dot product to count as coplanar
 * @returns {{polygons:number[][], triangles:number[], groups:number, kept:number}}
 */
export function mergeCoplanarTriangles(positions, triangles, opts = {}) {
  const cosTol = opts.cosTol ?? COS_TOL_DEFAULT;
  const n = Math.floor(triangles.length / 3);
  if (n < 2) {
    return { polygons: [], triangles: Array.from(triangles), groups: 0, kept: n };
  }

  const radius = Math.max(1e-6, boundsRadius(positions));
  const planeTol = radius * 1e-6;

  const tri = (t) => [triangles[t * 3], triangles[t * 3 + 1], triangles[t * 3 + 2]];
  const pt = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];

  const normal = new Array(n).fill(null);
  const anchor = new Array(n).fill(null);
  const valid = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    const pts = tri(t).map(pt);
    const nn = newellNormal(pts);
    if (length(nn) < 1e-12) continue; // zero-area: never a merge candidate
    normal[t] = nn;
    anchor[t] = pts[0];
    valid[t] = 1;
  }

  // Undirected edge -> triangles using it.
  const edgeUsers = new Map();
  for (let t = 0; t < n; t++) {
    if (!valid[t]) continue;
    const s = tri(t);
    for (let i = 0; i < 3; i++) {
      const a = s[i];
      const b = s[(i + 1) % 3];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      let list = edgeUsers.get(key);
      if (!list) edgeUsers.set(key, (list = []));
      list.push(t);
    }
  }

  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[ry] = rx;
  };

  /** true when triangle t walks `from -> to` along an edge. */
  function directed(t, from, to) {
    const s = tri(t);
    for (let i = 0; i < 3; i++) {
      if (s[i] === from && s[(i + 1) % 3] === to) return true;
      if (s[i] === to && s[(i + 1) % 3] === from) return false;
    }
    return false;
  }

  function coplanar(a, b) {
    if (!valid[a] || !valid[b]) return false;
    const na = normal[a];
    const nb = normal[b];
    if (dot(na, nb) < cosTol) return false;
    return Math.abs(dot(sub(anchor[b], anchor[a]), na)) <= planeTol;
  }

  for (const [key, list] of edgeUsers) {
    if (list.length < 2) continue;
    const [aStr, bStr] = key.split('|');
    const va = Number(aStr);
    const vb = Number(bStr);
    for (let k = 1; k < list.length; k++) {
      const first = list[0];
      const other = list[k];
      if (!coplanar(first, other)) continue;
      // Only glue triangles that traverse the shared edge in OPPOSITE
      // directions. Same direction means two faces occupying one edge (a
      // non-manifold join), which would stitch into nonsense.
      if (directed(first, va, vb) === directed(other, va, vb)) continue;
      union(first, other);
    }
  }

  const islands = new Map();
  for (let t = 0; t < n; t++) {
    if (!valid[t]) continue;
    const root = find(t);
    let list = islands.get(root);
    if (!list) islands.set(root, (list = []));
    list.push(t);
  }

  const polygons = [];
  const leftover = [];
  let groups = 0;

  const pushTris = (list) => {
    for (const t of list) leftover.push(...tri(t));
  };

  for (const list of islands.values()) {
    if (list.length === 1) {
      pushTris(list);
      continue;
    }
    // Union-find is transitive, so a chain of merely "close enough" neighbours
    // can drift into a noticeably different plane. One ring is only valid when
    // the whole island truly lies in one plane.
    if (!list.every((t) => coplanar(list[0], t))) {
      pushTris(list);
      continue;
    }
    const ring = boundaryRing(list);
    if (!ring || ring.length < 3 || ring.length > MAX_RING || !ringMatchesArea(list, ring)) {
      pushTris(list);
      continue;
    }
    polygons.push(ring);
    groups++;
  }

  /** Boundary of an island as one directed ring, or null when not a single loop. */
  function boundaryRing(list) {
    const counts = new Map();
    const owner = new Map(); // edge key -> a triangle using it (read only when count === 1)
    for (const t of list) {
      const s = tri(t);
      for (let i = 0; i < 3; i++) {
        const a = s[i];
        const b = s[(i + 1) % 3];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        owner.set(key, t);
      }
    }
    const boundary = [];
    for (const [key, used] of counts) {
      if (used > 2) return null; // non-manifold inside the island
      if (used !== 1) continue; // interior edge
      const [a, b] = key.split('|').map(Number);
      boundary.push(directed(owner.get(key), a, b) ? [a, b] : [b, a]);
    }
    if (boundary.length < 3) return null;

    // Every boundary vertex must have exactly one outgoing and one incoming
    // boundary edge, otherwise the island is not a single simple patch.
    const succ = new Map();
    const pred = new Map();
    for (const [a, b] of boundary) {
      if (succ.has(a) || pred.has(b)) return null;
      succ.set(a, b);
      pred.set(b, a);
    }
    if (succ.size !== boundary.length) return null;

    const start = boundary[0][0];
    const ring = [];
    let cur = start;
    for (let guard = 0; guard <= boundary.length; guard++) {
      const next = succ.get(cur);
      if (next === undefined) return null;
      // Push the current vertex BEFORE closing the loop, otherwise the ring
      // loses its last corner and the length check below rejects every patch.
      ring.push(cur);
      if (next === start) break;
      if (ring.length > boundary.length) return null;
      cur = next;
    }
    if (ring.length !== succ.size) return null; // did not close over every edge
    if (pred.size !== succ.size) return null;
    return ring;
  }

  /**
   * Cross-check: the polygon must cover the same surface as the triangles it
   * replaces. Catches self-intersecting rings (where the ear clipper silently
   * falls back to a fan) without trusting the ring's shape alone.
   */
  function ringMatchesArea(list, ring) {
    let want = 0;
    for (const t of list) {
      const s = tri(t);
      const p = [s[0], s[1], s[2]];
      // Triangle area from two edges.
      const u = sub(pt(p[1]), pt(p[0]));
      const v = sub(pt(p[2]), pt(p[0]));
      want += length(cross(u, v)) / 2;
    }
    const pts = ring.map(pt);
    const tris = triangulate(pts);
    if (!tris.length) return false;
    let got = 0;
    for (const t of tris) {
      const u = sub(pts[t[1]], pts[t[0]]);
      const v = sub(pts[t[2]], pts[t[0]]);
      got += length(cross(u, v)) / 2;
    }
    if (want <= 0) return false;
    return Math.abs(got - want) <= want * AREA_SLACK;
  }

  return { polygons, triangles: leftover, groups, kept: leftover.length / 3 };
}

function boundsRadius(positions) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (!Number.isFinite(v)) continue;
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!Number.isFinite(min[0])) return 1;
  return length(sub(max, min)) / 2;
}
