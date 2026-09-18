import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOBJ,
  parseSTL,
  parsePLY,
  parseGLTF,
  parseGLBContainer,
  parseAny,
  extOf,
  ImportError,
} from '../src/core/formats.js';
import { weldPositions, mergeCoplanarTriangles, defaultWeldTolerance } from '../src/core/merge.js';
import { buildDocument, normalisePositions } from '../src/core/importer.js';
import { importFile, stemOf } from '../src/ui/io.js';
import { makeCube } from '../src/core/primitives.js';
import { validate } from '../src/core/model.js';

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** Minimal File stand-in: importFile needs .name, .size, .arrayBuffer() and .text(). */
function fakeFile(name, bytes) {
  const asText = typeof bytes === 'string' ? bytes : null;
  const u8 = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  const ab = () => Promise.resolve(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length));
  return {
    name,
    size: u8.length,
    arrayBuffer: ab,
    text: () => (asText !== null ? Promise.resolve(asText) : ab().then((b) => new TextDecoder().decode(b))),
  };
}

function ascii(text) {
  return new TextEncoder().encode(text);
}

/** A unit square split into two triangles, as detached binary-STL facets. */
function binarySTL(facets) {
  const buf = new ArrayBuffer(84 + facets.length * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(new TextEncoder().encode('Binary STL written by the test suite'));
  view.setUint32(80, facets.length, true);
  let o = 84;
  for (const [n, verts] of facets) {
    for (const v of n) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    for (const v of verts) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}

/** A square (4 verts, 2 tris) in the XY plane, with optional Y offsets. */
function squareFacets() {
  return [
    [[0, 0, 1], [0, 0, 0, 1, 0, 0, 1, 1, 0]],
    [[0, 0, 1], [0, 0, 0, 1, 1, 0, 0, 1, 0]],
  ];
}

function glb(jsonBytes, binBytes) {
  const pad = (n, b) => Math.ceil(n / 4) * 4 - n;
  const json = jsonBytes.length + pad(jsonBytes.length, 0x20);
  const bin = binBytes.length + pad(binBytes.length, 0);
  const total = 12 + 8 + json + 8 + bin;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + json);

  const o = 20 + json;
  view.setUint32(o, binBytes.length, true);
  view.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
  bytes.set(binBytes, o + 8);
  bytes.fill(0, o + 8 + binBytes.length, o + 8 + bin);
  return bytes;
}

/** glb of a unit square: positions f32[12], indices u16[6]. */
function squareGLB() {
  const bin = new ArrayBuffer(48 + 12);
  const dv = new DataView(bin);
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  for (let i = 0; i < pos.length; i++) dv.setFloat32(i * 4, pos[i], true);
  const idx = [0, 1, 2, 0, 2, 3];
  for (let i = 0; i < idx.length; i++) dv.setUint16(48 + i * 2, idx[i], true);

  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 12 },
    ],
    buffers: [{ byteLength: 60 }],
  };
  return glb(ascii(JSON.stringify(json)), new Uint8Array(bin));
}

/* ------------------------------------------------------------------ *
 * extOf / dispatch
 * ------------------------------------------------------------------ */

test('extOf lowercases and strips the extension', () => {
  assert.equal(extOf('model.STL'), 'stl');
  assert.equal(extOf('a.b.glb'), 'glb');
  assert.equal(extOf('noext'), '');
  assert.equal(extOf(''), '');
});

test('stemOf drops the extension for the document name', () => {
  assert.equal(stemOf('widget.SLDPRT.stl'), 'widget.SLDPRT');
  assert.equal(stemOf('plain'), 'plain');
});

test('parseAny routes by extension and by content', () => {
  const obj = parseAny('x.obj', ascii('v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n'));
  assert.equal(obj.kind, 'OBJ');

  // No extension: sniffed from bytes.
  const sniffed = parseAny('mystery', ascii('v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n'));
  assert.equal(sniffed.kind, 'OBJ');

  const stl = parseAny('mystery', binarySTL(squareFacets()));
  assert.equal(stl.kind, 'STL');

  const glbParsed = parseAny('model.glb', squareGLB());
  assert.equal(glbParsed.kind, 'glTF');
});

