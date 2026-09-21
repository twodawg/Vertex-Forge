/**
 * Per-region colour fidelity: classify imported faces by luminance into the
 * head's three regions (hair / skin / eye) and compare each region's mean to
 * the generator's ground truth. An all-faces mean is useless here because the
 * head is ~45% dark hair, which drags any average toward black.
 *
 * Run: node tools/check-region-color.mjs
 */
import { readFileSync } from 'node:fs';
import { parseAny } from '../src/core/formats.js';
import { buildDocument } from '../src/core/importer.js';
import { buildHead, faceHex } from './head-mesh.mjs';

const truth = buildHead();
const lum = (h) => { const [r, g, b] = px(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const px = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (a) => '#' + a.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

function region(hex) {
  const L = lum(hex) / 255;
  if (L < 0.25) return 'hair';
  if (L > 0.78) return 'eye';
  return 'skin';
}

const refMean = {};
for (const g of truth.groups) {
  const hs = g.faces.map((fi) => faceHex(truth, truth.quads[fi]));
  const by = {};
  for (const h of hs) (by[region(h)] ||= []).push(h);
  for (const [name, list] of Object.entries(by)) {
    (refMean[name] ||= []).push(...list);
  }
}
const meanOf = (list) => toHex([0, 1, 2].map((k) => list.reduce((s, h) => s + px(h)[k], 0) / list.length));
console.log('GROUND TRUTH');
for (const n of ['hair', 'skin', 'eye']) console.log(`  ${n.padEnd(5)} n=${String(refMean[n].length).padStart(4)} mean ${meanOf(refMean[n])}`);

const files = [
  'head_vertexcolor.obj',
  'head_vertexcolor255.obj',
  'head_ascii.ply',
  'head_binary.ply',
  'head_color.glb',
  'head_materials.glb',
  'head_mtl.obj',
  'head_textured.glb',
];

console.log('\nIMPORTED (region means, and max channel error vs truth)');
for (const f of files) {
  let mtlText = null;
  if (f.endsWith('.obj')) {
    try { mtlText = readFileSync(new URL('../test-assets/head.mtl', import.meta.url), 'utf8'); } catch { /* optional */ }
  }
  const buf = readFileSync(new URL(`../test-assets/${f}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parsed = parseAny(f, ab, { mtlText });
  if (typeof parsed.textureJobs?.length === 'number') {
    const { applyTextures } = await import('../src/core/texture.js');
    await applyTextures(parsed);
  }
  const { doc } = buildDocument(parsed, { center: false, scale: 1 });
  const hexes = doc.faces.map((x) => x.color).filter(Boolean);
  const by = {};
  for (const h of hexes) (by[region(h)] ||= []).push(h);
  const parts = ['hair', 'skin', 'eye'].map((n) => {
    if (!by[n]) return `${n}=MISSING`;
    const m = meanOf(by[n]);
    const err = Math.max(...[0, 1, 2].map((k) => Math.abs(px(m)[k] - px(meanOf(refMean[n]))[k])));
    return `${n} ${m} (Δ${err})`;
  });
  console.log(`${f.padEnd(24)} faces ${String(hexes.length).padStart(4)}  ${parts.join('  ')}`);
}
