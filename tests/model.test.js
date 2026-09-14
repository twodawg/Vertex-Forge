import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDocument,
  addVertex,
  addEdge,
  addFace,
  removeVertex,
  removeEdge,
  removeFace,
  findEdge,
  getVertex,
  setVertexPosition,
  translateAll,
  centerOnOrigin,
  allEdgePairs,
  edgeUseCount,
  validate,
  serialize,
  deserialize,
  cloneDocument,
  createHistory,
  unifyWinding,
  flipAllFaces,
} from '../src/core/model.js';
import { buildMesh, isWatertight } from '../src/core/mesh.js';
import { makeCube, makePlane, makeTetra } from '../src/core/primitives.js';

/* ---------- document basics ---------- */

test('a fresh document is empty but valid', () => {
  const doc = createDocument('Empty');
  assert.equal(doc.vertices.length, 0);
  const v = validate(doc);
  assert.equal(v.errors.length, 0, 'empty is not an error');
  assert.ok(v.warnings.length > 0);
});

test('ids are unique across a session', () => {
  const doc = createDocument();
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(addVertex(doc, { x: i, y: 0, z: 0 }).id);
  assert.equal(ids.size, 500);
});

test('addVertex rounds coordinates to tame float noise', () => {
  const doc = createDocument();
  const v = addVertex(doc, { x: 0.1 + 0.2, y: -0, z: 1.0000000001 });
  assert.equal(v.x, 0.3);
  assert.equal(v.z, 1);
  assert.ok(Object.is(v.y, 0), 'no negative zero written');
});

test('addEdge rejects self-loops, missing vertices, and duplicates', () => {
  const doc = createDocument();
  const a = addVertex(doc, { x: 0, y: 0, z: 0 });
  const b = addVertex(doc, { x: 1, y: 0, z: 0 });
  assert.equal(addEdge(doc, a.id, a.id), null);
  assert.equal(addEdge(doc, a.id, 'nope'), null);
  const e1 = addEdge(doc, a.id, b.id);
  const e2 = addEdge(doc, b.id, a.id);
  assert.equal(e1.id, e2.id, 'order-insensitive dedupe');
  assert.equal(doc.edges.length, 1);
});

test('addFace rejects rings that are too short, repeated, or reference missing verts', () => {
  const doc = createDocument();
  const v = [0, 1, 2].map((i) => addVertex(doc, { x: i, y: 0, z: 0 }));
  assert.equal(addFace(doc, [v[0].id, v[1].id]), null);
  assert.equal(addFace(doc, [v[0].id, v[0].id, v[1].id]), null);
  assert.equal(addFace(doc, [v[0].id, v[1].id, 'ghost']), null);
  assert.equal(addFace(doc, 'not an array'), null);
  assert.ok(addFace(doc, [v[0].id, v[1].id, v[2].id]));
});

test('removing a vertex cascades out its edges and short faces', () => {
  const doc = createDocument();
  const v = [0, 1, 2, 3].map((i) => addVertex(doc, { x: i, y: i % 2, z: 0 }));
  addEdge(doc, v[0].id, v[1].id);
  addEdge(doc, v[2].id, v[3].id);
  addFace(doc, [v[0].id, v[1].id, v[2].id]); // becomes a 2-ring -> dropped
  addFace(doc, [v[0].id, v[1].id, v[2].id, v[3].id]); // becomes a 3-ring -> kept

  assert.equal(removeVertex(doc, v[2].id), true);
  assert.equal(doc.edges.length, 1);
  assert.equal(doc.faces.length, 1);
  assert.equal(doc.faces[0].loop.length, 3);
  assert.equal(removeVertex(doc, 'ghost'), false);
});

test('allEdgePairs merges explicit edges with face boundaries', () => {
  const doc = makeTetra();
  const pairs = allEdgePairs(doc);
  assert.equal(pairs.length, 6, 'a tetra has 6 edges');
  assert.equal(doc.edges.length, 6);
});