test('parseAny gives a readable error for junk', () => {
  assert.throws(() => parseAny('note.txt', ascii('hello there')), ImportError);
});

/* ------------------------------------------------------------------ *
 * OBJ
 * ------------------------------------------------------------------ */

test('OBJ: n-gons survive as polygons, not fan triangles', () => {
  const r = parseOBJ('# c\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
  assert.deepEqual(r.polygons, [[0, 1, 2, 3]]);
  assert.equal(r.triangles.length, 0);
});

test('OBJ: negative and v/vt/vn indices resolve', () => {
  const r = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nf -3/-1/-1 f -2 f -1\n');
  assert.deepEqual(r.polygons, [[0, 1, 2]]);
});

test('OBJ: a corner with two normals stays two vertices', () => {
  const r = parseOBJ(
    'v 0 0 0\nv 1 0 0\nv 1 1 0\nvn 0 0 1\nvn 0 0 -1\nf 1//1 2//1 3//1\nf 1//2 3//2 2//2\n',
  );
  assert.equal(r.positions.length / 3, 5); // v1 duplicated, v2/v3 shared
});

test('OBJ: lines import as edges', () => {
  const r = parseOBJ('v 0 0 0\nv 1 0 0\nv 2 0 0\nl 1 2 3\n');
  assert.deepEqual(r.lines, [
    [0, 1],
    [1, 2],
  ]);
});

test('OBJ: unused v lines are not imported', () => {
  const r = parseOBJ('v 9 9 9\nv 0 0 0\nv 1 0 0\nv 1 1 0\nf 2 3 4\n');
  assert.equal(r.positions.length / 3, 3);
});

test('OBJ: homogeneous w is divided out', () => {
  const r = parseOBJ('v 2 4 6 2\nv 1 0 0\nv 1 1 0\nf 1 2 3\n');
  assert.deepEqual(r.positions.slice(0, 3), [1, 2, 3]);
});

test('OBJ: reports dropped UVs and normals', () => {
  const r = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nvt 0 0\nvn 0 0 1\nf 1/1/1 2/1/1 3/1/1\n');
  assert.match(r.note, /UVs and normals were dropped/);
});

test('OBJ errors: no vertices, no faces', () => {
  assert.throws(() => parseOBJ('# nothing'), /no "v" lines/);
  assert.throws(() => parseOBJ('v 0 0 0\nv 1 0 0\n'), /no faces/);
});

/* ------------------------------------------------------------------ *
 * STL
 * ------------------------------------------------------------------ */

test('STL binary: every facet owns three vertices', () => {
  const r = parseSTL(binarySTL(squareFacets()));
  assert.equal(r.positions.length / 3, 6);
  assert.equal(r.triangles.length, 6);
  assert.match(r.note, /2 detached triangles/);
});

test('STL ascii parses the same square', () => {
  const text =
    'solid s\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 1 1 0\nendloop\nendfacet\n' +
    'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 1 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid s\n';
  const r = parseSTL(ascii(text));
  assert.equal(r.triangles.length, 6);
});

test('STL binary: size mismatch is rejected instead of read past the end', () => {
  const bytes = binarySTL(squareFacets());
  assert.throws(() => parseSTL(bytes.subarray(0, bytes.length - 10)), /size mismatch/);
  assert.throws(() => parseSTL(new Uint8Array(40)), /too small/);
});

test('STL: a file with no facets fails', () => {
  assert.throws(() => parseSTL(ascii('solid\nendsolid\n')), /does not look like an STL/);
});

/* ------------------------------------------------------------------ *
 * PLY
 * ------------------------------------------------------------------ */

const PLY_ASCII = [
  'ply',
  'format ascii 1.0',
  'element vertex 4',
  'property float x',
  'property float y',
  'property float z',
  'property uchar red',
  'property uchar green',
  'property uchar blue',
  'element face 1',
  'property list uchar int vertex_indices',
  'end_header',
  '0 0 0 255 0 0',
  '1 0 0 0 255 0',
  '1 1 0 0 0 255',
  '0 1 0 10 10 10',
  '4 0 1 2 3',
  '',
].join('\n');

test('PLY ascii: skips colour properties and keeps the quad', () => {
  const r = parsePLY(ascii(PLY_ASCII));
  assert.equal(r.positions.length / 3, 4);
  assert.deepEqual(r.polygons, [[0, 1, 2, 3]]);
});

test('PLY binary_little_endian parses with list counts', () => {
  const head = ascii(
    'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n',
  );
  const body = new ArrayBuffer(3 * 12 + 1 + 3 * 4);
  const dv = new DataView(body);
  const pts = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ];
  let o = 0;
  for (const p of pts) {
    for (const v of p) {
      dv.setFloat32(o, v, true);
      o += 4;
    }
  }
  new Uint8Array(body)[o++] = 3;
  for (let i = 0; i < 3; i++) {
    dv.setInt32(o, i, true);
    o += 4;
  }
  const bytes = new Uint8Array(head.length + body.byteLength);
  bytes.set(head, 0);
  bytes.set(new Uint8Array(body), head.length);

  const r = parsePLY(bytes.buffer);
  assert.equal(r.positions.length / 3, 3);
  assert.deepEqual(r.polygons, [[0, 1, 2]]);
});

