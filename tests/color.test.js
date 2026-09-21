import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDocument,
  addVertex,
  addFace,
  serialize,
  deserialize,
  cloneDocument,
  normalizeColor,
  setFaceColor,
  setFaceColors,
  getFace,
  DEFAULT_FACE_COLOR,
} from '../src/core/model.js';
import { buildMesh, buildColorGroups } from '../src/core/mesh.js';
import { extrudeFaces } from '../src/core/ops.js';

function squareDoc() {
  const doc = createDocument('Square');
  const a = addVertex(doc, { x: 0, y: 0, z: 0 });
  const b = addVertex(doc, { x: 1, y: 0, z: 0 });
  const c = addVertex(doc, { x: 1, y: 1, z: 0 });
  const d = addVertex(doc, { x: 0, y: 1, z: 0 });
  const e = addVertex(doc, { x: 2, y: 0, z: 0 });
  const f = addVertex(doc, { x: 2, y: 1, z: 0 });
  const f1 = addFace(doc, [a.id, b.id, c.id, d.id]);
  const f2 = addFace(doc, [b.id, e.id, f.id, c.id]);
  return { doc, f1, f2 };
}

/* ---------- normalizeColor ---------- */

test('normalizeColor accepts and canonicalises the usual spellings', () => {
  assert.equal(normalizeColor('#ff0000'), '#ff0000');
  assert.equal(normalizeColor('#F00'), '#ff0000');
  assert.equal(normalizeColor('f00'), '#ff0000');
  assert.equal(normalizeColor('  #00FF00  '), '#00ff00');
  assert.equal(normalizeColor('rgb(255,0,0)'), '#ff0000');
  assert.equal(normalizeColor('rgba(0, 255, 0, 0.5)'), '#00ff00');
  assert.equal(normalizeColor([1, 0, 0]), '#ff0000'); // importers emit 0-1
  assert.equal(normalizeColor([255, 128, 0]), '#ff8000');
});

