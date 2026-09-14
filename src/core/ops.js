/**
 * Higher-level modeling ops. Document-only (no UI, no three.js) so each is
 * unit-testable. Every function mutates `doc` in place and returns a short
 * result describing what changed, which is what the undo layer wants anyway.
 */
import { addVertex, addEdge, addFace, getVertex, vertexMap, edgeKey, findEdge, removeFace } from './model.js';
import { newellNormal, stitchLoop, sub, cross, length, normalize, round } from './geometry.js';

/** Ring through the shortest turn around its centroid, for "make face from selection". */
export function orderRing(doc, ids) {
  const m = vertexMap(doc);
  const pts = ids.map((id) => m.get(id)).filter(Boolean);
  if (pts.length < 3) return null;
  const c = [0, 1, 2].map((i) => pts.reduce((s, p) => s + p[['x', 'y', 'z'][i]], 0) / pts.length);
  const n = newellNormal(pts.map((p) => [p.x, p.y, p.z]));
  // Basis on the best-fit plane so angular sort is meaningful for tilted rings.
  const ref = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(n, ref));
  const v = cross(n, u);
  const withAngle = pts.map((p) => {
    const d = sub([p.x, p.y, p.z], c);
    return { id: p.id, a: Math.atan2(d[0] * v[0] + d[1] * v[1] + d[2] * v[2], d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) };
  });
  withAngle.sort((p, q) => p.a - q.a);
  return withAngle.map((p) => p.id);
}

/**
 * Delete a selection. Vertices cascade through edges/faces via the model layer;
 * faces and edges drop out when their endpoints vanish.
 */
/**
 * Delete a selection. `edges` are `[vertexIdA, vertexIdB]` pairs as produced by
 * the mesh's edge list; vertices cascade through edges/faces via the model layer.
 */
export function deleteSelection(doc, { verts = [], edges = [], faces = [] }) {
  const faceIds = new Set(faces);
  // Deleting an edge that only exists as a face boundary should cut that face
  // out too, otherwise the geometry silently remains in the mesh.
  for (const [a, b] of edges) {
    const k = edgeKey(a, b);
    for (const f of doc.faces) {
      const L = f.loop;
      for (let i = 0; i < L.length; i++) {
        if (edgeKey(L[i], L[(i + 1) % L.length]) === k) {
          faceIds.add(f.id);
          break;
        }
      }
    }
  }
  for (const id of faceIds) removeFace(doc, id);

  const edgeIds = new Set();
  for (const [a, b] of edges) {
    const e = findEdge(doc, a, b);
    if (e) edgeIds.add(e.id);
  }
  doc.edges = doc.edges.filter((e) => !edgeIds.has(e.id));

  const vIds = new Set(verts);
  const before = doc.vertices.length;
  doc.vertices = doc.vertices.filter((v) => !vIds.has(v.id));
  const removed = before - doc.vertices.length;
  if (removed) {
    doc.edges = doc.edges.filter((e) => !vIds.has(e.a) && !vIds.has(e.b));
    doc.faces = doc.faces
      .map((f) => ({ ...f, loop: f.loop.filter((x) => !vIds.has(x)) }))
      .filter((f) => f.loop.length >= 3);
  }
  return { vertices: removed, edges: edgeIds.size, faces: faceIds.size };
}

/**
 * Fill a set of selected edges into a face when they form one simple cycle.
 * @param {string[][]} edgePairs pairs of vertex ids
 * @returns {{face: object}|{error: string}}
 */
export function fillEdgeLoop(doc, edgePairs) {
  const loop = stitchLoop(edgePairs);
  if (!loop) return { error: 'Selected edges do not form one closed loop.' };
  const f = addFace(doc, loop);
  return f ? { face: f } : { error: 'Could not build a face from that loop.' };
}

/**
 * Push selected faces along their normal, growing side walls behind them.
 *
 * The selected faces keep their ring shape but move to fresh vertices, and each
 * boundary edge (an edge used by exactly one selected face) becomes a quad
 * connecting the old ring to the new one. Interior edges between two selected
 * faces correctly get no wall.
 */