test('edgeUseCount counts faces that use the edge, ignoring explicit edge records', () => {
  const doc = makeTetra();
  const L = doc.faces[0].loop;
  // Every tetra edge borders exactly two faces.
  assert.equal(edgeUseCount(doc, L[0], L[1]), 2);
  assert.equal(edgeUseCount(doc, L[1], L[2]), 2);
  // A pair that is not an edge at all is used by nothing.
  const v = addVertex(doc, { x: 50, y: 50, z: 50 });
  assert.equal(edgeUseCount(doc, v.id, L[0]), 0);
});

/* ---------- transforms ---------- */

test('translateAll and centerOnOrigin keep the shape', () => {
  const doc = makeCube();
  const before = doc.vertices.map((v) => [v.x, v.y, v.z]);
  translateAll(doc, 5, -3, 2);
  const after = doc.vertices.map((v) => [v.x, v.y, v.z]);
  // Same relative offsets.
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs(after[i][0] - before[i][0] - 5) < 1e-9);
  }
  centerOnOrigin(doc);
  const c = doc.vertices.reduce((s, v) => [s[0] + v.x, s[1] + v.y, s[2] + v.z], [0, 0, 0]);
  const n = doc.vertices.length;
  assert.ok(Math.abs(c[0] / n) < 1e-9 && Math.abs(c[1] / n) < 1e-9 && Math.abs(c[2] / n) < 1e-9);
});

test('setVertexPosition rounds to 6 decimals and ignores ghosts', () => {
  const doc = createDocument();
  const v = addVertex(doc, { x: 0, y: 0, z: 0 });
  assert.equal(setVertexPosition(doc, v.id, 1.0000001, 2, 3), true);
  assert.equal(getVertex(doc, v.id).x, 1, 'rounded at the 6th decimal');
  assert.equal(setVertexPosition(doc, v.id, 1.23456789, 0, 0), true);
  assert.equal(getVertex(doc, v.id).x, 1.234568);
  assert.equal(setVertexPosition(doc, 'ghost', 0, 0, 0), false);
});

/* ---------- winding ---------- */

test('flipAllFaces reverses every ring', () => {
  const doc = makeCube();
  const first = [...doc.faces[0].loop];
  flipAllFaces(doc);
  assert.deepEqual(doc.faces[0].loop, [...first].reverse());
});

test('unifyWinding makes shared edges traverse in opposite directions', () => {
  const doc = makeCube();
  // Deliberately break one face.
  doc.faces[2].loop.reverse();
  const res = unifyWinding(doc);
  assert.ok(res.flipped >= 1, 'at least the broken face was repaired');

  const dir = new Map();
  for (const f of doc.faces) {
    const L = f.loop;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      const b = L[(i + 1) % L.length];
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!dir.has(k)) dir.set(k, new Set());
      dir.get(k).add(`${a}>${b}`);
    }
  }
  for (const [k, set] of dir) {
    if (set.size === 2) continue; // consistently opposed
    assert.equal(set.size, 1, `edge ${k} is used ${[...set].join(', ')}`);
  }
});

/* ---------- validation ---------- */

test('validate reports an open mesh as a warning and non-manifold as an error', () => {
  const doc = makePlane(); // one shared interior edge among 4 quads, boundary open
  const v = validate(doc);
  assert.ok(v.boundaryEdges > 0, 'plane has an open boundary');
  assert.equal(v.errors.filter((e) => /non-manifold/.test(e)).length, 0);

  // Three faces sharing one edge => non-manifold.
  const bad = createDocument();
  const p = [
    addVertex(bad, { x: 0, y: 0, z: 0 }),
    addVertex(bad, { x: 1, y: 0, z: 0 }),
    addVertex(bad, { x: 0, y: 1, z: 0 }),
    addVertex(bad, { x: 0, y: 0, z: 1 }),
    addVertex(bad, { x: 1, y: 1, z: 1 }),
  ];
  addFace(bad, [p[0].id, p[1].id, p[2].id]);
  addFace(bad, [p[0].id, p[1].id, p[3].id]);
  addFace(bad, [p[0].id, p[1].id, p[4].id]);
  assert.ok(validate(bad).errors.some((e) => /non-manifold/.test(e)));
});

