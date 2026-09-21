/**
 * Import-fidelity harness: run every head asset through the real parse +
 * buildDocument path and compare the resulting FACE colours against the
 * ground truth the generator wrote.
 *
 * Run: node tools/check-head-imports.mjs
 */
import { readFileSync } from 'node:fs';
import { parseAny, extOf } from '../src/core/formats.js';
import { buildDocument } from '../src/core/importer.js';
import { buildHead, faceHex } from './head-mesh.mjs';

const truth = buildHead();
// Reference: what the head's own groups average to, per region.
const ref = {};
for (const g of truth.groups) {
  const hexes = g.faces.map((fi) => faceHex(truth, truth.quads[fi]));
  ref[g.name] = hexes;
}

const parseHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => {
  const A = parseHex(a);
  const B = parseHex(b);
  return Math.round(Math.sqrt(A.reduce((s, v, i) => s + (v - B[i]) ** 2, 0)));
};

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'head_vertexcolor.obj',
      'head_vertexcolor255.obj',
      'head_mtl.obj',
      'head_ascii.ply',
      'head_binary.ply',
      'head_color.glb',
      'head_materials.glb',
      'head_textured.glb',
      'head.stl',
    ];

console.log('ground truth region averages:');
for (const name of ['skin', 'hair', 'eye']) {
  const h = ref[name];
  const avg = [0, 1, 2].map((k) => Math.round(h.reduce((s, x) => s + parseHex(x)[k], 0) / h.length));
  console.log(`  ${name.padEnd(5)} mean #${avg.map((v) => v.toString(16).padStart(2, '0')).join('')}  distinct ${new Set(h).size}`);
}
console.log('');

for (const f of files) {
  const path = new URL(`../test-assets/${f}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  let line = `${f.padEnd(24)}`;
  try {
    const buf = readFileSync(path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const parsed = parseAny(f, ab);
    const { doc, stats } = buildDocument(parsed, { center: false, scale: 1 });

    const colored = doc.faces.filter((x) => x.color);
    const hues = colored.map((x) => x.color);
    const uniq = [...new Set(hues)];

    // Closest reference region for each imported face colour.
    let report = 'uncoloured';
    if (uniq.length) {
      const mean = [0, 1, 2].map((k) => Math.round(hues.reduce((s, h) => s + parseHex(h)[k], 0) / hues.length));
      const meanHex = `#${mean.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      const nearest = ['skin', 'hair', 'eye']
        .map((n) => {
          const h = ref[n];
          const m = [0, 1, 2].map((k) => Math.round(h.reduce((s, x) => s + parseHex(x)[k], 0) / h.length));
          const hex = `#${m.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          return { n, d: dist(meanHex, hex) };
        })
        .sort((a, b) => a.d - b.d)[0];
      report = `${uniq.length} distinct, mean ${meanHex} (nearest ${nearest.n}, d=${nearest.d})`;
    }

    // Geometry sanity: the head spans about 1.9 x 2.2 x 2.0.
    const xs = doc.vertices.map((v) => v.x);
    const ys = doc.vertices.map((v) => v.y);
    const zs = doc.vertices.map((v) => v.z);
    const size = [xs, ys, zs].map((a) => +(Math.max(...a) - Math.min(...a)).toFixed(2));

    console.log(
      `${line} verts ${String(stats.vertices).padStart(5)} faces ${String(doc.faces.length).padStart(4)}  ${report}\n${' '.repeat(24)} bbox size ${size.join(' x ')}`,
    );
  } catch (err) {
    console.log(`${line} FAILED: ${err.message}`);
  }
}
