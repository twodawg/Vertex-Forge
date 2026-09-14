/**
 * Turns the document into flat triangle/index buffers. Kept free of three.js
 * so it can be unit-tested and reused by exporters.
 */
import { triangulate, boundsOf } from './geometry.js';
import { vertexMap, allEdgePairs } from './model.js';

/**
 * Triangulate every face into one shared vertex pool.
 *
 * The pool is `doc.vertices` in order, so a vertex's pool index is also the
 * index its 3D handle uses - the renderer can therefore map a picked triangle
 * straight back to the model.
 *
 * @param {object} doc
 * @returns {{positions: Float32Array, indices: number[], vertexIndex: Map<string,number>,
 *            faceTriangles: Map<string,number[][]>, triangleCount: number}}
 */
export function buildMesh(doc) {
  const verts = doc.vertices;
  const m = vertexMap(doc);
  const vertexIndex = new Map();

  const positions = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => {
    vertexIndex.set(v.id, i);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  });

  const indices = [];
  const faceTriangles = new Map();
  const triFace = []; // triangle position in `indices` -> owning face id

  for (const f of doc.faces) {
    const ring = f.loop.filter((id) => vertexIndex.has(id));
    if (ring.length < 3) continue;
    const pts = ring.map((id) => {
      const v = m.get(id);
      return [v.x, v.y, v.z];
    });
    const tris = triangulate(pts).map((t) => [
      vertexIndex.get(ring[t[0]]),
      vertexIndex.get(ring[t[1]]),
      vertexIndex.get(ring[t[2]]),
    ]);
    if (!tris.length) continue;
    faceTriangles.set(f.id, tris);
    for (const t of tris) {
      indices.push(t[0], t[1], t[2]);
      triFace.push(f.id);
    }
  }

  const edgePairs = buildEdgePairs(doc, vertexIndex);

  return {
    positions,
    indices,
    vertexIndex,
    faceTriangles,
    triFace,
    edgePairs,
    edgeIndices: edgePairs.flat(),
    triangleCount: indices.length / 3,
    bounds: boundsOf(verts),
  };
}

/**
 * Every edge as pool-index pairs: explicit edges plus the boundary edges
 * implied by faces. Feeds the wireframe overlay and screen-space edge picking.
 * Deterministic order, so an index is a stable handle for "the Nth edge".
 */
export function buildEdgePairs(doc, vertexIndex) {
  const out = [];
  for (const [a, b] of allEdgePairs(doc)) {
    const ia = vertexIndex.get(a);
    const ib = vertexIndex.get(b);
    if (ia === undefined || ib === undefined) continue;
    out.push([ia, ib]);
  }
  return out;
}

/**
 * True when the mesh is closed: every edge is shared by exactly two faces.
 * Cheap enough to run on every edit and a useful live signal before GLB export.
 */
export function isWatertight(doc) {
  const use = new Map();
  for (const f of doc.faces) {
    const L = f.loop;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      const b = L[(i + 1) % L.length];
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      use.set(k, (use.get(k) || 0) + 1);
    }
  }
  if (!use.size) return false;
  for (const n of use.values()) if (n !== 2) return false;
  return true;
}