test('normalizeColor returns null for junk, not a wrong colour', () => {
  for (const bad of [null, undefined, '', 'not a colour', '#12', 'rgb()', 42, [1], {}]) {
    assert.equal(normalizeColor(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('normalizeColor clamps out-of-range channels', () => {
  assert.equal(normalizeColor([300, -20, 128]), '#ff0080');
});

test('normalizeColor picks the 0-1 vs 0-255 scale once, from the biggest channel', () => {
  assert.equal(normalizeColor([0.5, 0, 1]), '#8000ff'); // all <= 1 -> 0-1 scale
  // A component above 1 means the whole array is 0-255, so the sub-1 channels
  // are NOT treated as fractions. Deciding per channel would invent a colour.
  assert.equal(normalizeColor([1.5, 0.0, 0.5]), '#020001');
});

/* ---------- document layer ---------- */

test('addFace stores a normalised colour, and only when valid', () => {
  const doc = createDocument();
  const ids = [0, 1, 2].map((i) => addVertex(doc, { x: i, y: i * i, z: 0 }).id);
  assert.equal(addFace(doc, ids, '#F00').color, '#ff0000');
  assert.equal(addFace(doc, [ids[1], ids[0], ids[2]], 'garbage').color, undefined);
});

test('setFaceColor paints and clears', () => {
  const { doc, f1 } = squareDoc();
  assert.equal(setFaceColor(doc, f1.id, '#00ff00'), true);
  assert.equal(getFace(doc, f1.id).color, '#00ff00');
  setFaceColor(doc, f1.id, null);
  assert.equal('color' in getFace(doc, f1.id), false, 'clearing removes the key entirely');
  assert.equal(setFaceColor(doc, 'ghost', '#000000'), false);
});

test('setFaceColors counts only real changes', () => {
  const { doc, f1, f2 } = squareDoc();
  assert.equal(setFaceColors(doc, [f1.id, f2.id], '#ff0000'), 2);
  assert.equal(setFaceColors(doc, [f1.id, f2.id], '#ff0000'), 0, 'repainting the same colour is a no-op');
  assert.equal(setFaceColors(doc, [f1.id, 'ghost'], null), 1);
});

/* ---------- persistence ---------- */

test('colour round-trips through JSON; colourless docs serialise without the key', () => {
  const { doc, f1 } = squareDoc();
  assert.equal('color' in serialize(doc).faces[0], false);
  setFaceColor(doc, f1.id, '#ff8800');
  const raw = serialize(doc);
  assert.equal(raw.faces[0].color, '#ff8800');
  const back = deserialize(structuredClone(raw)).doc;
  assert.equal(back.faces[0].color, '#ff8800');
});

test('deserialize sanitises hostile colour values', () => {
  const raw = serialize(squareDoc().doc);
  raw.faces[0].color = { toString: () => '#000000' };
  assert.equal(deserialize(raw).doc.faces[0].color, undefined);
  raw.faces[0].color = '#zzzzzz';
  assert.equal(deserialize(raw).doc.faces[0].color, undefined);
});

test('cloneDocument keeps colour, so undo/redo restores it', () => {
  const { doc, f1 } = squareDoc();
  setFaceColor(doc, f1.id, '#123456');
  const copy = cloneDocument(doc);
  assert.equal(copy.faces.find((f) => f.id === f1.id).color, '#123456');
});

/* ---------- mesh layer ---------- */

test('buildMesh: uncoloured document is one material and no groups', () => {
  const m = buildMesh(squareDoc().doc);
  assert.deepEqual(m.colors, [DEFAULT_FACE_COLOR]);
  assert.equal(m.groups, null, 'groups:null lets the renderer use a single material');
});

test('buildMesh: colours become a palette plus contiguous groups', () => {
  const { doc, f1, f2 } = squareDoc();
  setFaceColor(doc, f1.id, '#ff0000');
  setFaceColor(doc, f2.id, '#00ff00');
  const m = buildMesh(doc);
  assert.deepEqual(m.colors, [DEFAULT_FACE_COLOR, '#ff0000', '#00ff00']);

  // Groups must tile the index buffer exactly, in order.
  let cursor = 0;
  for (const g of m.groups) {
    assert.equal(g.start, cursor, 'groups are contiguous and start at 0');
    assert.equal(g.count % 3, 0, 'count is whole triangles');
    cursor += g.count;
  }
  assert.equal(cursor, m.indices.length, 'every triangle is covered by a group');

  // Every triangle in a group uses that group's colour.
  for (const g of m.groups) {
    const want = m.colors[g.materialIndex];
    for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) {
      assert.equal(m.colors[m.triColor[t]], want);
    }
  }
});

test('buildMesh: triangle order is untouched by colour, so triFace picking holds', () => {
  const { doc, f1 } = squareDoc();
  const before = buildMesh(doc);
  setFaceColor(doc, f1.id, '#ff0000');
  const after = buildMesh(doc);
  assert.deepEqual(Array.from(after.indices), Array.from(before.indices));
  assert.deepEqual(Array.from(after.triFace), Array.from(before.triFace));
});

test('buildColorGroups: single colour needs no groups', () => {
  assert.equal(buildColorGroups([0, 0, 0], 1), null);
  assert.equal(buildColorGroups([], 3), null);
});

/* ---------- ops ---------- */

test('extrude carries colour onto the side walls', () => {
  const doc = createDocument('Extrude me');
  const a = addVertex(doc, { x: 0, y: 0, z: 0 });
  const b = addVertex(doc, { x: 1, y: 0, z: 0 });
  const c = addVertex(doc, { x: 1, y: 1, z: 0 });
  const face = addFace(doc, [a.id, b.id, c.id], '#ff0000');
  const res = extrudeFaces(doc, [face.id], 0.5);
  assert.ok(res.created > 0, 'extrusion produced walls');
  assert.ok(
    res.faces.every((f) => f.color === '#ff0000'),
    'every wall inherits the cap colour',
  );
});

/* ---------- import colour regressions (Playwright-debugged 2026-09-20) ---------- */

import { parseOBJ, parsePLY, parseGLTF, parseAny } from '../src/core/formats.js';
import { buildDocument } from '../src/core/importer.js';

const bytes = (s) => { const b = new TextEncoder().encode(s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

test('OBJ "v x y z r g b" imports colour and keeps geometry unwarped', () => {
  // The old parser read r as homogeneous w: colours vanished AND the mesh was
  // silently rescaled by 1/r. Both must hold now.
  const obj = parseOBJ(
    ['v 0 0 0 0.8 0.1 0.1', 'v 4 0 0 0.8 0.1 0.1', 'v 4 4 0 0.8 0.1 0.1', 'v 0 4 0 0.8 0.1 0.1', 'f 1 2 3 4'].join('\n'),
  );
  assert.ok(obj.colors, 'vertex colours must reach the parsed mesh');
  // 8-bit-looking values (any channel > 1) divide by 255; these are 0-1 floats.
  const { doc } = buildDocument(obj, { center: false, scale: 1 });
  const xs = doc.vertices.map((v) => v.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 3.9, 'square stays 4 units wide, not rescaled by 1/0.8');
  assert.equal(doc.faces[0].color, '#cc1a1a');
});

test('OBJ 0-255 vertex colours scale the whole file by its max channel', () => {
  const obj = parseOBJ(
    ['v 0 0 0 255 0 0', 'v 1 0 0 255 0 0', 'v 1 1 0 255 0 0', 'f 1 2 3'].join('\n'),
  );
  const { doc } = buildDocument(obj, { center: false, scale: 1 });
  assert.equal(doc.faces[0].color, '#ff0000');
});

test('PLY uchar colour scale comes from the header, not the values', () => {
  // A dark-scan file: uchar (1,0,0) is near-black red. The old per-vertex
  // "any channel above 1?" heuristic read it as full-brightness #ff0000.
  const ply = [
    'ply', 'format ascii 1.0', 'element vertex 3',
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue',
    'element face 1', 'property list uchar int vertex_indices', 'end_header',
    '0 0 0 1 0 0', '1 0 0 2 0 0', '1 1 0 2 0 0',
    '3 0 1 2',
  ].join('\n');
  const parsed = parsePLY(bytes(ply));
  const { doc } = buildDocument(parsed, { center: false, scale: 1 });
  const [r, g, b] = [1, 2, 0].map(() => 0); // silence
  assert.equal(doc.faces[0].color, '#020000', 'uchar 1..2 means 1..2/255, not full brightness');
});

test('PLY float colour stays 0-1', () => {
  const ply = [
    'ply', 'format ascii 1.0', 'element vertex 3',
    'property float x', 'property float y', 'property float z',
    'property float red', 'property float green', 'property float blue',
    'element face 1', 'property list uchar int vertex_indices', 'end_header',
    '0 0 0 1 0 0', '1 0 0 1 0 0', '1 1 0 1 0 0',
    '3 0 1 2',
  ].join('\n');
  const { doc } = buildDocument(parsePLY(bytes(ply)), { center: false, scale: 1 });
  assert.equal(doc.faces[0].color, '#ff0000');
});

test('glTF linear colour is encoded to sRGB before it becomes a hex', () => {
  // glTF 0.5 linear grey is display #bcbcbc, NOT #808080.
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const col = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  const bp = new Uint8Array(pos.buffer);
  const bc = new Uint8Array(col.buffer);
  const all = new Uint8Array(bp.length + bc.length);
  all.set(bp, 0);
  all.set(bc, bp.length);
  const b64 = btoa(String.fromCharCode(...all));
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: all.length, uri: 'data:application/octet-stream;base64,' + b64 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: bp.length },
      { buffer: 0, byteOffset: bp.length, byteLength: bc.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const { doc } = buildDocument(parseGLTF(structuredClone(json), new Map(), 't.gltf'), { center: false, scale: 1 });
  assert.equal(doc.faces[0].color, '#bcbcbc');
});

test('glTF material baseColorFactor (linear) is encoded too, white still means none', () => {
  const json = {
    asset: { version: '2.0' },
    buffers: [],
    accessors: [],
    meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2383, 0.0452, 0.0452, 1] } }],
  };
  // Build a tiny POSITION-only primitive instead: reuse the COLOR_0 test layout.
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bp = new Uint8Array(pos.buffer);
  const b64 = btoa(String.fromCharCode(...bp));
  json.buffers = [{ byteLength: bp.length, uri: 'data:application/octet-stream;base64,' + b64 }];
  json.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: bp.length }];
  json.accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }];
  json.meshes[0].primitives[0].attributes = { POSITION: 0 };
  json.materials[0].pbrMetallicRoughness.baseColorFactor = [0.5, 0.5, 0.5, 1];
  const { doc } = buildDocument(parseGLTF(json, new Map(), 'm.gltf'), { center: false, scale: 1 });
  assert.equal(doc.faces[0].color, '#bcbcbc', 'linear 0.5 grey from a MATERIAL reads as #bcbcbc');

  const jsonW = structuredClone(json);
  jsonW.materials[0].pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
  const { doc: docW } = buildDocument(parseGLTF(jsonW, new Map(), 'w.gltf'), { center: false, scale: 1 });
  assert.equal(docW.faces[0].color, undefined, 'pure white material stays uncoloured');
});