test('validate catches dangling references and bad geometry', () => {
  const doc = makeTetra();
  doc.faces.push({ id: 'fghost', loop: ['nope', 'nah', 'nada'] });
  doc.edges.push({ id: 'eghost', a: 'nope', b: 'nah' });
  doc.edges.push({ id: 'eloop', a: doc.vertices[0].id, b: doc.vertices[0].id });
  doc.vertices.push({ id: doc.vertices[0].id, x: 0, y: 0, z: 0 });
  const v = validate(doc);
  assert.ok(v.errors.length >= 3, v.errors.join('; '));
});

/* ---------- serialization ---------- */

test('serialize -> deserialize round-trips exactly', () => {
  const doc = makeCube();
  const back = deserialize(serialize(doc)).doc;
  assert.deepEqual(back.vertices, doc.vertices);
  assert.deepEqual(back.edges, doc.edges);
  assert.deepEqual(back.faces, doc.faces);
});

test('deserialize accepts foreign index-based meshes', () => {
  const raw = {
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    faces: [[0, 1, 2]],
  };
  const { doc, foreign } = deserialize(raw);
  assert.equal(foreign, true);
  assert.equal(doc.vertices.length, 3);
  assert.equal(doc.faces.length, 1);
  // All face references resolve.
  const ids = new Set(doc.vertices.map((v) => v.id));
  assert.ok(doc.faces[0].loop.every((id) => ids.has(id)));
});

test('deserialize rejects a foreign format and prunes broken references', () => {
  assert.throws(() => deserialize({ format: 'other-thing', vertices: [] }), /Not a Vertex Forge file/);
  assert.throws(() => deserialize(null), /Expected a JSON object/);

  const doc = deserialize({
    format: 'vertex-forge',
    version: 1,
    vertices: [{ id: 'v1', x: 0, y: 0, z: 0 }, { id: 'v2', x: 1, y: 0, z: 0 }, { id: 'v3', x: 0, y: 1, z: 0 }],
    edges: [{ id: 'e1', a: 'v1', b: 'ghost' }, { id: 'e2', a: 'v1', b: 'v2' }],
    faces: [{ id: 'f1', loop: ['v1', 'v2', 'ghost'] }, { id: 'f2', loop: ['v1', 'v2', 'v3'] }],
  }).doc;
  assert.equal(doc.edges.length, 1, 'dangling edge dropped');
  assert.equal(doc.faces.length, 1, 'face with a missing vertex dropped');
});

test('cloneDocument is a deep copy', () => {
  const doc = makeTetra();
  const copy = cloneDocument(doc);
  copy.vertices[0].x = 99;
  copy.faces[0].loop.push('junk');
  assert.notEqual(doc.vertices[0].x, 99);
  assert.equal(doc.faces[0].loop.includes('junk'), false);
});

/* ---------- history ---------- */

test('history begin/commit/undo/redo restores state', () => {
  const doc = createDocument();
  const hist = createHistory(doc);

  hist.begin();
  addVertex(doc, { x: 1, y: 2, z: 3 });
  assert.equal(hist.commit('add'), true);
  assert.equal(doc.vertices.length, 1);

  assert.equal(hist.undo().label, 'add');
  assert.equal(doc.vertices.length, 0, 'undo applied the snapshot to the doc');

  assert.equal(hist.redo().label, 'add');
  assert.equal(doc.vertices.length, 1);
  assert.equal(doc.vertices[0].x, 1);
});

test('undo then new edits clears redo', () => {
  const doc = createDocument();
  const hist = createHistory(doc);
  hist.begin(); addVertex(doc, { x: 0, y: 0, z: 0 }); hist.commit('one');
  hist.begin(); addVertex(doc, { x: 1, y: 1, z: 1 }); hist.commit('two');
  hist.undo();
  assert.equal(hist.canRedo(), true);
  hist.begin(); addVertex(doc, { x: 2, y: 2, z: 2 }); hist.commit('branch');
  assert.equal(hist.canRedo(), false);
});

test('a commit with no actual change does not pollute the stack', () => {
  const doc = createDocument();
  const hist = createHistory(doc);
  hist.begin();
  assert.equal(hist.commit('noop'), false);
  assert.equal(hist.canUndo(), false);
});

