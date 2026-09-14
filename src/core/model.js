/**
 * The document model: vertices, edges, faces, plus history and validation.
 * Deliberately UI-free and three.js-free so it can be tested in Node and
 * reused headlessly.
 */

import { round, boundsOf } from './geometry.js';

export const FORMAT = 'vertex-forge';
export const VERSION = 1;

let seq = 0;
/** Ids are short, sortable and stable within a session. */
export function newId(prefix) {
  seq += 1;
  return `${prefix}${seq.toString(36)}`;
}

export function createDocument(name = 'Untitled') {
  return {
    format: FORMAT,
    version: VERSION,
    name,
    units: 'unit',
    vertices: [], // {id,x,y,z}
    edges: [], // {id,a,b}  a/b = vertex ids
    faces: [], // {id, loop:[vertexId,...]}  ordered ring
    created: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Accessors
 * ------------------------------------------------------------------ */

export function vertexMap(doc) {
  const m = new Map();
  for (const v of doc.vertices) m.set(v.id, v);
  return m;
}

export function getVertex(doc, id) {
  return doc.vertices.find((v) => v.id === id);
}

export function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function findEdge(doc, a, b) {
  const k = edgeKey(a, b);
  return doc.edges.find((e) => edgeKey(e.a, e.b) === k) || null;
}

/** Number of faces referencing a given edge (used for manifold diagnostics). */
export function edgeUseCount(doc, a, b) {
  const want = new Set([edgeKey(a, b)]);
  let n = 0;
  for (const f of doc.faces) {
    const L = f.loop;
    for (let i = 0; i < L.length; i++) {
      if (want.has(edgeKey(L[i], L[(i + 1) % L.length]))) n++;
    }
  }
  return n;
}

/** All edges as [a,b] pairs, including the implicit closing edges of faces. */
export function allEdgePairs(doc) {
  const seen = new Map();
  const add = (a, b) => {
    const k = edgeKey(a, b);
    if (!seen.has(k)) seen.set(k, [a, b]);
  };
  for (const e of doc.edges) add(e.a, e.b);
  for (const f of doc.faces) {
    const L = f.loop;
    for (let i = 0; i < L.length; i++) add(L[i], L[(i + 1) % L.length]);
  }
  return [...seen.values()];
}

export function faceVertices(doc, face) {
  const m = vertexMap(doc);
  return face.loop.map((id) => m.get(id)).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Mutations - each returns the created entity or null when rejected
 * ------------------------------------------------------------------ */

export function addVertex(doc, { x, y, z, id } = {}) {
  const v = {
    id: id || newId('v'),
    x: round(x, 6),
    y: round(y, 6),
    z: round(z, 6),
  };
  doc.vertices.push(v);
  return v;
}

export function removeVertex(doc, id) {
  const before = doc.vertices.length;
  doc.vertices = doc.vertices.filter((v) => v.id !== id);
  if (doc.vertices.length === before) return false;
  // Cascade: an edge or face referencing a deleted vertex is meaningless.
  doc.edges = doc.edges.filter((e) => e.a !== id && e.b !== id);
  doc.faces = doc.faces
    .map((f) => ({ ...f, loop: f.loop.filter((v) => v !== id) }))
    .filter((f) => f.loop.length >= 3);
  return true;
}

export function addEdge(doc, a, b) {
  if (a === b) return null;
  if (!getVertex(doc, a) || !getVertex(doc, b)) return null;
  const existing = findEdge(doc, a, b);
  if (existing) return existing;
  const e = { id: newId('e'), a, b };
  doc.edges.push(e);
  return e;
}

export function removeEdge(doc, id) {
  const e = doc.edges.find((x) => x.id === id);
  if (!e) return false;
  doc.edges = doc.edges.filter((x) => x.id !== id);
  return true;
}

/**
 * Add a face from an ordered ring of vertex ids. Duplicated and degenerate
 * rings are rejected so the renderer never has to cope with garbage.
 */
export function addFace(doc, loop) {
  if (!Array.isArray(loop) || loop.length < 3) return null;
  if (new Set(loop).size !== loop.length) return null;
  const m = vertexMap(doc);
  if (loop.some((id) => !m.has(id))) return null;
  const f = { id: newId('f'), loop: [...loop] };
  doc.faces.push(f);
  return f;
}

export function removeFace(doc, id) {
  const before = doc.faces.length;
  doc.faces = doc.faces.filter((f) => f.id !== id);
  return doc.faces.length !== before;
}

export function setVertexPosition(doc, id, x, y, z) {
  const v = getVertex(doc, id);
  if (!v) return false;
  v.x = round(x, 6);
  v.y = round(y, 6);
  v.z = round(z, 6);
  return true;
}

export function translateAll(doc, dx, dy, dz) {
  for (const v of doc.vertices) {
    v.x = round(v.x + dx, 6);
    v.y = round(v.y + dy, 6);
    v.z = round(v.z + dz, 6);
  }
}

export function centerOnOrigin(doc) {
  const b = boundsOf(doc.vertices);
  translateAll(doc, -b.center[0], -b.center[1], -b.center[2]);
}

/**
 * Make face orientations consistent across the mesh.
 *
 * A ring's own Newell normal is derived from its winding, so testing a face in
 * isolation is a no-op - consistency only has meaning *between* neighbours.
 * Two faces sharing an edge should traverse it in opposite directions. Walk the
 * face-adjacency graph breadth-first and flip any face that violates that, then
 * (for closed-ish meshes) orient the whole result outwards from the centroid.
 *
 * @returns {{flipped:number, seeds:number, outward:boolean}}
 */
export function unifyWinding(doc, { outward = true } = {}) {
  if (doc.faces.length < 2) return { flipped: 0, seeds: 0, outward: false };

  const directedEdge = (a, b) => `${a}>${b}`;

  // Adjacency: for each undirected edge, the faces using it.
  const users = new Map();
  for (const f of doc.faces) {
    const L = f.loop;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      const b = L[(i + 1) % L.length];
      const k = edgeKey(a, b);
      if (!users.has(k)) users.set(k, []);
      users.get(k).push({ face: f.id, from: a, to: b });
    }
  }
  const facesById = new Map(doc.faces.map((f) => [f.id, f]));

  // Seed orientation: normal pointing away from the mesh centroid.
  const all = boundsOf(doc.vertices);
  const centroid = all.center;
  const seedOutward = (f) => {
    const m = vertexMap(doc);
    const pts = f.loop.map((id) => m.get(id)).filter(Boolean).map((v) => [v.x, v.y, v.z]);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    const n = pts.length;
    const faceCenter = [cx / n, cy / n, cz / n];
    const nrm = newellNormalOf(pts);
    const dir = [faceCenter[0] - centroid[0], faceCenter[1] - centroid[1], faceCenter[2] - centroid[2]];
    return nrm[0] * dir[0] + nrm[1] * dir[1] + nrm[2] * dir[2] >= 0;
  };

  const visited = new Set();
  let flipped = 0;
  let seeds = 0;

  for (const start of doc.faces) {
    if (visited.has(start.id)) continue;
    seeds++;
    if (outward && !seedOutward(start)) {
      start.loop.reverse();
      flipped++;
    }
    visited.add(start.id);

    const queue = [start];
    while (queue.length) {
      const current = queue.shift();
      const L = current.loop;
      for (let i = 0; i < L.length; i++) {
        const a = L[i];
        const b = L[(i + 1) % L.length];
        const bucket = users.get(edgeKey(a, b)) || [];
        for (const use of bucket) {
          if (use.face === current.id) continue;
          if (visited.has(use.face)) continue;
          const neighbour = facesById.get(use.face);
          if (!neighbour) continue;
          // Consistent when neighbours cross the shared edge in opposite
          // directions; the current face says the edge runs a -> b, so the
          // neighbour must run b -> a.
          const agrees = use.from === b && use.to === a;
          if (!agrees) {
            neighbour.loop.reverse();
            flipped++;
          }
          visited.add(neighbour.id);
          queue.push(neighbour);
        }
      }
    }
  }
  return { flipped, seeds, outward };
}

/** Newell normal without importing geometry twice (kept local for speed). */
function newellNormalOf(pts) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i];
    const n = pts[(i + 1) % pts.length];
    nx += (c[1] - n[1]) * (c[2] + n[2]);
    ny += (c[2] - n[2]) * (c[0] + n[0]);
    nz += (c[0] - n[0]) * (c[1] + n[1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Reverse every face ring (in-place). */
export function flipAllFaces(doc) {
  for (const f of doc.faces) f.loop.reverse();
  return doc.faces.length;
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

/**
 * Validate the document. Returns {errors:[], warnings:[]} where errors are
 * things that break export and warnings are cosmetic / modelling hints.
 */
export function validate(doc) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  for (const v of doc.vertices) {
    if (ids.has(v.id)) errors.push(`Duplicate vertex id ${v.id}`);
    ids.add(v.id);
    for (const axis of ['x', 'y', 'z']) {
      if (!Number.isFinite(v[axis])) {
        errors.push(`Vertex ${v.id} has non-finite ${axis}`);
      }
    }
  }
  for (const e of doc.edges) {
    if (!ids.has(e.a) || !ids.has(e.b)) errors.push(`Edge ${e.id} references a missing vertex`);
    if (e.a === e.b) errors.push(`Edge ${e.id} is a zero-length loop`);
  }
  for (const f of doc.faces) {
    if (f.loop.length < 3) errors.push(`Face ${f.id} has fewer than 3 corners`);
    if (new Set(f.loop).size !== f.loop.length) errors.push(`Face ${f.id} repeats a vertex`);
    for (const id of f.loop) if (!ids.has(id)) errors.push(`Face ${f.id} references missing vertex ${id}`);
  }

  if (doc.vertices.length === 0) warnings.push('No vertices yet - click in the viewport to place the first one.');
  else if (doc.faces.length === 0) warnings.push('Nothing to export as a solid mesh: add faces (or press F to fill a closed edge loop).');

  // Boundary edges: an edge used by exactly one face means the mesh is open.
  const use = new Map();
  for (const f of doc.faces) {
    const L = f.loop;
    for (let i = 0; i < L.length; i++) {
      const k = edgeKey(L[i], L[(i + 1) % L.length]);
      use.set(k, (use.get(k) || 0) + 1);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const n of use.values()) {
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
  }
  if (doc.faces.length && boundary) warnings.push(`${boundary} open edge${boundary === 1 ? '' : 's'} - the mesh is not watertight.`);
  if (nonManifold) errors.push(`${nonManifold} edge${nonManifold === 1 ? '' : 's'} shared by more than 2 faces (non-manifold).`);

  return { errors, warnings, boundaryEdges: boundary, nonManifold };
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

export function serialize(doc) {
  return {
    format: FORMAT,
    version: VERSION,
    name: doc.name,
    units: doc.units,
    vertices: doc.vertices.map((v) => ({
      id: v.id,
      x: round(v.x, 6),
      y: round(v.y, 6),
      z: round(v.z, 6),
    })),
    edges: doc.edges.map((e) => ({ id: e.id, a: e.a, b: e.b })),
    faces: doc.faces.map((f) => ({ id: f.id, loop: [...f.loop] })),
    stats: {
      vertices: doc.vertices.length,
      edges: doc.edges.length,
      faces: doc.faces.length,
      triangles: 0, // filled by the caller when a mesh is available
    },
  };
}

/** Strict-ish loader. Accepts our own exports and plain coordinate arrays. */
export function deserialize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Expected a JSON object.');

  // Tolerated foreign shape: { vertices:[[x,y,z],...], faces:[[i,j,k],...] }
  if (Array.isArray(raw.vertices) && !raw.format) {
    const doc = createDocument(raw.name || 'Imported');
    const idOf = new Map();
    raw.vertices.forEach((p, i) => {
      const [x, y, z] = Array.isArray(p) ? p : [p.x, p.y, p.z];
      const v = addVertex(doc, { x, y, z, id: `i${i}` });
      idOf.set(i, v.id);
    });
    for (const f of raw.faces || []) {
      const loop = (Array.isArray(f) ? f : f.loop || f.indices || []).map((i) => idOf.get(Number(i))).filter(Boolean);
      addFace(doc, loop);
    }
    return { doc, foreign: true };
  }

  if (raw.format && raw.format !== FORMAT) {
    throw new Error(`Not a Vertex Forge file (format "${raw.format}").`);
  }
  const doc = createDocument(raw.name || 'Imported');
  doc.vertices = (raw.vertices || []).map((v) => ({
    id: v.id || newId('v'),
    x: Number(v.x) || 0,
    y: Number(v.y) || 0,
    z: Number(v.z) || 0,
  }));
  const ids = new Set(doc.vertices.map((v) => v.id));
  doc.edges = (raw.edges || [])
    .map((e) => ({ id: e.id || newId('e'), a: e.a, b: e.b }))
    .filter((e) => ids.has(e.a) && ids.has(e.b) && e.a !== e.b);
  doc.faces = (raw.faces || [])
    .map((f) => ({ id: f.id || newId('f'), loop: (f.loop || []).filter((x) => ids.has(x)) }))
    .filter((f) => f.loop.length >= 3 && new Set(f.loop).size === f.loop.length);
  doc.units = raw.units || 'unit';
  return { doc, foreign: false };
}

/** Deep copy - the basis of the snapshot history. */
export function cloneDocument(doc) {
  return {
    ...structuredCloneSafe(doc),
  };
}

export function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

export const HISTORY_LIMIT = 100;

export function createHistory(doc) {
  const past = [];
  const future = [];
  let baseline = cloneDocument(doc);

  /** Write a snapshot into `doc` in place, keeping the object identity. */
  function restore(state) {
    const fresh = cloneDocument(state); // never alias the stored snapshot
    doc.vertices = fresh.vertices;
    doc.edges = fresh.edges;
    doc.faces = fresh.faces;
    baseline = cloneDocument(doc);
  }

  return {
    /** Call BEFORE a mutation, then commit() if it actually changed something. */
    begin() {
      baseline = cloneDocument(doc);
    },
    commit(label = 'edit') {
      if (JSON.stringify(baseline) === JSON.stringify(doc)) {
        baseline = cloneDocument(doc);
        return false;
      }
      past.push({ label, state: baseline });
      if (past.length > HISTORY_LIMIT) past.shift();
      future.length = 0;
      baseline = cloneDocument(doc);
      return true;
    },
    /** A mutation that already happened but should not create an undo step. */
    touch() {
      baseline = cloneDocument(doc);
    },
    /** Applies the previous state to `doc`; returns {label} or null. */
    undo() {
      const entry = past.pop();
      if (!entry) return null;
      future.push({ label: entry.label, state: cloneDocument(doc) });
      restore(entry.state);
      return entry;
    },
    redo() {
      const entry = future.pop();
      if (!entry) return null;
      past.push({ label: entry.label, state: cloneDocument(doc) });
      restore(entry.state);
      return entry;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() {
      past.length = 0;
      future.length = 0;
      baseline = cloneDocument(doc);
    },
  };
}
