/**
 * Import pipeline: neutral parsed geometry -> an editable VertexForge document.
 *
 * A file's raw vertex soup is not something you can model with. Three things
 * have to happen before the viewport is usable:
 *
 *   1. normalise the frame   - unit scale, up axis, optional centring
 *   2. weld the corners      - coincident positions become ONE vertex
 *   3. rebuild polygons      - flat triangle runs become n-gon faces
 *
 * All three are options because they are lossy in different directions: a CAD
 * brick wants welding and merging, a scanned point cloud wants neither. Large
 * imports default to "keep it simple" (weld on, merge off above a threshold) so
 * a 200k-triangle scan does not spend a minute in ear clipping before it appears.
 *
 * Pure core code: no three.js, no DOM, unit-testable.
 */

import { createDocument, addVertex, addEdge, addFace, vertexMap } from './model.js';
import { boundsOf, round } from './geometry.js';
import { weldPositions, mergeCoplanarTriangles, defaultWeldTolerance } from './merge.js';

/** Above this vertex count, handle drawing and picking get painful. */
export const LARGE_IMPORT_VERTS = 12_000;
/** Above this triangle count, coplanar merging is opt-in rather than automatic. */
export const LARGE_IMPORT_TRIS = 6_000;

/**
 * Rotate/scale positions into the editor's frame.
 *
 * @param {number[]} positions flat xyz (mutated copy returned)
 * @param {object} opts
 * @param {'y-up'|'z-up'} [opts.up] source up axis; 'z-up' swaps Y/Z (STL, CAD, 3ds Max)
 * @param {number} [opts.scale] uniform multiplier applied first
 * @param {boolean} [opts.center] put the bounding-box centre on the origin
 * @param {boolean} [opts.fit] scale so the model spans about this many units
 * @returns {{positions:number[], note:string}}
 */
export function normalisePositions(positions, opts = {}) {
  const scale = Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1;
  const swap = opts.up === 'z-up';
  const out = new Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] * scale;
    const y = positions[i + 1] * scale;
    const z = positions[i + 2] * scale;
    if (swap) {
      // Rotate -90deg about X: source Z becomes up, source Y becomes toward
      // the viewer. Right-handedness is preserved, so face windings stay valid.
      out[i] = x;
      out[i + 1] = z;
      out[i + 2] = -y;
    } else {
      out[i] = x;
      out[i + 1] = y;
      out[i + 2] = z;
    }
  }

  let note = '';
  const asVerts = toVertexObjects(out);
  const b = boundsOf(asVerts);

  if (opts.fit && b.radius > 0) {
    // "fit N" means the bounding RADIUS lands on N and the model is centred:
    // a 10-long bar with fit:2 becomes [-2, 2], not [0, 2]. Half-extent is the
    // intuitive quantity when the result is centred on the origin anyway.
    const target = Number(opts.fit);
    const k = target / b.radius;
    for (let i = 0; i < out.length; i++) out[i] *= k;
    const fb = boundsOf(toVertexObjects(out));
    for (let i = 0; i < out.length; i += 3) {
      out[i] -= fb.center[0];
      out[i + 1] -= fb.center[1];
      out[i + 2] -= fb.center[2];
    }
    note = `Scaled to fit ${round(target, 3)} units.`;
    return { positions: out, note };
  }
  if (opts.center && b.radius > 0) {
    for (let i = 0; i < out.length; i += 3) {
      out[i] -= b.center[0];
      out[i + 1] -= b.center[1];
      out[i + 2] -= b.center[2];
    }
  }
  return { positions: out, note };
}

function toVertexObjects(flat) {
  const out = new Array(flat.length / 3);
  for (let i = 0; i < out.length; i++) {
    out[i] = { x: flat[i * 3], y: flat[i * 3 + 1], z: flat[i * 3 + 2] };
  }
  return out;
}

/**
 * Build a document from parsed geometry.
 *
 * @param {object} parsed result of a formats.js reader
 * @param {object} [opts]
 * @param {'y-up'|'z-up'} [opts.up='y-up']
 * @param {number} [opts.scale=1]
 * @param {number|null} [opts.fit=null] target size in units (overrides center)
 * @param {boolean} [opts.center=true]
 * @param {boolean|number} [opts.weld=true] true = auto tolerance, or an explicit eps
 * @param {boolean} [opts.mergePolys=true] collapse flat triangle runs into n-gons
 * @param {boolean} [opts.keepEdges=false] also write every polygon boundary as an explicit edge
 * @param {string} [opts.name]
 * @param {string} [opts.mode='replace'] 'replace' or 'merge' into an existing doc
 * @param {object} [opts.doc] target document for mode 'merge'
 * @returns {{doc:object, stats:object}}
 */