export function extrudeFaces(doc, faceIds, distance = 0.25, direction = null) {
  const sel = new Set(faceIds);
  const chosen = doc.faces.filter((f) => sel.has(f.id));
  if (!chosen.length) return { created: 0, error: 'Select faces to extrude first.' };

  // Averaged Newell normal of the selection = the extrude direction.
  let dir = direction;
  if (!dir) {
    const acc = [0, 0, 0];
    const m = vertexMap(doc);
    for (const f of chosen) {
      const n = newellNormal(f.loop.map((id) => {
        const v = m.get(id);
        return [v.x, v.y, v.z];
      }));
      acc[0] += n[0];
      acc[1] += n[1];
      acc[2] += n[2];
    }
    dir = normalize(acc);
    if (!length(dir)) dir = [0, 1, 0];
  }

  // Boundary edges of the selection, in face-ring order so walls stay coherent.
  const counts = new Map();
  for (const f of chosen) {
    const L = f.loop;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      const b = L[(i + 1) % L.length];
      const k = edgeKey(a, b);
      if (!counts.has(k)) counts.set(k, []);
      counts.get(k).push({ a, b });
    }
  }
  const boundary = [];
  for (const [k, uses] of counts) {
    const sharedBySelected = chosen.filter((f) =>
      f.loop.some((id, i) => edgeKey(id, f.loop[(i + 1) % f.loop.length]) === k),
    ).length;
    if (sharedBySelected > 1) continue;
    boundary.push(uses[0]);
  }

  const oldToNew = new Map();
  const off = [dir[0] * distance, dir[1] * distance, dir[2] * distance];
  const makeNew = (id) => {
    if (oldToNew.has(id)) return oldToNew.get(id);
    const v = getVertex(doc, id);
    const nv = addVertex(doc, { x: v.x + off[0], y: v.y + off[1], z: v.z + off[2] });
    oldToNew.set(id, nv.id);
    return nv.id;
  };

  // 1. Side walls, built BEFORE the caps move so we read old positions.
  const walls = [];
  for (const { a, b } of boundary) {
    const na = makeNew(a);
    const nb = makeNew(b);
    const f = addFace(doc, [a, b, nb, na]);
    if (f) walls.push(f);
  }

  // 2. Move the selected caps onto the new ring.
  for (const f of chosen) {
    const moved = f.loop.map((id) => makeNew(id));
    if (new Set(moved).size === moved.length) f.loop = moved;
  }

  return { created: walls.length, moved: chosen.length, faces: [...walls] };
}

/**
 * Weld vertices closer than `eps`, rewriting every loop/edge reference. The
 * usual fix after dragging two halves of a model together.
 */
export function weldVertices(doc, eps = 1e-4) {
  if (!doc.vertices.length) return { merged: 0 };
  const remap = new Map();
  const kept = [];
  const resolve = (id) => {
    let cur = id;
    const seen = new Set();
    while (remap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = remap.get(cur);
    }
    return cur;
  };

  for (const v of doc.vertices) {
    let match = null;
    for (const k of kept) {
      if (Math.abs(k.x - v.x) <= eps && Math.abs(k.y - v.y) <= eps && Math.abs(k.z - v.z) <= eps) {
        match = k;
        break;
      }
    }
    if (match) remap.set(v.id, match.id);
    else kept.push(v);
  }

  let merged = doc.vertices.length - kept.length;
  if (!merged) return { merged: 0 };

  doc.vertices = kept;
  doc.edges = doc.edges
    .map((e) => ({ ...e, a: resolve(e.a), b: resolve(e.b) }))
    .filter((e) => e.a !== e.b);
  // De-duplicate edges after remap.
  const seenEdge = new Set();
  doc.edges = doc.edges.filter((e) => {
    const k = edgeKey(e.a, e.b);
    if (seenEdge.has(k)) return false;
    seenEdge.add(k);
    return true;
  });

  const ids = new Set(kept.map((v) => v.id));
  doc.faces = doc.faces
    .map((f) => {
      const loop = f.loop.map(resolve).filter((id) => ids.has(id));
      // Drop consecutive duplicates introduced by the weld.
      const out = loop.filter((id, i) => id !== loop[(i + 1) % loop.length]);
      return { ...f, loop: out };
    })
    .filter((f) => f.loop.length >= 3 && new Set(f.loop).size === f.loop.length);

  return { merged };
}

/**
 * Recenter coordinates on the origin without changing shape.
 * @param {string[]|null} onlyIds restrict to these vertex ids (null = all).
 */
export function snapVerticesToGrid(doc, step, onlyIds = null) {
  if (!step || step <= 0) return { moved: 0 };
  const scope = onlyIds && onlyIds.length ? new Set(onlyIds) : null;
  let moved = 0;
  for (const v of doc.vertices) {
    if (scope && !scope.has(v.id)) continue;
    const nx = round(Math.round(v.x / step) * step, 6);
    const ny = round(Math.round(v.y / step) * step, 6);
    const nz = round(Math.round(v.z / step) * step, 6);
    if (nx !== v.x || ny !== v.y || nz !== v.z) moved++;
    v.x = nx;
    v.y = ny;
    v.z = nz;
  }
  return { moved };
}
