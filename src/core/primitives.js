/**
 * Seed geometry. Pure document builders - no UI, no three.js - so the same
 * shapes can be asserted on in tests and used as starter content in the app.
 */
import { createDocument, addVertex, addEdge, addFace } from './model.js';

/** Unit cube centred on the origin, faces wound outwards. */
export function makeCube(doc = createDocument('Cube'), size = 1) {
  const h = size / 2;
  const corner = (sx, sy, sz) => addVertex(doc, { x: sx * h, y: sy * h, z: sz * h });
  const p = [
    corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1),
    corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1),
  ];
  // Index rings: 0-3 back (-Z), 4-7 front (+Z).
  const quads = [
    [4, 5, 6, 7], // +Z
    [1, 0, 3, 2], // -Z
    [5, 1, 2, 6], // +X
    [0, 4, 7, 3], // -X
    [3, 7, 6, 2], // +Y
    [0, 1, 5, 4], // -Y
  ];
  for (const q of quads) {
    addFace(
      doc,
      q.map((i) => p[i].id),
    );
  }
  for (const f of doc.faces) {
    const L = f.loop;
    for (let i = 0; i < L.length; i++) addEdge(doc, L[i], L[(i + 1) % L.length]);
  }
  return doc;
}

/** A flat n x m grid of quads on the XZ plane, useful for learning to pull vertices. */
export function makePlane(
  doc = createDocument('Plane'),
  { width = 2, depth = 2, cols = 2, rows = 2, y = 0 } = {},
) {
  cols = Math.max(1, Math.floor(cols));
  rows = Math.max(1, Math.floor(rows));
  const grid = [];
  for (let r = 0; r <= rows; r++) {
    const row = [];
    for (let c = 0; c <= cols; c++) {
      row.push(
        addVertex(doc, {
          x: -width / 2 + (width * c) / cols,
          y,
          z: -depth / 2 + (depth * r) / rows,
        }),
      );
    }
    grid.push(row);
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ring = [grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]].map((v) => v.id);
      addFace(doc, ring);
      for (let i = 0; i < ring.length; i++) addEdge(doc, ring[i], ring[(i + 1) % ring.length]);
    }
  }
  return doc;
}

/** Tetrahedron - the smallest closed solid, handy for validating exports. */
export function makeTetra(doc = createDocument('Tetra'), size = 1) {
  const s = size;
  const p = [
    addVertex(doc, { x: s, y: 0, z: 0 }),
    addVertex(doc, { x: -s, y: 0, z: s }),
    addVertex(doc, { x: -s, y: 0, z: -s }),
    addVertex(doc, { x: 0, y: s, z: 0 }),
  ].map((v) => v.id);
  const tris = [
    [0, 2, 1],
    [0, 1, 3],
    [1, 2, 3],
    [2, 0, 3],
  ];
  for (const t of tris) {
    addFace(doc, t.map((i) => p[i]));
    for (let i = 0; i < t.length; i++) addEdge(doc, p[t[i]], p[t[(i + 1) % t.length]]);
  }
  return doc;
}

export const PRIMITIVES = [
  { id: 'cube', label: 'Cube', build: makeCube },
  { id: 'plane', label: 'Grid plane', build: makePlane },
  { id: 'tetra', label: 'Tetra', build: makeTetra },
];