test('undo snapshots are immune to later mutation of the live document', () => {
  const doc = createDocument();
  const hist = createHistory(doc);

  hist.begin();
  const v1 = addVertex(doc, { x: 1, y: 1, z: 1 });
  hist.commit('one');
  hist.begin();
  addVertex(doc, { x: 2, y: 2, z: 2 });
  hist.commit('two');

  // Corrupt the live document, including the object the snapshot refers to.
  v1.x = 500;
  doc.vertices.length = 0;

  hist.undo();
  assert.equal(doc.vertices.length, 1, 'restored the state after the first commit');
  assert.equal(doc.vertices[0].x, 1, 'snapshot was not aliased to live objects');
});

test('history respects its cap', () => {
  const doc = createDocument();
  const hist = createHistory(doc);
  for (let i = 0; i < 140; i++) {
    hist.begin();
    addVertex(doc, { x: i, y: 0, z: 0 });
    hist.commit(`v${i}`);
  }
  let undos = 0;
  while (hist.undo()) undos++;
  assert.equal(undos, 100, 'HISTORY_LIMIT');
});

/* ---------- mesh build ---------- */

test('buildMesh: cube gives 8 verts, 12 tris, 12 unique edges', () => {
  const doc = makeCube();
  const m = buildMesh(doc);
  assert.equal(m.positions.length / 3, 8);
  assert.equal(m.triangleCount, 12, '6 quads -> 12 triangles');
  assert.equal(m.indices.length, 36);
  assert.equal(m.edgePairs.length, 12);
  assert.equal(m.edgeIndices.length, 24);
});

test('buildMesh indices stay inside the position pool', () => {
  const doc = makeCube();
  doc.faces[0].loop[0] = 'ghost'; // hand-corrupt the doc
  const m = buildMesh(doc);
  const n = m.positions.length / 3;
  for (const i of m.indices) assert.ok(i >= 0 && i < n);
});

test('every triangle in a closed cube points outward from the centre', () => {
  const doc = makeCube();
  const m = buildMesh(doc);
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    const n = [
      (b[1] - a[1]) * (c[2] - b[2]) - (b[2] - a[2]) * (c[1] - b[1]),
      (b[2] - a[2]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[2] - b[2]),
      (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]),
    ];
    const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const outward = n[0] * centroid[0] + n[1] * centroid[1] + n[2] * centroid[2];
    assert.ok(outward > 0, 'face normal points away from the origin');
  }
});

test('buildMesh bounds use the vertex objects, not undefined array reads', () => {
  const doc = makeCube();
  const m = buildMesh(doc);
  assert.deepEqual(m.bounds.min, [-0.5, -0.5, -0.5]);
  assert.deepEqual(m.bounds.max, [0.5, 0.5, 0.5]);
  assert.equal(doc.vertices.length, 8);
});

test('triFace maps every triangle back to a real face id', () => {
  const doc = makeCube();
  const m = buildMesh(doc);
  const ids = new Set(doc.faces.map((f) => f.id));
  assert.equal(m.triFace.length, m.triangleCount);
  for (const id of m.triFace) assert.ok(ids.has(id));
});

test('isWatertight distinguishes closed solids from open sheets', () => {
  assert.equal(isWatertight(makeCube()), true);
  assert.equal(isWatertight(makeTetra()), true);
  assert.equal(isWatertight(makePlane()), false);
  assert.equal(isWatertight(createDocument()), false, 'no faces is not watertight');

  const holed = makeCube();
  holed.faces.pop();
  assert.equal(isWatertight(holed), false, 'one missing face opens the mesh');
});

test('primitives are internally consistent', () => {
  for (const build of [makeCube, makePlane, makeTetra]) {
    const doc = build();
    const ids = new Set(doc.vertices.map((v) => v.id));
    assert.ok(doc.vertices.length > 0);
    assert.ok(doc.faces.length > 0);
    for (const f of doc.faces) {
      assert.ok(f.loop.length >= 3);
      assert.ok(new Set(f.loop).size === f.loop.length, 'no repeated corners');
      assert.ok(f.loop.every((id) => ids.has(id)), 'all corners exist');
    }
    assert.equal(validate(doc).errors.length, 0, `${doc.name} should validate`);
  }
});

test('makePlane grid counts match request', () => {
  const doc = makePlane(undefined, { cols: 3, rows: 2 });
  assert.equal(doc.vertices.length, 4 * 3);
  assert.equal(doc.faces.length, 6);
});