test('PLY: missing magic and missing vertex element fail clearly', () => {
  assert.throws(() => parsePLY(ascii('not a ply\n')), /not a PLY/);
  assert.throws(() => parsePLY(ascii('ply\nformat ascii 1.0\nend_header\n')), /no vertex element/);
});

/* ------------------------------------------------------------------ *
 * glTF / GLB
 * ------------------------------------------------------------------ */

test('GLB container reads both chunks with padding', () => {
  const { json, buffers } = parseGLBContainer(squareGLB().buffer);
  assert.equal(json.asset.version, '2.0');
  assert.equal(buffers.get(0).length, 60);
});

test('GLB round-trip: square becomes 4 positions and 2 triangles', () => {
  const r = parseAny('square.glb', squareGLB());
  assert.equal(r.kind, 'glTF');
  assert.equal(r.positions.length / 3, 4);
  assert.deepEqual(Array.from(r.triangles), [0, 1, 2, 0, 2, 3]);
  assert.equal(r.name, 'square');
});

test('GLB: node translation is baked into positions', () => {
  const json = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [5, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
    buffers: [{ byteLength: 12 }],
  };
  const bin = new ArrayBuffer(12);
  const dv = new DataView(bin);
  [1, 2, 3].forEach((v, i) => dv.setFloat32(i * 4, v, true));
  const r = parseAny('t.glb', glb(ascii(JSON.stringify(json)), new Uint8Array(bin)));
  assert.deepEqual(r.positions, [6, 2, 3]);
});

test('GLB: bad magic, bad version, truncation', () => {
  assert.throws(() => parseGLBContainer(ascii('not a glb file at all....').buffer), /magic/);
  const bytes = squareGLB();
  new DataView(bytes.buffer).setUint32(4, 1, true);
  assert.throws(() => parseGLBContainer(bytes.buffer), /GLB version 1/);
  assert.throws(() => parseGLBContainer(bytes.subarray(0, 30).buffer), /too small/);
});

test('gltf with an external buffer explains what to do', () => {
  const json = {
    asset: { version: '2.0' },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 12 }],
    buffers: [{ uri: 'model.bin', byteLength: 12 }],
  };
  assert.throws(
    () => parseGLTF(json, new Map(), 'x.gltf'),
    /single-file \.glb/,
  );
});

test('glTF: unsupported version and empty files fail clearly', () => {
  assert.throws(() => parseGLTF({ asset: { version: '1.0' }, meshes: [] }, new Map()), /glTF 1/);
  assert.throws(() => parseGLTF({ asset: { version: '2.0' } }, new Map()), /no scene and no meshes/);
});