/* ---------- save/load round-trip (the reported "colours vanish on reload") ---------- */

import { weldPositions } from '../src/core/merge.js';

test('weld keeps coincident corners apart when their colours differ', () => {
  const pos = [0, 0, 0, 0, 0, 0, 1, 0, 0];
  const same = weldPositions(pos, 1e-4, [1, 0, 0, 1, 0, 0, 1, 0, 0]);
  assert.equal(same.merged, 1, 'identical colours still weld');
  const diff = weldPositions(pos, 1e-4, [1, 0, 0, 0, 0, 1, 1, 0, 0]);
  assert.equal(diff.merged, 0, 'red and blue on the same corner must not merge');
  assert.equal(diff.positions.length / 3, 3);
});

test('buildDocument keeps both colours of a corner shared by two materials', () => {
  // Exactly what parseGLTF emits for a multi-material glTF that shares one
  // POSITION accessor: the duplicated corner is welded back to one vertex,
  // and whichever colour happened to be written first used to win for ALL
  // faces touching it - a red-and-blue cube re-imported as an all-red cube.
  const doc = createDocument('TwoTone');
  const A = addVertex(doc, { x: 0, y: 0, z: 0 });
  const B = addVertex(doc, { x: 1, y: 0, z: 0 });
  const C = addVertex(doc, { x: 1, y: 1, z: 0 });
  const D = addVertex(doc, { x: 0, y: 1, z: 0 });
  addFace(doc, [A.id, B.id, C.id], '#ff0000');
  addFace(doc, [A.id, C.id, D.id], '#0000ff');
  const parsed = {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0],
    colors: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    polygons: [],
    triangles: [0, 1, 2, 3, 4, 5],
    lines: [],
  };
  const { doc: out } = buildDocument(parsed, { center: false, scale: 1 });
  const hexes = out.faces.map((f) => f.color);
  assert.equal(hexes.length, 2);
  assert.notEqual(hexes[0], hexes[1], 'the two triangles keep their own colour');
  assert.ok(hexes.includes('#ff0000') && hexes.includes('#0000ff'), JSON.stringify(hexes));
});

test('paint -> exportJSON -> deserialize round-trips colour through the real serialiser', () => {
  const { doc, f1, f2 } = squareDoc();
  setFaceColors(doc, [f1.id], '#e05a4e');
  const raw = serialize(doc);
  const text = JSON.stringify(raw); // what exportJSON writes to disk
  const back = deserialize(JSON.parse(text)).doc;
  assert.equal(back.faces.find((f) => f.id === f1.id).color, '#e05a4e');
  assert.equal(back.faces.find((f) => f.id === f2.id).color, undefined);
  // and the reloaded document still drives the mesh palette correctly
  const m = buildMesh(back);
  assert.ok(m.colors.includes('#e05a4e'));
});
