import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  snap,
  round,
  newellNormal,
  planeBasis,
  signedArea2,
  earClip,
  triangulate,
  boundsOf,
  stitchLoop,
  cross,
  dot,
  length,
  normalize,
} from '../src/core/geometry.js';

test('snap rounds to the step grid; 0 step is a no-op', () => {
  assert.equal(snap(0.26, 0.25), 0.25);
  assert.equal(snap(0.4, 0.25), 0.5);
  assert.equal(snap(1.234, 0), 1.234);
  assert.equal(snap(1.234, -1), 1.234);
});

test('round kills float noise and negative zero', () => {
  assert.equal(round(1.0000000001, 6), 1);
  assert.equal(round(-0.0000001, 4), 0);
  assert.ok(Object.is(round(-0.0001, 2), 0), 'no -0 in output');
});

test('newellNormal of a CCW unit square in XY points along +Z', () => {
  const n = newellNormal([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]);
  assert.deepEqual(n.map((v) => round(v, 6)), [0, 0, 1]);
});

test('newellNormal is orientation-aware, not dependent on the first two edges', () => {
  const cw = newellNormal([[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]);
  assert.deepEqual(cw.map((v) => round(v, 6)), [0, 0, -1]);
});

test('newellNormal returns zero for degenerate loops', () => {
  assert.deepEqual(newellNormal([[1, 2, 3], [1, 2, 3]]), [0, 0, 0]);
  // Collinear points enclose no area.
  const flat = newellNormal([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
  assert.equal(length(flat), 0);
});

test('planeBasis is right-handed for every axis direction (winding regression)', () => {
  const dirs = [
    [0, 0, 1], [0, 0, -1],
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [1, 1, 1],
  ];
  for (const d of dirs) {
    const up = normalize(d);
    const { u, v } = planeBasis(up);
    // cross(u, v) must agree with up, and both must be unit & perpendicular to it.
    const n = cross(u, v);
    assert.ok(Math.abs(dot(n, up) - 1) < 1e-9, `right-handed for ${d}`);
    assert.ok(Math.abs(length(u) - 1) < 1e-9);
    assert.ok(Math.abs(length(v) - 1) < 1e-9);
    assert.ok(Math.abs(dot(u, up)) < 1e-9);
    assert.ok(Math.abs(dot(v, up)) < 1e-9);
    assert.ok(Math.abs(dot(u, v)) < 1e-9);
  }
});

test('a back-facing polygon triangulates WITH its own normal, not mirrored', () => {
  // Square facing -Z, wound CW when viewed from +Z (i.e. CCW from -Z).
  const pts = [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]];
  const up = newellNormal(pts);
  assert.ok(up[2] < 0, 'polygon faces -Z');

  const tris = triangulate(pts);
  assert.equal(tris.length, 2);
  for (const [a, b, c] of tris) {
    const e1 = [pts[b][0] - pts[a][0], pts[b][1] - pts[a][1], pts[b][2] - pts[a][2]];
    const e2 = [pts[c][0] - pts[b][0], pts[c][1] - pts[b][1], pts[c][2] - pts[b][2]];
    assert.ok(dot(cross(e1, e2), up) > 0, 'triangle winding agrees with polygon normal');
  }
});

test('signedArea2 reports CCW as positive', () => {
  assert.ok(signedArea2([[0, 0], [1, 0], [1, 1], [0, 1]]) > 0);
  assert.ok(signedArea2([[0, 0], [0, 1], [1, 1], [1, 0]]) < 0);
});

test('earClip handles a concave L-shape and covers the full area', () => {
  const L = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
  const tris = earClip(L);
  assert.equal(tris.length, L.length - 2, 'n-2 triangles');
  const area = tris.reduce((s, [a, b, c]) => s + Math.abs(signedArea2([L[a], L[b], L[c]])), 0);
  assert.ok(Math.abs(area - 5) < 1e-9, `area preserved (got ${area})`);
});

test('earClip normalizes a CW input loop', () => {
  const ccw = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const cw = [...ccw].reverse();
  const a = earClip(ccw).reduce((s, t) => s + Math.abs(signedArea2(t.map((i) => ccw[i]))), 0);
  const b = earClip(cw).reduce((s, t) => s + Math.abs(signedArea2(t.map((i) => cw[i]))), 0);
  assert.ok(Math.abs(a - 4) < 1e-9);
  assert.ok(Math.abs(b - 4) < 1e-9, 'same area from either winding');
});

test('earClip does not hang on a self-intersecting bowtie', () => {
  const bowtie = [[0, 0], [2, 2], [2, 0], [0, 2]];
  const tris = earClip(bowtie);
  assert.ok(Array.isArray(tris));
  assert.ok(tris.length >= 1, 'still produces usable coverage');
});

test('triangulate: triangle passthrough, quad = 2, degenerate = fan', () => {
  assert.deepEqual(triangulate([[0, 0, 0], [1, 0, 0], [0, 1, 0]]), [[0, 1, 2]]);
  assert.equal(triangulate([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]).length, 2);
  assert.deepEqual(triangulate([[0, 0, 0], [1, 1, 1]]), []);
  // Zero-area loop still fans so the caller keeps geometry.
  const fan = triangulate([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]);
  assert.ok(fan.length > 0);
});

test('boundsOf accepts both array points and {x,y,z} vertices', () => {
  const fromArrays = boundsOf([[-1, -2, -3], [4, 5, 6]]);
  const fromObjects = boundsOf([{ x: -1, y: -2, z: -3 }, { x: 4, y: 5, z: 6 }]);
  assert.deepEqual(fromArrays, fromObjects);
  assert.deepEqual(fromArrays.min, [-1, -2, -3]);
  assert.deepEqual(fromArrays.max, [4, 5, 6]);
  assert.deepEqual(fromArrays.center, [1.5, 1.5, 1.5]);
});

test('boundsOf of an empty list is a safe zero box', () => {
  const b = boundsOf([]);
  assert.deepEqual(b.center, [0, 0, 0]);
  assert.equal(b.radius, 0);
});

test('boundsOf ignores non-finite coordinates instead of poisoning the box', () => {
  const b = boundsOf([{ x: 0, y: 0, z: 0 }, { x: NaN, y: 2, z: 2 }]);
  assert.equal(Number.isNaN(b.min[0]), false);
  assert.deepEqual(b.max, [0, 2, 2]);
});

test('stitchLoop orders a closed ring from unordered edges', () => {
  const loop = stitchLoop([['a', 'b'], ['c', 'd'], ['b', 'c'], ['d', 'a']]);
  assert.equal(loop.length, 4);
  const set = new Set(loop);
  assert.equal(set.size, 4);
  // Consecutive pairs must all be real edges.
  const edges = new Set(['a|b', 'b|c', 'c|d', 'd|a']);
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    assert.ok(edges.has(`${a}|${b}`) || edges.has(`${b}|${a}`), `${a}->${b} is an edge`);
  }
});

test('stitchLoop rejects open chains, branching graphs, and too-few edges', () => {
  assert.equal(stitchLoop([['a', 'b'], ['b', 'c']]), null, 'open path');
  assert.equal(stitchLoop([['a', 'b'], ['a', 'c'], ['a', 'd']]), null, 'branching');
  assert.equal(stitchLoop([['a', 'b'], ['b', 'a']]), null, 'degenerate double edge');
  assert.equal(stitchLoop([]), null);
});

test('stitchLoop rejects a figure-eight (two cycles sharing a vertex)', () => {
  const edges = [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'd'], ['d', 'e'], ['e', 'a']];
  assert.equal(stitchLoop(edges), null);
});