test('glTF: line modes become document edges', () => {
  const bin = new ArrayBuffer(24 + 4);
  const dv = new DataView(bin);
  [0, 0, 0, 1, 1, 1].forEach((v, i) => dv.setFloat32(i * 4, v, true));
  dv.setUint16(24, 0, true);
  dv.setUint16(26, 1, true);
  const json = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 2, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 24 },
      { buffer: 0, byteOffset: 24, byteLength: 4 },
    ],
    buffers: [{ byteLength: 28 }],
  };
  const r = parseAny('wire.glb', glb(ascii(JSON.stringify(json)), new Uint8Array(bin)));
  assert.deepEqual(r.lines, [[0, 1]]);
});

/* ------------------------------------------------------------------ *
 * merge.js
 * ------------------------------------------------------------------ */

test('weldPositions collapses exact duplicates, first one wins', () => {
  const { positions, remap, merged } = weldPositions([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0], 1e-4);
  assert.equal(merged, 2);
  assert.equal(positions.length / 3, 3);
  assert.deepEqual(Array.from(remap), [0, 1, 0, 2, 0]);
});

test('weldPositions keeps duplicates straddling a grid cell boundary', () => {
  const eps = 0.1;
  const { positions, merged } = weldPositions([1, 0, 0, 1.09, 0, 0], eps);
  assert.equal(merged, 1);
  assert.equal(positions.length, 3);
});

test('weldPositions honours eps=0 (keep every duplicate)', () => {
  const { positions, merged } = weldPositions([0, 0, 0, 0, 0, 0], 0);
  assert.equal(merged, 0);
  assert.equal(positions.length / 3, 2);
});

test('weldPositions never welds non-finite coordinates', () => {
  const { remap, merged } = weldPositions([NaN, 0, 0, NaN, 0, 0], 1);
  assert.equal(merged, 0);
  assert.notEqual(remap[0], remap[1]);
});

test('defaultWeldTolerance is tiny but never zero or NaN', () => {
  assert.ok(defaultWeldTolerance(1) > 0);
  assert.equal(defaultWeldTolerance(0), 1e-9);
  assert.ok(Number.isFinite(defaultWeldTolerance(Infinity)));
});

test('mergeCoplanarTriangles: two tris become one quad', () => {
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const r = mergeCoplanarTriangles(pos, [0, 1, 2, 0, 2, 3]);
  assert.equal(r.groups, 1);
  assert.equal(r.polygons.length, 1);
  assert.equal(r.polygons[0].length, 4);
  assert.equal(r.triangles.length, 0);
});

test('mergeCoplanarTriangles: perpendicular faces stay separate triangles', () => {
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1];
  const r = mergeCoplanarTriangles(pos, [0, 1, 2, 0, 3, 1]);
  assert.equal(r.groups, 0);
  assert.equal(r.triangles.length, 6);
});

test('mergeCoplanarTriangles: two touching quads give two groups', () => {
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0];
  const r = mergeCoplanarTriangles(pos, [0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]);
  assert.equal(r.groups, 2);
  assert.equal(r.polygons.length, 2);
});

test('mergeCoplanarTriangles leaves a holed plate as triangles', () => {
  // A square ring of 8 triangles around a missing centre: boundary is two loops.
  const pos = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 2, 1, 0, 0, 2, 0, 1, 2, 0, 2, 2, 0];
  const tris = [0, 1, 3, 1, 4, 3, 3, 4, 7, 3, 7, 6, 1, 2, 4, 4, 2, 5, 5, 2, 7, 7, 2, 6];
  const r = mergeCoplanarTriangles(pos, tris);
  assert.equal(r.groups, 0);
  assert.equal(r.triangles.length, tris.length);
});

test('mergeCoplanarTriangles ignores degenerate triangles', () => {
  const pos = [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0];
  const r = mergeCoplanarTriangles(pos, [0, 1, 2, 0, 1, 3]);
  assert.equal(r.groups, 0);
});

/* ------------------------------------------------------------------ *
 * importer.js
 * ------------------------------------------------------------------ */

test('normalisePositions: z-up rotates -90deg about X', () => {
  const { positions } = normalisePositions([1, 2, 3], { up: 'z-up', center: false });
  assert.deepEqual(positions, [1, 3, -2]);
});