export function buildDocument(parsed, opts = {}) {
  if (!parsed) throw new Error('Nothing was parsed.');
  const hasGeometry = parsed.positions.length >= 3;
  if (!hasGeometry) throw new Error('That file had no usable geometry.');

  const { positions: norm, note: fitNote } = normalisePositions(parsed.positions, {
    up: opts.up || 'y-up',
    scale: opts.scale ?? 1,
    center: opts.center !== false,
    fit: opts.fit ?? null,
  });

  // --- weld -------------------------------------------------------------
  const radius = Math.max(...boundsOf(toVertexObjects(norm)).size.map((v) => (Number.isFinite(v) ? v : 0)), 1e-6);
  const eps =
    opts.weld === false
      ? 0
      : typeof opts.weld === 'number' && Number.isFinite(opts.weld)
        ? Math.abs(opts.weld)
        : defaultWeldTolerance(radius);

  const { positions, remap, merged } = weldPositions(norm, eps, parsed.colors);
  const map = (i) => (i >= 0 && i < remap.length ? remap[i] : -1);
  const vcount = positions.length / 3;

  // Per-welded-vertex colour. weldPositions keeps the FIRST occurrence of a
  // duplicated corner, so walking the input in order and writing each output
  // slot once reproduces exactly that choice - the colour stays attached to the
  // same corner the geometry does.
  const src = parsed.colors;
  let wcolor = null;
  if (src && src.length >= 3) {
    wcolor = new Float32Array(vcount * 3);
    const filled = new Uint8Array(vcount);
    for (let i = 0; i < remap.length; i++) {
      const o = remap[i];
      if (o < 0 || o >= vcount || filled[o]) continue;
      filled[o] = 1;
      wcolor[o * 3] = src[i * 3] ?? 0;
      wcolor[o * 3 + 1] = src[i * 3 + 1] ?? 0;
      wcolor[o * 3 + 2] = src[i * 3 + 2] ?? 0;
    }
    // Unfilled slots (non-finite inputs dropped by welding) default to mid-grey.
    for (let i = 0; i < vcount; i++) {
      if (!filled[i]) wcolor[i * 3] = wcolor[i * 3 + 1] = wcolor[i * 3 + 2] = 0.5;
    }
  }

  /** Average a ring's vertex colours into one face hex, or null if uncoloured. */
  const ringColor = (ring) => {
    if (!wcolor || !ring.length) return null;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const i of ring) {
      r += wcolor[i * 3];
      g += wcolor[i * 3 + 1];
      b += wcolor[i * 3 + 2];
    }
    const n = ring.length;
    const q = (v) => Math.max(0, Math.min(255, Math.round((v / n) * 255)));
    const h = (v) => v.toString(16).padStart(2, '0');
    return `#${h(q(r))}${h(q(g))}${h(q(b))}`;
  };

  const reindexRing = (ring) => {
    const out = [];
    for (const raw of ring) {
      const i = map(raw);
      if (i < 0) continue;
      if (!out.length || out[out.length - 1] !== i) out.push(i);
    }
    if (out.length > 2 && out[0] === out[out.length - 1]) out.pop();
    return out;
  };

  // --- polygons ----------------------------------------------------------
  const rings = parsed.polygons.map(reindexRing).filter((r) => r.length >= 3);
  let tris = [];
  for (let i = 0; i + 2 < parsed.triangles.length; i += 3) {
    const ring = reindexRing([parsed.triangles[i], parsed.triangles[i + 1], parsed.triangles[i + 2]]);
    if (ring.length === 3) tris.push(ring[0], ring[1], ring[2]);
  }

  let groups = 0;
  let mergedTris = 0;
  const doMerge = opts.mergePolys !== false && tris.length / 3 <= LARGE_IMPORT_TRIS;
  if (doMerge && tris.length >= 6) {
    const res = mergeCoplanarTriangles(positions, tris);
    rings.push(...res.polygons);
    tris = res.triangles; // flat leftover indices: islands that refused to merge
    groups = res.groups;
    mergedTris = res.kept;
  }

  // Whatever is still a plain triangle becomes a 3-vertex face. Without this,
  // mergePolys:false produced vertices but NO faces at all, and a partially
  // merged mesh imported with holes in it.
  for (let i = 0; i + 2 < tris.length; i += 3) rings.push([tris[i], tris[i + 1], tris[i + 2]]);

  // --- edges (wire imports, and the optional explicit-outline pass) -------
  const linePairs = [];
  for (const [a, b] of parsed.lines || []) {
    const ia = map(a);
    const ib = map(b);
    if (ia >= 0 && ib >= 0 && ia !== ib) linePairs.push([ia, ib]);
  }

  // --- emit the document -------------------------------------------------
  // Honour a caller-supplied doc in BOTH modes: 'replace' overwrites its
  // contents in place (callers hold the identity for undo/history), 'merge'
  // appends to it. Without a doc, replace mode creates a fresh one.
  const doc = opts.doc && (opts.mode === 'merge' || opts.mode === 'replace') ? opts.doc : createDocument(opts.name || parsed.name || 'Imported');
  if (opts.mode !== 'merge' && doc.vertices.length) {
    // Guard against a caller passing a pre-populated doc in replace mode.
    doc.vertices = [];
    doc.edges = [];
    doc.faces = [];
  }
  doc.name = opts.name || parsed.name || doc.name || 'Imported';

  const ids = new Array(vcount);
  for (let i = 0; i < vcount; i++) {
    ids[i] = addVertex(doc, {
      x: round(positions[i * 3], 6),
      y: round(positions[i * 3 + 1], 6),
      z: round(positions[i * 3 + 2], 6),
    }).id;
  }

  // One id->vertex map for the whole batch: building it per addFace() is
  // O(vertices) each and turned a 17k-vertex import into ~50 seconds.
  const vmap = vertexMap(doc);

  let faces = 0;
  for (const ring of rings) {
    const f = addFace(doc, ring.map((i) => ids[i]), ringColor(ring), vmap);
    if (f) faces++;
  }

  const boundary = new Set();
  const addLine = (a, b) => {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (boundary.has(k)) return;
    boundary.add(k);
    if (addEdge(doc, ids[a], ids[b])) edgesAdded++;
  };
  let edgesAdded = 0;
  for (const [a, b] of linePairs) addLine(a, b);
  if (opts.keepEdges) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) addLine(ring[i], ring[(i + 1) % ring.length]);
    }
  }

  const stats = {
    vertices: vcount,
    merged,
    polygons: rings.length,
    polygonGroups: groups,
    triangles: mergedTris,
    faces,
    edges: edgesAdded,
    large: vcount > LARGE_IMPORT_VERTS,
    note: [fitNote, parsed.note].filter(Boolean).join(' '),
  };

  return { doc, stats };
}