test('normalisePositions: scale then center on the origin', () => {
  const { positions } = normalisePositions([0, 0, 0, 2, 2, 2], { scale: 0.5, center: true });
  assert.deepEqual(positions, [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
});

test('normalisePositions: fit overrides centering and leaves a note', () => {
  const { positions, note } = normalisePositions([0, 0, 0, 10, 0, 0], { fit: 2 });
  assert.match(note, /Scaled to fit 2 units/);
  assert.equal(Math.max(...positions), 2);
  assert.ok(Math.abs(Math.min(...positions) + 2) < 1e-9);
});

test('buildDocument: an STL square welds to 4 verts and merges to one quad', () => {
  const parsed = parseSTL(binarySTL(squareFacets()));
  const { doc, stats } = buildDocument(parsed, { name: 'Square' });
  assert.equal(stats.vertices, 4);
  assert.equal(stats.merged, 2);
  assert.equal(doc.faces.length, 1);
  assert.equal(doc.faces[0].loop.length, 4);
  assert.equal(doc.name, 'Square');
  assert.deepEqual(validate(doc), []);
});

test('buildDocument: mergePolys off keeps triangle faces', () => {
  const parsed = parseSTL(binarySTL(squareFacets()));
  const { doc, stats } = buildDocument(parsed, { mergePolys: false });
  assert.equal(doc.faces.length, 2);
  assert.equal(stats.polygonGroups, 0);
});

test('buildDocument: weld off leaves the detached corners', () => {
  const parsed = parseSTL(binarySTL(squareFacets()));
  const { stats } = buildDocument(parsed, { weld: false });
  assert.equal(stats.vertices, 6);
  assert.equal(stats.merged, 0);
});

test('buildDocument: z-up import stands the model up', () => {
  const flat = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], polygons: [[0, 1, 2]], triangles: [], lines: [] };
  const { doc } = buildDocument(flat, { up: 'z-up', center: false, weld: false });
  const zs = doc.vertices.map((v) => v.z);
  assert.ok(Math.max(...zs) < 1e-9); // XY-plane source has no height after the swap
});

test('buildDocument: keepEdges writes the polygon outline', () => {
  const parsed = parseSTL(binarySTL(squareFacets()));
  const a = buildDocument(parsed, { keepEdges: false });
  const b = buildDocument(parsed, { keepEdges: true });
  assert.equal(a.doc.edges.length, 0);
  assert.equal(b.doc.edges.length, 4);
});

test('buildDocument: wire imports keep lines as edges', () => {
  const flat = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], polygons: [], triangles: [], lines: [[0, 1], [1, 2]] };
  const { doc, stats } = buildDocument(flat, {});
  assert.equal(doc.edges.length, 2);
  assert.equal(doc.faces.length, 0);
  assert.equal(stats.faces, 0);
});

test('buildDocument: merge mode appends into the live document', () => {
  const doc = makeCube();
  const before = doc.vertices.length;
  const parsed = parseSTL(binarySTL(squareFacets()));
  const { doc: out } = buildDocument(parsed, { mode: 'merge', doc });
  assert.equal(out, doc);
  assert.equal(doc.vertices.length, before + 4);
  assert.deepEqual(validate(doc), []);
});

test('buildDocument: replace mode refuses to blend with a dirty doc', () => {
  const doc = makeCube();
  const parsed = parseSTL(binarySTL(squareFacets()));
  buildDocument(parsed, { mode: 'replace', doc });
  assert.equal(doc.vertices.length, 4);
});

test('buildDocument: rejects empty and unusable input', () => {
  assert.throws(() => buildDocument(null), /Nothing was parsed/);
  assert.throws(() => buildDocument({ positions: [], polygons: [], triangles: [], lines: [] }), /no usable geometry/);
});

test('buildDocument: duplicate vertices collapse into a valid face ring', () => {
  // Face refers to the same welded corner twice; the ring must shrink, not degenerate.
  const flat = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
    polygons: [[0, 1, 2, 3]],
    triangles: [],
    lines: [],
  };
  const { doc } = buildDocument(flat, { weld: true });
  assert.equal(doc.faces[0].loop.length, 3);
  assert.deepEqual(validate(doc), []);
});

/* ------------------------------------------------------------------ *
 * ui/io.js importFile (DOM-free path)
 * ------------------------------------------------------------------ */

test('importFile: OBJ through the real entry point', async () => {
  const { doc, stats } = await importFile(
    fakeFile('part.obj', 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n'),
    { center: false },
  );
  assert.equal(doc.vertices.length, 4);
  assert.equal(doc.faces.length, 1);
  assert.equal(stats.native, undefined);
  assert.equal(doc.name, 'part');
});

test('importFile: STL, PLY and GLB all reach an editable document', async () => {
  const stl = await importFile(fakeFile('s.stl', binarySTL(squareFacets())), {});
  assert.equal(stl.doc.vertices.length, 4);

  const ply = await importFile(fakeFile('p.ply', PLY_ASCII), {});
  assert.equal(ply.doc.faces[0].loop.length, 4);

  const glbDoc = await importFile(fakeFile('g.glb', squareGLB()), {});
  assert.equal(glbDoc.doc.vertices.length, 4);
});

test('importFile: native JSON keeps ids and reports native', async () => {
  const raw = JSON.stringify({ format: 'vertex-forge', version: 1, name: 'Mine', vertices: [{ id: 'v1', x: 1, y: 2, z: 3 }], edges: [], faces: [] });
  const { doc, stats } = await importFile(fakeFile('mine.json', raw), {});
  assert.equal(stats.native, true);
  assert.equal(doc.name, 'Mine');
  assert.equal(doc.vertices[0].id, 'v1');
});

test('importFile: a renamed native doc is sniffed from content', async () => {
  const raw = JSON.stringify({ format: 'vertex-forge', version: 1, vertices: [{ id: 'v1', x: 0, y: 0, z: 0 }], edges: [], faces: [] });
  const { stats } = await importFile(fakeFile('exported.txt', raw), {});
  assert.equal(stats.native, true);
});

test('importFile: gltf JSON is never mistaken for a native doc', async () => {
  const raw = JSON.stringify({ asset: { version: '2.0' }, meshes: [], buffers: [{ uri: 'a.bin', byteLength: 12 }] });
  await assert.rejects(() => importFile(fakeFile('x.json', raw), {}), /not a native|glTF|external|single-file/i);
});

test('importFile: clear errors for missing file and junk bytes', async () => {
  await assert.rejects(() => importFile(null, {}), /No file was selected/);
  await assert.rejects(() => importFile(fakeFile('junk.stl', ascii('nope')), {}), ImportError);
});

test('importFile: an import that yields nothing fails loudly', async () => {
  // A .txt that is not JSON and has no geometry must not show an empty viewport.
  await assert.rejects(
    () => importFile(fakeFile('empty', ascii('v 0 0 0\nv 1 0 0\n')), {}),
    /no faces|Import failed|imported no vertices/i,
  );
});

test('importFile: passes options through to the importer', async () => {
  const off = await importFile(fakeFile('s.stl', binarySTL(squareFacets())), { weld: false, mergePolys: false });
  assert.equal(off.doc.vertices.length, 6);
  assert.equal(off.doc.faces.length, 2);

  const fit = await importFile(fakeFile('s.stl', binarySTL(squareFacets())), { fit: 4 });
  const xs = fit.doc.vertices.map((v) => v.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 3.9);
});

/* ------------------------------------------------------------------ *
 * the bug class that blanked the whole page: named imports must exist
 * ------------------------------------------------------------------ */

test('ui/io.js exports every name the app imports', async () => {
  const io = await import('../src/ui/io.js');
  for (const name of ['download', 'exportJSON', 'readJSONFile', 'exportGLB', 'safeName', 'importFile', 'stemOf', 'extOf', 'IMPORT_ACCEPT']) {
    assert.ok(name in io, `io.js must export ${name}`);
  }
});
